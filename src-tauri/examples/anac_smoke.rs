//! Verifica l'ingestione ANAC su una copia del database reale.
//!
//! `cargo run --example anac_smoke -- 2026-09-01 2026-09-30`
//! Scarica un solo mese, non invia email e non tocca il database dell'app.

use std::path::PathBuf;
use std::sync::Arc;

use cig_lib::anac;
use cig_lib::db::Db;
use cig_lib::ingest::IngestProgress;
use cig_lib::search;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let from = args.next().unwrap_or_else(|| "2026-09-01".to_string());
    let to = args.next().unwrap_or_else(|| "2026-09-30".to_string());

    let source = PathBuf::from(std::env::var("APPDATA")?)
        .join("it.cig.intelligence")
        .join("cig.db");
    let work = std::env::temp_dir().join(format!("cig-anac-smoke-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work)?;
    let db_path = work.join("cig.db");
    std::fs::copy(&source, &db_path)?;
    println!("copia database: {}", db_path.display());

    let stats = anac::run(
        db_path.clone(),
        from.clone(),
        to.clone(),
        false,
        |progress: IngestProgress| {
            if progress.phase != "download" || progress.current == progress.total {
                println!(
                    "  [{}] {} · letti {} · salvati {} · aggiudicazioni {}",
                    progress.phase,
                    progress.message,
                    progress.fetched,
                    progress.saved,
                    progress.awards
                );
            }
        },
    )
    .await?;
    println!(
        "ANAC {from} → {to}: letti {}, salvati {}, scartati {}, aggiudicazioni {}",
        stats.fetched, stats.saved, stats.skipped, stats.awards
    );

    let db = Arc::new(Db::open(&db_path)?);
    let overall = {
        let conn = db.conn();
        search::stats(&conn)?
    };
    let anac_count: i64 = {
        let conn = db.conn();
        conn.query_row("SELECT COUNT(*) FROM notices WHERE source = 'anac'", [], |row| {
            row.get(0)
        })?
    };
    let cig_count: i64 = {
        let conn = db.conn();
        conn.query_row("SELECT COUNT(*) FROM notice_flags WHERE cig IS NOT NULL", [], |row| {
            row.get(0)
        })?
    };
    let duplicate_cig: i64 = {
        let conn = db.conn();
        conn.query_row(
            "SELECT COUNT(*) FROM (
                SELECT cig FROM notice_flags WHERE cig IS NOT NULL
                GROUP BY cig HAVING COUNT(*) > 1
             )",
            [],
            |row| row.get(0),
        )?
    };
    let anac_with_region: i64 = {
        let conn = db.conn();
        conn.query_row(
            "SELECT COUNT(*) FROM notices WHERE source = 'anac' AND region IS NOT NULL",
            [],
            |row| row.get(0),
        )?
    };
    let lots: i64 = {
        let conn = db.conn();
        conn.query_row("SELECT COUNT(*) FROM lots", [], |row| row.get(0))?
    };
    println!(
        "dopo ingest: {} avvisi totali ({} ANAC), {} CIG, {} duplicati CIG, {} ANAC con regione, {} lotti",
        overall.notices, anac_count, cig_count, duplicate_cig, anac_with_region, lots
    );
    assert!(anac_count > 0, "nessun avviso ANAC salvato");
    assert_eq!(duplicate_cig, 0, "CIG duplicati dopo la deduplica");

    let sample = {
        let conn = db.conn();
        let mut statement = conn.prepare(
            "SELECT n.title, n.province, n.region, f.cig, f.pnrr, n.estimated_value
             FROM notices n JOIN notice_flags f ON f.notice_id = n.id
             WHERE n.source = 'anac' LIMIT 5",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<f64>>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (title, province, region, cig, pnrr, value) in sample {
        println!(
            "  {} · CIG {} · {} / {} · PNRR {} · {:?}",
            title.chars().take(80).collect::<String>(),
            cig.unwrap_or_default(),
            province.unwrap_or_default(),
            region.unwrap_or_default(),
            pnrr,
            value
        );
    }

    println!("ANAC SMOKE OK · {}", work.display());
    Ok(())
}
