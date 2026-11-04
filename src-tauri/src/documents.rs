//! Documenti di gara e analisi del disciplinare, interamente offline.
//!
//! L'utente carica il PDF (o il testo) del disciplinare sulla scheda della gara.
//! Il testo viene conservato pagina per pagina e analizzato con regole
//! deterministiche — nessun modello generativo — così ogni risultato cita la
//! pagina da cui proviene e resta verificabile.
//!
//! L'analisi non decide nulla per l'utente: segnala criteri, requisiti,
//! garanzie, termini e clausole che vale la pena leggere, con la frase esatta.

use std::path::Path;
use std::sync::LazyLock;

use anyhow::{anyhow, Context, Result};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::now_iso;

/// Cambiare le regole di estrazione richiede di ricalcolare le analisi salvate.
pub const ANALYZER_VERSION: i64 = 1;

const MAX_DOCUMENT_BYTES: u64 = 60 * 1024 * 1024;
const MAX_ITEMS_PER_SECTION: usize = 6;
const MIN_SENTENCE_CHARS: usize = 40;
/// Le intestazioni sono più corte: senza questa soglia finirebbero tra le
/// citazioni come se fossero clausole.
const MIN_ITEM_CHARS: usize = 60;
const MAX_QUOTE_CHARS: usize = 320;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub id: String,
    pub notice_id: String,
    pub filename: String,
    pub pages: i64,
    pub chars: i64,
    pub added_at: String,
    pub analyzed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisItem {
    /// Segnali riconosciuti nella frase (es. «offerta tecnica · punteggio»).
    pub label: String,
    /// Dato utile estratto dalla frase: punti, percentuale, data, importo.
    pub note: Option<String>,
    pub page: i64,
    pub quote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSection {
    pub id: String,
    pub label: String,
    pub hint: String,
    pub summary: String,
    pub found: bool,
    pub items: Vec<AnalysisItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAnalysis {
    pub filename: String,
    pub pages: i64,
    pub analyzer_version: i64,
    pub generated_at: String,
    pub sections: Vec<AnalysisSection>,
    pub warnings: Vec<String>,
}

struct Sentence {
    page: i64,
    text: String,
}

struct Keyword {
    needle: &'static str,
    core: bool,
}

struct SectionSpec {
    id: &'static str,
    label: &'static str,
    hint: &'static str,
    keywords: &'static [Keyword],
}

const fn kw(needle: &'static str, core: bool) -> Keyword {
    Keyword { needle, core }
}

static SECTIONS: &[SectionSpec] = &[
    SectionSpec {
        id: "criteri",
        label: "Criteri di aggiudicazione",
        hint: "Come vengono assegnati i punti: offerta tecnica, offerta economica, qualità.",
        keywords: &[
            kw("offerta economicamente più vantaggiosa", true),
            kw("criterio di aggiudicazione", true),
            kw("criteri di aggiudicazione", true),
            kw("offerta tecnica", true),
            kw("offerta economica", true),
            kw("prezzo più basso", true),
            kw("minor prezzo", true),
            kw("punteggio", true),
            kw("punti", false),
            kw("qualità", false),
            kw("ribasso", false),
        ],
    },
    SectionSpec {
        id: "solvibilita",
        label: "Requisiti di partecipazione",
        hint: "Solidità economica, capacità tecnica, attestazioni e categorie.",
        keywords: &[
            kw("requisiti di partecipazione", true),
            kw("requisiti di capacità", true),
            kw("capacità economica e finanziaria", true),
            kw("capacità tecnica e professionale", true),
            kw("fatturato", true),
            kw("attestazione soa", true),
            kw("idoneità professionale", true),
            kw("referenze", true),
            kw("classifica", false),
            kw("categorie", false),
        ],
    },
    SectionSpec {
        id: "garanzie",
        label: "Garanzie e coperture",
        hint: "Cauzioni, fideiussioni e polizze da presentare o stipulare.",
        keywords: &[
            kw("garanzia provvisoria", true),
            kw("garanzia definitiva", true),
            kw("cauzione", true),
            kw("fideiussione", true),
            kw("polizza", true),
            kw("assicurativa", false),
        ],
    },
    SectionSpec {
        id: "scadenze",
        label: "Termini e scadenze",
        hint: "Date entro cui presentare offerta, documenti o richieste di chiarimento.",
        keywords: &[
            kw("termine di presentazione", true),
            kw("presentazione delle offerte", true),
            kw("termine ultimo", true),
            kw("scadenza", true),
            kw("entro il", true),
            kw("non oltre il", true),
            kw("chiarimenti", false),
            kw("sopralluogo", false),
        ],
    },
    SectionSpec {
        id: "rischi",
        label: "Clausole da leggere",
        hint: "Penali, recesso, subappalto, revisione prezzi: dove nascono i costi.",
        keywords: &[
            kw("penale", true),
            kw("penali", true),
            kw("recesso", true),
            kw("risoluzione del contratto", true),
            kw("subappalto", true),
            kw("clausola sociale", true),
            kw("revisione dei prezzi", true),
            kw("revisione prezzi", true),
            kw("sospensione", false),
            kw("contestazione", false),
            kw("responsabilità", false),
            kw("riservatezza", false),
        ],
    },
];

static DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b").expect("regex data valida")
});

