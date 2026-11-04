use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;

pub type DbResult<T> = Result<T, rusqlite::Error>;

pub struct Db {
    conn: Mutex<Connection>,
    pub path: PathBuf,
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Self> {
        let conn = Self::connect(path)?;
        migrate(&conn)?;
        conn.execute_batch(include_str!("schema.sql"))?;
        backfill_ted_national_ids(&conn)?;
        dedupe_cig_duplicates(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        })
    }

    /// A configured connection; ingestion uses its own so the UI stays responsive.
    pub fn connect(path: &Path) -> DbResult<Connection> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(15))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        // `synchronous` non restituisce righe: va eseguito, non interrogato.
        conn.execute_batch("PRAGMA synchronous = NORMAL;")?;
        Ok(conn)
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        // Un panic in un'altra richiesta non deve rendere l'app inutilizzabile.
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn table_exists(conn: &Connection, table: &str) -> DbResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        [table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> DbResult<bool> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn add_column(conn: &Connection, table: &str, column: &str, definition: &str) -> DbResult<()> {
    if table_exists(conn, table)? && !column_exists(conn, table, column)? {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

/// Migrazioni idempotenti per i database creati dalle versioni precedenti.
/// Le tabelle nuove sono in `schema.sql`; qui si aggiungono solo le colonne
/// che `CREATE TABLE IF NOT EXISTS` non può aggiungere a una tabella esistente.
fn migrate(conn: &Connection) -> DbResult<()> {
    add_column(conn, "notices", "source", "TEXT NOT NULL DEFAULT 'ted'")?;
    add_column(conn, "ingest_runs", "source", "TEXT NOT NULL DEFAULT 'ted'")?;
    add_column(
        conn,
        "followed_entities",
        "min_similarity",
        "REAL NOT NULL DEFAULT 0.75",
    )?;
    add_column(
        conn,
        "followed_entities",
        "active",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column(conn, "notices", "text_hash", "TEXT")?;
    add_column(conn, "lots", "lot_number", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "lots", "description", "TEXT")?;
    add_column(conn, "lots", "awarded_value", "REAL")?;
    add_column(conn, "lots", "status", "TEXT")?;
    migrate_user_signals_pk(conn)?;
    Ok(())
}

/// Le prime versioni usavano `notice_id` come chiave primaria, quindi nascondere
/// una gara cancellava l'eventuale segnale «interessa». Lo schema attuale ha la
/// chiave composta `(notice_id, signal)`: qui si ricostruisce la tabella dei
/// database già esistenti senza perdere i segnali registrati.
fn migrate_user_signals_pk(conn: &Connection) -> DbResult<()> {
    if !table_exists(conn, "user_signals")? {
        return Ok(());
    }
    let sql: String = conn.query_row(
        "SELECT COALESCE(sql, '') FROM sqlite_master WHERE type = 'table' AND name = 'user_signals'",
        [],
        |row| row.get(0),
    )?;
    let compact: String = sql
        .to_lowercase()
        .chars()
        .filter(|value| !value.is_whitespace())
        .collect();
    if compact.contains("primarykey(notice_id,signal)") {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "DROP INDEX IF EXISTS user_signals_signal_idx;
         ALTER TABLE user_signals RENAME TO user_signals_legacy;
         CREATE TABLE user_signals (
           notice_id  TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
           signal     TEXT NOT NULL CHECK (signal IN ('hide', 'interest')),
           created_at TEXT NOT NULL DEFAULT (datetime('now')),
           PRIMARY KEY (notice_id, signal)
         );
         INSERT OR IGNORE INTO user_signals (notice_id, signal, created_at)
           SELECT notice_id, signal, created_at FROM user_signals_legacy;
         DROP TABLE user_signals_legacy;
         CREATE INDEX IF NOT EXISTS user_signals_signal_idx
           ON user_signals (signal, created_at DESC);",
    )?;
    tx.commit()?;
    Ok(())
}

/// Backfill una tantum: i TED già in archivio non hanno `notice_flags`, quindi
/// senza questo passaggio il CIG estratto dal testo varrebbe solo per i nuovi
/// avvisi e la deduplica con ANAC resterebbe incompleta.
fn backfill_ted_national_ids(conn: &Connection) -> DbResult<()> {
    const MARKER: &str = "ted_national_ids_v1";
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM schema_meta WHERE key = ?",
        [MARKER],
        |row| row.get(0),
    )?;
    if done > 0 {
        return Ok(());
    }

    let rows: Vec<(String, String)> = {
        let mut statement = conn.prepare(
            "SELECT n.id, n.raw FROM notices n
             WHERE n.source = 'ted' AND n.raw IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM notice_flags f WHERE f.notice_id = n.id)",
        )?;
        let mapped = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let tx = conn.unchecked_transaction()?;
    {
        let mut insert = tx.prepare(
            "INSERT OR IGNORE INTO notice_flags
                (notice_id, cig, cup, pnrr, pnrr_pnc, cig_accordo_quadro, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
        )?;
        for (id, raw) in &rows {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
                continue;
            };
            let flags = crate::ted::normalize::extract_flags_from_notice(&value);
            if flags.cig.is_none()
                && flags.cup.is_none()
                && flags.cig_accordo_quadro.is_none()
                && !flags.pnrr
                && !flags.pnrr_pnc
            {
                continue;
            }
            insert.execute(rusqlite::params![
                id,
                flags.cig,
                flags.cup,
                flags.pnrr as i64,
                flags.pnrr_pnc as i64,
                flags.cig_accordo_quadro
            ])?;
        }
        tx.execute(
            "INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = excluded.updated_at",
            rusqlite::params![MARKER, rows.len().to_string()],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// I TED ripubblicati (corrigenda, proroghe) hanno id diversi ma lo stesso
/// CIG. L'ingest li unisce quando arrivano insieme; questo passaggio una
/// tantum ripulisce i doppioni già in archivio, conservando la scheda con più
/// dati e i collegamenti dell'utente.
fn dedupe_cig_duplicates(conn: &Connection) -> DbResult<()> {
    const MARKER: &str = "cig_dedupe_v1";
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM schema_meta WHERE key = ?",
        [MARKER],
        |row| row.get(0),
    )?;
    if done > 0 {
        return Ok(());
    }

    let duplicates: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT cig FROM notice_flags
             WHERE cig IS NOT NULL
             GROUP BY cig HAVING COUNT(*) > 1",
        )?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let tx = conn.unchecked_transaction()?;
    let mut merged = 0usize;
    for cig in &duplicates {
        let candidates: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT n.id,
                    (CASE WHEN n.description IS NOT NULL AND n.description <> '' THEN 3 ELSE 0 END)
                    + (CASE WHEN n.buyer_name IS NOT NULL AND n.buyer_name <> '' THEN 1 ELSE 0 END)
                    + (CASE WHEN n.estimated_value IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN n.awarded_value IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN n.discount_pct IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN n.deadline_at IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN n.region IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN n.province IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN n.url IS NOT NULL THEN 1 ELSE 0 END)
                    + (SELECT COUNT(*) FROM notice_cpv c WHERE c.notice_id = n.id)
                    + (SELECT COUNT(*) FROM awards a WHERE a.notice_id = n.id)
                    + (SELECT COUNT(*) FROM lots l WHERE l.notice_id = n.id)
                    + (CASE WHEN EXISTS (
                        SELECT 1 FROM notice_flags f WHERE f.notice_id = n.id
                      ) THEN 1 ELSE 0 END)
                    + (CASE WHEN EXISTS (
                        SELECT 1 FROM user_signals s WHERE s.notice_id = n.id
                      ) THEN 5 ELSE 0 END)
                    + (CASE WHEN EXISTS (
                        SELECT 1 FROM board_items b WHERE b.notice_id = n.id
                      ) THEN 5 ELSE 0 END)
                    AS score
                 FROM notices n
                 WHERE n.id IN (SELECT notice_id FROM notice_flags WHERE cig = ?)
                 ORDER BY score DESC,
                          COALESCE(n.published_at, n.published_on, n.created_at) DESC,
                          n.id",
            )?;
            let rows = statement.query_map([cig], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        if let Some((keeper, losers)) = candidates.split_first() {
            for loser in losers {
                merge_duplicate_notice(&tx, keeper, loser)?;
                merged += 1;
            }
        }
    }

    tx.execute(
        "INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at",
        rusqlite::params![MARKER, merged.to_string()],
    )?;
    tx.commit()?;
    Ok(())
}

struct NoticeMergeFields {
    source: String,
    kind: String,
    description: Option<String>,
    buyer_id: Option<String>,
    buyer_name: Option<String>,
    buyer_city: Option<String>,
    contract_nature: Option<String>,
    procedure_type: Option<String>,
    estimated_value: Option<f64>,
    awarded_value: Option<f64>,
    discount_pct: Option<f64>,
    published_at: Option<String>,
    published_on: Option<String>,
    deadline_at: Option<String>,
    place_city: Option<String>,
    province: Option<String>,
    region: Option<String>,
    url: Option<String>,
    cpv_codes: String,
    embedded_at: Option<String>,
}

/// Unisce il doppione `loser` nella scheda `keeper`, poi elimina il doppione.
/// I segnali, la bacheca e le valutazioni restano agganciati alla scheda
/// conservata; i campi mancanti vengono completati.
fn merge_duplicate_notice(conn: &Connection, keeper: &str, loser: &str) -> DbResult<()> {
    let fields = conn.query_row(
        "SELECT source, kind, description, buyer_id, buyer_name, buyer_city,
                contract_nature, procedure_type, estimated_value, awarded_value,
                discount_pct, published_at, published_on, deadline_at, place_city,
                province, region, url, cpv_codes, embedded_at
         FROM notices WHERE id = ?",
        [loser],
        |row| {
            Ok(NoticeMergeFields {
                source: row.get(0)?,
                kind: row.get(1)?,
                description: row.get(2)?,
                buyer_id: row.get(3)?,
                buyer_name: row.get(4)?,
                buyer_city: row.get(5)?,
                contract_nature: row.get(6)?,
                procedure_type: row.get(7)?,
                estimated_value: row.get(8)?,
                awarded_value: row.get(9)?,
                discount_pct: row.get(10)?,
                published_at: row.get(11)?,
                published_on: row.get(12)?,
                deadline_at: row.get(13)?,
                place_city: row.get(14)?,
                province: row.get(15)?,
                region: row.get(16)?,
                url: row.get(17)?,
                cpv_codes: row.get(18)?,
                embedded_at: row.get(19)?,
            })
        },
    )?;

    // Segnali: per ogni tipo (interesse/nascosto) vince il più recente. La
    // chiave composta permette a una gara di essere insieme interessante e
    // nascosta, quindi non si può assumere una sola riga per scheda.
    let loser_signals: Vec<(String, String)> = {
        let mut statement = conn
            .prepare("SELECT signal, created_at FROM user_signals WHERE notice_id = ?")?;
        let rows = statement.query_map([loser], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (signal, created_at) in loser_signals {
        conn.execute(
            "INSERT INTO user_signals (notice_id, signal, created_at) VALUES (?, ?, ?)
             ON CONFLICT(notice_id, signal) DO UPDATE SET created_at = excluded.created_at
             WHERE excluded.created_at > user_signals.created_at",
            rusqlite::params![keeper, signal, created_at],
        )?;
    }
    conn.execute("DELETE FROM user_signals WHERE notice_id = ?", [loser])?;

    let keeper_on_board: i64 = conn.query_row(
        "SELECT COUNT(*) FROM board_items WHERE notice_id = ?",
        [keeper],
        |row| row.get(0),
    )?;
    if keeper_on_board == 0 {
        conn.execute(
            "UPDATE OR IGNORE board_items SET notice_id = ? WHERE notice_id = ?",
            rusqlite::params![keeper, loser],
        )?;
    }
    conn.execute(
        "UPDATE evaluations SET notice_id = ? WHERE notice_id = ?",
        rusqlite::params![keeper, loser],
    )?;
    conn.execute(
        "UPDATE OR IGNORE awards SET notice_id = ? WHERE notice_id = ?",
        rusqlite::params![keeper, loser],
    )?;

    let keeper_embedded: i64 = conn.query_row(
        "SELECT COUNT(*) FROM notice_embedding WHERE notice_id = ?",
        [keeper],
        |row| row.get(0),
    )?;
    if keeper_embedded == 0 {
        conn.execute(
            "UPDATE OR IGNORE notice_embedding SET notice_id = ? WHERE notice_id = ?",
            rusqlite::params![keeper, loser],
        )?;
    }

    conn.execute(
        "INSERT OR IGNORE INTO notice_cpv (notice_id, cpv)
         SELECT ?, cpv FROM notice_cpv WHERE notice_id = ?",
        rusqlite::params![keeper, loser],
    )?;

    let keeper_lots: i64 = conn.query_row(
        "SELECT COUNT(*) FROM lots WHERE notice_id = ?",
        [keeper],
        |row| row.get(0),
    )?;
    let loser_lots: i64 = conn.query_row(
        "SELECT COUNT(*) FROM lots WHERE notice_id = ?",
        [loser],
        |row| row.get(0),
    )?;
    if loser_lots > keeper_lots {
        conn.execute("DELETE FROM lots WHERE notice_id = ?", [keeper])?;
        conn.execute(
            "UPDATE lots SET notice_id = ?, id = ? || '-lot-' || lot_number
             WHERE notice_id = ?",
            rusqlite::params![keeper, keeper, loser],
        )?;
    }

    conn.execute(
        "INSERT INTO notice_flags (notice_id, cig, cup, pnrr, pnrr_pnc, esito,
            esito_at, cig_accordo_quadro, lot_count, source_dataset, updated_at)
         SELECT ?, cig, cup, pnrr, pnrr_pnc, esito, esito_at, cig_accordo_quadro,
                lot_count, source_dataset, updated_at
         FROM notice_flags WHERE notice_id = ?
         ON CONFLICT(notice_id) DO UPDATE SET
            cig = COALESCE(notice_flags.cig, excluded.cig),
            cup = COALESCE(notice_flags.cup, excluded.cup),
            pnrr = MAX(notice_flags.pnrr, excluded.pnrr),
            pnrr_pnc = MAX(notice_flags.pnrr_pnc, excluded.pnrr_pnc),
            esito = COALESCE(notice_flags.esito, excluded.esito),
            esito_at = COALESCE(notice_flags.esito_at, excluded.esito_at),
            cig_accordo_quadro = COALESCE(notice_flags.cig_accordo_quadro,
                excluded.cig_accordo_quadro),
            lot_count = COALESCE(notice_flags.lot_count, excluded.lot_count),
            source_dataset = COALESCE(notice_flags.source_dataset, excluded.source_dataset),
            updated_at = excluded.updated_at",
        rusqlite::params![keeper, loser],
    )?;

    let keeper_description: Option<String> = conn.query_row(
        "SELECT description FROM notices WHERE id = ?",
        [keeper],
        |row| row.get(0),
    )?;
    let description = if fields
        .description
        .as_ref()
        .map(|value| value.len())
        .unwrap_or(0)
        > keeper_description
            .as_ref()
            .map(|value| value.len())
            .unwrap_or(0)
    {
        fields.description.clone()
    } else {
        keeper_description
    };

    let keeper_cpv: String = conn.query_row(
        "SELECT cpv_codes FROM notices WHERE id = ?",
        [keeper],
        |row| row.get(0),
    )?;
    let mut cpv_codes = parse_string_list(&keeper_cpv);
    for code in parse_string_list(&fields.cpv_codes) {
        if !cpv_codes.contains(&code) {
            cpv_codes.push(code);
        }
    }

    conn.execute(
        "UPDATE notices SET
            source = CASE WHEN source = 'ted' OR ? = 'ted' THEN 'ted' ELSE source END,
            kind = CASE WHEN kind = 'call' AND ? = 'award' THEN 'award' ELSE kind END,
            description = COALESCE(?, description),
            buyer_id = COALESCE(buyer_id, ?),
            buyer_name = COALESCE(NULLIF(buyer_name, ''), ?),
            buyer_city = COALESCE(buyer_city, ?),
            contract_nature = COALESCE(contract_nature, ?),
            procedure_type = COALESCE(procedure_type, ?),
            estimated_value = COALESCE(estimated_value, ?),
            awarded_value = COALESCE(awarded_value, ?),
            discount_pct = COALESCE(discount_pct, ?),
            published_at = CASE WHEN ? IS NOT NULL
                AND (published_at IS NULL OR ? > published_at) THEN ? ELSE published_at END,
            published_on = CASE WHEN ? IS NOT NULL
                AND (published_on IS NULL OR ? > published_on) THEN ? ELSE published_on END,
            deadline_at = CASE WHEN ? IS NOT NULL
                AND (deadline_at IS NULL OR ? > deadline_at) THEN ? ELSE deadline_at END,
            place_city = COALESCE(place_city, ?),
            province = COALESCE(province, ?),
            region = COALESCE(region, ?),
            url = COALESCE(url, ?),
            cpv_codes = ?,
            embedded_at = COALESCE(embedded_at, ?),
            updated_at = datetime('now')
         WHERE id = ?",
        rusqlite::params![
            fields.source,
            fields.kind,
            description,
            fields.buyer_id,
            fields.buyer_name,
            fields.buyer_city,
            fields.contract_nature,
            fields.procedure_type,
            fields.estimated_value,
            fields.awarded_value,
            fields.discount_pct,
            fields.published_at,
            fields.published_at,
            fields.published_at,
            fields.published_on,
            fields.published_on,
            fields.published_on,
            fields.deadline_at,
            fields.deadline_at,
            fields.deadline_at,
            fields.place_city,
            fields.province,
            fields.region,
            fields.url,
            to_string_list_json(&cpv_codes),
            fields.embedded_at,
            keeper
        ],
    )?;

    // I documenti caricati dall'utente non devono essere cancellati insieme
    // al doppione. Se lo stesso contenuto esiste già, conserva un'analisi
    // disponibile; altrimenti riaggancia il documento senza cambiarne l'id.
    let documents: Vec<(String, String)> = {
        let mut statement = conn.prepare("SELECT id, hash FROM notice_documents WHERE notice_id = ?")?;
        let rows = statement.query_map([loser], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (document_id, hash) in documents {
        use rusqlite::OptionalExtension;
        let existing: Option<String> = conn.query_row(
            "SELECT id FROM notice_documents WHERE notice_id = ? AND hash = ?",
            rusqlite::params![keeper, hash], |row| row.get(0),
        ).optional()?;
        if let Some(existing_id) = existing {
            conn.execute(
                "INSERT OR IGNORE INTO document_analysis (document_id, version, payload, created_at)
                 SELECT ?, version, payload, created_at FROM document_analysis WHERE document_id = ?",
                rusqlite::params![existing_id, document_id],
            )?;
        } else {
            conn.execute("UPDATE notice_documents SET notice_id = ? WHERE id = ?",
                rusqlite::params![keeper, document_id])?;
        }
    }

    conn.execute("DELETE FROM notices WHERE id = ?", [loser])?;
    Ok(())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Testo che finisce nel modello di embedding: stessa composizione usata dalla
/// pipeline e dal calcolo dell'hash, così i due non possono divergere.
pub fn embedding_text(title: &str, description: Option<&str>, buyer_name: Option<&str>) -> String {
    let joined = format!(
        "{title} {} {}",
        description.unwrap_or_default(),
        buyer_name.unwrap_or_default()
    );
    joined
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(1200)
        .collect()
}

/// Hash FNV-1a del testo vettorizzato. Serve a distinguere un re-ingest che ha
/// davvero cambiato l'avviso da uno identico: senza, ogni importazione
/// azzererebbe i vettori di tutto l'intervallo e andrebbero ricalcolati.
pub fn text_hash(title: &str, description: Option<&str>, buyer_name: Option<&str>) -> String {
    let text = embedding_text(title, description, buyer_name);
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// JSON array of strings stored in `notices.cpv_codes`.
pub fn parse_string_list(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json).unwrap_or_default()
}

pub fn to_string_list_json(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

/// Cosine similarity from a sqlite-vec distance (both vectors normalized).
pub fn similarity_from_distance(distance: f32) -> f32 {
    (1.0 - distance).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Apertura di un database nuovo: crea lo schema, imposta i pragma e resta
    /// scrivibile. Copre l'avvio dell'app, che non deve mai fallire qui.
    #[test]
    fn opens_fresh_database() {
        let dir = std::env::temp_dir().join(format!("cig-db-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cig.db");

        let db = Db::open(&path).expect("apertura database");
        {
            let conn = db.conn();
            let tables: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'\n                     AND name IN ('notices', 'awards', 'board_items', 'saved_searches', 'alert_log',\n                     'user_signals', 'lots', 'followed_entities', 'notice_flags')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(tables, 9, "schema incompleto");
            let source: String = conn
                .query_row(
                    "SELECT dflt_value FROM pragma_table_info('notices') WHERE name = 'source'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(source, "'ted'");
            let mode: String = conn
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .unwrap();
            assert_eq!(mode.to_lowercase(), "wal");
            let sync: i64 = conn
                .query_row("PRAGMA synchronous", [], |row| row.get(0))
                .unwrap();
            assert_eq!(sync, 1, "synchronous NORMAL");
        }

        // Riapertura dello stesso file: `IF NOT EXISTS` deve rendere l'operazione idempotente.
        Db::open(&path).expect("riapertura database");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Un database della versione TED-only non ha `notices.source`: l'apertura
    /// deve aggiungerla senza perdere le righe esistenti.
    #[test]
    fn migrates_legacy_database() {
        let dir = std::env::temp_dir().join(format!("cig-db-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cig.db");

        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE notices (
                    id TEXT PRIMARY KEY,
                    notice_type TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    buyer_id TEXT,
                    buyer_name TEXT,
                    buyer_city TEXT,
                    cpv_codes TEXT NOT NULL DEFAULT '[]',
                    contract_nature TEXT,
                    procedure_type TEXT,
                    estimated_value REAL,
                    awarded_value REAL,
                    discount_pct REAL,
                    currency TEXT NOT NULL DEFAULT 'EUR',
                    published_at TEXT,
                    published_on TEXT,
                    deadline_at TEXT,
                    place_city TEXT,
                    province TEXT,
                    region TEXT,
                    url TEXT,
                    raw TEXT,
                    embedded_at TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO notices (id, notice_type, kind, title) VALUES ('legacy', 'cn-standard', 'call', 'Gara storica');
                CREATE TABLE ingest_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at TEXT NOT NULL DEFAULT (datetime('now')),
                    finished_at TEXT,
                    from_date TEXT,
                    to_date TEXT,
                    fetched INTEGER NOT NULL DEFAULT 0,
                    saved INTEGER NOT NULL DEFAULT 0,
                    skipped INTEGER NOT NULL DEFAULT 0,
                    awards INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'running',
                    message TEXT
                );
                CREATE TABLE followed_entities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE (entity_type, entity_id)
                );
                INSERT INTO followed_entities (entity_type, entity_id, name)
                VALUES ('supplier', 'cf-legacy', 'Impresa storica');",
            )
            .unwrap();
        }

        let db = Db::open(&path).expect("migrazione database legacy");
        {
            let conn = db.conn();
            let source: String = conn
                .query_row("SELECT source FROM notices WHERE id = 'legacy'", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(source, "ted");
            let run_source: String = conn
                .query_row(
                    "SELECT dflt_value FROM pragma_table_info('ingest_runs') WHERE name = 'source'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(run_source, "'ted'");
            let (similarity, active): (f64, i64) = conn
                .query_row(
                    "SELECT min_similarity, active FROM followed_entities WHERE entity_id = 'cf-legacy'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert!((similarity - 0.75).abs() < 1e-9);
            assert_eq!(active, 1);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// I TED già presenti devono ricevere CIG/CUP dal testo al primo avvio
    /// dopo l'aggiornamento, altrimenti la deduplica con ANAC vale solo per i
    /// nuovi avvisi.
    #[test]
    fn backfills_ted_national_ids_on_open() {
        let dir = std::env::temp_dir().join(format!("cig-db-backfill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cig.db");

        let db = Db::open(&path).unwrap();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO notices (id, source, notice_type, kind, title, raw)
                 VALUES ('ted-1', 'ted', 'can-standard', 'award', 'Lavori', ?)",
                [r#"{"publication-number":"ted-1","notice-title":{"ita":"Lavori"},
                     "description-lot":{"ita":"CIG: BAEA6A55C3 CUP: J81B21003260002 PNRR"}}"#],
            )
            .unwrap();
            conn.execute("DELETE FROM schema_meta WHERE key = 'ted_national_ids_v1'", [])
                .unwrap();
        }
        drop(db);

        let db = Db::open(&path).unwrap();
        {
            let conn = db.conn();
            let (cig, cup, pnrr): (String, String, i64) = conn
                .query_row(
                    "SELECT cig, cup, pnrr FROM notice_flags WHERE notice_id = 'ted-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(cig, "BAEA6A55C3");
            assert_eq!(cup, "J81B21003260002");
            assert_eq!(pnrr, 1);
            let marker: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM schema_meta WHERE key = 'ted_national_ids_v1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(marker, 1);
        }
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// I TED ripubblicati con lo stesso CIG non devono restare doppi: la
    /// scheda con i collegamenti dell'utente resta, il doppione la completa.
    #[test]
    fn dedupes_duplicate_cig_preserving_user_links() {
        let dir = std::env::temp_dir().join(format!("cig-db-dedupe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cig.db");

        let db = Db::open(&path).unwrap();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO notices (id, source, notice_type, kind, title, description,
                    buyer_name, estimated_value, region, published_on)
                 VALUES ('ted-old', 'ted', 'cn-standard', 'call', 'Depurazione', 'breve',
                    'Comune', 100.0, 'Campania', '2026-10-01')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO notices (id, source, notice_type, kind, title, description,
                    estimated_value, awarded_value, deadline_at, published_on)
                 VALUES ('ted-new', 'ted', 'cn-standard', 'call', 'Depurazione',
                    'descrizione molto più lunga', 100.0, 90.0,
                    '2026-12-01T12:00:00Z', '2026-10-20')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO notice_flags (notice_id, cig) VALUES ('ted-old', 'BCAE315E28')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO notice_flags (notice_id, cig) VALUES ('ted-new', 'BCAE315E28')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO user_signals (notice_id, signal) VALUES ('ted-old', 'interest')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO board_items (notice_id, column_key, note)
                 VALUES ('ted-old', 'valutare', 'da chiamare')",
                [],
            )
            .unwrap();
            conn.execute("DELETE FROM schema_meta WHERE key = 'cig_dedupe_v1'", [])
                .unwrap();
        }
        drop(db);

        let db = Db::open(&path).unwrap();
        {
            let conn = db.conn();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM notices", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1);
            let (description, awarded, deadline, region): (String, f64, String, String) = conn
                .query_row(
                    "SELECT description, awarded_value, deadline_at, region
                     FROM notices WHERE id = 'ted-old'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert_eq!(description, "descrizione molto più lunga");
            assert!((awarded - 90.0).abs() < 1e-9);
            assert_eq!(deadline, "2026-12-01T12:00:00Z");
            assert_eq!(region, "Campania");
            let signal: String = conn
                .query_row(
                    "SELECT signal FROM user_signals WHERE notice_id = 'ted-old'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(signal, "interest");
            let note: String = conn
                .query_row(
                    "SELECT note FROM board_items WHERE notice_id = 'ted-old'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(note, "da chiamare");
            let duplicates: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM (
                        SELECT cig FROM notice_flags WHERE cig IS NOT NULL
                        GROUP BY cig HAVING COUNT(*) > 1
                     )",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(duplicates, 0);
        }
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Un database creato prima della chiave composta non deve perdere il
    /// segnale «interessa» quando la stessa gara viene nascosta.
    #[test]
    fn migrates_user_signals_to_composite_key() {
        let dir = std::env::temp_dir().join(format!("cig-db-signals-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cig.db");

        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE notices (
                    id TEXT PRIMARY KEY,
                    notice_type TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    buyer_id TEXT,
                    buyer_name TEXT,
                    buyer_city TEXT,
                    cpv_codes TEXT NOT NULL DEFAULT '[]',
                    contract_nature TEXT,
                    procedure_type TEXT,
                    estimated_value REAL,
                    awarded_value REAL,
                    discount_pct REAL,
                    currency TEXT NOT NULL DEFAULT 'EUR',
                    published_at TEXT,
                    published_on TEXT,
                    deadline_at TEXT,
                    place_city TEXT,
                    province TEXT,
                    region TEXT,
                    url TEXT,
                    raw TEXT,
                    embedded_at TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO notices (id, notice_type, kind, title)
                VALUES ('n1', 'cn-standard', 'call', 'Gara con segnale');
                CREATE TABLE user_signals (
                    notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
                    signal TEXT NOT NULL CHECK (signal IN ('hide', 'interest')),
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE INDEX user_signals_signal_idx ON user_signals (signal, created_at DESC);
                INSERT INTO user_signals (notice_id, signal) VALUES ('n1', 'interest');",
            )
            .unwrap();
        }

        let db = Db::open(&path).unwrap();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO user_signals (notice_id, signal) VALUES ('n1', 'hide')",
                [],
            )
            .unwrap();
            let signals: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM user_signals WHERE notice_id = 'n1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(signals, 2, "interesse e nascosto devono coesistere");
            let index: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'index' AND name = 'user_signals_signal_idx'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(index, 1);
        }
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
