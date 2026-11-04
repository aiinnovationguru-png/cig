//! Ingestione ANAC/BDNCP: pacchetti mensili CIG e aggiornamenti di esito.

pub mod client;
pub mod normalize;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection};

use crate::db::now_iso;
use crate::ingest::{self, BatchRow, IngestProgress, IngestStats};
use crate::ted::normalize::slugify;

use self::client::AnacClient;
use self::normalize::{parse_awards_csv, parse_cig_csv, parse_participants_csv, Participant};

fn parse_date(value: &str) -> Result<NaiveDate> {
    let head = value.get(..10).unwrap_or(value);
    NaiveDate::parse_from_str(head, "%Y-%m-%d")
        .with_context(|| format!("data non valida: {value} (atteso YYYY-MM-DD)"))
}

fn months(from: NaiveDate, to: NaiveDate) -> Vec<(i32, u32)> {
    let mut result = Vec::new();
    let mut year = from.year();
    let mut month = from.month();
    let end = (to.year(), to.month());
    loop {
        result.push((year, month));
        if (year, month) == end {
            break;
        }
        month += 1;
        if month > 12 {
            month = 1;
            year += 1;
        }
    }
    result
}

fn resource_date(name: &str) -> Option<NaiveDate> {
    let digits: String = name.chars().take(8).collect();
    if digits.len() != 8 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    NaiveDate::parse_from_str(&digits, "%Y%m%d").ok()
}

fn resource_in_range(name: &str, from: NaiveDate, to: NaiveDate) -> bool {
    match resource_date(name) {
        Some(date) => date >= from && date <= to,
        // Risorse senza data (indice o documentazione) non sono dati utili.
        None => false,
    }
}

async fn save_month(
    db_path: &Path,
    client: &AnacClient,
    year: i32,
    month: u32,
    progress: &(impl Fn(IngestProgress) + Send + Sync),
    stats: &mut IngestStats,
) -> Result<()> {
    let label = format!("{year}-{month:02}");
    progress(IngestProgress {
        phase: "download".into(),
        message: format!("ANAC · scarico il pacchetto CIG {label}"),
        fetched: stats.fetched,
        saved: stats.saved,
        awards: stats.awards,
        notice_type: Some(format!("anac-{label}")),
        current: 0,
        total: 1,
    });
    let zip = client.cig_month(year, month).await?;
    let (_name, csv) = client::first_csv(&zip)?;
    let notices = parse_cig_csv(&csv)?;
    stats.fetched += notices.len() as u64;
    stats.per_type.insert(format!("anac-{label}"), notices.len() as u64);

    let mut batch: Vec<BatchRow> = Vec::new();
    for notice in notices {
        let raw = normalize::raw_json(&notice);
        batch.push(BatchRow { notice, raw });
        if batch.len() >= 80 {
            let saved = ingest::save_batch(db_path, &batch)?;
            stats.saved += saved.notices;
            stats.awards += saved.awards;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        let saved = ingest::save_batch(db_path, &batch)?;
        stats.saved += saved.notices;
        stats.awards += saved.awards;
    }

    progress(IngestProgress {
        phase: "done".into(),
        message: format!("ANAC · {label} completato · {} CIG", stats.per_type[&format!("anac-{label}")]),
        fetched: stats.fetched,
        saved: stats.saved,
        awards: stats.awards,
        notice_type: Some(format!("anac-{label}")),
        current: 1,
        total: 1,
    });
    Ok(())
}

fn find_notice(conn: &Connection, cig: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT notice_id FROM notice_flags WHERE cig = ? LIMIT 1",
            [cig],
            |row| row.get(0),
        )
        .ok())
}

fn supplier_key(tax_code: Option<&str>, name: &str) -> String {
    if let Some(code) = tax_code {
        let digits: String = code.chars().filter(|ch| ch.is_ascii_digit()).collect();
        if (8..=16).contains(&digits.len()) {
            return format!("cf-{digits}");
        }
    }
    format!("name-{}", slugify(name))
}

