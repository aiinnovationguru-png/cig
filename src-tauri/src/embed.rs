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

// Fallimenti temporanei di rete o disco non devono avvelenare l'intera sessione.
// L'inizializzazione riuscita viene memorizzata, quella fallita può essere riprovata.
fn get_or_try_init<'a, T>(slot: &'a OnceLock<T>, lock: &Mutex<()>, init: impl FnOnce() -> Result<T>) -> Result<&'a T> {
    if let Some(value) = slot.get() { return Ok(value); }
    let _guard = lock.lock().map_err(|_| anyhow!("inizializzazione del modello bloccata"))?;
    if let Some(value) = slot.get() { return Ok(value); }
    let value = init()?;
    slot.set(value).map_err(|_| anyhow!("inizializzazione concorrente del modello"))?;
    slot.get().ok_or_else(|| anyhow!("modello non inizializzato"))
}

fn local_model() -> Result<&'static Mutex<TextEmbedding>> {
    static MODEL: OnceLock<Mutex<TextEmbedding>> = OnceLock::new();
    static INIT_LOCK: Mutex<()> = Mutex::new(());
    get_or_try_init(&MODEL, &INIT_LOCK, || {
        let mut options = InitOptions::new(EmbeddingModel::MultilingualE5Small)
            .with_show_download_progress(false);
        if let Some(dir) = model_cache_dir() { options = options.with_cache_dir(dir); }
        TextEmbedding::try_new(options).map(Mutex::new)
            .map_err(|err| anyhow!("modello di embedding non disponibile: {err}"))
    })
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
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()?
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
    parse_api_embeddings(&body, texts.len())
}

/// Una risposta incompleta, riordinata male o con valori non validi non deve
/// associare il vettore di un avviso a un altro avviso.
fn parse_api_embeddings(body: &serde_json::Value, expected: usize) -> Result<Vec<Vec<f32>>> {
    let entries = body.get("data").and_then(|data| data.as_array())
        .ok_or_else(|| anyhow!("risposta API embedding priva di dati"))?;
    if entries.len() != expected { return Err(anyhow!("l'API ha restituito un numero di vettori diverso")); }
    let mut rows: Vec<Option<Vec<f32>>> = vec![None; expected];
    for entry in entries {
        let index = entry.get("index").and_then(|v| v.as_u64())
            .and_then(|v| usize::try_from(v).ok())
            .filter(|index| *index < expected)
            .ok_or_else(|| anyhow!("indice embedding API mancante o fuori intervallo"))?;
        if rows[index].is_some() { return Err(anyhow!("indice embedding API duplicato")); }
        let values = entry.get("embedding").and_then(|v| v.as_array())
            .ok_or_else(|| anyhow!("vettore embedding API mancante"))?;
        if values.len() != EMBEDDING_DIMS {
            return Err(anyhow!("il modello API ha restituito {} dimensioni invece di {EMBEDDING_DIMS}", values.len()));
        }
        let mut vector = Vec::with_capacity(EMBEDDING_DIMS);
        for value in values {
            let number = value.as_f64().ok_or_else(|| anyhow!("valore embedding API non numerico"))? as f32;
            if !number.is_finite() { return Err(anyhow!("valore embedding API non finito")); }
            vector.push(number);
        }
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        if !norm.is_finite() || norm <= f32::EPSILON { return Err(anyhow!("vettore embedding API nullo o non valido")); }
        rows[index] = Some(normalize(vector));
    }
    rows.into_iter().map(|row| row.ok_or_else(|| anyhow!("indice embedding API mancante"))).collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn failed_initialization_can_be_retried() {
        let slot = OnceLock::new();
        let lock = Mutex::new(());
        let attempts = AtomicUsize::new(0);
        let first = get_or_try_init(&slot, &lock, || -> Result<u32> {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(anyhow!("offline"))
        });
        assert!(first.is_err());
        assert_eq!(*get_or_try_init(&slot, &lock, || { attempts.fetch_add(1, Ordering::SeqCst); Ok(42) }).unwrap(), 42);
        assert_eq!(*get_or_try_init(&slot, &lock, || { attempts.fetch_add(1, Ordering::SeqCst); Ok(99) }).unwrap(), 42);
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn api_results_reorder_by_index_and_reject_duplicates_or_invalid_vectors() {
        let mut a = vec![0.0; EMBEDDING_DIMS]; a[0] = 2.0;
        let mut b = vec![0.0; EMBEDDING_DIMS]; b[1] = 3.0;
        let valid = json!({"data":[{"index":1,"embedding":b},{"index":0,"embedding":a}]});
        let vectors = parse_api_embeddings(&valid, 2).unwrap();
        assert_eq!(vectors[0][0], 1.0); assert_eq!(vectors[1][1], 1.0);
        let duplicate = json!({"data":[{"index":0,"embedding":vec![1.0; EMBEDDING_DIMS]},{"index":0,"embedding":vec![1.0; EMBEDDING_DIMS]}]});
        assert!(parse_api_embeddings(&duplicate, 2).is_err());
        assert!(parse_api_embeddings(&json!({"data":[{"index":1,"embedding":vec![1.0; EMBEDDING_DIMS]}]}), 1).is_err());
        assert!(parse_api_embeddings(&json!({"data":[{"index":0,"embedding":vec![0.0; EMBEDDING_DIMS]}]}), 1).is_err());
    }
}
