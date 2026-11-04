//! Smoke test contro il database reale dell'app.
//!
//! `cargo run --example smoke` (dalla cartella src-tauri).
//! Non invia email e non scarica dati: verifica migrazione, ricerca, segnali,
//! scheda, profilo ente, previsioni e anteprima digest sui dati già presenti.

use std::sync::Arc;

use cig_lib::alerts;
use cig_lib::config::Settings;
use cig_lib::db::Db;
use cig_lib::embed;
use cig_lib::entities;
use cig_lib::search::{self, SearchFilters, SearchRequest};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = std::path::PathBuf::from(std::env::var("APPDATA")?)
        .join("it.cig.intelligence");
    std::env::set_var("CIG_MODEL_CACHE", data_dir.join("models"));
    let db_path = data_dir.join("cig.db");
    println!("database: {}", db_path.display());

    let db = Arc::new(Db::open(&db_path)?);
    let settings = Settings::default();
    let stats = {
        let conn = db.conn();
        search::stats(&conn)?
    };
    println!(
        "statistiche: {} avvisi ({} bandi, {} aggiudicazioni), {} TED, {} ANAC, {} con CIG, {} PNRR, {} embedding",
        stats.notices,
        stats.calls,
        stats.awarded,
        stats.ted,
        stats.anac,
        {
            let conn = db.conn();
            conn.query_row("SELECT COUNT(*) FROM notice_flags WHERE cig IS NOT NULL", [], |row| {
                row.get::<_, i64>(0)
            })?
        },
        stats.pnrr,
        stats.embedded
    );

    // 1. Ricerca filtrata senza testo.
    let filtered = {
        let conn = db.conn();
        search::run(
            &conn,
            &SearchRequest {
                mode: Some("filtered".into()),
                filters: SearchFilters {
                    hide_expired: Some(false),
                    ..Default::default()
                },
                limit: Some(5),
                ..Default::default()
            },
            None,
        )?
    };
    println!(
        "ricerca filtrata: {} totali, primo = {}",
        filtered.total,
        filtered.items.first().map(|hit| hit.title.as_str()).unwrap_or("—")
    );
    assert!(filtered.total > 0, "archivio vuoto");

    // 2. Ricerca semantica con soglia 60%.
    let query = "servizi di pulizia e igiene";
    let vector = embed::embed_texts(vec![query.to_string()], &settings, true)
        .await?
        .remove(0);
    let semantic = {
        let conn = db.conn();
        search::run(
            &conn,
            &SearchRequest {
                query: query.into(),
                mode: Some("semantic".into()),
                filters: SearchFilters {
                    min_similarity: Some(0.6),
                    hide_expired: Some(false),
                    ..Default::default()
                },
                limit: Some(5),
                ..Default::default()
            },
            Some(&vector),
        )?
    };
    println!(
        "ricerca semantica 60%: {} risultati su {} in {} ms",
        semantic.items.len(),
        semantic.total,
        semantic.took_ms
    );
    for hit in &semantic.items {
        println!(
            "  {:.0}% · {} · {}",
            hit.similarity.unwrap_or(0.0) * 100.0,
            hit.source,
            hit.title.chars().take(90).collect::<String>()
        );
    }
    assert!(semantic.semantic, "la ricerca non ha usato il vettore");
    assert!(!semantic.items.is_empty(), "nessun risultato semantico");

    // 3. Nascondi / interessante.
    let target = filtered.items[0].id.clone();
    {
        let conn = db.conn();
        let before = search::run(
            &conn,
            &SearchRequest {
                mode: Some("filtered".into()),
                filters: SearchFilters {
                    hide_expired: Some(false),
                    ..Default::default()
                },
                limit: Some(200),
                ..Default::default()
            },
            None,
        )?
        .items
        .iter()
        .any(|hit| hit.id == target);
        assert!(before, "la gara scelta non è visibile prima del segnale");
        search::set_signal(&conn, &target, "hide")?;
        let after = search::run(
            &conn,
            &SearchRequest {
                mode: Some("filtered".into()),
                filters: SearchFilters {
                    hide_expired: Some(false),
                    ..Default::default()
                },
                limit: Some(200),
                ..Default::default()
            },
            None,
        )?
        .items
        .iter()
        .any(|hit| hit.id == target);
        assert!(!after, "la gara nascosta è ancora nei risultati");
        search::clear_signal(&conn, &target, Some("hide"))?;
    }
    println!("segnale hide: la gara sparisce e torna dopo clear");

    // 4. Scheda avviso completa.
    let detail_id = semantic
        .items
        .iter()
        .find(|hit| hit.award_count > 0)
        .or_else(|| filtered.items.first())
        .map(|hit| hit.id.clone())
        .expect("gara per la scheda");
    let detail = {
        let conn = db.conn();
        search::notice_detail(&conn, &detail_id)?
    }
    .expect("scheda avviso");
    println!(
        "scheda {}: {} lotti, {} aggiudicazioni, {} simili, {} eventi timeline",
        detail.notice.id,
        detail.notice.lots.len(),
        detail.awards.len(),
        detail.similar.len(),
        detail.timeline.len()
    );

    // 5. Profilo ente e previsioni.
    let supplier = {
        let conn = db.conn();
        conn.query_row(
            "SELECT a.supplier_id FROM awards a
             JOIN notice_embedding e ON e.notice_id = a.notice_id
             WHERE a.supplier_id IS NOT NULL
             GROUP BY a.supplier_id HAVING COUNT(*) >= 3
             ORDER BY COUNT(*) DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };
    if let Some(supplier_id) = supplier {
        let profile = {
            let conn = db.conn();
            entities::entity_profile(&conn, "supplier", &supplier_id)?
        };
        println!(
            "profilo impresa {}: {} contratti, {:.0} €, ribasso medio {:?}, {} gare aperte",
            profile.name,
            profile.contracts,
            profile.total_value,
            profile.avg_discount,
            profile.open_notices.len()
        );
        let predictions = {
            let conn = db.conn();
            search::run(
                &conn,
                &SearchRequest {
                    mode: Some("predictions".into()),
                    entity_type: Some("supplier".into()),
                    entity_id: Some(supplier_id),
                    filters: SearchFilters {
                        min_similarity: Some(0.6),
                        ..Default::default()
                    },
                    limit: Some(5),
                    ..Default::default()
                },
                None,
            )?
        };
        println!(
            "previsioni impresa: {} risultati, etichetta {:?}",
            predictions.total, predictions.label
        );
        for hit in &predictions.items {
            assert_eq!(hit.kind, "call", "le previsioni devono essere bandi");
            println!(
                "  {:.0}% · {} · {}",
                hit.similarity.unwrap_or(0.0) * 100.0,
                hit.source,
                hit.title.chars().take(90).collect::<String>()
            );
        }
        assert!(
            predictions.items.is_empty() || predictions.items.iter().all(|hit| hit.kind == "call"),
            "previsioni con aggiudicazioni"
        );
    } else {
        println!("previsioni: nessuna impresa con almeno 3 gare embeddate");
    }

    // 6. Anteprima digest con una ricerca temporanea.
    let search_id = {
        let conn = db.conn();
        search::insert_saved_search(
            &conn,
            "__smoke_digest__",
            query,
            &SearchFilters::default(),
            0.6,
        )?
    };
    let mut digest_settings = settings.clone();
    digest_settings.digest_days = 3650;
    let report = alerts::run(db.clone(), digest_settings, Some(search_id), false).await?;
    println!(
        "digest: {} gare in {} sezioni, saltato {}, errore {:?}",
        report.notices, report.sections, report.skipped, report.error
    );
    {
        let conn = db.conn();
        conn.execute("DELETE FROM saved_searches WHERE id = ?", [search_id])?;
    }
    assert!(!report.sent, "l'anteprima non deve inviare email");

    println!("SMOKE OK");
    Ok(())
}