/// Applica gli aggiornamenti di aggiudicazione e i partecipanti ai CIG già in archivio.
fn apply_updates(
    db_path: &Path,
    awards: &[normalize::AwardUpdate],
    participants: &HashMap<String, Vec<Participant>>,
) -> Result<(u64, u64)> {
    if awards.is_empty() && participants.is_empty() {
        return Ok((0, 0));
    }
    let mut conn = Connection::open(db_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(15))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    let tx = conn.transaction()?;
    let now = now_iso();
    let mut updated = 0u64;
    let mut inferred_awards = 0u64;

    for update in awards {
        let Some(notice_id) = find_notice(&tx, &update.cig)? else {
            continue;
        };
        let kind = if update.awarded_value.is_some()
            || update
                .esito
                .as_deref()
                .map(|value| value.to_uppercase().contains("AGGIUDICATA"))
                .unwrap_or(false)
        {
            "award"
        } else {
            "call"
        };
        tx.execute(
            "UPDATE notices SET awarded_value = COALESCE(?, awarded_value),
                discount_pct = COALESCE(?, discount_pct), kind = ?, updated_at = ?
             WHERE id = ?",
            params![
                update.awarded_value,
                update.discount_pct,
                kind,
                now,
                notice_id
            ],
        )?;
        tx.execute(
            "UPDATE notice_flags SET esito = COALESCE(?, esito), esito_at = COALESCE(?, esito_at),
                updated_at = ? WHERE notice_id = ?",
            params![update.esito, update.awarded_at, now, notice_id],
        )?;
        updated += 1;

        // I dataset ANAC non pubblicano il vincitore. Se per il CIG c'è un solo
        // partecipante, è ragionevole trattarlo come aggiudicatario.
        let single = participants
            .get(&update.cig)
            .filter(|list| list.len() == 1)
            .and_then(|list| list.first());
        if let Some(participant) = single {
            let Some(name) = participant.name.as_deref().filter(|value| !value.is_empty()) else {
                continue;
            };
            let key = supplier_key(participant.tax_code.as_deref(), name);
            tx.execute(
                "INSERT INTO suppliers (id, name, country, updated_at) VALUES (?, ?, 'IT', ?)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
                params![key, name, now],
            )?;
            let (estimated, region, cpv_json): (Option<f64>, Option<String>, String) = tx
                .query_row(
                    "SELECT estimated_value, region, cpv_codes FROM notices WHERE id = ?",
                    [&notice_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            tx.execute(
                "INSERT INTO awards (id, notice_id, supplier_id, supplier_name, awarded_value,
                    estimated_value, discount_pct, currency, awarded_at, cpv_codes, region)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET supplier_id = excluded.supplier_id,
                    supplier_name = excluded.supplier_name, awarded_value = excluded.awarded_value,
                    discount_pct = excluded.discount_pct, awarded_at = excluded.awarded_at",
                params![
                    format!("{notice_id}:anac-award"),
                    notice_id,
                    key,
                    name,
                    update.awarded_value,
                    estimated,
                    update.discount_pct,
                    update.awarded_at,
                    cpv_json,
                    region
                ],
            )?;
            inferred_awards += 1;
        }
    }

    tx.commit()?;
    Ok((updated, inferred_awards))
}

async fn enrich_updates(
    db_path: &Path,
    client: &AnacClient,
    from: NaiveDate,
    to: NaiveDate,
    progress: &(impl Fn(IngestProgress) + Send + Sync),
    stats: &mut IngestStats,
) -> Result<()> {
    let mut awards = Vec::new();
    let mut participants: HashMap<String, Vec<Participant>> = HashMap::new();

    for dataset in ["aggiudicazioni", "partecipanti"] {
        let resources = match client.resources(dataset).await {
            Ok(resources) => resources,
            Err(err) => {
                progress(IngestProgress {
                    phase: "warning".into(),
                    message: format!("ANAC · {dataset} non disponibile: {err}"),
                    fetched: stats.fetched,
                    saved: stats.saved,
                    awards: stats.awards,
                    notice_type: Some(dataset.to_string()),
                    current: 0,
                    total: 0,
                });
                continue;
            }
        };
        let selected: Vec<_> = resources
            .into_iter()
            .filter(|resource| {
                resource.url.to_lowercase().ends_with(".zip")
                    && resource_in_range(&resource.name, from, to)
            })
            .collect();
        for resource in selected {
            let bytes = match client.download(&resource.url).await {
                Ok(bytes) => bytes,
                Err(err) => {
                    progress(IngestProgress {
                        phase: "warning".into(),
                        message: format!("ANAC · salto {}: {err}", resource.name),
                        fetched: stats.fetched,
                        saved: stats.saved,
                        awards: stats.awards,
                        notice_type: Some(dataset.to_string()),
                        current: 0,
                        total: 0,
                    });
                    continue;
                }
            };
            let Ok((_name, csv)) = client::first_csv(&bytes) else {
                continue;
            };
            if dataset == "aggiudicazioni" {
                awards.extend(parse_awards_csv(&csv)?);
            } else {
                for (cig, list) in parse_participants_csv(&csv)? {
                    participants.entry(cig).or_default().extend(list);
                }
            }
            progress(IngestProgress {
                phase: "enrich".into(),
                message: format!("ANAC · elaboro {}", resource.name),
                fetched: stats.fetched,
                saved: stats.saved,
                awards: stats.awards,
                notice_type: Some(dataset.to_string()),
                current: 0,
                total: 0,
            });
        }
    }

    let (updated, inferred) = apply_updates(db_path, &awards, &participants)?;
    stats.awards += inferred;
    stats.skipped += updated.saturating_sub(inferred);
    Ok(())
}

/// Scarica i pacchetti CIG dei mesi compresi nell'intervallo e, se richiesto,
/// applica gli aggiornamenti di aggiudicazione disponibili.
pub async fn run(
    db_path: PathBuf,
    from: String,
    to: String,
    include_updates: bool,
    progress: impl Fn(IngestProgress) + Send + Sync,
) -> Result<IngestStats> {
    let from_date = parse_date(&from)?;
    let to_date = parse_date(&to)?;
    if from_date > to_date {
        anyhow::bail!("la data iniziale è successiva alla finale");
    }
    let client = AnacClient::new()?;
    let mut stats = IngestStats {
        started_at: now_iso(),
        ..Default::default()
    };

    for (year, month) in months(from_date, to_date) {
        save_month(&db_path, &client, year, month, &progress, &mut stats).await?;
    }

    if include_updates {
        enrich_updates(&db_path, &client, from_date, to_date, &progress, &mut stats).await?;
    }

    stats.finished_at = Some(now_iso());
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_month_range() {
        let from = NaiveDate::from_ymd_opt(2024, 11, 15).unwrap();
        let to = NaiveDate::from_ymd_opt(2025, 2, 2).unwrap();
        assert_eq!(
            months(from, to),
            vec![(2024, 11), (2024, 12), (2025, 1), (2025, 2)]
        );
    }

    #[test]
    fn parses_resource_dates() {
        assert_eq!(
            resource_date("20260901-aggiudicazioni_csv.zip"),
            NaiveDate::from_ymd_opt(2026, 9, 1)
        );
        assert!(resource_date("aggiudicazioni_csv").is_none());
    }
}
