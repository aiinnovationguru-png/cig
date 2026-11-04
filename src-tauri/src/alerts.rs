//! Digest email unico: ricerche salvate e enti seguiti nello stesso messaggio.
//!
//! Le gare vengono deduplicate tra le sezioni e il totale è limitato da
//! `digest_max_notices`. Se non c'è nulla di nuovo non parte alcuna email.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use serde::Serialize;

use crate::config::Settings;
use crate::db::{now_iso, Db};
use crate::embed::{embed_texts, to_blob};
use crate::search::{self, NoticeHit, SearchFilters, SearchRequest};

/// Scarto di similarità sotto il quale un risultato è ancora "vicino al migliore".
const DIGEST_GAP: f32 = 0.04;
/// Massimo di gare per singola sezione: evita che una ricerca saturi il digest.
const SECTION_MAX: usize = 8;
/// Massimo di gare suggerite da ciascun ente seguito.
const ENTITY_MAX: usize = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestNotice {
    pub id: String,
    pub source: String,
    pub kind: String,
    pub title: String,
    pub buyer_name: Option<String>,
    pub region: Option<String>,
    pub deadline_at: Option<String>,
    pub estimated_value: Option<f64>,
    pub discount_pct: Option<f64>,
    pub similarity: Option<f32>,
    pub url: Option<String>,
    pub cig: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestSection {
    /// "search" oppure "entity".
    pub kind: String,
    pub id: String,
    pub name: String,
    pub detail: Option<String>,
    pub notices: Vec<DigestNotice>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    pub subject: String,
    pub sections: Vec<DigestSection>,
    pub notices: Vec<DigestNotice>,
    pub total: i64,
    pub html: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestReport {
    pub sent: bool,
    pub skipped: bool,
    pub notices: i64,
    pub sections: i64,
    pub recipient: Option<String>,
    pub error: Option<String>,
}

struct SearchRow {
    id: i64,
    name: String,
    query: String,
    filters: SearchFilters,
    min_similarity: f64,
}

struct EntityRow {
    entity_type: String,
    entity_id: String,
    name: String,
    min_similarity: f64,
}

fn euro(value: Option<f64>) -> String {
    match value {
        Some(value) => format!("€ {value:.0}"),
        None => "—".to_string(),
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn date_short(value: Option<&str>) -> &str {
    // `get` invece di uno slice di byte: una data con un carattere multibyte
    // dentro i primi 10 byte non deve far panico mentre si compone l'email.
    value
        .map(|value| value.get(..10).unwrap_or(value))
        .unwrap_or("—")
}

fn days_left(value: Option<&str>) -> Option<i64> {
    let date = chrono::NaiveDate::parse_from_str(date_short(value), "%Y-%m-%d").ok()?;
    Some((date - chrono::Local::now().date_naive()).num_days())
}

/// Solo link http(s): un URL inatteso nei dati non deve finire in un `href`.
fn safe_href(value: Option<&str>) -> String {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return String::new();
    };
    let lowered = value.to_ascii_lowercase();
    if lowered.starts_with("https://") || lowered.starts_with("http://") {
        value.to_string()
    } else {
        String::new()
    }
}

fn render_html(sections: &[DigestSection], total: usize) -> String {
    let mut body = String::new();
    for section in sections {
        let detail = section
            .detail
            .as_deref()
            .map(|value| {
                format!(
                    " <span style=\"color:#94a3b8;font-weight:400;\">· {}</span>",
                    escape_html(value)
                )
            })
            .unwrap_or_default();
        body.push_str(&format!(
            "<div style=\"padding:20px 24px 6px;\">\
             <div style=\"font-size:12px;letter-spacing:1.4px;text-transform:uppercase;\
             color:#b45309;font-weight:700;\">{kind}</div>\
             <div style=\"font-size:17px;font-weight:700;color:#0f172a;margin-top:4px;\">{name}{detail}</div>\
             </div>",
            kind = if section.kind == "entity" {
                "Ente seguito"
            } else {
                "Ricerca salvata"
            },
            name = escape_html(&section.name),
            detail = detail,
        ));
        body.push_str("<table style=\"width:100%;border-collapse:collapse;\">");
        for notice in &section.notices {
            let link = safe_href(notice.url.as_deref());
            let title = escape_html(&notice.title);
            let title_html = if link.is_empty() {
                format!(
                    "<span style=\"color:#0f172a;font-weight:600;\">{title}</span>"
                )
            } else {
                format!(
                    "<a href=\"{link}\" style=\"color:#0f172a;font-weight:600;text-decoration:none;\">{title}</a>",
                    link = escape_html(&link),
                )
            };
            let score = notice
                .similarity
                .map(|value| format!("{:.0}%", (value.clamp(0.0, 1.0) * 100.0)))
                .unwrap_or_else(|| "—".to_string());
            let source = if notice.source == "anac" { "ANAC" } else { "TED" };
            let cig = notice
                .cig
                .as_deref()
                .map(|value| format!(" · CIG {}", escape_html(value)))
                .unwrap_or_default();
            let deadline = match days_left(notice.deadline_at.as_deref()) {
                Some(days) if days < 0 => format!("scaduta il {}", date_short(notice.deadline_at.as_deref())),
                Some(days) => format!(
                    "{} · tra {days} {}",
                    date_short(notice.deadline_at.as_deref()),
                    if days == 1 { "giorno" } else { "giorni" }
                ),
                None => date_short(notice.deadline_at.as_deref()).to_string(),
            };
            body.push_str(&format!(
                "<tr>\
                 <td style=\"padding:12px 24px;border-bottom:1px solid #e2e8f0;\">\
                   {title_html}\
                   <div style=\"color:#64748b;font-size:13px;margin-top:4px;\">{buyer} · {region} · {source}{cig} · {score}</div>\
                 </td>\
                 <td style=\"padding:12px 24px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:13px;white-space:nowrap;\">{deadline}</td>\
                 <td style=\"padding:12px 24px;border-bottom:1px solid #e2e8f0;text-align:right;color:#0f172a;white-space:nowrap;\">{value}</td>\
                 </tr>",
                title_html = title_html,
                buyer = escape_html(
                    notice
                        .buyer_name
                        .as_deref()
                        .unwrap_or("Stazione appaltante non indicata")
                ),
                region = escape_html(notice.region.as_deref().unwrap_or("")),
                source = source,
                cig = cig,
                score = score,
                deadline = escape_html(&deadline),
                value = euro(notice.estimated_value),
            ));
        }
        body.push_str("</table>");
    }

    format!(
        "<!doctype html><html><body style=\"margin:0;background:#f1f5f9;font-family:Segoe UI,Helvetica,Arial,sans-serif;\">\
         <div style=\"max-width:760px;margin:0 auto;padding:28px 18px;\">\
         <div style=\"background:#0f172a;color:#f8fafc;padding:24px;border-radius:14px 14px 0 0;\">\
         <div style=\"font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#f59e0b;\">CIG · Italia</div>\
         <div style=\"font-size:23px;font-weight:700;margin-top:6px;\">Nuove opportunità per te</div>\
         <div style=\"color:#cbd5e1;font-size:13px;margin-top:6px;\">{total} gare dalle tue ricerche e dai tuoi enti</div>\
         </div><div style=\"background:#ffffff;border-radius:0 0 14px 14px;overflow:hidden;\">{body}</div>\
         <div style=\"color:#94a3b8;font-size:11px;text-align:center;margin-top:16px;\">\
         Generato da CIG — dati TED e ANAC/BDNCP</div></div></body></html>",
        total = total,
        body = body,
    )
}

pub fn send_test(settings: &Settings) -> Result<()> {
    if !settings.smtp_configured() {
        return Err(anyhow!(
            "compila server SMTP, mittente e destinatario prima di inviare la prova"
        ));
    }
    let html = "<div style=\"font-family:Segoe UI,Arial,sans-serif;color:#0f172a\">\
        <h2 style=\"margin:0 0 6px\">CIG è configurato</h2>\
        <p style=\"color:#475569;margin:0\">Questa è una email di prova: il digest giornaliero \
        arriverà a questo indirizzo con le nuove gare delle ricerche salvate e degli enti seguiti.</p></div>"
        .to_string();
    send_mail(settings, "[CIG] Email di prova", html)
}

fn send_mail(settings: &Settings, subject: &str, html: String) -> Result<()> {
    let mut builder = match settings.smtp_security.as_str() {
        "tls" => SmtpTransport::relay(&settings.smtp_host)?,
        "none" => SmtpTransport::builder_dangerous(&settings.smtp_host),
        _ => SmtpTransport::starttls_relay(&settings.smtp_host)?,
    };
    builder = builder.port(settings.smtp_port);
    if !settings.smtp_user.trim().is_empty() {
        builder = builder.credentials(Credentials::new(
            settings.smtp_user.trim().to_string(),
            settings.smtp_password.clone(),
        ));
    }
    let mailer = builder.build();

    let email = Message::builder()
        .from(settings.smtp_from.parse()?)
        .to(settings.alert_recipient.parse()?)
        .subject(subject)
        .header(ContentType::TEXT_HTML)
        .body(html)?;

    mailer
        .send(&email)
        .map_err(|err| anyhow!("invio SMTP fallito: {err}"))?;
    Ok(())
}

fn load_searches(db: &Db, only: Option<i64>) -> Result<Vec<SearchRow>> {
    let conn = db.conn();
    let mut statement = conn.prepare(
        "SELECT id, name, query, filters, min_similarity
         FROM saved_searches WHERE active = 1 ORDER BY id",
    )?;
    let rows = statement
        .query_map([], |row| {
            let filters_json: String = row.get(3)?;
            Ok(SearchRow {
                id: row.get(0)?,
                name: row.get(1)?,
                query: row.get(2)?,
                filters: serde_json::from_str(&filters_json).unwrap_or_default(),
                min_similarity: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter(|row| only.map(|id| id == row.id).unwrap_or(true))
        .collect())
}

fn load_entities(db: &Db) -> Result<Vec<EntityRow>> {
    let conn = db.conn();
    let mut statement = conn.prepare(
        "SELECT entity_type, entity_id, name, min_similarity FROM followed_entities
         WHERE active = 1 ORDER BY created_at DESC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(EntityRow {
                entity_type: row.get(0)?,
                entity_id: row.get(1)?,
                name: row.get(2)?,
                min_similarity: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Gare già incluse in un digest inviato oggi: un secondo invio nello stesso
/// giorno non deve ripeterle. Il registro è la fonte di verità anche quando il
/// digest viene lanciato a mano prima dell'orario programmato.
fn sent_today(db: &Db, timezone: &str) -> Result<HashSet<String>> {
    let conn = db.conn();
    let day_filter = if timezone == "utc" {
        "date(sent_at) = date('now')"
    } else {
        "date(sent_at, 'localtime') = date('now', 'localtime')"
    };
    let mut statement = conn.prepare(&format!(
        "SELECT notice_ids FROM alert_log WHERE {day_filter}"
    ))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut ids = HashSet::new();
    for row in rows {
        let json = row?;
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&json) {
            ids.extend(list);
        }
    }
    Ok(ids)
}

fn digest_notice(hit: NoticeHit) -> DigestNotice {
    DigestNotice {
        id: hit.id,
        source: hit.source,
        kind: hit.kind,
        title: hit.title,
        buyer_name: hit.buyer_name,
        region: hit.region,
        deadline_at: hit.deadline_at,
        estimated_value: hit.estimated_value,
        discount_pct: hit.discount_pct,
        similarity: hit.similarity,
        url: hit.url,
        cig: hit.cig,
    }
}

fn published_from(days: u32, settings: &Settings) -> String {
    let today = if settings.digest_timezone == "utc" {
        chrono::Utc::now().date_naive()
    } else {
        chrono::Local::now().date_naive()
    };
    (today - chrono::Duration::days(days.max(1) as i64))
        .format("%Y-%m-%d")
        .to_string()
}

async fn search_section(
    db: &Db,
    settings: &Settings,
    search: &SearchRow,
    days: u32,
    limit: usize,
) -> Result<Vec<DigestNotice>> {
    let stored: Option<Vec<u8>> = {
        let conn = db.conn();
        conn.query_row(
            "SELECT embedding FROM search_embedding WHERE search_id = ?",
            [search.id],
            |row| row.get(0),
        )
        .ok()
    };

    let vector: Option<Vec<f32>> = match stored {
        Some(blob) => Some(crate::embed::from_blob(&blob)),
        None if !search.query.trim().is_empty() => {
            let vectors = embed_texts(vec![search.query.clone()], settings, true).await?;
            let vector = vectors.into_iter().next();
            if let Some(vector) = &vector {
                let conn = db.conn();
                conn.execute(
                    "INSERT INTO search_embedding (search_id, embedding, model, updated_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(search_id) DO UPDATE SET embedding = excluded.embedding,
                     updated_at = excluded.updated_at",
                    rusqlite::params![
                        search.id,
                        to_blob(vector),
                        crate::embed::status(settings).model,
                        now_iso()
                    ],
                )?;
            }
            vector
        }
        None => None,
    };

    let mut filters = search.filters.clone();
    filters.published_from = Some(published_from(days, settings));
    let request = SearchRequest {
        query: search.query.clone(),
        filters,
        limit: Some(60),
        offset: Some(0),
        sort: None,
        keyword_only: None,
        mode: if vector.is_some() {
            Some("semantic".into())
        } else {
            None
        },
        ..Default::default()
    };

    let outcome = {
        let conn = db.conn();
        search::run(&conn, &request, vector.as_deref())?
    };

    // Con un modello multilingua compatto tutte le gare italiane si addensano
    // tra 0,80 e 0,90: una soglia assoluta non separa i pertinenti. Si tiene
    // quindi ciò che resta vicino al migliore.
    let best = outcome
        .items
        .iter()
        .filter_map(|hit| hit.similarity)
        .fold(0.0f32, f32::max);
    let cutoff = (best - DIGEST_GAP).max(search.min_similarity as f32);
    Ok(outcome
        .items
        .into_iter()
        .filter(|hit| {
            hit.similarity
                .map(|score| best > 0.0 && score >= cutoff)
                .unwrap_or(true)
        })
        .take(limit)
        .map(digest_notice)
        .collect())
}

fn entity_section(
    db: &Db,
    settings: &Settings,
    entity: &EntityRow,
    days: u32,
    limit: usize,
) -> Result<Vec<DigestNotice>> {
    let request = SearchRequest {
        query: String::new(),
        filters: SearchFilters {
            published_from: Some(published_from(days, settings)),
            min_similarity: Some(entity.min_similarity.clamp(0.0, 1.0)),
            ..Default::default()
        },
        limit: Some(limit as i64),
        offset: Some(0),
        sort: None,
        mode: Some("predictions".into()),
        entity_type: Some(entity.entity_type.clone()),
        entity_id: Some(entity.entity_id.clone()),
        ..Default::default()
    };
    let outcome = {
        let conn = db.conn();
        search::run(&conn, &request, None)?
    };
    Ok(outcome.items.into_iter().take(limit).map(digest_notice).collect())
}

/// Costruisce il digest combinato. Restituisce `None` quando non ci sono gare:
/// in quel caso non va inviata alcuna email.
pub async fn build_digest(
    db: &Db,
    settings: &Settings,
    only_search: Option<i64>,
    days: u32,
) -> Result<Option<Digest>> {
    let max = settings.digest_max_notices.clamp(1, 50) as usize;
    let searches = load_searches(db, only_search)?;
    let entities = if only_search.is_some() {
        Vec::new()
    } else {
        load_entities(db)?
    };

    let mut sections: Vec<DigestSection> = Vec::new();
    let mut all: Vec<DigestNotice> = Vec::new();
    let mut seen: HashSet<String> = sent_today(db, &settings.digest_timezone)?;
    let mut remaining = max;

    for search in searches {
        if remaining == 0 {
            break;
        }
        let notices = search_section(
            db,
            settings,
            &search,
            days,
            remaining.min(SECTION_MAX),
        )
        .await?;
        let mut unique = Vec::new();
        for notice in notices {
            if seen.insert(notice.id.clone()) {
                unique.push(notice);
            }
        }
        if unique.is_empty() {
            continue;
        }
        remaining -= unique.len();
        all.extend(unique.iter().cloned());
        sections.push(DigestSection {
            kind: "search".into(),
            id: search.id.to_string(),
            name: search.name.clone(),
            detail: if search.query.trim().is_empty() {
                None
            } else {
                Some(format!("«{}»", search.query.trim()))
            },
            notices: unique,
        });
    }

    for entity in entities {
        if remaining == 0 {
            break;
        }
        let notices = entity_section(db, settings, &entity, days, remaining.min(ENTITY_MAX))?;
        let mut unique = Vec::new();
        for notice in notices {
            if seen.insert(notice.id.clone()) {
                unique.push(notice);
            }
        }
        if unique.is_empty() {
            continue;
        }
        remaining -= unique.len();
        all.extend(unique.iter().cloned());
        sections.push(DigestSection {
            kind: "entity".into(),
            id: format!("{}:{}", entity.entity_type, entity.entity_id),
            name: entity.name.clone(),
            detail: Some(if entity.entity_type == "supplier" {
                "impresa seguita".into()
            } else {
                "stazione appaltante seguita".into()
            }),
            notices: unique,
        });
    }

    if all.is_empty() {
        return Ok(None);
    }

    let today = if settings.digest_timezone == "utc" {
        chrono::Utc::now().date_naive()
    } else {
        chrono::Local::now().date_naive()
    };
    let subject = format!(
        "[CIG] {} nuove gare · {}",
        all.len(),
        today.format("%d/%m/%Y")
    );
    let html = render_html(&sections, all.len());
    Ok(Some(Digest {
        subject,
        total: all.len() as i64,
        sections,
        notices: all,
        html,
    }))
}

pub async fn run(
    db: Arc<Db>,
    settings: Settings,
    only_search: Option<i64>,
    send: bool,
) -> Result<DigestReport> {
    let days = settings.digest_days.max(1);
    let Some(digest) = build_digest(&db, &settings, only_search, days).await? else {
        return Ok(DigestReport {
            sent: false,
            skipped: true,
            notices: 0,
            sections: 0,
            recipient: None,
            error: None,
        });
    };

    let (sent, error) = if send {
        if !settings.smtp_configured() {
            (
                false,
                Some("SMTP non configurato nelle impostazioni".to_string()),
            )
        } else {
            let settings_for_mail = settings.clone();
            let html = digest.html.clone();
            let subject = digest.subject.clone();
            match tokio::task::spawn_blocking(move || {
                send_mail(&settings_for_mail, &subject, html)
            })
            .await
            {
                Ok(Ok(())) => (true, None),
                Ok(Err(err)) => (false, Some(err.to_string())),
                Err(err) => (false, Some(err.to_string())),
            }
        }
    } else {
        (false, None)
    };

    if sent {
        let conn = db.conn();
        let ids = serde_json::to_string(
            &digest
                .notices
                .iter()
                .map(|notice| notice.id.clone())
                .collect::<Vec<_>>(),
        )?;
        conn.execute(
            "INSERT INTO alert_log (saved_search_id, notice_ids, recipient, subject, sent_at)
             VALUES (?, ?, ?, ?, ?)",
            rusqlite::params![
                only_search,
                ids,
                &settings.alert_recipient,
                digest.subject,
                now_iso()
            ],
        )?;
        if let Some(id) = only_search {
            conn.execute(
                "UPDATE saved_searches SET last_run_at = ? WHERE id = ?",
                rusqlite::params![now_iso(), id],
            )?;
        } else {
            conn.execute(
                "UPDATE saved_searches SET last_run_at = ? WHERE active = 1",
                [now_iso()],
            )?;
        }
    }

    Ok(DigestReport {
        sent,
        skipped: false,
        notices: digest.total,
        sections: digest.sections.len() as i64,
        recipient: Some(settings.alert_recipient),
        error,
    })
}

/// Controlla ogni 20 minuti se è il momento del digest giornaliero.
pub fn spawn_scheduler(
    app: tauri::AppHandle,
    db: Arc<Db>,
    settings: Arc<std::sync::RwLock<Settings>>,
    emit: impl Fn(&tauri::AppHandle, &str) + Send + 'static,
) {
    tauri::async_runtime::spawn(async move {
        // Primo controllo dopo un minuto, poi ogni dieci: l'orario configurato è
        // una soglia, non una finestra. Se l'app parte alle 07:50 con digest alle
        // 07:00, l'invio della giornata deve comunque avvenire.
        let mut delay = std::time::Duration::from_secs(60);
        loop {
            tokio::time::sleep(delay).await;
            delay = std::time::Duration::from_secs(60 * 10);
            let current = settings
                .read()
                .map(|guard| guard.clone())
                .unwrap_or_default();
            if !current.smtp_configured() {
                continue;
            }
            let hour = if current.digest_timezone == "utc" {
                chrono::Utc::now().format("%H").to_string()
            } else {
                chrono::Local::now().format("%H").to_string()
            }
            .parse::<u8>()
            .unwrap_or(99);
            if hour < current.alert_hour {
                continue;
            }
            let already_sent: i64 = {
                let conn = db.conn();
                let day_filter = if current.digest_timezone == "utc" {
                    "date(sent_at) = date('now')"
                } else {
                    "date(sent_at, 'localtime') = date('now', 'localtime')"
                };
                conn.query_row(
                    &format!("SELECT COUNT(*) FROM alert_log WHERE {day_filter}"),
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0)
            };
            if already_sent > 0 {
                continue;
            }
            let result = run(db.clone(), current, None, true).await;
            match &result {
                Ok(report) if report.sent => emit(
                    &app,
                    &format!("digest inviato: {} gare in {} sezioni", report.notices, report.sections),
                ),
                Ok(report) if report.skipped => emit(&app, "digest non inviato: nessuna gara nuova"),
                Ok(_) => emit(&app, "digest non inviato"),
                Err(err) => emit(&app, &format!("digest fallito: {err}")),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_db() -> (PathBuf, Db) {
        let dir = std::env::temp_dir().join(format!(
            "cig-alerts-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("cig.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn sent_today_reads_only_todays_notices() {
        let (dir, db) = test_db();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO alert_log (notice_ids, recipient) VALUES ('[\"a\",\"b\"]', 'x@example.it')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO alert_log (notice_ids, sent_at) VALUES ('[\"c\"]', datetime('now', '-2 days'))",
                [],
            )
            .unwrap();
        }
        let ids = sent_today(&db, "local").unwrap();
        assert!(ids.contains("a"));
        assert!(ids.contains("b"));
        assert!(!ids.contains("c"), "un invio vecchio non deve bloccare le gare");
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_active_entities_enter_the_digest() {
        let (dir, db) = test_db();
        {
            let conn = db.conn();
            conn.execute_batch(
                "INSERT INTO followed_entities (entity_type, entity_id, name, min_similarity, active)
                 VALUES ('supplier', 's1', 'Impresa attiva', 0.72, 1);
                 INSERT INTO followed_entities (entity_type, entity_id, name, min_similarity, active)
                 VALUES ('buyer', 'b1', 'Ente sospeso', 0.85, 0);",
            )
            .unwrap();
        }
        let rows = load_entities(&db).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].entity_id, "s1");
        assert!((rows[0].min_similarity - 0.72).abs() < 1e-9);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }
}
