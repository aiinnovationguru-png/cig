//! Normalizzazione dei dataset ANAC/BDNCP in record uniformi.
//!
//! Il dataset mensile CIG contiene una riga per CIG/CPV: le righe dello stesso
//! CIG vengono raggruppate in un solo avviso, con il CPV prevalente per primo.

use std::collections::{BTreeMap, HashMap};

use anyhow::{Context, Result};
use chrono::NaiveDate;
use serde_json::{json, Value};

use crate::geo::{province_from_name, region_for_province};
use crate::ted::normalize::{slugify, NormalizedFlags, NormalizedLot, NormalizedNotice};

#[derive(Debug, Clone)]
pub struct AwardUpdate {
    pub cig: String,
    pub awarded_value: Option<f64>,
    pub discount_pct: Option<f64>,
    pub awarded_at: Option<String>,
    pub esito: Option<String>,
    pub offers: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Participant {
    pub cig: String,
    pub role: Option<String>,
    pub tax_code: Option<String>,
    pub name: Option<String>,
    pub subject_type: Option<String>,
}

fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn number(value: Option<&String>) -> Option<f64> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let normalized = raw.replace([' ', '\u{00a0}'], "");
    let candidate = if normalized.contains(',') && !normalized.contains('.') {
        normalized.replace(',', ".")
    } else {
        normalized.replace(',', "")
    };
    candidate.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn integer(value: Option<&String>) -> Option<i64> {
    number(value).map(|value| value.round() as i64)
}

fn flag(value: Option<&String>) -> bool {
    matches!(
        value.map(|value| value.trim().to_uppercase()).as_deref(),
        Some("1") | Some("SI") | Some("SÌ") | Some("TRUE") | Some("Y")
    )
}

fn date_only(value: Option<&String>) -> Option<String> {
    let raw = value?.trim();
    // `get` invece dello slice di byte: un CSV con un carattere multibyte nei
    // primi 10 byte faceva panico e buttava via l'intero mese.
    let head = raw.get(..10)?;
    NaiveDate::parse_from_str(head, "%Y-%m-%d")
        .ok()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn iso_date(value: Option<&String>) -> Option<String> {
    date_only(value).map(|date| format!("{date}T00:00:00Z"))
}

fn valid_cpv(code: &str) -> bool {
    let trimmed = code.trim();
    let main_len = trimmed
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if main_len != 8 {
        return false;
    }
    match &trimmed[8..] {
        "" => true,
        suffix => {
            suffix.len() == 2
                && suffix.starts_with('-')
                && suffix[1..].bytes().all(|byte| byte.is_ascii_digit())
        }
    }
}

fn contract_nature(value: Option<&String>) -> Option<String> {
    let raw = value?.to_uppercase();
    if raw.contains("LAVOR") {
        Some("works".into())
    } else if raw.contains("SERVIZ") {
        Some("services".into())
    } else if raw.contains("FORNIT") {
        Some("supplies".into())
    } else {
        None
    }
}

fn notice_kind(stato: Option<&String>, esito: Option<&String>) -> &'static str {
    let esito = esito.map(|value| value.to_uppercase()).unwrap_or_default();
    let stato = stato.map(|value| value.to_uppercase()).unwrap_or_default();
    if esito.contains("AGGIUDICATA") || stato.contains("AGGIUDICATA") {
        "award"
    } else {
        "call"
    }
}

fn buyer_key(tax_code: Option<&String>, name: &str) -> String {
    if let Some(code) = tax_code.map(|value| value.trim()).filter(|value| !value.is_empty()) {
        let normalized: String = code
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .collect::<String>()
            .to_uppercase();
        if !normalized.is_empty() {
            return format!("buyer-cf-{normalized}");
        }
    }
    format!("buyer-anac-{}", slugify(name))
}

fn row_map(headers: &csv::StringRecord, record: &csv::StringRecord) -> HashMap<String, String> {
    let mut map = HashMap::with_capacity(headers.len());
    for (index, header) in headers.iter().enumerate() {
        let key = header.trim_start_matches('\u{feff}').trim().to_lowercase();
        if let Some(value) = record.get(index) {
            map.insert(key, value.trim().to_string());
        }
    }
    map
}

fn get<'a>(row: &'a HashMap<String, String>, key: &str) -> Option<&'a String> {
    row.get(key).filter(|value| !value.is_empty())
}

/// Dati di un CIG ridotti a ciò che serve davvero: la prima riga (i campi
/// descrittivi sono identici per tutte le righe del CIG) e i suoi CPV. Tenere
/// una mappa completa per ogni riga del mese costava centinaia di MB inutili.
struct Group {
    first: HashMap<String, String>,
    cpv: Vec<(String, bool)>,
}

