//! Embedding multilingua a 384 dimensioni.
//!
//! Due provider intercambiabili: il modello E5-small eseguito in locale (nessuna
//! chiave, nessuna rete dopo il primo download) oppure un endpoint
//! OpenAI-compatibile. Entrambi producono vettori normalizzati, così la
//! similarità è un semplice prodotto scalare.

use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, Result};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use serde::Serialize;

use crate::config::Settings;

pub const EMBEDDING_DIMS: usize = 384;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStatus {
    pub provider: String,
    pub model: String,
    pub dims: usize,
    pub ready: bool,
    pub error: Option<String>,
}

fn model_cache_dir() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("CIG_MODEL_CACHE") {
        if !path.is_empty() {
            return Some(std::path::PathBuf::from(path));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(base) = std::env::var_os("APPDATA") {
            return Some(
                std::path::PathBuf::from(base)
                    .join("it.cig.intelligence")
                    .join("models"),
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(base) = std::env::var_os("XDG_CACHE_HOME") {
            return Some(std::path::PathBuf::from(base).join("cig").join("models"));
        }
        if let Some(home) = std::env::var_os("HOME") {
            return Some(
                std::path::PathBuf::from(home)
                    .join(".cache")
                    .join("cig")
                    .join("models"),
            );
        }
    }
    None
}

fn local_model() -> Result<&'static Mutex<TextEmbedding>> {
    static MODEL: OnceLock<Result<Mutex<TextEmbedding>, String>> = OnceLock::new();
    let slot = MODEL.get_or_init(|| {
        let mut options = InitOptions::new(EmbeddingModel::MultilingualE5Small)
            .with_show_download_progress(false);
        // Una cache stabile evita di riscaricare ~470 MB a ogni avvio e rende
        // l'app utilizzabile offline dopo il primo download.
        if let Some(dir) = model_cache_dir() {
            options = options.with_cache_dir(dir);
        }
        TextEmbedding::try_new(options)
            .map(Mutex::new)
            .map_err(|err| err.to_string())
    });
    match slot {
        Ok(model) => Ok(model),
        Err(message) => Err(anyhow!(
            "modello di embedding non disponibile: {message}"
        )),
    }
}

fn normalize(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in &mut vector {
            *value /= norm;
        }
    }
    vector
}

fn embed_local(texts: Vec<String>, as_query: bool) -> Result<Vec<Vec<f32>>> {
    let model = local_model()?;
    let mut guard = model
        .lock()
        .map_err(|_| anyhow!("modello di embedding bloccato"))?;
    // I modelli E5 sono addestrati con questi prefissi: senza, la similarità
    // degrada in modo netto.
    let prefix = if as_query { "query: " } else { "passage: " };
    let prepared: Vec<String> = texts
        .into_iter()
        .map(|text| format!("{prefix}{text}"))
        .collect();
    let output = guard
        .embed(prepared, Some(16))
        .map_err(|err| anyhow!("embedding locale fallito: {err}"))?;
    Ok(output.into_iter().map(normalize).collect())
}

async fn embed_api(texts: Vec<String>, settings: &Settings) -> Result<Vec<Vec<f32>>> {
    if settings.api_key.trim().is_empty() {
        return Err(anyhow!("nessuna chiave API configurata per gli embedding"));
    }
    let url = format!(
        "{}/embeddings",
        settings.api_base_url.trim_end_matches('/')
    );
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(settings.api_key.trim())
        .json(&serde_json::json!({
            "model": settings.api_model,
            "input": texts,
            "dimensions": EMBEDDING_DIMS,
            "encoding_format": "float",
        }))
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "embedding API {status}: {}",
            body.chars().take(300).collect::<String>()
        ));
    }

    let body: serde_json::Value = response.json().await?;
    let mut rows: Vec<(usize, Vec<f32>)> = Vec::new();
    for entry in body
        .get("data")
        .and_then(|data| data.as_array())
        .into_iter()
        .flatten()
    {
        let index = entry.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let vector: Vec<f32> = entry
            .get("embedding")
            .and_then(|v| v.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_f64().map(|v| v as f32))
                    .collect()
            })
            .unwrap_or_default();
        if vector.len() != EMBEDDING_DIMS {
            return Err(anyhow!(
                "il modello API ha restituito {} dimensioni invece di {EMBEDDING_DIMS}; \
                 usa un modello con output a 384 dimensioni",
                vector.len()
            ));
        }
        rows.push((index, normalize(vector)));
    }
    if rows.len() != texts.len() {
        return Err(anyhow!("l'API ha restituito un numero di vettori diverso"));
    }
    rows.sort_by_key(|(index, _)| *index);
    Ok(rows.into_iter().map(|(_, vector)| vector).collect())
}

pub async fn embed_texts(
    texts: Vec<String>,
    settings: &Settings,
    as_query: bool,
) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    if settings.embedding_provider == "api" {
        return embed_api(texts, settings).await;
    }
    tokio::task::spawn_blocking(move || embed_local(texts, as_query))
        .await
        .map_err(|err| anyhow!("embedding interrotto: {err}"))?
}

pub fn to_blob(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

pub fn from_blob(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Prodotto scalare direttamente sul BLOB: evita di allocare un `Vec<f32>` per
/// ogni candidato durante il ranking, che è il percorso più caldo della ricerca.
pub fn dot_blob(a: &[f32], blob: &[u8]) -> f32 {
    if blob.len() != a.len() * 4 {
        return f32::NEG_INFINITY;
    }
    a.iter()
        .zip(blob.chunks_exact(4))
        .map(|(x, chunk)| x * f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .sum()
}

pub fn status(settings: &Settings) -> EmbeddingStatus {
    let api = settings.embedding_provider == "api";
    let model = if api {
        settings.api_model.clone()
    } else {
        "multilingual-e5-small".to_string()
    };
    if api {
        return EmbeddingStatus {
            provider: "api".into(),
            model,
            dims: EMBEDDING_DIMS,
            ready: !settings.api_key.trim().is_empty(),
            error: None,
        };
    }
    match local_model() {
        Ok(_) => EmbeddingStatus {
            provider: "local".into(),
            model,
            dims: EMBEDDING_DIMS,
            ready: true,
            error: None,
        },
        Err(err) => EmbeddingStatus {
            provider: "local".into(),
            model,
            dims: EMBEDDING_DIMS,
            ready: false,
            error: Some(err.to_string()),
        },
    }
}

/// Scarica/initializza il modello in background all'avvio, così la prima
/// ricerca non paga il costo di caricamento.
pub fn warm_up(settings: Settings) {
    if settings.embedding_provider == "api" {
        return;
    }
    std::thread::spawn(move || {
        let _ = local_model();
    });
}
