//! Intelligence sulle aggiudicazioni: contratti simili, vincitori ricorrenti,
//! ribassi per settore, regione e stazione appaltante.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{params_from_iter, types::Value, Connection};
use serde::Serialize;

use crate::embed::{dot, from_blob};
use crate::search::{build_where, SearchFilters, SimilarAward};

fn suppliers_by_notice(conn: &Connection, ids: &[String]) -> Result<HashMap<String, Vec<String>>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!(
        "SELECT notice_id, supplier_name FROM awards WHERE notice_id IN ({placeholders}) \
         ORDER BY awarded_value DESC NULLS LAST"
    );
    let params: Vec<Value> = ids.iter().map(|id| Value::Text(id.clone())).collect();
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(params.iter()))?;
    while let Some(row) = rows.next()? {
        let notice_id: String = row.get(0)?;
        let name: String = row.get(1)?;
        map.entry(notice_id).or_default().push(name);
    }
    Ok(map)
}

/// Aggiudicazioni simili a un avviso, per contenuto e codice CPV.
pub fn similar_to(conn: &Connection, notice_id: &str, limit: i64) -> Result<Vec<SimilarAward>> {
    let target: Option<Vec<u8>> = conn
        .query_row(
            "SELECT embedding FROM notice_embedding WHERE notice_id = ?",
            [notice_id],
            |row| row.get(0),
        )
        .ok();
    let target = target.map(|blob| from_blob(&blob));

    let mut candidates: Vec<(SimilarAward, f32)> = Vec::new();

    if let Some(vector) = target {
        let mut statement = conn.prepare(
            "SELECT n.id, n.title, n.buyer_name, n.region, n.awarded_value, n.estimated_value,
                    n.discount_pct, n.published_at, n.url, e.embedding
             FROM notices n JOIN notice_embedding e ON e.notice_id = n.id
             WHERE n.kind = 'award' AND n.id <> ?",
        )?;
        let mut rows = statement.query([notice_id])?;
        while let Some(row) = rows.next()? {
            let blob: Vec<u8> = row.get(9)?;
            let candidate = from_blob(&blob);
            if candidate.len() != vector.len() {
                continue;
            }
            let score = dot(&vector, &candidate);
            candidates.push((
                SimilarAward {
                    notice_id: row.get(0)?,
                    title: row.get(1)?,
                    buyer_name: row.get(2)?,
                    region: row.get(3)?,
                    awarded_value: row.get(4)?,
                    estimated_value: row.get(5)?,
                    discount_pct: row.get(6)?,
                    published_at: row.get(7)?,
                    suppliers: Vec::new(),
                    similarity: score,
                    url: row.get(8)?,
                },
                score,
            ));
        }
    }

    // Senza vettori (o con pochi risultati) si ripiega sullo stesso CPV.
    if candidates.len() < limit as usize {
        let mut statement = conn.prepare(
            "SELECT DISTINCT n.id, n.title, n.buyer_name, n.region, n.awarded_value,
                    n.estimated_value, n.discount_pct, n.published_at, n.url
             FROM notices n
             JOIN notice_cpv c ON c.notice_id = n.id
             WHERE n.kind = 'award' AND n.id <> ?
               AND c.cpv IN (SELECT cpv FROM notice_cpv WHERE notice_id = ?)
             ORDER BY n.published_at DESC LIMIT ?",
        )?;
        let rows = statement.query_map(rusqlite::params![notice_id, notice_id, limit], |row| {
            Ok(SimilarAward {
                notice_id: row.get(0)?,
                title: row.get(1)?,
                buyer_name: row.get(2)?,
                region: row.get(3)?,
                awarded_value: row.get(4)?,
                estimated_value: row.get(5)?,
                discount_pct: row.get(6)?,
                published_at: row.get(7)?,
                suppliers: Vec::new(),
                similarity: 0.0,
                url: row.get(8)?,
            })
        })?;
        for row in rows {
            let item = row?;
            if !candidates.iter().any(|(existing, _)| existing.notice_id == item.notice_id) {
                candidates.push((item, 0.0));
            }
        }
    }

    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(limit.max(1) as usize);

    let ids: Vec<String> = candidates
        .iter()
        .map(|(item, _)| item.notice_id.clone())
        .collect();
    let mut suppliers = suppliers_by_notice(conn, &ids)?;

    Ok(candidates
        .into_iter()
        .map(|(mut item, score)| {
            item.similarity = score;
            item.suppliers = suppliers.remove(&item.notice_id).unwrap_or_default();
            item
        })
        .collect())
}