fn group_rows(text: &str) -> Result<BTreeMap<String, Group>> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b';')
        .flexible(true)
        .from_reader(text.as_bytes());
    let headers = reader
        .headers()
        .context("intestazioni CSV ANAC mancanti")?
        .clone();
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for record in reader.records() {
        let record = record.context("riga CSV ANAC non valida")?;
        let row = row_map(&headers, &record);
        let Some(cig) = get(&row, "cig").map(|value| value.to_uppercase()) else {
            continue;
        };
        if cig.is_empty() {
            continue;
        }

        let group = groups.entry(cig).or_insert_with(|| Group {
            first: row.clone(),
            cpv: Vec::new(),
        });
        if let Some(code) = get(&row, "cod_cpv") {
            let trimmed = code.trim();
            if valid_cpv(trimmed) && !group.cpv.iter().any(|(existing, _)| existing == trimmed) {
                let prevalent = get(&row, "flag_prevalente")
                    .map(|value| value.trim() == "1")
                    .unwrap_or(false);
                group.cpv.push((trimmed.to_string(), prevalent));
            }
        }
    }
    Ok(groups)
}

fn normalize_group(cig: &str, group: &Group) -> Option<NormalizedNotice> {
    let first = &group.first;
    let title = get(first, "oggetto_lotto")
        .or_else(|| get(first, "oggetto_gara"))
        .map(|value| clean(value))?;
    if title.is_empty() {
        return None;
    }
    let buyer_name = get(first, "denominazione_amministrazione_appaltante")
        .map(|value| clean(value))
        .filter(|value| !value.is_empty());
    let buyer_tax_code = get(first, "cf_amministrazione_appaltante");
    let province = get(first, "provincia")
        .and_then(|value| province_from_name(value))
        .map(str::to_string);
    let region = province
        .as_deref()
        .and_then(region_for_province)
        .map(str::to_string);

    let mut cpv_entries = group.cpv.clone();
    cpv_entries.sort_by_key(|(_, prevalent)| !*prevalent);
    let cpv_codes: Vec<String> = cpv_entries.into_iter().map(|(code, _)| code).collect();

    let estimated_value = number(get(first, "importo_lotto"))
        .or_else(|| number(get(first, "importo_complessivo_gara")));
    let lot_title = get(first, "oggetto_lotto")
        .map(|value| clean(value))
        .filter(|value| !value.is_empty());
    let lot_description = get(first, "oggetto_gara").map(|value| clean(value));
    let esito = get(first, "esito").map(|value| clean(value));
    let stato = get(first, "stato");
    let kind = notice_kind(stato, esito.as_ref());
    let esito_at = iso_date(get(first, "data_comunicazione_esito"));
    let pnrr_pnc = flag(get(first, "flag_pnrr_pnc"));
    let lot_count = integer(get(first, "n_lotti_componenti"));

    let mut description_parts: Vec<String> = Vec::new();
    if let Some(gara) = get(first, "oggetto_gara").map(|value| clean(value)) {
        if gara != title {
            description_parts.push(gara);
        }
    }
    if let Some(cpv_description) = get(first, "descrizione_cpv").map(|value| clean(value)) {
        description_parts.push(format!("CPV: {cpv_description}"));
    }
    if let Some(settore) = get(first, "settore").map(|value| clean(value)) {
        description_parts.push(format!("Settore: {settore}"));
    }
    let description = if description_parts.is_empty() {
        None
    } else {
        Some(description_parts.join(" · "))
    };

    let published_on = date_only(get(first, "data_pubblicazione"));
    let deadline_at = iso_date(get(first, "data_scadenza_offerta"));
    let year = get(first, "anno_pubblicazione")
        .map(|value| value.as_str())
        .unwrap_or("");
    let month = get(first, "mese_pubblicazione")
        .map(|value| value.as_str())
        .unwrap_or("");

    let lot = NormalizedLot {
        lot_number: 1,
        title: lot_title,
        description: lot_description,
        estimated_value,
        awarded_value: None,
        cpv_codes: cpv_codes.clone(),
        status: esito.clone(),
    };

    Some(NormalizedNotice {
        id: format!("anac-{cig}"),
        source: "anac".into(),
        notice_type: "anac-cig".into(),
        kind: kind.into(),
        title,
        description,
        buyer_id: buyer_name
            .as_deref()
            .map(|name| buyer_key(buyer_tax_code, name)),
        buyer_name,
        buyer_city: None,
        cpv_codes,
        contract_nature: contract_nature(get(first, "oggetto_principale_contratto")),
        procedure_type: get(first, "tipo_scelta_contraente").map(|value| clean(value)),
        estimated_value,
        awarded_value: None,
        currency: "EUR".into(),
        published_at: published_on
            .as_ref()
            .map(|date| format!("{date}T00:00:00Z")),
        published_on,
        deadline_at,
        place_city: None,
        province,
        region,
        url: Some(format!("https://www.anticorruzione.it/-/cig-{cig}")),
        discount_pct: None,
        awards: Vec::new(),
        lots: vec![lot],
        flags: Some(NormalizedFlags {
            cig: Some(cig.to_string()),
            cup: None,
            pnrr: pnrr_pnc,
            pnrr_pnc,
            esito,
            esito_at,
            cig_accordo_quadro: get(first, "cig_accordo_quadro").map(|value| clean(value)),
            lot_count,
            source_dataset: Some(format!("cig-{year}-{month}")),
        }),
    })
}

