//! Comandi IPC esposti al frontend Tauri.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::awards::{self, IntelOutcome};
use crate::board::{self, BoardItem};
use crate::config::{Paths, Settings};
use crate::db::{now_iso, Db};
use crate::documents::{self, DocumentAnalysis, DocumentSummary};
use crate::embed::{self, EmbeddingStatus};
use crate::entities::{self, EntityProfile, FollowedEntity};
use crate::evaluate::{self, Criterion, Evaluation, SavedEvaluation};
use crate::export::{self, ExportRow};
use crate::ingest::{self, IngestStats};
use crate::search::{
    self, NoticeDetail, NoticeHit, SavedSearch, SearchFilters, SearchOutcome, SearchRequest, Stats,
    HIT_COLUMNS,
};

pub struct AppState {
    pub db: Arc<Db>,
    pub settings: Arc<RwLock<Settings>>,
    pub paths: Paths,
}

fn current_settings(state: &State<'_, AppState>) -> Settings {
    state
        .settings
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn to_error(error: impl std::fmt::Display) -> String {
    let message = error.to_string();
    // Gli errori grezzi di SQLite non dicono niente a chi usa l'app.
    if message.contains("database is locked") || message.contains("database table is locked") {
        return "Il database è occupato da un'altra operazione: riprova tra un istante.".into();
    }
    if message.contains("no such table") {
        return "Archivio locale non inizializzato: riapri l'app.".into();
    }
    if message.contains("disk I/O error") || message.contains("disk is full") {
        return "Errore di scrittura su disco: controlla lo spazio libero.".into();
    }
    message
}

/// Una sola importazione alla volta: due writer sullo stesso file si
/// contendono il lock e i conteggi finali si sovrappongono.
static INGESTING: AtomicBool = AtomicBool::new(false);

struct IngestGuard;

impl IngestGuard {
    fn acquire() -> Option<Self> {
        INGESTING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| IngestGuard)
    }
}

impl Drop for IngestGuard {
    fn drop(&mut self) {
        INGESTING.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> Result<Stats, String> {
    let conn = state.db.conn();
    search::stats(&conn).map_err(to_error)
}

#[tauri::command]
pub async fn search_notices(
    state: State<'_, AppState>,
    request: SearchRequest,
) -> Result<SearchOutcome, String> {
    let settings = current_settings(&state);
    let wants_semantic = !request.query.trim().is_empty()
        && !request.keyword_only.unwrap_or(false)
        && settings.embeddings_ready();

    let mut vector = None;
    if wants_semantic {
        match embed::embed_texts(vec![request.query.trim().to_string()], &settings, true).await {
            Ok(mut vectors) => vector = vectors.pop(),
            Err(_) => vector = None,
        }
    }

    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.conn();
        search::run(&conn, &request, vector.as_deref())
    })
    .await
    .map_err(to_error)?
    .map_err(to_error)
}

#[tauri::command]
pub fn notice_detail(state: State<'_, AppState>, id: String) -> Result<Option<NoticeDetail>, String> {
    let conn = state.db.conn();
    search::notice_detail(&conn, &id).map_err(to_error)
}

// ---------------------------------------------------------------------------
// Documenti di gara e analisi del disciplinare

#[tauri::command]
pub fn notice_documents(
    state: State<'_, AppState>,
    notice_id: String,
) -> Result<Vec<DocumentSummary>, String> {
    let conn = state.db.conn();
    documents::list(&conn, &notice_id).map_err(to_error)
}

/// Il file viene scelto con il selettore nativo e letto da Rust: il contenuto
/// non passa dal webview e i PDF possono essere grandi.
#[tauri::command]
pub fn add_notice_document(
    state: State<'_, AppState>,
    notice_id: String,
    path: String,
) -> Result<DocumentSummary, String> {
    let conn = state.db.conn();
    documents::add_from_path(&conn, &notice_id, &path).map_err(to_error)
}

