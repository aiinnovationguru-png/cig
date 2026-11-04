//! Client HTTP per gli open data ANAC (CKAN) e i pacchetti mensili CIG.

use std::io::{Cursor, Read};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::Value;

const CKAN_BASE: &str = "https://dati.anticorruzione.it/opendata";
const DOWNLOAD_BASE: &str = "https://dati.anticorruzione.it/opendata/download/dataset";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/131.0 Safari/537.36 CIG-Italia/0.1";

#[derive(Debug, Clone)]
pub struct AnacResource {
    pub name: String,
    pub url: String,
    pub updated: Option<String>,
}

/// Sceglie la risorsa CSV del mese richiesto. Nel dataset annuale i nomi sono
/// `cig_csv_2025_12`; nel dataset corrente `20260901-cig_csv`.
fn pick_month_resource(
    resources: &[AnacResource],
    year: i32,
    month: u32,
) -> Option<AnacResource> {
    let yearly = format!("cig_csv_{year}_{month:02}");
    let current = format!("{year}{month:02}");
    resources
        .iter()
        .filter(|resource| {
            let name = resource.name.to_lowercase();
            let url = resource.url.to_lowercase();
            url.ends_with(".zip")
                && name.contains("csv")
                && !name.contains("json")
                && (name.contains(&yearly) || name.starts_with(&current))
        })
        .max_by(|a, b| a.name.cmp(&b.name))
        .cloned()
}

pub struct AnacClient {
    client: reqwest::Client,
}

impl AnacClient {
    pub fn new() -> Result<Self> {
        let mut headers = reqwest::header::HeaderMap::new();
        // Il WAF di ANAC rifiuta le richieste che sembrano script: oltre allo
        // User-Agent servono Accept e Accept-Language di un browser.
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json, text/plain, */*"),
        );
        headers.insert(
            reqwest::header::ACCEPT_LANGUAGE,
            reqwest::header::HeaderValue::from_static("it-IT,it;q=0.9,en;q=0.8"),
        );
        headers.insert(
            reqwest::header::REFERER,
            reqwest::header::HeaderValue::from_static(
                "https://dati.anticorruzione.it/opendata/dataset/cig",
            ),
        );
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .default_headers(headers)
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .context("creazione client ANAC")?;
        Ok(Self { client })
    }

    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .with_context(|| format!("richiesta ANAC fallita: {url}"))?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "ANAC ha risposto {} per {url}",
                response.status()
            ));
        }
        Ok(response.bytes().await?.to_vec())
    }

    /// Pacchetto mensile CIG: una riga per CIG/CPV.
    ///
    /// Fino al 2025 i dati stanno in `cig-{anno}` con file
    /// `cig_csv_{anno}_{mese}.zip`. Dal 2026 i mesi correnti sono nel dataset
    /// `cig` come `AAAAMMGG-cig_csv.zip`; si prova prima l'URL diretto, poi il
    /// dataset annuale e infine il dataset corrente.
    pub async fn cig_month(&self, year: i32, month: u32) -> Result<Vec<u8>> {
        let url = format!(
            "{DOWNLOAD_BASE}/cig-{year}/filesystem/cig_csv_{year}_{month:02}.zip"
        );
        let direct_error = match self.get_bytes(&url).await {
            Ok(bytes) => return Ok(bytes),
            Err(err) => err.to_string(),
        };

        let mut errors = vec![direct_error];
        for dataset in [format!("cig-{year}"), "cig".to_string()] {
            match self.resources(&dataset).await {
                Ok(resources) => {
                    if let Some(resource) = pick_month_resource(&resources, year, month) {
                        return self.get_bytes(&resource.url).await.with_context(|| {
                            format!("download del pacchetto ANAC {} ({dataset})", resource.name)
                        });
                    }
                }
                Err(err) => errors.push(err.to_string()),
            }
        }

        Err(anyhow!(
            "pacchetto CIG {year}-{month:02} non trovato: {}",
            errors.join(" · ")
        ))
    }

    /// Elenco delle risorse pubblicate per un dataset CKAN.
    pub async fn resources(&self, dataset: &str) -> Result<Vec<AnacResource>> {
        let url = format!("{CKAN_BASE}/api/3/action/package_show?id={dataset}");
        let bytes = self.get_bytes(&url).await?;
        let payload: Value = serde_json::from_slice(&bytes)
            .with_context(|| format!("risposta CKAN non valida per {dataset}"))?;
        if payload.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(anyhow!("dataset ANAC non disponibile: {dataset}"));
        }
        let resources = payload
            .get("result")
            .and_then(|result| result.get("resources"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut result = Vec::new();
        for resource in resources {
            let Some(url) = resource.get("url").and_then(Value::as_str) else {
                continue;
            };
            let name = resource
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(url)
                .to_string();
            let updated = resource
                .get("last_modified")
                .or_else(|| resource.get("created"))
                .and_then(Value::as_str)
                .map(str::to_string);
            result.push(AnacResource {
                name,
                url: url.to_string(),
                updated,
            });
        }
        Ok(result)
    }

    pub async fn download(&self, url: &str) -> Result<Vec<u8>> {
        self.get_bytes(url).await
    }
}

/// Estrae il primo CSV da uno ZIP ANAC, in memoria.
pub fn first_csv(zip_bytes: &[u8]) -> Result<(String, Vec<u8>)> {
    let cursor = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).context("ZIP ANAC non valido")?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let name = file.name().to_string();
        if !name.to_lowercase().ends_with(".csv") {
            continue;
        }
        let mut content = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut content)?;
        return Ok((name, content));
    }
    Err(anyhow!("lo ZIP ANAC non contiene file CSV"))
}

/// I CSV ANAC sono UTF-8; in caso contrario si usa Windows-1252.
pub fn decode_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.trim_start_matches('\u{feff}').to_string(),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            decoded.trim_start_matches('\u{feff}').to_string()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct PackageResponse {
    pub success: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource(name: &str, url: &str) -> AnacResource {
        AnacResource {
            name: name.into(),
            url: url.into(),
            updated: None,
        }
    }

    #[test]
    fn picks_yearly_monthly_csv() {
        let resources = vec![
            resource(
                "cig_csv_2025_11",
                "https://example.test/cig_csv_2025_11.zip",
            ),
            resource(
                "cig_csv_2025_12",
                "https://example.test/cig_csv_2025_12.zip",
            ),
            resource(
                "cig_csv_2025_12_json",
                "https://example.test/cig_csv_2025_12_json.zip",
            ),
        ];
        let picked = pick_month_resource(&resources, 2025, 12).unwrap();
        assert_eq!(picked.name, "cig_csv_2025_12");
    }

    #[test]
    fn picks_current_year_snapshot_and_latest() {
        let resources = vec![
            resource(
                "20260901-cig_csv",
                "https://example.test/20260901-cig_csv.zip",
            ),
            resource(
                "20260915-cig_csv",
                "https://example.test/20260915-cig_csv.zip",
            ),
            resource(
                "20260915-cig_json",
                "https://example.test/20260915-cig_json.zip",
            ),
            resource(
                "20261001-cig_csv",
                "https://example.test/20261001-cig_csv.zip",
            ),
        ];
        let picked = pick_month_resource(&resources, 2026, 9).unwrap();
        assert_eq!(picked.name, "20260915-cig_csv");
    }

    #[test]
    fn no_resource_for_missing_month() {
        let resources = vec![resource(
            "20260901-cig_csv",
            "https://example.test/20260901-cig_csv.zip",
        )];
        assert!(pick_month_resource(&resources, 2026, 10).is_none());
    }
}