pub fn parse_cig_csv(bytes: &[u8]) -> Result<Vec<NormalizedNotice>> {
    // UTF-8 valido è il caso normale: si legge il buffer senza copiarlo in una
    // nuova String (per un mese ANAC sono centinaia di MB in meno in RAM).
    match std::str::from_utf8(bytes) {
        Ok(text) => normalize_groups(text.trim_start_matches('\u{feff}')),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            normalize_groups(decoded.trim_start_matches('\u{feff}'))
        }
    }
}

fn normalize_groups(text: &str) -> Result<Vec<NormalizedNotice>> {
    let groups = group_rows(text)?;
    Ok(groups
        .iter()
        .filter_map(|(cig, group)| normalize_group(cig, group))
        .collect())
}

/// Il record grezzo conserva i campi ANAC più utili, senza duplicare il CSV.
pub fn raw_json(notice: &NormalizedNotice) -> Value {
    json!({
        "source": "anac",
        "cig": notice.flags.as_ref().and_then(|flags| flags.cig.clone()),
        "esito": notice.flags.as_ref().and_then(|flags| flags.esito.clone()),
        "publishedOn": notice.published_on,
        "deadlineAt": notice.deadline_at,
        "cpv": notice.cpv_codes,
    })
}

pub fn parse_awards_csv(bytes: &[u8]) -> Result<Vec<AwardUpdate>> {
    let text = crate::anac::client::decode_text(bytes);
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b';')
        .flexible(true)
        .from_reader(text.as_bytes());
    let headers = reader.headers()?.clone();
    let mut updates = Vec::new();
    for record in reader.records() {
        let record = record?;
        let row = row_map(&headers, &record);
        let Some(cig) = get(&row, "cig").map(|value| value.to_uppercase()) else {
            continue;
        };
        let discount = number(get(&row, "ribasso_aggiudicazione"))
            .filter(|value| (-100.0..=100.0).contains(value));
        updates.push(AwardUpdate {
            cig,
            awarded_value: number(get(&row, "importo_aggiudicazione")),
            discount_pct: discount,
            awarded_at: iso_date(get(&row, "data_aggiudicazione_definitiva"))
                .or_else(|| iso_date(get(&row, "data_comunicazione_esito"))),
            esito: get(&row, "esito").map(|value| clean(value)),
            offers: integer(get(&row, "numero_offerte_ammesse")),
        });
    }
    Ok(updates)
}