#[tauri::command]
pub fn remove_notice_document(
    state: State<'_, AppState>,
    document_id: String,
) -> Result<(), String> {
    let conn = state.db.conn();
    documents::remove(&conn, &document_id).map_err(to_error)
}

#[tauri::command]
pub fn analyze_notice_document(
    state: State<'_, AppState>,
    document_id: String,
    refresh: Option<bool>,
) -> Result<DocumentAnalysis, String> {
    let conn = state.db.conn();
    documents::analyze(&conn, &document_id, refresh.unwrap_or(false)).map_err(to_error)
}

// ---------------------------------------------------------------------------
// Segnali, previsioni ed enti

#[tauri::command]
pub fn set_user_signal(
    state: State<'_, AppState>,
    notice_id: String,
    signal: String,
) -> Result<(), String> {
    let conn = state.db.conn();
    search::set_signal(&conn, &notice_id, &signal).map_err(to_error)
}

#[tauri::command]
pub fn clear_user_signal(
    state: State<'_, AppState>,
    notice_id: String,
    signal: Option<String>,
) -> Result<(), String> {
    let conn = state.db.conn();
    search::clear_signal(&conn, &notice_id, signal.as_deref()).map_err(to_error)
}

#[tauri::command]
pub fn follow_entity(
    state: State<'_, AppState>,
    entity_type: String,
    entity_id: String,
    name: Option<String>,
) -> Result<(), String> {
    let conn = state.db.conn();
    entities::follow_entity(&conn, &entity_type, &entity_id, name.as_deref()).map_err(to_error)
}

#[tauri::command]
pub fn unfollow_entity(
    state: State<'_, AppState>,
    entity_type: String,
    entity_id: String,
) -> Result<(), String> {
    let conn = state.db.conn();
    entities::unfollow_entity(&conn, &entity_type, &entity_id).map_err(to_error)
}

#[tauri::command]
pub fn list_followed_entities(state: State<'_, AppState>) -> Result<Vec<FollowedEntity>, String> {
    let conn = state.db.conn();
    entities::list_followed_entities(&conn).map_err(to_error)
}

#[tauri::command]
pub fn update_followed_entity(
    state: State<'_, AppState>,
    entity_type: String,
    entity_id: String,
    min_similarity: Option<f64>,
    active: Option<bool>,
) -> Result<(), String> {
    let conn = state.db.conn();
    entities::update_followed_entity(
        &conn,
        &entity_type,
        &entity_id,
        min_similarity,
        active,
    )
    .map_err(to_error)
}

#[tauri::command]
pub fn entity_profile(
    state: State<'_, AppState>,
    entity_type: String,
    entity_id: String,
) -> Result<EntityProfile, String> {
    let conn = state.db.conn();
    entities::entity_profile(&conn, &entity_type, &entity_id).map_err(to_error)
}

#[tauri::command]
pub fn entity_suggestions(
    state: State<'_, AppState>,
    entity_type: String,
    query: String,
) -> Result<Vec<entities::ProfileCount>, String> {
    let conn = state.db.conn();
    entities::entity_suggestions(&conn, &entity_type, &query, 12).map_err(to_error)
}

#[tauri::command]
pub async fn predict_from_entity(
    state: State<'_, AppState>,
    entity_type: String,
    entity_id: String,
    filters: Option<SearchFilters>,
    limit: Option<i64>,
    min_similarity: Option<f64>,
    offset: Option<i64>,
) -> Result<SearchOutcome, String> {
    let mut filters = filters.unwrap_or_default();
    if let Some(value) = min_similarity {
        filters.min_similarity = Some(value);
    }
    let request = SearchRequest {
        query: String::new(),
        filters,
        limit,
        offset: Some(offset.unwrap_or(0)),
        mode: Some("predictions".into()),
        entity_type: Some(entity_type),
        entity_id: Some(entity_id),
        ..Default::default()
    };
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.conn();
        search::run(&conn, &request, None)
    })
    .await
    .map_err(to_error)?
    .map_err(to_error)
}