fn cpv_division_label(code: &str) -> String {
    let label = match code {
        "03" => "Prodotti agricoli",
        "09" => "Petrolio e combustibili",
        "14" => "Prodotti minerari",
        "15" => "Alimentari e bevande",
        "18" => "Abbigliamento",
        "19" => "Cuoio e tessuti",
        "22" => "Stampati",
        "24" => "Prodotti chimici",
        "30" => "Macchine per ufficio e informatica",
        "31" => "Macchinari elettrici",
        "32" => "Apparecchiature radio e telecomunicazioni",
        "33" => "Apparecchi medicali e ottici",
        "34" => "Veicoli e trasporti",
        "35" => "Attrezzature di sicurezza",
        "37" => "Strumenti musicali e sportivi",
        "38" => "Laboratorio e misurazione",
        "39" => "Arredamento",
        "41" => "Acqua",
        "42" => "Macchine industriali",
        "43" => "Macchine per l'edilizia",
        "44" => "Materiali da costruzione",
        "45" => "Lavori di costruzione",
        "48" => "Software",
        "50" => "Riparazione e manutenzione",
        "51" => "Servizi di installazione",
        "55" => "Servizi alberghieri e ristorazione",
        "60" => "Trasporti",
        "63" => "Servizi di trasporto accessori",
        "64" => "Servizi postali e telecomunicazioni",
        "65" => "Servizi pubblici",
        "66" => "Servizi finanziari",
        "70" => "Servizi immobiliari",
        "71" => "Architettura e ingegneria",
        "72" => "Servizi informatici",
        "73" => "Ricerca e sviluppo",
        "75" => "Servizi per la PA",
        "76" => "Servizi petroliferi",
        "77" => "Servizi agricoli e forestali",
        "79" => "Servizi aziendali",
        "80" => "Istruzione e formazione",
        "85" => "Servizi sanitari",
        "90" => "Rifiuti e ambiente",
        "92" => "Cultura e sport",
        "98" => "Altri servizi",
        _ => "Altri settori",
    };
    format!("{code} · {label}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelRow {
    pub key: String,
    pub label: String,
    pub contracts: i64,
    pub total_value: f64,
    pub avg_discount: Option<f64>,
    pub best_discount: Option<f64>,
    pub worst_discount: Option<f64>,
    pub last_award: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearPoint {
    pub year: String,
    pub contracts: i64,
    pub total_value: f64,
    pub avg_discount: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelOutcome {
    pub group_by: String,
    pub rows: Vec<IntelRow>,
    pub total_awards: i64,
    pub total_value: f64,
    pub avg_discount: Option<f64>,
    pub years: Vec<YearPoint>,
    pub top_contracts: Vec<IntelRow>,
}

impl IntelOutcome {
    pub fn empty(group_by: String) -> Self {
        Self {
            group_by,
            rows: Vec::new(),
            total_awards: 0,
            total_value: 0.0,
            avg_discount: None,
            years: Vec::new(),
            top_contracts: Vec::new(),
        }
    }
}

fn row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<IntelRow> {
    Ok(IntelRow {
        key: row.get(0)?,
        label: row.get(1)?,
        contracts: row.get(2)?,
        total_value: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
        avg_discount: row.get(4)?,
        best_discount: row.get(5)?,
        worst_discount: row.get(6)?,
        last_award: row.get(7)?,
    })
}

/// Aggregazioni sui contratti aggiudicati.
pub fn intel(
    conn: &Connection,
    filters: &SearchFilters,
    group_by: &str,
    limit: i64,
) -> Result<IntelOutcome> {
    let where_clause = build_where(filters);
    let mut outcome = IntelOutcome::empty(group_by.to_string());
    let limit = limit.clamp(1, 200);

    let (group_sql, label_sql, extra_join) = match group_by {
        "supplier" => (
            "COALESCE(a.supplier_id, a.supplier_name)",
            "a.supplier_name",
            "",
        ),
        "region" => (
            "COALESCE(a.region, 'Non indicata')",
            "COALESCE(a.region, 'Non indicata')",
            "",
        ),
        "buyer" => (
            "COALESCE(n.buyer_id, n.buyer_name)",
            "COALESCE(n.buyer_name, 'Non indicata')",
            "",
        ),
        "cpv" => (
            "substr(c.cpv, 1, 2)",
            "substr(c.cpv, 1, 2)",
            "JOIN (SELECT DISTINCT notice_id, substr(cpv, 1, 2) AS cpv FROM notice_cpv) c ON c.notice_id = n.id",
        ),
        "nature" => (
            "COALESCE(n.contract_nature, 'Altro')",
            "COALESCE(n.contract_nature, 'Altro')",
            "",
        ),
        _ => (
            "COALESCE(a.supplier_id, a.supplier_name)",
            "a.supplier_name",
            "",
        ),
    };

    let sql = format!(
        "SELECT {group_sql} AS k, MAX({label_sql}) AS label, COUNT(DISTINCT a.id) AS contracts,
                SUM(a.awarded_value) AS total_value, AVG(a.discount_pct) AS avg_discount,
                MAX(a.discount_pct) AS best_discount, MIN(a.discount_pct) AS worst_discount,
                MAX(a.awarded_at) AS last_award
         FROM awards a JOIN notices n ON n.id = a.notice_id {extra_join}
         {where_sql} GROUP BY k ORDER BY contracts DESC, total_value DESC LIMIT ?",
        where_sql = where_clause.sql
    );

    let mut params = where_clause.params.clone();
    params.push(Value::Integer(limit));
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(params.iter()))?;
    while let Some(row) = rows.next()? {
        let mut item = row_from(row)?;
        if group_by == "cpv" {
            item.label = cpv_division_label(&item.key);
        }
        outcome.rows.push(item);
    }

    let totals_sql = format!(
        "SELECT COUNT(DISTINCT a.id), SUM(a.awarded_value), AVG(a.discount_pct)
         FROM awards a JOIN notices n ON n.id = a.notice_id {where_sql}",
        where_sql = where_clause.sql
    );
    if let Ok((count, value, avg)) = conn.query_row(
        &totals_sql,
        params_from_iter(where_clause.params.iter()),
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                row.get::<_, Option<f64>>(2)?,
            ))
        },
    ) {
        outcome.total_awards = count;
        outcome.total_value = value;
        outcome.avg_discount = avg;
    }

    let years_sql = format!(
        "SELECT substr(a.awarded_at, 1, 4) AS year, COUNT(DISTINCT a.id), SUM(a.awarded_value),
                AVG(a.discount_pct)
         FROM awards a JOIN notices n ON n.id = a.notice_id {where_sql}
         AND a.awarded_at IS NOT NULL
         GROUP BY year ORDER BY year",
        where_sql = where_clause.sql
    );
    let mut years_statement = conn.prepare(&years_sql)?;
    let mut years_rows = years_statement.query(params_from_iter(where_clause.params.iter()))?;
    while let Some(row) = years_rows.next()? {
        outcome.years.push(YearPoint {
            year: row.get(0)?,
            contracts: row.get(1)?,
            total_value: row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
            avg_discount: row.get(3)?,
        });
    }

    let top_sql = format!(
        "SELECT a.notice_id, n.title, 1 AS contracts, a.awarded_value,
                a.discount_pct, NULL, NULL, a.awarded_at
         FROM awards a JOIN notices n ON n.id = a.notice_id {where_sql}
         AND a.awarded_value IS NOT NULL
         ORDER BY a.awarded_value DESC LIMIT 8",
        where_sql = where_clause.sql
    );
    let mut top_statement = conn.prepare(&top_sql)?;
    let mut top_rows = top_statement.query(params_from_iter(where_clause.params.iter()))?;
    while let Some(row) = top_rows.next()? {
        outcome.top_contracts.push(IntelRow {
            key: row.get(0)?,
            label: row.get(1)?,
            contracts: 1,
            total_value: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
            avg_discount: row.get(4)?,
            best_discount: None,
            worst_discount: None,
            last_award: row.get(7)?,
        });
    }

    Ok(outcome)
}

