//! Valutazione orientativa basata su riscontri testuali, non su giudizi automatici.
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::db::now_iso;
use crate::evaluation_engine;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    pub id: String,
    pub label: String,
    pub weight: f64,
    #[serde(default)]
    pub requirements: Vec<String>,
    #[serde(default)]
    pub manual_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence { pub sentence: String, pub matched: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriterionResult {
    pub id: String,
    pub label: String,
    pub weight: f64,
    pub coverage: f64,
    pub suggested_score: f64,
    pub applied_score: f64,
    pub evidence: Vec<Evidence>,
    pub gaps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal { pub label: String, pub value: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub criteria: Vec<CriterionResult>,
    pub total_score: f64,
    pub max_score: f64,
    pub coverage: f64,
    pub word_count: usize,
    pub signals: Vec<Signal>,
    pub gaps: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedEvaluation {
    pub id: i64,
    pub notice_id: Option<String>,
    pub report_title: Option<String>,
    pub report_text: String,
    pub created_at: String,
    pub total_score: f64,
    pub max_score: f64,
    pub criteria: Vec<Criterion>,
    pub result: Evaluation,
}

pub fn default_criteria() -> Vec<Criterion> {
    [
        ("metodologia", "Metodologia e organizzazione", 30.0, &["metodologia", "piano operativo", "organizzazione"][..]),
        ("qualita", "Qualità del servizio", 25.0, &["qualità", "monitoraggio", "controllo"][..]),
        ("personale", "Personale e competenze", 20.0, &["personale", "esperienza", "formazione"][..]),
        ("sostenibilita", "Sostenibilità", 15.0, &["ambiente", "sostenibilità", "emissioni"][..]),
        ("innovazione", "Innovazione e miglioramenti", 10.0, &["innovazione", "miglioramento", "digitale"][..]),
    ].into_iter().map(|(id, label, weight, requirements)| Criterion {
        id: id.into(), label: label.into(), weight,
        requirements: requirements.iter().map(|s| (*s).to_string()).collect(), manual_score: None,
    }).collect()
}

fn valid_weight(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 100.0) } else { 0.0 }
}

pub fn evaluate(report: &str, criteria: &[Criterion]) -> Evaluation {
    let results: Vec<_> = criteria.iter().map(|criterion| {
        let found = evaluation_engine::analyze(report, &criterion.requirements);
        let weight = valid_weight(criterion.weight);
        let suggested = weight * found.coverage;
        let applied = criterion.manual_score.filter(|s| s.is_finite())
            .map(|s| s.clamp(0.0, weight)).unwrap_or(suggested);
        CriterionResult {
            id: criterion.id.clone(), label: criterion.label.clone(), weight,
            coverage: found.coverage, suggested_score: suggested, applied_score: applied,
            evidence: found.evidence.into_iter().map(|(sentence, matched)| Evidence { sentence, matched }).collect(),
            gaps: found.gaps,
        }
    }).collect();
    let max_score: f64 = results.iter().map(|r| r.weight).sum();
    let total_score = results.iter().map(|r| r.applied_score).sum();
    let coverage = if max_score > 0.0 { results.iter().map(|r| r.coverage * r.weight).sum::<f64>() / max_score } else { 0.0 };
    let gaps = results.iter().flat_map(|r| r.gaps.iter().cloned()).collect();
    Evaluation {
        criteria: results, total_score, max_score, coverage,
        word_count: report.split_whitespace().count(), signals: Vec::new(), gaps,
        summary: "Analisi orientativa per parole chiave: le citazioni non dimostrano conformità o qualità dell'offerta. Verifica sempre il disciplinare e il contenuto completo.".into(),
    }
}

// Compatibile con il database locale; la tabella viene creata solo se assente.
fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notice_id TEXT REFERENCES notices(id) ON DELETE SET NULL,
        report_title TEXT, report_text TEXT NOT NULL,
        created_at TEXT NOT NULL, total_score REAL NOT NULL, max_score REAL NOT NULL,
        criteria_json TEXT NOT NULL, result_json TEXT NOT NULL
    );")?;
    Ok(())
}

pub fn save(conn: &Connection, notice_id: Option<&str>, title: Option<&str>, report: &str, criteria: &[Criterion], result: &Evaluation) -> Result<i64> {
    ensure_schema(conn)?;
    conn.execute("INSERT INTO evaluations (notice_id, report_title, report_text, created_at, total_score, max_score, criteria_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![notice_id, title, report, now_iso(), result.total_score, result.max_score, serde_json::to_string(criteria)?, serde_json::to_string(result)?])?;
    Ok(conn.last_insert_rowid())
}

pub fn list(conn: &Connection, limit: usize) -> Result<Vec<SavedEvaluation>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare("SELECT id, notice_id, report_title, report_text, created_at, total_score, max_score, criteria_json, result_json FROM evaluations ORDER BY id DESC LIMIT ?")?;
    let rows = stmt.query_map([limit.min(1000) as i64], |row| Ok((
        row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?,
        row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, f64>(5)?,
        row.get::<_, f64>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?)))?;
    let mut output = Vec::new();
    for row in rows {
        let (id, notice_id, report_title, report_text, created_at, total_score, max_score, criteria, result) = row?;
        output.push(SavedEvaluation { id, notice_id, report_title, report_text, created_at, total_score, max_score,
            criteria: serde_json::from_str(&criteria)?, result: serde_json::from_str(&result)? });
    }
    Ok(output)
}