#[tauri::command]
pub fn award_intel(
    state: State<'_, AppState>,
    filters: SearchFilters,
    group_by: String,
) -> Result<IntelOutcome, String> {
    let conn = state.db.conn();
    awards::intel(&conn, &filters, &group_by, 40).map_err(to_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoFilters {
    pub regions: Vec<&'static str>,
    pub provinces: Vec<ProvinceOption>,
}

#[derive(Serialize)]
pub struct ProvinceOption {
    pub code: &'static str,
    pub region: &'static str,
}

#[tauri::command]
pub fn geo_filters() -> GeoFilters {
    let mut provinces: Vec<ProvinceOption> = crate::geo::PROVINCES
        .iter()
        .map(|(code, region)| ProvinceOption { code, region })
        .collect();
    provinces.sort_by(|a, b| a.code.cmp(b.code));
    GeoFilters {
        regions: crate::geo::regions(),
        provinces,
    }
}

// ---------------------------------------------------------------------------
// Bacheca

#[tauri::command]
pub fn board_list(state: State<'_, AppState>) -> Result<Vec<BoardItem>, String> {
    let conn = state.db.conn();
    board::list(&conn).map_err(to_error)
}

#[tauri::command]
pub fn board_add(
    state: State<'_, AppState>,
    notice_id: String,
    column: Option<String>,
) -> Result<(), String> {
    let conn = state.db.conn();
    board::add(&conn, &notice_id, column.as_deref().unwrap_or("valutare")).map_err(to_error)
}

#[tauri::command]
pub fn board_update(
    state: State<'_, AppState>,
    notice_id: String,
    column: Option<String>,
    position: Option<i64>,
    note: Option<String>,
) -> Result<(), String> {
    let conn = state.db.conn();
    board::update(&conn, &notice_id, column.as_deref(), position, note.as_deref())
        .map_err(to_error)
}

#[tauri::command]
pub fn board_remove(state: State<'_, AppState>, notice_id: String) -> Result<(), String> {
    let conn = state.db.conn();
    board::remove(&conn, &notice_id).map_err(to_error)
}

// ---------------------------------------------------------------------------
// Esportazione

fn export_row_from_hit(hit: &NoticeHit) -> ExportRow {
    ExportRow {
        title: hit.title.clone(),
        source: hit.source.clone(),
        cig: hit.cig.clone(),
        cup: hit.cup.clone(),
        pnrr: hit.pnrr || hit.pnrr_pnc,
        buyer: hit.buyer_name.clone(),
        region: hit.region.clone(),
        province: hit.province.clone(),
        cpv: hit.cpv_codes.join(", "),
        kind: hit.kind.clone(),
        estimated_value: hit.estimated_value,
        awarded_value: hit.awarded_value,
        discount_pct: hit.discount_pct,
        published_at: hit.published_at.clone(),
        deadline_at: hit.deadline_at.clone(),
        lot_count: hit.lot_count,
        url: hit.url.clone(),
        board_column: None,
        note: None,
        nature: None,
    }
}

/// Natura del contratto per le righe esportate: `NoticeHit` non la porta, ma il
/// foglio Excel la richiede.
fn load_natures(conn: &rusqlite::Connection, ids: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for chunk in ids.chunks(400) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "SELECT id, contract_nature FROM notices WHERE id IN ({placeholders}) \
             AND contract_nature IS NOT NULL"
        );
        let Ok(mut statement) = conn.prepare(&sql) else {
            continue;
        };
        let params: Vec<rusqlite::types::Value> = chunk
            .iter()
            .map(|id| rusqlite::types::Value::Text(id.clone()))
            .collect();
        let Ok(rows) = statement.query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) else {
            continue;
        };
        for row in rows.flatten() {
            map.insert(row.0, row.1);
        }
    }
    map
}

