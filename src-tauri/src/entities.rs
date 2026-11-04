//! Profili degli enti: imprese aggiudicatarie e stazioni appaltanti.
//!
//! Un profilo riunisce storico, valori, ribassi, CPV e gare aperte collegate.
//! Gli enti seguiti alimentano il digest e le previsioni.

use anyhow::Result;
use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::Serialize;

use crate::db::{now_iso, parse_string_list};
use crate::search::{self, NoticeHit, SearchFilters, SearchRequest};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowedEntity {
    pub id: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub name: String,
    pub min_similarity: f64,
    pub active: bool,
    pub created_at: String,
    pub open_notices: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCount {
    pub key: String,
    pub label: String,
    pub count: i64,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityHistoryRow {
    pub id: String,
    pub source: String,
    pub kind: String,
    pub title: String,
    pub buyer_name: Option<String>,
    pub region: Option<String>,
    pub cpv_codes: Vec<String>,
    pub estimated_value: Option<f64>,
    pub awarded_value: Option<f64>,
    pub discount_pct: Option<f64>,
    pub published_at: Option<String>,
    pub deadline_at: Option<String>,
    pub url: Option<String>,
    pub suppliers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityProfile {
    pub entity_type: String,
    pub entity_id: String,
    pub name: String,
    pub followed: bool,
    pub contracts: i64,
    pub total_value: f64,
    pub avg_discount: Option<f64>,
    pub median_discount: Option<f64>,
    pub min_discount: Option<f64>,
    pub max_discount: Option<f64>,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    pub top_cpv: Vec<ProfileCount>,
    pub top_regions: Vec<ProfileCount>,
    /// Per un'impresa: le stazioni appaltanti con cui lavora di più.
    /// Per una stazione appaltante: le imprese che vincono di più.
    pub top_counterparties: Vec<ProfileCount>,
    pub history: Vec<EntityHistoryRow>,
    pub open_notices: Vec<NoticeHit>,
}

fn entity_type(value: &str) -> Result<&str> {
    match value {
        "supplier" | "buyer" => Ok(value),
        other => anyhow::bail!("tipo ente non valido: {other} (atteso supplier o buyer)"),
    }
}

fn resolve_name(conn: &Connection, kind: &str, id: &str) -> Option<String> {
    let sql = if kind == "supplier" {
        "SELECT name FROM suppliers WHERE id = ?"
    } else {
        "SELECT name FROM buyers WHERE id = ?"
    };
    if let Ok(name) = conn.query_row(sql, [id], |row| row.get::<_, String>(0)) {
        return Some(name);
    }
    if kind == "supplier" {
        return conn
            .query_row(
                "SELECT supplier_name FROM awards WHERE supplier_id = ? LIMIT 1",
                [id],
                |row| row.get(0),
            )
            .ok();
    }
    conn.query_row(
        "SELECT buyer_name FROM notices WHERE buyer_id = ? AND buyer_name IS NOT NULL LIMIT 1",
        [id],
        |row| row.get(0),
    )
    .ok()
}

pub fn follow_entity(
    conn: &Connection,
    kind: &str,
    entity_id: &str,
    name: Option<&str>,
) -> Result<()> {
    let kind = entity_type(kind)?;
    let entity_id = entity_id.trim();
    if entity_id.is_empty() {
        anyhow::bail!("identificativo dell'ente mancante");
    }
    let name = name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| resolve_name(conn, kind, entity_id))
        .unwrap_or_else(|| entity_id.to_string());
    conn.execute(
        "INSERT INTO followed_entities (entity_type, entity_id, name, min_similarity, created_at)
         VALUES (?, ?, ?, 0.75, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET name = excluded.name",
        params![kind, entity_id, name, now_iso()],
    )?;
    Ok(())
}

pub fn unfollow_entity(conn: &Connection, kind: &str, entity_id: &str) -> Result<()> {
    let kind = entity_type(kind)?;
    conn.execute(
        "DELETE FROM followed_entities WHERE entity_type = ? AND entity_id = ?",
        params![kind, entity_id],
    )?;
    Ok(())
}

/// Aggiorna soglia e stato di un ente seguito senza cambiare lo storico.
pub fn update_followed_entity(
    conn: &Connection,
    kind: &str,
    entity_id: &str,
    min_similarity: Option<f64>,
    active: Option<bool>,
) -> Result<()> {
    let kind = entity_type(kind)?;
    let entity_id = entity_id.trim();
    if entity_id.is_empty() {
        anyhow::bail!("identificativo dell'ente mancante");
    }
    if let Some(value) = min_similarity {
        conn.execute(
            "UPDATE followed_entities SET min_similarity = ? \
             WHERE entity_type = ? AND entity_id = ?",
            params![value.clamp(0.0, 1.0), kind, entity_id],
        )?;
    }
    if let Some(value) = active {
        conn.execute(
            "UPDATE followed_entities SET active = ? WHERE entity_type = ? AND entity_id = ?",
            params![if value { 1 } else { 0 }, kind, entity_id],
        )?;
    }
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM followed_entities WHERE entity_type = ? AND entity_id = ?",
        params![kind, entity_id],
        |row| row.get(0),
    )?;
    if exists == 0 {
        anyhow::bail!("ente non seguito");
    }
    Ok(())
}

pub fn list_followed_entities(conn: &Connection) -> Result<Vec<FollowedEntity>> {
    let mut statement = conn.prepare(
        "SELECT f.id, f.entity_type, f.entity_id, f.name, f.min_similarity, f.active, f.created_at,
                CASE f.entity_type
                  WHEN 'buyer' THEN (
                    SELECT COUNT(*) FROM notices n
                    WHERE n.buyer_id = f.entity_id AND n.kind = 'call'
                      AND (n.deadline_at IS NULL OR date(n.deadline_at, 'localtime') >= date('now', 'localtime'))
                      AND NOT EXISTS (SELECT 1 FROM user_signals s
                                      WHERE s.notice_id = n.id AND s.signal = 'hide')
                  )
                  ELSE (
                    SELECT COUNT(DISTINCT n.id) FROM notices n
                    JOIN notice_cpv c ON c.notice_id = n.id
                    WHERE n.kind = 'call'
                      AND (n.deadline_at IS NULL OR date(n.deadline_at, 'localtime') >= date('now', 'localtime'))
                      AND NOT EXISTS (SELECT 1 FROM user_signals s
                                      WHERE s.notice_id = n.id AND s.signal = 'hide')
                      AND substr(c.cpv, 1, 2) IN (
                        SELECT substr(c2.cpv, 1, 2) FROM awards a
                        JOIN notice_cpv c2 ON c2.notice_id = a.notice_id
                        WHERE a.supplier_id = f.entity_id
                      )
                  )
                END AS open_notices
         FROM followed_entities f ORDER BY f.created_at DESC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(FollowedEntity {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                name: row.get(3)?,
                min_similarity: row.get(4)?,
                active: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                open_notices: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        Some((values[middle - 1] + values[middle]) / 2.0)
    } else {
        Some(values[middle])
    }
}

fn count_rows(
    conn: &Connection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<ProfileCount>> {
    let mut statement = conn.prepare(sql)?;
    let mut rows = statement.query(params_from_iter(params.iter()))?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(ProfileCount {
            key: row.get(0)?,
            label: row.get(1)?,
            count: row.get(2)?,
            value: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
        });
    }
    Ok(result)
}

fn supplier_notice_ids(conn: &Connection, entity_id: &str) -> Result<Vec<String>> {
    let mut statement =
        conn.prepare("SELECT DISTINCT notice_id FROM awards WHERE supplier_id = ?")?;
    let rows = statement.query_map([entity_id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn history_for_ids(conn: &Connection, ids: &[String], limit: i64) -> Result<Vec<EntityHistoryRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!(
        "SELECT n.id, n.source, n.kind, n.title, n.buyer_name, n.region, n.cpv_codes,
                n.estimated_value, n.awarded_value, n.discount_pct, n.published_at,
                n.deadline_at, n.url,
                (SELECT GROUP_CONCAT(a.supplier_name, '||')
                 FROM awards a WHERE a.notice_id = n.id) AS suppliers
         FROM notices n WHERE n.id IN ({placeholders})
         ORDER BY COALESCE(n.published_at, n.created_at) DESC LIMIT ?"
    );
    let mut params: Vec<Value> = ids.iter().map(|id| Value::Text(id.clone())).collect();
    params.push(Value::Integer(limit));
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(params.iter()))?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        let cpv_json: String = row.get(6)?;
        let suppliers: Option<String> = row.get(13)?;
        result.push(EntityHistoryRow {
            id: row.get(0)?,
            source: row.get(1)?,
            kind: row.get(2)?,
            title: row.get(3)?,
            buyer_name: row.get(4)?,
            region: row.get(5)?,
            cpv_codes: parse_string_list(&cpv_json),
            estimated_value: row.get(7)?,
            awarded_value: row.get(8)?,
            discount_pct: row.get(9)?,
            published_at: row.get(10)?,
            deadline_at: row.get(11)?,
            url: row.get(12)?,
            suppliers: suppliers
                .map(|value| value.split("||").map(str::to_string).collect())
                .unwrap_or_default(),
        });
    }
    Ok(result)
}

fn top_cpv_for_ids(conn: &Connection, ids: &[String], limit: i64) -> Result<Vec<ProfileCount>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!(
        "SELECT c.cpv, c.cpv, COUNT(DISTINCT c.notice_id), SUM(n.awarded_value)
         FROM notice_cpv c JOIN notices n ON n.id = c.notice_id
         WHERE c.notice_id IN ({placeholders})
         GROUP BY c.cpv ORDER BY COUNT(DISTINCT c.notice_id) DESC, SUM(n.awarded_value) DESC
         LIMIT ?"
    );
    let mut params: Vec<Value> = ids.iter().map(|id| Value::Text(id.clone())).collect();
    params.push(Value::Integer(limit));
    count_rows(conn, &sql, &params)
}

fn top_regions_for_ids(conn: &Connection, ids: &[String], limit: i64) -> Result<Vec<ProfileCount>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!(
        "SELECT COALESCE(n.region, 'Non indicata'), COALESCE(n.region, 'Non indicata'),
                COUNT(*), SUM(n.awarded_value)
         FROM notices n WHERE n.id IN ({placeholders})
         GROUP BY COALESCE(n.region, 'Non indicata')
         ORDER BY COUNT(*) DESC, SUM(n.awarded_value) DESC LIMIT ?"
    );
    let mut params: Vec<Value> = ids.iter().map(|id| Value::Text(id.clone())).collect();
    params.push(Value::Integer(limit));
    count_rows(conn, &sql, &params)
}

fn top_counterparties_for_supplier(
    conn: &Connection,
    entity_id: &str,
    limit: i64,
) -> Result<Vec<ProfileCount>> {
    count_rows(
        conn,
        "SELECT COALESCE(n.buyer_id, n.buyer_name), COALESCE(n.buyer_name, 'Non indicata'),
                COUNT(DISTINCT n.id), SUM(a.awarded_value)
         FROM awards a JOIN notices n ON n.id = a.notice_id
         WHERE a.supplier_id = ?
         GROUP BY COALESCE(n.buyer_id, n.buyer_name)
         ORDER BY COUNT(DISTINCT n.id) DESC, SUM(a.awarded_value) DESC LIMIT ?",
        &[
            Value::Text(entity_id.to_string()),
            Value::Integer(limit),
        ],
    )
}

fn top_suppliers_for_buyer(
    conn: &Connection,
    entity_id: &str,
    limit: i64,
) -> Result<Vec<ProfileCount>> {
    count_rows(
        conn,
        "SELECT COALESCE(a.supplier_id, a.supplier_name), a.supplier_name,
                COUNT(DISTINCT a.notice_id), SUM(a.awarded_value)
         FROM awards a JOIN notices n ON n.id = a.notice_id
         WHERE n.buyer_id = ?
         GROUP BY COALESCE(a.supplier_id, a.supplier_name)
         ORDER BY COUNT(DISTINCT a.notice_id) DESC, SUM(a.awarded_value) DESC LIMIT ?",
        &[
            Value::Text(entity_id.to_string()),
            Value::Integer(limit),
        ],
    )
}

fn open_notices_for_buyer(conn: &Connection, entity_id: &str, limit: i64) -> Result<Vec<NoticeHit>> {
    let filters = SearchFilters {
        buyer_id: Some(entity_id.to_string()),
        kind: Some("call".into()),
        only_open: Some(true),
        ..Default::default()
    };
    let request = SearchRequest {
        query: String::new(),
        filters,
        limit: Some(limit),
        sort: Some("deadline".into()),
        ..Default::default()
    };
    Ok(search::run(conn, &request, None)?.items)
}

fn open_notices_for_supplier(
    conn: &Connection,
    entity_id: &str,
    limit: i64,
) -> Result<Vec<NoticeHit>> {
    let divisions: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT DISTINCT substr(c.cpv, 1, 2) FROM awards a
             JOIN notice_cpv c ON c.notice_id = a.notice_id
             WHERE a.supplier_id = ?",
        )?;
        let rows = statement.query_map([entity_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if divisions.is_empty() {
        return Ok(Vec::new());
    }
    // Il filtro CPV sta in SQL: scaricare le prime 200 gare aperte e filtrarle in
    // Rust poteva restituire zero risultati anche con match esistenti.
    let filters = SearchFilters {
        kind: Some("call".into()),
        only_open: Some(true),
        cpv_prefixes: Some(divisions),
        ..Default::default()
    };
    let request = SearchRequest {
        query: String::new(),
        filters,
        limit: Some(limit.max(1)),
        sort: Some("deadline".into()),
        ..Default::default()
    };
    Ok(search::run(conn, &request, None)?.items)
}

pub fn entity_profile(conn: &Connection, kind: &str, entity_id: &str) -> Result<EntityProfile> {
    let kind = entity_type(kind)?;
    let name = resolve_name(conn, kind, entity_id).unwrap_or_else(|| entity_id.to_string());
    let followed: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM followed_entities WHERE entity_type = ? AND entity_id = ?",
            params![kind, entity_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);

    let (ids, total_value, top_counterparties): (Vec<String>, f64, Vec<ProfileCount>) =
        if kind == "supplier" {
            let ids = supplier_notice_ids(conn, entity_id)?;
            let total: f64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(awarded_value), 0) FROM awards WHERE supplier_id = ?",
                    [entity_id],
                    |row| row.get(0),
                )
                .unwrap_or(0.0);
            let counterparties = top_counterparties_for_supplier(conn, entity_id, 8)?;
            (ids, total, counterparties)
        } else {
            let ids: Vec<String> = {
                let mut statement = conn.prepare(
                    "SELECT id FROM notices WHERE buyer_id = ? AND
                     (kind = 'award' OR awarded_value IS NOT NULL OR discount_pct IS NOT NULL)
                     ORDER BY COALESCE(published_at, created_at) DESC",
                )?;
                let rows = statement.query_map([entity_id], |row| row.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let total: f64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(awarded_value), 0) FROM notices WHERE buyer_id = ?",
                    [entity_id],
                    |row| row.get(0),
                )
                .unwrap_or(0.0);
            let counterparties = top_suppliers_for_buyer(conn, entity_id, 8)?;
            (ids, total, counterparties)
        };

    let history = history_for_ids(conn, &ids, 80)?;
    let mut discounts: Vec<f64> = history
        .iter()
        .filter_map(|row| row.discount_pct)
        .collect();
    let avg_discount = if discounts.is_empty() {
        None
    } else {
        Some(discounts.iter().sum::<f64>() / discounts.len() as f64)
    };
    let min_discount = discounts
        .iter()
        .copied()
        .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let max_discount = discounts
        .iter()
        .copied()
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_discount = median(&mut discounts);
    let first_at = history
        .iter()
        .filter_map(|row| row.published_at.clone())
        .min();
    let last_at = history
        .iter()
        .filter_map(|row| row.published_at.clone())
        .max();

    let top_cpv = top_cpv_for_ids(conn, &ids, 8)?;
    let top_regions = top_regions_for_ids(conn, &ids, 8)?;
    let open_notices = if kind == "buyer" {
        open_notices_for_buyer(conn, entity_id, 10)?
    } else {
        open_notices_for_supplier(conn, entity_id, 10)?
    };

    Ok(EntityProfile {
        entity_type: kind.to_string(),
        entity_id: entity_id.to_string(),
        name,
        followed,
        contracts: ids.len() as i64,
        total_value,
        avg_discount,
        median_discount,
        min_discount,
        max_discount,
        first_at,
        last_at,
        top_cpv,
        top_regions,
        top_counterparties,
        history,
        open_notices,
    })
}

/// Mappa nome normalizzato -> id per i suggerimenti di ricerca degli enti.
pub fn entity_suggestions(
    conn: &Connection,
    kind: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<ProfileCount>> {
    let kind = entity_type(kind)?;
    let needle = format!("%{}%", query.trim().to_lowercase());
    let sql = if kind == "supplier" {
        "SELECT id, name, COUNT(*) AS contracts, COALESCE(SUM(awarded_value), 0)
         FROM suppliers WHERE lower(name) LIKE ? GROUP BY id ORDER BY contracts DESC LIMIT ?"
    } else {
        "SELECT id, name, 1, 0 FROM buyers WHERE lower(name) LIKE ? ORDER BY name LIMIT ?"
    };
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(params![needle, limit.clamp(1, 30)], |row| {
        Ok(ProfileCount {
            key: row.get(0)?,
            label: row.get(1)?,
            count: row.get(2)?,
            value: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::{self, SearchRequest};

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("schema.sql")).unwrap();
        conn
    }

    #[test]
    fn profile_uses_awards_and_finds_open_notices() {
        let conn = database();
        conn.execute_batch(
            "INSERT INTO notices (id, notice_type, kind, title, buyer_id, buyer_name, region,
                cpv_codes, estimated_value, awarded_value, discount_pct, published_at, updated_at)
             VALUES ('a1', 'can-standard', 'award', 'Strada 1', 'b1', 'Comune di Milano', 'Lombardia',
                '[\"45233140\"]', 100000, 90000, 10, '2025-01-10T00:00:00Z', datetime('now'));
             INSERT INTO awards (id, notice_id, supplier_id, supplier_name, awarded_value,
                estimated_value, discount_pct, awarded_at, cpv_codes, region)
             VALUES ('aw1', 'a1', 'cf-1', 'Impresa Rossi', 90000, 100000, 10,
                '2025-01-10T00:00:00Z', '[\"45233140\"]', 'Lombardia');
             INSERT INTO notice_cpv (notice_id, cpv) VALUES ('a1', '45233140');
             INSERT INTO notices (id, notice_type, kind, title, buyer_id, buyer_name, region,
                cpv_codes, estimated_value, deadline_at, updated_at)
             VALUES ('c1', 'cn-standard', 'call', 'Strada 2', 'b2', 'Comune di Monza', 'Lombardia',
                '[\"45233141\"]', 50000, '2099-01-01T00:00:00Z', datetime('now'));
             INSERT INTO notice_cpv (notice_id, cpv) VALUES ('c1', '45233141');",
        )
        .unwrap();

        let profile = entity_profile(&conn, "supplier", "cf-1").unwrap();
        assert_eq!(profile.contracts, 1);
        assert_eq!(profile.total_value, 90000.0);
        assert_eq!(profile.median_discount, Some(10.0));
        assert_eq!(profile.top_counterparties[0].label, "Comune di Milano");
        assert_eq!(profile.open_notices.len(), 1);
        assert_eq!(profile.open_notices[0].id, "c1");

        let buyer = entity_profile(&conn, "buyer", "b1").unwrap();
        assert_eq!(buyer.contracts, 1);
        assert_eq!(buyer.top_counterparties[0].label, "Impresa Rossi");
    }

    #[test]
    fn followed_entities_are_unique() {
        let conn = database();
        follow_entity(&conn, "supplier", "cf-1", Some("Impresa Rossi")).unwrap();
        follow_entity(&conn, "supplier", "cf-1", Some("Impresa Rossi S.r.l.")).unwrap();
        let list = list_followed_entities(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Impresa Rossi S.r.l.");
        assert!((list[0].min_similarity - 0.75).abs() < 1e-9);
        assert!(list[0].active);
        unfollow_entity(&conn, "supplier", "cf-1").unwrap();
        assert!(list_followed_entities(&conn).unwrap().is_empty());
    }

    #[test]
    fn followed_entity_threshold_and_active_can_change() {
        let conn = database();
        follow_entity(&conn, "buyer", "b1", Some("Comune di Milano")).unwrap();
        update_followed_entity(&conn, "buyer", "b1", Some(1.5), Some(false)).unwrap();
        let list = list_followed_entities(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert!((list[0].min_similarity - 1.0).abs() < 1e-9, "soglia non limitata a 1");
        assert!(!list[0].active);
        assert!(update_followed_entity(&conn, "buyer", "missing", Some(0.5), None).is_err());
    }

    #[test]
    fn prediction_centroid_uses_supplier_history() {
        let conn = database();
        conn.execute_batch(
            "INSERT INTO notices (id, notice_type, kind, title, buyer_id, updated_at)
             VALUES ('a1', 'can-standard', 'award', 'Strada 1', 'b1', datetime('now'));
             INSERT INTO notices (id, notice_type, kind, title, buyer_id, updated_at)
             VALUES ('a2', 'can-standard', 'award', 'Strada 2', 'b1', datetime('now'));
             INSERT INTO notices (id, notice_type, kind, title, buyer_id, updated_at)
             VALUES ('a3', 'can-standard', 'award', 'Strada 3', 'b1', datetime('now'));
             INSERT INTO awards (id, notice_id, supplier_id, supplier_name)
             VALUES ('aw1', 'a1', 'cf-1', 'Rossi');
             INSERT INTO awards (id, notice_id, supplier_id, supplier_name)
             VALUES ('aw2', 'a2', 'cf-1', 'Rossi');
             INSERT INTO awards (id, notice_id, supplier_id, supplier_name)
             VALUES ('aw3', 'a3', 'cf-1', 'Rossi');
             INSERT INTO notice_embedding (notice_id, embedding, model, dims)
             VALUES ('a1', X'0000803F0000803F', 'test', 2);
             INSERT INTO notice_embedding (notice_id, embedding, model, dims)
             VALUES ('a2', X'0000803F0000803F', 'test', 2);
             INSERT INTO notice_embedding (notice_id, embedding, model, dims)
             VALUES ('a3', X'0000803F0000803F', 'test', 2);",
        )
        .unwrap();
        let request = SearchRequest {
            mode: Some("predictions".into()),
            entity_type: Some("supplier".into()),
            entity_id: Some("cf-1".into()),
            ..Default::default()
        };
        let (vector, label) = search::prediction_centroid(&conn, &request).unwrap().unwrap();
        assert_eq!(label, "Rossi");
        assert!((vector[0] - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.01);
    }

    #[test]
    fn prediction_centroid_needs_three_embedded_samples() {
        let conn = database();
        conn.execute_batch(
            "INSERT INTO notices (id, notice_type, kind, title, buyer_id, updated_at)
             VALUES ('a1', 'can-standard', 'award', 'Strada', 'b1', datetime('now'));
             INSERT INTO awards (id, notice_id, supplier_id, supplier_name)
             VALUES ('aw1', 'a1', 'cf-1', 'Rossi');
             INSERT INTO notice_embedding (notice_id, embedding, model, dims)
             VALUES ('a1', X'0000803F0000803F', 'test', 2);",
        )
        .unwrap();
        let request = SearchRequest {
            mode: Some("predictions".into()),
            entity_type: Some("supplier".into()),
            entity_id: Some("cf-1".into()),
            ..Default::default()
        };
        assert!(search::prediction_centroid(&conn, &request).unwrap().is_none());
    }
}