static POINTS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:punti|punto|pt)\b").expect("regex punti valida")
});

static MAX_POINTS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:max|massimo|fino a|totale)\s*(?:di\s*)?(\d{1,3})\s*(?:punti|punto)")
        .expect("regex punteggio massimo valida")
});

static PERCENT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d{1,3}(?:[.,]\d{1,2})?)\s*%").expect("regex percentuale valida"));

static AMOUNT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"€\s*([\d.]{3,}(?:,\d{2})?)|([\d.]{4,}(?:,\d{2})?)\s*€")
        .expect("regex importo valida")
});

// ---------------------------------------------------------------------------
// Archivio dei documenti

pub fn list(conn: &Connection, notice_id: &str) -> Result<Vec<DocumentSummary>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.notice_id, d.filename, d.pages, d.chars, d.added_at,
                EXISTS (SELECT 1 FROM document_analysis a WHERE a.document_id = d.id) AS analyzed
         FROM notice_documents d
         WHERE d.notice_id = ?
         ORDER BY d.added_at DESC, d.filename",
    )?;
    let rows = stmt.query_map([notice_id], summary_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentSummary> {
    Ok(DocumentSummary {
        id: row.get(0)?,
        notice_id: row.get(1)?,
        filename: row.get(2)?,
        pages: row.get(3)?,
        chars: row.get(4)?,
        added_at: row.get(5)?,
        analyzed: row.get::<_, i64>(6)? != 0,
    })
}

/// Salva un documento letto dal disco. Ripetere lo stesso file sulla stessa gara
/// non crea doppioni: il contenuto viene riconosciuto da un'impronta.
pub fn add_from_path(conn: &Connection, notice_id: &str, path: &str) -> Result<DocumentSummary> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM notices WHERE id = ?", [notice_id], |_| Ok(()))
        .optional()?
        .is_some();
    if !exists {
        return Err(anyhow!("gara non trovata: {notice_id}"));
    }

    let path = Path::new(path);
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("nome del file non valido"))?
        .to_string();

    let metadata = std::fs::metadata(path)
        .with_context(|| format!("file non leggibile: {}", path.display()))?;
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(anyhow!(
            "il file supera {} MB: carica il disciplinare o il capitolato, non l'intero archivio di gara",
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    if metadata.len() == 0 {
        return Err(anyhow!("il file è vuoto"));
    }

    let raw = std::fs::read(path)
        .with_context(|| format!("lettura non riuscita: {}", path.display()))?;
    let pages = extract_pages(path, &raw)?;
    let chars: i64 = pages.iter().map(|page| page.chars().count() as i64).sum();
    let hash = fingerprint(&raw);
    let id = format!("{notice_id}#{hash}");

    conn.execute(
        "INSERT INTO notice_documents (id, notice_id, filename, hash, pages, chars, page_texts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(notice_id, hash) DO UPDATE SET filename = excluded.filename",
        params![
            id,
            notice_id,
            filename,
            hash,
            pages.len() as i64,
            chars,
            serde_json::to_string(&pages)?
        ],
    )?;

    let summary = conn.query_row(
        "SELECT d.id, d.notice_id, d.filename, d.pages, d.chars, d.added_at,
                EXISTS (SELECT 1 FROM document_analysis a WHERE a.document_id = d.id)
         FROM notice_documents d WHERE d.notice_id = ? AND d.hash = ?",
        params![notice_id, hash],
        summary_from_row,
    )?;
    Ok(summary)
}

pub fn remove(conn: &Connection, document_id: &str) -> Result<()> {
    conn.execute("DELETE FROM notice_documents WHERE id = ?", [document_id])?;
    Ok(())
}

/// Testo del documento, pagina per pagina. Usato dai test e dalle verifiche.
pub fn pages_of(conn: &Connection, document_id: &str) -> Result<Vec<String>> {
    let raw: String = conn
        .query_row(
            "SELECT page_texts FROM notice_documents WHERE id = ?",
            [document_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("documento non trovato"))?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

/// Analisi del documento, dalla cache quando possibile.
pub fn analyze(conn: &Connection, document_id: &str, refresh: bool) -> Result<DocumentAnalysis> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT filename, page_texts FROM notice_documents WHERE id = ?",
            [document_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (filename, page_texts) = row.ok_or_else(|| anyhow!("documento non trovato"))?;

    if !refresh {
        let cached: Option<String> = conn
            .query_row(
                "SELECT payload FROM document_analysis WHERE document_id = ? AND version = ?",
                params![document_id, ANALYZER_VERSION],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(payload) = cached {
            if let Ok(analysis) = serde_json::from_str::<DocumentAnalysis>(&payload) {
                return Ok(analysis);
            }
        }
    }

    let pages: Vec<String> = serde_json::from_str(&page_texts).unwrap_or_default();
    let analysis = analyze_pages(&filename, &pages);
    conn.execute(
        "INSERT INTO document_analysis (document_id, version, payload, created_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(document_id) DO UPDATE SET version = excluded.version,
             payload = excluded.payload, created_at = excluded.created_at",
        params![
            document_id,
            ANALYZER_VERSION,
            serde_json::to_string(&analysis)?
        ],
    )?;
    Ok(analysis)
}

// ---------------------------------------------------------------------------
// Estrazione del testo

fn extract_pages(path: &Path, raw: &[u8]) -> Result<Vec<String>> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if extension == "pdf" {
        return extract_pdf_pages(path, raw);
    }

    let text = String::from_utf8_lossy(raw).into_owned();
    let text = text.trim();
    if text.is_empty() {
        return Err(anyhow!("il file non contiene testo"));
    }
    Ok(vec![text.to_string()])
}

fn extract_pdf_pages(path: &Path, raw: &[u8]) -> Result<Vec<String>> {
    // L'estrazione per pagina è quella che serve alle citazioni; se il PDF non
    // collabora si prova il testo intero e lo si tratta come pagina unica.
    let by_page = pdf_extract::extract_text_from_mem_by_pages(raw)
        .ok()
        .map(|pages| {
            pages
                .into_iter()
                .map(|page| clean_page(&page))
                .collect::<Vec<_>>()
        })
        .filter(|pages| pages.iter().any(|page| !page.is_empty()));

    let pages = match by_page {
        Some(pages) => pages,
        None => {
            let whole = pdf_extract::extract_text(path).unwrap_or_default();
            let whole = clean_page(&whole);
            if whole.is_empty() {
                return Err(anyhow!(
                    "nessun testo estraibile dal PDF: se è un documento scansionato serve l'OCR, non supportato in questa versione"
                ));
            }
            vec![whole]
        }
    };

    Ok(pages)
}

fn clean_page(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = false;
    for line in text.replace('\r', "\n").lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            if !blank && !out.is_empty() {
                out.push('\n');
                blank = true;
            }
            continue;
        }
        blank = false;
        out.push_str(&line);
        out.push('\n');
    }
    out.trim().to_string()
}

fn fingerprint(bytes: &[u8]) -> String {
    // FNV-1a: sufficiente a riconoscere lo stesso file ricaricato, senza
    // aggiungere dipendenze.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

// ---------------------------------------------------------------------------
// Analisi deterministica

pub fn analyze_pages(filename: &str, pages: &[String]) -> DocumentAnalysis {
    let sentences = collect_sentences(pages);
    let total_chars: usize = pages.iter().map(|page| page.chars().count()).sum();

    let mut warnings = Vec::new();
    if total_chars == 0 {
        warnings.push(
            "Il documento non contiene testo estraibile: i PDF scansionati richiedono OCR, non supportato in questa versione."
                .to_string(),
        );
    } else if total_chars < 400 {
        warnings.push(
            "Il testo estratto è molto breve: potrebbe essere solo la copertina o un allegato parziale."
                .to_string(),
        );
    }

    let sections = SECTIONS
        .iter()
        .map(|spec| build_section(spec, &sentences))
        .collect();

    DocumentAnalysis {
        filename: filename.to_string(),
        pages: pages.len() as i64,
        analyzer_version: ANALYZER_VERSION,
        generated_at: now_iso(),
        sections,
        warnings,
    }
}

fn collect_sentences(pages: &[String]) -> Vec<Sentence> {
    let mut out = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        for line in reflow(page).lines() {
            for sentence in split_sentences(line) {
                out.push(Sentence {
                    page: index as i64 + 1,
                    text: sentence,
                });
            }
        }
    }
    out
}

/// I PDF vanno a capo dove finisce la riga, non dove finisce la frase: senza
/// ricomposizione le citazioni sarebbero frammenti di mezza riga.
fn reflow(page: &str) -> String {
    let mut out = String::new();
    let mut closed = true;
    for line in page.lines() {
        let line = line.trim();
        if line.is_empty() {
            closed = true;
            continue;
        }
        // Una riga che continua la precedente inizia con minuscola, con una
        // cifra o con un simbolo: «…minimo di» / «500.000 €». Se invece inizia
        // con maiuscola dopo una riga senza punto, è una nuova voce (intestazione
        // o elenco) e va tenuta separata.
        let continues = line
            .chars()
            .next()
            .map(|value| value.is_lowercase() || value.is_ascii_digit() || "€(«\"'-".contains(value))
            .unwrap_or(false);
        if out.is_empty() {
            out.push_str(line);
        } else if !closed && continues {
            out.push(' ');
            out.push_str(line);
        } else {
            out.push('\n');
            out.push_str(line);
        }
        closed = line
            .chars()
            .last()
            .map(|value| matches!(value, '.' | ';' | ':' | '!' | '?'))
            .unwrap_or(false);
    }
    out
}

fn split_sentences(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for word in line.split(' ').filter(|word| !word.is_empty()) {
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
        let closed = word.ends_with('.') || word.ends_with(';') || word.ends_with(':');
        if closed && current.chars().count() >= MIN_SENTENCE_CHARS {
            out.push(current.clone());
            current.clear();
        } else if current.chars().count() > 600 {
            out.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn build_section(spec: &SectionSpec, sentences: &[Sentence]) -> AnalysisSection {
    let mut hits: Vec<(usize, AnalysisItem)> = Vec::new();

    for sentence in sentences {
        let text = sentence.text.to_lowercase();
        let mut matched: Vec<&str> = Vec::new();
        let mut core = false;
        for keyword in spec.keywords {
            if text.contains(keyword.needle) {
                core |= keyword.core;
                if !matched.contains(&keyword.needle) {
                    matched.push(keyword.needle);
                }
            }
        }
        if !core || sentence.text.chars().count() < MIN_ITEM_CHARS {
            continue;
        }

        let note = note_for(spec.id, &sentence.text);
        let mut label = matched
            .iter()
            .take(3)
            .map(|value| (*value).to_string())
            .collect::<Vec<_>>()
            .join(" · ");
        if label.is_empty() {
            label = "riferimento nel testo".to_string();
        }

        hits.push((
            matched.len(),
            AnalysisItem {
                label,
                note,
                page: sentence.page,
                quote: truncate(&sentence.text, MAX_QUOTE_CHARS),
            },
        ));
    }

    hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.page.cmp(&b.1.page)));
    hits.dedup_by(|a, b| a.1.quote == b.1.quote);
    let total = hits.len();
    let items: Vec<AnalysisItem> = hits
        .into_iter()
        .take(MAX_ITEMS_PER_SECTION)
        .map(|(_, item)| item)
        .collect();

    let summary = section_summary(spec.id, &items, total, sentences);

    AnalysisSection {
        id: spec.id.to_string(),
        label: spec.label.to_string(),
        hint: spec.hint.to_string(),
        summary,
        found: !items.is_empty(),
        items,
    }
}

fn section_summary(id: &str, items: &[AnalysisItem], total: usize, sentences: &[Sentence]) -> String {
    if items.is_empty() {
        return "Nessun riferimento trovato nel testo caricato.".to_string();
    }

    match id {
        "criteri" => {
            let joined = sentences
                .iter()
                .map(|sentence| sentence.text.to_lowercase())
                .collect::<Vec<_>>()
                .join(" ");
            let procedure = if joined.contains("offerta economicamente più vantaggiosa") {
                Some("offerta economicamente più vantaggiosa")
            } else if joined.contains("prezzo più basso") || joined.contains("minor prezzo") {
                Some("minor prezzo")
            } else {
                None
            };
            let max_points = MAX_POINTS_RE
                .captures_iter(&joined)
                .filter_map(|capture| capture.get(1))
                .filter_map(|value| value.as_str().parse::<f64>().ok())
                .fold(None, |best: Option<f64>, value| {
                    Some(best.map_or(value, |current| current.max(value)))
                });
            let mut parts = Vec::new();
            if let Some(procedure) = procedure {
                parts.push(format!("Criterio: {procedure}"));
            }
            if let Some(points) = max_points {
                parts.push(format!("punteggio massimo {}", trim_number(points)));
            }
            parts.push(format!(
                "{total} {} con criteri o punteggi",
                if total == 1 { "frase" } else { "frasi" }
            ));
            parts.join(" · ")
        }
        "solvibilita" => format!(
            "{total} {} su requisiti e attestazioni",
            if total == 1 { "frase" } else { "frasi" }
        ),
        "garanzie" => format!(
            "{total} {} a cauzioni o polizze",
            if total == 1 { "riferimento" } else { "riferimenti" }
        ),
        "scadenze" => {
            let with_date = items.iter().filter(|item| item.note.is_some()).count();
            if with_date > 0 {
                format!("{with_date} {} con data esplicita", if with_date == 1 { "termine" } else { "termini" })
            } else {
                format!("{total} {} a termini di presentazione", if total == 1 { "riferimento" } else { "riferimenti" })
            }
        }
        "rischi" => format!(
            "{total} {} da verificare prima di presentare l'offerta",
            if total == 1 { "clausola" } else { "clausole" }
        ),
        _ => format!("{total} riferimenti trovati"),
    }
}

fn note_for(section: &str, sentence: &str) -> Option<String> {
    match section {
        "criteri" => {
            if let Some(capture) = MAX_POINTS_RE.captures(sentence) {
                return Some(format!("massimo {} punti", &capture[1]));
            }
            if let Some(capture) = POINTS_RE.captures(sentence) {
                return Some(format!("{} punti", &capture[1]));
            }
            None
        }
        "garanzie" => PERCENT_RE
            .captures(sentence)
            .map(|capture| format!("{}%", &capture[1])),
        "scadenze" => DATE_RE
            .find(sentence)
            .map(|found| format!("data {}", found.as_str())),
        "solvibilita" => AMOUNT_RE.captures(sentence).map(|capture| {
            let value = capture
                .get(1)
                .or_else(|| capture.get(2))
                .map(|found| found.as_str())
                .unwrap_or_default();
            format!("importo {value} €")
        }),
        _ => None,
    }
}

fn trim_number(value: f64) -> String {
    if (value.fract()).abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

fn truncate(value: &str, limit: usize) -> String {
    let mut out: String = value.chars().take(limit).collect();
    if value.chars().count() > limit {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    const DISCIPLINARE: &str = "\
CAPITOLO 1 — OGGETTO
L'appalto ha per oggetto il servizio di manutenzione del verde pubblico.
CAPITOLO 8 — CRITERI DI AGGIUDICAZIONE
L'appalto è aggiudicato con il criterio dell'offerta economicamente più vantaggiosa, con un punteggio massimo di 100 punti.
All'offerta tecnica sono attribuiti 70 punti e all'offerta economica 30 punti.
I requisiti di partecipazione comprendono un fatturato globale minimo di 500.000 € negli ultimi tre esercizi.
È richiesta garanzia provvisoria pari al 2% dell'importo a base di gara e garanzia definitiva del 10%.
Le offerte devono essere presentate entro il 15/03/2026 alle ore 12:00.
In caso di ritardo si applicano le penali previste dall'articolo 12 e il subappalto è ammesso nei limiti di legge.";

    #[test]
    fn cites_the_page_where_each_sentence_lives() {
        let analysis = analyze_pages(
            "disciplinare.pdf",
            &pages(&["Indice del documento e premesse generali.", DISCIPLINARE]),
        );
        let criteri = analysis
            .sections
            .iter()
            .find(|section| section.id == "criteri")
            .expect("sezione criteri");
        assert!(criteri.found);
        assert!(criteri.items.iter().all(|item| item.page == 2));
        assert!(criteri.summary.contains("offerta economicamente più vantaggiosa"));
        assert!(criteri.summary.contains("punteggio massimo 100"));
    }

    #[test]
    fn extracts_points_percentages_dates_and_amounts() {
        let analysis = analyze_pages("disciplinare.pdf", &pages(&[DISCIPLINARE]));
        let section = |id: &str| {
            analysis
                .sections
                .iter()
                .find(|section| section.id == id)
                .expect("sezione presente")
        };
        assert!(section("criteri").items.iter().any(|item| item
            .note
            .as_deref()
            .is_some_and(|note| note.contains("punti"))));
        assert!(section("garanzie")
            .items
            .iter()
            .any(|item| item.note.as_deref() == Some("2%")));
        assert!(section("scadenze")
            .items
            .iter()
            .any(|item| item.note.as_deref() == Some("data 15/03/2026")));
        assert!(section("solvibilita")
            .items
            .iter()
            .any(|item| item.note.as_deref().is_some_and(|note| note.contains("500.000"))));
        assert!(section("rischi").found);
    }

    #[test]
    fn stays_honest_when_the_text_has_no_requirements() {
        let analysis = analyze_pages("premessa.pdf", &pages(&["Carta intestata della stazione appaltante."]));
        assert!(analysis.sections.iter().all(|section| !section.found));
        assert!(analysis.sections.iter().all(|section| section
            .summary
            .contains("Nessun riferimento")));
    }

    #[test]
    fn warns_when_nothing_was_extracted() {
        let analysis = analyze_pages("scansione.pdf", &pages(&[""]));
        assert_eq!(analysis.pages, 1);
        assert!(analysis
            .warnings
            .iter()
            .any(|warning| warning.contains("OCR")));
    }

    #[test]
    fn stores_documents_once_and_keeps_pages() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("schema.sql")).unwrap();
        conn.execute(
            "INSERT INTO notices (id, source, notice_type, kind, title, published_at, deadline_at)
             VALUES ('n1', 'ted', 'cn-standard', 'call', 'Manutenzione del verde', '2026-01-01',
                '2026-03-15')",
            [],
        )
        .unwrap();

        let dir = std::env::temp_dir().join(format!("cig-doc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("disciplinare.txt");
        std::fs::write(&path, DISCIPLINARE).unwrap();

        let first = add_from_path(&conn, "n1", path.to_str().unwrap()).unwrap();
        assert_eq!(first.pages, 1);
        assert!(first.chars > 200);
        assert_eq!(list(&conn, "n1").unwrap().len(), 1);

        let again = add_from_path(&conn, "n1", path.to_str().unwrap()).unwrap();
        assert_eq!(again.id, first.id, "lo stesso file non deve creare doppioni");
        assert_eq!(list(&conn, "n1").unwrap().len(), 1);

        let analysis = analyze(&conn, &first.id, false).unwrap();
        assert!(analysis.sections.iter().any(|section| section.found));
        let cached = analyze(&conn, &first.id, false).unwrap();
        assert_eq!(cached.generated_at, analysis.generated_at);

        remove(&conn, &first.id).unwrap();
        assert!(list(&conn, "n1").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