#[tauri::command]
pub fn export_notice(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let detail = {
        let conn = state.db.conn();
        search::notice_detail(&conn, &id).map_err(to_error)?
    }
    .ok_or_else(|| format!("gara non trovata: {id}"))?;
    let mut row = export_row_from_hit(&detail.notice);
    row.nature = detail.contract_nature.clone();
    let rows = vec![row];
    let path = export::export(&state.paths.exports_dir, "gara", &rows).map_err(to_error)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn export_board(state: State<'_, AppState>) -> Result<String, String> {
    let items = {
        let conn = state.db.conn();
        board::list(&conn).map_err(to_error)?
    };
    let ids: Vec<String> = items.iter().map(|item| item.notice.id.clone()).collect();
    let natures = {
        let conn = state.db.conn();
        load_natures(&conn, &ids)
    };
    let rows: Vec<ExportRow> = items
        .iter()
        .map(|item| ExportRow {
            board_column: Some(item.column_key.clone()),
            note: item.note.clone(),
            nature: natures.get(&item.notice.id).cloned(),
            ..export_row_from_hit(&item.notice)
        })
        .collect();
    let path = export::export(&state.paths.exports_dir, "bacheca", &rows).map_err(to_error)?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub rows: i64,
    /// Risultati che la ricerca avrebbe restituito: se supera `rows` il file è
    /// parziale e va detto, non lasciato credere che sia completo.
    pub total: i64,
    pub truncated: bool,
}

#[tauri::command]
pub async fn export_search(
    state: State<'_, AppState>,
    request: SearchRequest,
    name: Option<String>,
) -> Result<ExportResult, String> {
    let settings = current_settings(&state);
    let mut vector = None;
    if !request.query.trim().is_empty()
        && !request.keyword_only.unwrap_or(false)
        && settings.embeddings_ready()
    {
        if let Ok(mut vectors) =
            embed::embed_texts(vec![request.query.trim().to_string()], &settings, true).await
        {
            vector = vectors.pop();
        }
    }
    let mut export_request = request.clone();
    // Un solo passaggio fino al tetto massimo: paginare a 500 righe per volta
    // costringeva a rifare il ranking semantico per ogni pagina.
    export_request.limit = Some(search::MAX_RESULTS);
    export_request.offset = Some(0);

    let db = state.db.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let conn = db.conn();
        search::run(&conn, &export_request, vector.as_deref())
    })
    .await
    .map_err(to_error)?
    .map_err(to_error)?;

    let ids: Vec<String> = outcome.items.iter().map(|hit| hit.id.clone()).collect();
    let natures = {
        let conn = state.db.conn();
        load_natures(&conn, &ids)
    };
    let rows: Vec<ExportRow> = outcome
        .items
        .iter()
        .map(|hit| ExportRow {
            nature: natures.get(&hit.id).cloned(),
            ..export_row_from_hit(hit)
        })
        .collect();
    let stem = name.unwrap_or_else(|| {
        if request.query.trim().is_empty() {
            "gare".to_string()
        } else {
            request.query.clone()
        }
    });
    let path = export::export(&state.paths.exports_dir, &stem, &rows).map_err(to_error)?;
    let written = rows.len() as i64;
    Ok(ExportResult {
        path: path.to_string_lossy().to_string(),
        rows: written,
        total: outcome.total,
        truncated: outcome.total > written,
    })
}

/// Gare nascoste dall'utente: senza questo elenco il segnale "nascondi" era
/// irreversibile dall'interfaccia.
#[tauri::command]
pub fn hidden_notices(state: State<'_, AppState>) -> Result<Vec<NoticeHit>, String> {
    let conn = state.db.conn();
    let sql = format!(
        "SELECT {HIT_COLUMNS} FROM notices n \
         JOIN user_signals s ON s.notice_id = n.id AND s.signal = 'hide' \
         ORDER BY s.created_at DESC"
    );
    let mut statement = conn.prepare(&sql).map_err(to_error)?;
    let mut items = statement
        .query_map([], search::hit_from_row)
        .map_err(to_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_error)?;
    search::attach_lots(&conn, &mut items).map_err(to_error)?;
    Ok(items)
}