/// Serie dei ribassi per CPV, usata nella scheda di un bando.
pub fn cpv_discount_context(conn: &Connection, notice_id: &str) -> Result<Vec<IntelRow>> {
    let codes: Vec<String> = {
        let mut statement = conn.prepare("SELECT cpv FROM notice_cpv WHERE notice_id = ?")?;
        let rows = statement.query_map([notice_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut result = Vec::new();
    for code in codes.into_iter().take(3) {
        let prefix = code.get(..5).unwrap_or(code.as_str());
        let mut statement = conn.prepare(
            "SELECT COUNT(DISTINCT a.id), AVG(a.discount_pct), MIN(a.discount_pct),
                    MAX(a.discount_pct), SUM(a.awarded_value)
             FROM awards a JOIN notice_cpv c ON c.notice_id = a.notice_id
             WHERE c.cpv LIKE ? AND a.discount_pct IS NOT NULL",
        )?;
        let row = statement.query_row([format!("{prefix}%")], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<f64>>(1)?,
                row.get::<_, Option<f64>>(2)?,
                row.get::<_, Option<f64>>(3)?,
                row.get::<_, Option<f64>>(4)?,
            ))
        })?;
        result.push(IntelRow {
            key: code.clone(),
            label: code.clone(),
            contracts: row.0,
            total_value: row.4.unwrap_or(0.0),
            avg_discount: row.1,
            best_discount: row.3,
            worst_discount: row.2,
            last_award: None,
        });
    }
    Ok(result)
}

