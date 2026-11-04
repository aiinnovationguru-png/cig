//! Esportazione Excel locale. I campi provenienti dalle fonti vengono scritti
//! come stringhe, mai come formule eseguibili.
use std::path::{Path, PathBuf};
use anyhow::{bail, Result};
use rust_xlsxwriter::Workbook;

pub struct ExportRow {
    pub title: String,
    pub source: String,
    pub cig: Option<String>,
    pub cup: Option<String>,
    pub pnrr: bool,
    pub buyer: Option<String>,
    pub region: Option<String>,
    pub province: Option<String>,
    pub cpv: String,
    pub kind: String,
    pub estimated_value: Option<f64>,
    pub awarded_value: Option<f64>,
    pub discount_pct: Option<f64>,
    pub published_at: Option<String>,
    pub deadline_at: Option<String>,
    pub lot_count: i64,
    pub url: Option<String>,
    pub board_column: Option<String>,
    pub note: Option<String>,
    pub nature: Option<String>,
}

pub fn export(directory: &Path, stem: &str, rows: &[ExportRow]) -> Result<PathBuf> {
    if rows.len() > 1_048_575 { bail!("troppe righe per un foglio Excel"); }
    std::fs::create_dir_all(directory)?;
    let safe_stem: String = stem.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(60).collect();
    let safe_stem = if safe_stem.is_empty() { "export" } else { &safe_stem };
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%f");
    let path = directory.join(format!("{safe_stem}-{stamp}.xlsx"));
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let headings = ["Titolo", "Fonte", "CIG", "CUP", "PNRR/PNC", "Stazione appaltante", "Regione", "Provincia", "CPV", "Tipo", "Importo stimato", "Importo aggiudicato", "Ribasso %", "Pubblicazione", "Scadenza", "Lotti", "URL", "Bacheca", "Note", "Natura"];
    for (column, title) in headings.iter().enumerate() {
        sheet.write_string(0, column as u16, *title)?;
    }
    for (index, item) in rows.iter().enumerate() {
        let row = index as u32 + 1;
        let strings = [Some(item.title.as_str()), Some(item.source.as_str()), item.cig.as_deref(), item.cup.as_deref(), Some(if item.pnrr { "Sì" } else { "No" }), item.buyer.as_deref(), item.region.as_deref(), item.province.as_deref(), Some(item.cpv.as_str()), Some(item.kind.as_str()), None, None, None, item.published_at.as_deref(), item.deadline_at.as_deref(), None, item.url.as_deref(), item.board_column.as_deref(), item.note.as_deref(), item.nature.as_deref()];
        for (column, value) in strings.iter().enumerate() {
            if let Some(value) = value { sheet.write_string(row, column as u16, *value)?; }
        }
        for (column, value) in [(10, item.estimated_value), (11, item.awarded_value), (12, item.discount_pct), (15, Some(item.lot_count as f64))] {
            if let Some(value) = value.filter(|value| value.is_finite()) { sheet.write_number(row, column, value)?; }
        }
    }
    workbook.save(&path)?;
    Ok(path)
}