// ---------------------------------------------------------------------------
// Ricerche salvate e digest

#[tauri::command]
pub async fn save_search(
    state: State<'_, AppState>,
    name: String,
    query: String,
    filters: SearchFilters,
    min_similarity: Option<f64>,
) -> Result<i64, String> {
    let settings = current_settings(&state);
    let threshold = min_similarity.unwrap_or(0.78);
    let id = {
        let conn = state.db.conn();
        search::insert_saved_search(&conn, &name, &query, &filters, threshold).map_err(to_error)?
    };

    if !query.trim().is_empty() && settings.embeddings_ready() {
        if let Ok(vectors) = embed::embed_texts(vec![query.clone()], &settings, true).await {
            if let Some(vector) = vectors.first() {
                let conn = state.db.conn();
                search::set_saved_search_embedding(
                    &conn,
                    id,
                    &embed::to_blob(vector),
                    &embed::status(&settings).model,
                )
                .map_err(to_error)?;
            }
        }
    }
    Ok(id)
}

#[tauri::command]
pub fn list_saved_searches(state: State<'_, AppState>) -> Result<Vec<SavedSearch>, String> {
    let conn = state.db.conn();
    search::list_saved_searches(&conn).map_err(to_error)
}

#[tauri::command]
pub fn delete_saved_search(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.conn();
    conn.execute("DELETE FROM saved_searches WHERE id = ?", [id])
        .map_err(to_error)?;
    Ok(())
}

#[tauri::command]
pub fn set_saved_search_active(
    state: State<'_, AppState>,
    id: i64,
    active: bool,
) -> Result<(), String> {
    let conn = state.db.conn();
    conn.execute(
        "UPDATE saved_searches SET active = ? WHERE id = ?",
        rusqlite::params![active as i64, id],
    )
    .map_err(to_error)?;
    Ok(())
}

#[tauri::command]
pub async fn send_test_email(state: State<'_, AppState>) -> Result<(), String> {
    let settings = current_settings(&state);
    tokio::task::spawn_blocking(move || crate::alerts::send_test(&settings))
        .await
        .map_err(to_error)?
        .map_err(to_error)
}

#[tauri::command]
pub async fn preview_digest(
    state: State<'_, AppState>,
    search_id: Option<i64>,
) -> Result<Option<crate::alerts::Digest>, String> {
    let settings = current_settings(&state);
    let db = state.db.clone();
    crate::alerts::build_digest(&db, &settings, search_id, settings.digest_days)
        .await
        .map_err(to_error)
}

#[tauri::command]
pub async fn send_digest(
    state: State<'_, AppState>,
    search_id: Option<i64>,
) -> Result<crate::alerts::DigestReport, String> {
    let settings = current_settings(&state);
    let db = state.db.clone();
    crate::alerts::run(db, settings, search_id, true)
        .await
        .map_err(to_error)
}