pub fn parse_participants_csv(bytes: &[u8]) -> Result<HashMap<String, Vec<Participant>>> {
    let text = crate::anac::client::decode_text(bytes);
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b';')
        .flexible(true)
        .from_reader(text.as_bytes());
    let headers = reader.headers()?.clone();
    let mut map: HashMap<String, Vec<Participant>> = HashMap::new();
    for record in reader.records() {
        let record = record?;
        let row = row_map(&headers, &record);
        let Some(cig) = get(&row, "cig").map(|value| value.to_uppercase()) else {
            continue;
        };
        let participant = Participant {
            cig: cig.clone(),
            role: get(&row, "ruolo").map(|value| clean(value)),
            tax_code: get(&row, "codice_fiscale").map(|value| clean(value)),
            name: get(&row, "denominazione").map(|value| clean(value)),
            subject_type: get(&row, "tipo_soggetto").map(|value| clean(value)),
        };
        map.entry(cig).or_default().push(participant);
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CIG_CSV: &str = "\"cig\";\"cig_accordo_quadro\";\"numero_gara\";\"oggetto_gara\";\"importo_complessivo_gara\";\"n_lotti_componenti\";\"oggetto_lotto\";\"importo_lotto\";\"oggetto_principale_contratto\";\"stato\";\"settore\";\"luogo_istat\";\"provincia\";\"data_pubblicazione\";\"data_scadenza_offerta\";\"tipo_scelta_contraente\";\"cf_amministrazione_appaltante\";\"denominazione_amministrazione_appaltante\";\"cod_cpv\";\"flag_prevalente\";\"ESITO\";\"DATA_COMUNICAZIONE_ESITO\";\"FLAG_PNRR_PNC\"\n\
\"B239EC0976\";\"\";\"SUA24124\";\"LAVORI DI RIQUALIFICAZIONE\";\"542022.99\";\"1\";\"LOTTO A1\";\"542022.99\";\"LAVORI\";\"ATTIVO\";\"SETTORI ORDINARI\";\"108054\";\"MONZA E DELLA BRIANZA\";\"2024-06-25\";\"2024-07-12\";\"PROCEDURA NEGOZIATA\";\"83000890158\";\"COMUNE DI LENTATE SUL SEVESO\";\"45454000-4\";\"0\";\"AGGIUDICATA\";\"2025-04-07\";\"1\"\n\
\"B239EC0976\";\"\";\"SUA24124\";\"LAVORI DI RIQUALIFICAZIONE\";\"542022.99\";\"1\";\"LOTTO A1\";\"542022.99\";\"LAVORI\";\"ATTIVO\";\"SETTORI ORDINARI\";\"108054\";\"MONZA E DELLA BRIANZA\";\"2024-06-25\";\"2024-07-12\";\"PROCEDURA NEGOZIATA\";\"83000890158\";\"COMUNE DI LENTATE SUL SEVESO\";\"45454000-4\";\"0\";\"AGGIUDICATA\";\"2025-04-07\";\"1\"\n\
\"B239EC0976\";\"\";\"SUA24124\";\"LAVORI DI RIQUALIFICAZIONE\";\"542022.99\";\"1\";\"LOTTO A1\";\"542022.99\";\"LAVORI\";\"ATTIVO\";\"SETTORI ORDINARI\";\"108054\";\"MONZA E DELLA BRIANZA\";\"2024-06-25\";\"2024-07-12\";\"PROCEDURA NEGOZIATA\";\"83000890158\";\"COMUNE DI LENTATE SUL SEVESO\";\"45454100-5\";\"1\";\"AGGIUDICATA\";\"2025-04-07\";\"1\"\n";

    #[test]
    fn groups_cig_rows_and_puts_prevalent_cpv_first() {
        let notices = parse_cig_csv(CIG_CSV.as_bytes()).unwrap();
        assert_eq!(notices.len(), 1);
        let notice = &notices[0];
        assert_eq!(notice.id, "anac-B239EC0976");
        assert_eq!(notice.source, "anac");
        assert_eq!(notice.kind, "award");
        assert_eq!(notice.cpv_codes, vec!["45454100-5", "45454000-4"]);
        assert_eq!(notice.province.as_deref(), Some("MB"));
        assert_eq!(notice.region.as_deref(), Some("Lombardia"));
        assert_eq!(notice.estimated_value, Some(542022.99));
        assert_eq!(notice.lots.len(), 1);
        let flags = notice.flags.as_ref().unwrap();
        assert!(flags.pnrr);
        assert_eq!(flags.cig.as_deref(), Some("B239EC0976"));
        assert_eq!(flags.esito.as_deref(), Some("AGGIUDICATA"));
    }

    #[test]
    fn sanitizes_award_discount_outliers() {
        let csv = "\"cig\";\"data_aggiudicazione_definitiva\";\"esito\";\"importo_aggiudicazione\";\"ribasso_aggiudicazione\";\"numero_offerte_ammesse\"\n\
                   \"A1\";\"2026-01-02\";\"AGGIUDICATA\";\"10000.0\";\"-103000000\";\"3\"\n\
                   \"A2\";\"2026-01-03\";\"AGGIUDICATA\";\"9000.0\";\"12,5\";\"1\"\n";
        let updates = parse_awards_csv(csv.as_bytes()).unwrap();
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].discount_pct, None);
        assert_eq!(updates[1].discount_pct, Some(12.5));
        assert_eq!(updates[1].awarded_at.as_deref(), Some("2026-01-03T00:00:00Z"));
    }

    #[test]
    fn participants_are_grouped_by_cig() {
        let csv = "\"cig\";\"ruolo\";\"codice_fiscale\";\"denominazione\";\"tipo_soggetto\"\n\
                   \"A1\";\"\";\"01427710304\";\"LIMACORPORATE S.P.A.\";\"IMPRESA\"\n";
        let map = parse_participants_csv(csv.as_bytes()).unwrap();
        assert_eq!(map.get("A1").unwrap()[0].name.as_deref(), Some("LIMACORPORATE S.P.A."));
    }

    /// Una data con un carattere multibyte nei primi dieci byte faceva panico
    /// (slice di byte) e buttava via l'intero mese ANAC.
    #[test]
    fn malformed_multibyte_date_does_not_panic() {
        let csv = "\"cig\";\"data_aggiudicazione_definitiva\";\"esito\"\n\
                   \"A1\";\"2026-01-0à\";\"AGGIUDICATA\"\n";
        let updates = parse_awards_csv(csv.as_bytes()).unwrap();
        assert_eq!(updates.len(), 1);
        assert!(updates[0].awarded_at.is_none());
    }
}