// ---------------------------------------------------------------------------
// Valutazione della relazione tecnica

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationInput {
    pub report: String,
    #[serde(default)]
    pub criteria: Vec<Criterion>,
    pub notice_id: Option<String>,
    pub report_title: Option<String>,
    #[serde(default)]
    pub save: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationOutput {
    pub evaluation: Evaluation,
    pub criteria: Vec<Criterion>,
    pub saved_id: Option<i64>,
}

#[tauri::command]
pub fn evaluate_report(
    state: State<'_, AppState>,
    input: EvaluationInput,
) -> Result<EvaluationOutput, String> {
    let criteria = if input.criteria.is_empty() {
        evaluate::default_criteria()
    } else {
        input.criteria
    };
    let evaluation = evaluate::evaluate(&input.report, &criteria);
    let mut saved_id = None;
    if input.save {
        let conn = state.db.conn();
        saved_id = Some(
            evaluate::save(
                &conn,
                input.notice_id.as_deref(),
                input.report_title.as_deref(),
                &input.report,
                &criteria,
                &evaluation,
            )
            .map_err(to_error)?,
        );
    }
    Ok(EvaluationOutput {
        evaluation,
        criteria,
        saved_id,
    })
}

#[tauri::command]
pub fn list_evaluations(state: State<'_, AppState>) -> Result<Vec<SavedEvaluation>, String> {
    let conn = state.db.conn();
    evaluate::list(&conn, 30).map_err(to_error)
}

#[tauri::command]
pub fn delete_evaluation(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.conn();
    conn.execute("DELETE FROM evaluations WHERE id = ?", [id])
        .map_err(to_error)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Impostazioni e embedding

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    current_settings(&state)
}

#[tauri::command]
pub fn save_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    // Serializza i salvataggi ed evita che memoria e file usino valori diversi.
    let settings = settings.sanitized();
    let mut guard = state.settings.write().map_err(to_error)?;
    let previous = guard.clone();
    let model_changed = previous.embedding_provider != settings.embedding_provider
        || previous.api_model != settings.api_model
        || (settings.embedding_provider == "api" && previous.api_base_url != settings.api_base_url);
    if model_changed {
        // Le tabelle sono derivate e ricostruibili: cancellarle insieme prima
        // di cambiare provider evita di mescolare vettori incompatibili.
        let mut conn = state.db.conn();
        let tx = conn.transaction().map_err(to_error)?;
        tx.execute("DELETE FROM notice_embedding", []).map_err(to_error)?;
        tx.execute("DELETE FROM search_embedding", []).map_err(to_error)?;
        tx.commit().map_err(to_error)?;
    }
    settings.save(&state.paths.settings_path).map_err(to_error)?;
    *guard = settings.clone();
    Ok(settings)
}

#[tauri::command]
pub async fn embedding_status(state: State<'_, AppState>) -> Result<EmbeddingStatus, String> {
    let settings = current_settings(&state);
    tokio::task::spawn_blocking(move || embed::status(&settings))
        .await
        .map_err(to_error)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmbedProgress {
    pub done: i64,
    pub total: i64,
    pub message: String,
}

#[tauri::command]
pub async fn embed_pending(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<EmbedProgress, String> {
    let settings = current_settings(&state);
    if !settings.embeddings_ready() {
        return Err("nessun provider di embedding configurato".into());
    }
    let model = embed::status(&settings).model;
    let total: i64 = {
        let conn = state.db.conn();
        conn.query_row(
            "SELECT COUNT(*) FROM notices n WHERE NOT EXISTS \
             (SELECT 1 FROM notice_embedding e WHERE e.notice_id = n.id)",
            [],
            |row| row.get(0),
        )
        .map_err(to_error)?
    };

    let mut done = 0i64;
    loop {
        let rows: Vec<(String, String, Option<String>, Option<String>)> = {
            let conn = state.db.conn();
            let mut statement = conn
                .prepare(
                    "SELECT n.id, n.title, n.description, n.buyer_name
                     FROM notices n
                     WHERE NOT EXISTS (SELECT 1 FROM notice_embedding e WHERE e.notice_id = n.id)
                     ORDER BY n.published_at DESC LIMIT 32",
                )
                .map_err(to_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .map_err(to_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(to_error)?;
            rows
        };
        if rows.is_empty() {
            break;
        }

        // Stessa composizione del testo e dell'hash usata dall'ingestione: se
        // divergessero, ogni re-ingest invaliderebbe i vettori appena calcolati.
        let texts: Vec<String> = rows
            .iter()
            .map(|(_, title, description, buyer)| {
                crate::db::embedding_text(title, description.as_deref(), buyer.as_deref())
            })
            .collect();
        let hashes: Vec<String> = rows
            .iter()
            .map(|(_, title, description, buyer)| {
                crate::db::text_hash(title, description.as_deref(), buyer.as_deref())
            })
            .collect();
        let vectors = embed::embed_texts(texts, &settings, false)
            .await
            .map_err(to_error)?;

        {
            // Mantieni il lock delle impostazioni fino al commit: un cambio di
            // modello non deve lasciare in archivio vettori del modello vecchio.
            let current = state.settings.read().map_err(to_error)?;
            if current.embedding_provider != settings.embedding_provider
                || current.api_model != settings.api_model
                || (settings.embedding_provider == "api" && current.api_base_url != settings.api_base_url)
            {
                return Err("Il modello è cambiato durante il calcolo: riavvia la vettorizzazione.".into());
            }
            let mut conn = state.db.conn();
            let tx = conn.transaction().map_err(to_error)?;
            for (((id, title, description, buyer), vector), hash) in
                rows.iter().zip(vectors.iter()).zip(hashes.iter())
            {
                // L'ingestione potrebbe aver modificato il testo mentre il
                // modello lavorava. Non associare mai un vettore obsoleto.
                let changed = tx.execute(
                    "INSERT INTO notice_embedding (notice_id, embedding, model, dims, updated_at)
                     SELECT ?, ?, ?, ?, ? WHERE EXISTS (
                       SELECT 1 FROM notices WHERE id = ? AND title = ?
                         AND description IS ? AND buyer_name IS ?)
                     ON CONFLICT(notice_id) DO UPDATE SET embedding = excluded.embedding,
                     model = excluded.model, dims = excluded.dims, updated_at = excluded.updated_at",
                    rusqlite::params![id, embed::to_blob(vector), model,
                        embed::EMBEDDING_DIMS as i64, now_iso(), id, title, description, buyer],
                ).map_err(to_error)?;
                if changed != 0 {
                    tx.execute("UPDATE notices SET text_hash = ? WHERE id = ?",
                        rusqlite::params![hash, id]).map_err(to_error)?;
                }
            }
            tx.commit().map_err(to_error)?;
        }

        done += rows.len() as i64;
        let _ = app.emit(
            "embed-progress",
            EmbedProgress {
                done,
                total,
                message: format!("{done} di {total} avvisi vettorizzati"),
            },
        );
    }

    Ok(EmbedProgress {
        done,
        total,
        message: format!("{done} avvisi vettorizzati"),
    })
}

// ---------------------------------------------------------------------------
// Ingestione

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestOutcome {
    pub stats: IngestStats,
    pub embedded: i64,
}

#[tauri::command]
pub async fn ingest_range(
    app: AppHandle,
    state: State<'_, AppState>,
    from: String,
    to: String,
    notice_types: Option<Vec<String>>,
) -> Result<IngestStats, String> {
    let Some(_guard) = IngestGuard::acquire() else {
        return Err("un'importazione è già in corso: attendi che finisca".into());
    };
    let types = notice_types.filter(|list| !list.is_empty()).unwrap_or_else(ingest::all_notice_types);
    let db_path = state.db.path.clone();

    let run_id: i64 = {
        let conn = state.db.conn();
        conn.execute(
            "INSERT INTO ingest_runs (source, from_date, to_date, status)
             VALUES ('ted', ?, ?, 'running')",
            rusqlite::params![from, to],
        )
        .map_err(to_error)?;
        conn.last_insert_rowid()
    };

    let app_for_progress = app.clone();
    let result = ingest::run(db_path, from.clone(), to.clone(), types, move |progress| {
        let _ = app_for_progress.emit("ingest-progress", &progress);
    })
    .await;

    match result {
        Ok(stats) => {
            let conn = state.db.conn();
            let _ = conn.execute(
                "UPDATE ingest_runs SET finished_at = ?, status = 'done', fetched = ?, saved = ?, \
                 skipped = ?, awards = ? WHERE id = ?",
                rusqlite::params![
                    stats.finished_at.clone(),
                    stats.fetched as i64,
                    stats.saved as i64,
                    stats.skipped as i64,
                    stats.awards as i64,
                    run_id
                ],
            );
            Ok(stats)
        }
        Err(err) => {
            let conn = state.db.conn();
            let _ = conn.execute(
                "UPDATE ingest_runs SET finished_at = ?, status = 'error', message = ? WHERE id = ?",
                rusqlite::params![now_iso(), err.to_string(), run_id],
            );
            Err(err.to_string())
        }
    }
}

#[tauri::command]
pub async fn ingest_anac_range(
    app: AppHandle,
    state: State<'_, AppState>,
    from: String,
    to: String,
    include_updates: Option<bool>,
) -> Result<IngestStats, String> {
    let Some(_guard) = IngestGuard::acquire() else {
        return Err("un'importazione è già in corso: attendi che finisca".into());
    };
    let db_path = state.db.path.clone();
    let run_id: i64 = {
        let conn = state.db.conn();
        conn.execute(
            "INSERT INTO ingest_runs (source, from_date, to_date, status)
             VALUES ('anac', ?, ?, 'running')",
            rusqlite::params![from, to],
        )
        .map_err(to_error)?;
        conn.last_insert_rowid()
    };

    let app_for_progress = app.clone();
    let result = crate::anac::run(
        db_path,
        from,
        to,
        include_updates.unwrap_or(true),
        move |progress| {
            let _ = app_for_progress.emit("ingest-progress", &progress);
        },
    )
    .await;

    match result {
        Ok(stats) => {
            let conn = state.db.conn();
            let _ = conn.execute(
                "UPDATE ingest_runs SET finished_at = ?, status = 'done', fetched = ?, saved = ?, \
                 skipped = ?, awards = ? WHERE id = ?",
                rusqlite::params![
                    stats.finished_at.clone(),
                    stats.fetched as i64,
                    stats.saved as i64,
                    stats.skipped as i64,
                    stats.awards as i64,
                    run_id
                ],
            );
            Ok(stats)
        }
        Err(err) => {
            let conn = state.db.conn();
            let _ = conn.execute(
                "UPDATE ingest_runs SET finished_at = ?, status = 'error', message = ? WHERE id = ?",
                rusqlite::params![now_iso(), err.to_string(), run_id],
            );
            Err(err.to_string())
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSummary {
    pub stats: Stats,
    pub runs: Vec<IngestRunRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRunRow {
    pub id: i64,
    pub source: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub from_date: Option<String>,
    pub to_date: Option<String>,
    pub fetched: i64,
    pub saved: i64,
    pub skipped: i64,
    pub awards: i64,
    pub status: String,
    pub message: Option<String>,
}

#[tauri::command]
pub fn data_summary(state: State<'_, AppState>) -> Result<DataSummary, String> {
    let conn = state.db.conn();
    let stats = search::stats(&conn).map_err(to_error)?;
    let mut statement = conn
        .prepare(
            "SELECT id, source, started_at, finished_at, from_date, to_date, fetched, saved,
                    skipped, awards, status, message
             FROM ingest_runs ORDER BY id DESC LIMIT 12",
        )
        .map_err(to_error)?;
    let runs = statement
        .query_map([], |row| {
            Ok(IngestRunRow {
                id: row.get(0)?,
                source: row.get(1)?,
                started_at: row.get(2)?,
                finished_at: row.get(3)?,
                from_date: row.get(4)?,
                to_date: row.get(5)?,
                fetched: row.get(6)?,
                saved: row.get(7)?,
                skipped: row.get(8)?,
                awards: row.get(9)?,
                status: row.get(10)?,
                message: row.get(11)?,
            })
        })
        .map_err(to_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(to_error)?;
    Ok(DataSummary { stats, runs })
}
