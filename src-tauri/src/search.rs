//! Ricerca locale: filtri parametrizzati, FTS e ordinamento vettoriale.
use std::time::Instant;
use anyhow::{bail, Result};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use crate::{awards, db, embed};

pub const MAX_RESULTS: i64 = 5000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchFilters {
    pub kind: Option<String>, pub source: Option<String>, pub region: Option<String>,
    pub province: Option<String>, pub cpv_prefix: Option<String>, pub cpv_prefixes: Option<Vec<String>>,
    pub category: Option<String>, pub soa_category: Option<String>, pub buyer: Option<String>,
    pub buyer_id: Option<String>, pub supplier_id: Option<String>,
    pub min_value: Option<f64>, pub max_value: Option<f64>, pub min_discount: Option<f64>, pub max_discount: Option<f64>,
    pub deadline_from: Option<String>, pub deadline_to: Option<String>, pub published_from: Option<String>, pub published_to: Option<String>,
    pub only_awarded: Option<bool>, pub hide_expired: Option<bool>, pub only_open: Option<bool>, pub min_similarity: Option<f64>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchRequest {
    pub query: String, pub filters: SearchFilters, pub limit: Option<i64>, pub offset: Option<i64>,
    pub sort: Option<String>, pub keyword_only: Option<bool>, pub mode: Option<String>,
    pub entity_type: Option<String>, pub entity_id: Option<String>, pub notice_id: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LotRow { pub id: String, pub notice_id: String, pub lot_number: i64, pub title: Option<String>, pub description: Option<String>, pub estimated_value: Option<f64>, pub awarded_value: Option<f64>, pub cpv_codes: Vec<String>, pub status: Option<String> }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeHit {
    pub id: String, pub source: String, pub kind: String, pub notice_type: String, pub title: String,
    pub description: Option<String>, pub buyer_id: Option<String>, pub buyer_name: Option<String>, pub buyer_city: Option<String>,
    pub region: Option<String>, pub province: Option<String>, pub place_city: Option<String>, pub cpv_codes: Vec<String>,
    pub estimated_value: Option<f64>, pub awarded_value: Option<f64>, pub discount_pct: Option<f64>,
    pub published_at: Option<String>, pub deadline_at: Option<String>, pub url: Option<String>,
    pub similarity: Option<f32>, pub why: Option<String>, pub signal: Option<String>,
    pub award_count: i64, pub lot_count: i64, pub cig: Option<String>, pub cup: Option<String>,
    pub pnrr: bool, pub pnrr_pnc: bool, pub esito: Option<String>, pub esito_at: Option<String>, pub lots: Vec<LotRow>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome { pub items: Vec<NoticeHit>, pub total: i64, pub semantic: bool, pub warning: Option<String>, pub took_ms: u128, pub mode: String, pub label: Option<String> }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarAward { pub notice_id: String, pub title: String, pub buyer_name: Option<String>, pub region: Option<String>, pub awarded_value: Option<f64>, pub estimated_value: Option<f64>, pub discount_pct: Option<f64>, pub published_at: Option<String>, pub suppliers: Vec<String>, pub similarity: f32, pub url: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwardRow { pub id: String, pub supplier_id: Option<String>, pub supplier_name: String, pub awarded_value: Option<f64>, pub estimated_value: Option<f64>, pub discount_pct: Option<f64>, pub awarded_at: Option<String>, pub notice_id: String, pub notice_title: String, pub region: Option<String>, pub cpv_codes: Vec<String>, pub url: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent { pub label: String, pub date: String, pub kind: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeDetail { pub notice: NoticeHit, pub cpv_context: Vec<awards::IntelRow>, pub procedure_type: Option<String>, pub contract_nature: Option<String>, pub awards: Vec<AwardRow>, pub similar: Vec<SimilarAward>, pub timeline: Vec<TimelineEvent> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats { pub notices:i64, pub calls:i64, pub awarded:i64, pub awards:i64, pub suppliers:i64, pub buyers:i64, pub embedded:i64, pub earliest:Option<String>, pub latest:Option<String>, pub avg_discount:Option<f64>, pub board_items:i64, pub ted:i64, pub anac:i64, pub pnrr:i64, pub hidden:i64, pub followed:i64, pub lots:i64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSearch { pub id:i64, pub name:String, pub query:String, pub filters:SearchFilters, pub frequency:String, pub active:bool, pub min_similarity:f64, pub last_run_at:Option<String>, pub created_at:String, pub has_embedding:bool, pub matches:i64 }

// Le prime 28 colonne sono un contratto condiviso con board.rs.
pub const HIT_COLUMNS: &str = "n.id,n.source,n.kind,n.notice_type,n.title,n.description,n.buyer_id,n.buyer_name,n.buyer_city,n.region,n.province,n.place_city,n.cpv_codes,n.estimated_value,n.awarded_value,n.discount_pct,n.published_at,n.deadline_at,n.url,\
 (SELECT signal FROM user_signals WHERE notice_id=n.id ORDER BY CASE signal WHEN 'hide' THEN 0 ELSE 1 END LIMIT 1),\
 (SELECT count(*) FROM awards WHERE notice_id=n.id),\
 COALESCE((SELECT lot_count FROM notice_flags WHERE notice_id=n.id),(SELECT count(*) FROM lots WHERE notice_id=n.id)),\
 (SELECT cig FROM notice_flags WHERE notice_id=n.id), (SELECT cup FROM notice_flags WHERE notice_id=n.id),\
 COALESCE((SELECT pnrr FROM notice_flags WHERE notice_id=n.id),0), COALESCE((SELECT pnrr_pnc FROM notice_flags WHERE notice_id=n.id),0),\
 (SELECT esito FROM notice_flags WHERE notice_id=n.id), (SELECT esito_at FROM notice_flags WHERE notice_id=n.id)";
pub fn hit_from_row(row: &Row<'_>) -> rusqlite::Result<NoticeHit> {
    Ok(NoticeHit { id:row.get(0)?, source:row.get(1)?, kind:row.get(2)?, notice_type:row.get(3)?, title:row.get(4)?, description:row.get(5)?, buyer_id:row.get(6)?, buyer_name:row.get(7)?, buyer_city:row.get(8)?, region:row.get(9)?, province:row.get(10)?, place_city:row.get(11)?, cpv_codes:db::parse_string_list(&row.get::<_,String>(12)?), estimated_value:row.get(13)?, awarded_value:row.get(14)?, discount_pct:row.get(15)?, published_at:row.get(16)?, deadline_at:row.get(17)?, url:row.get(18)?, signal:row.get(19)?, award_count:row.get(20)?, lot_count:row.get(21)?, cig:row.get(22)?, cup:row.get(23)?, pnrr:row.get::<_,i64>(24)? != 0, pnrr_pnc:row.get::<_,i64>(25)? != 0, esito:row.get(26)?, esito_at:row.get(27)?, similarity:None, why:None, lots:Vec::new() })
}
pub fn attach_lots(conn: &Connection, hits: &mut [NoticeHit]) -> Result<()> {
    let mut stmt=conn.prepare("SELECT id,notice_id,lot_number,title,description,estimated_value,awarded_value,cpv_codes,status FROM lots WHERE notice_id=? ORDER BY position,lot_number")?;
    for hit in hits {
        hit.lots=stmt.query_map([&hit.id], |r| Ok(LotRow { id:r.get(0)?,notice_id:r.get(1)?,lot_number:r.get(2)?,title:r.get(3)?,description:r.get(4)?,estimated_value:r.get(5)?,awarded_value:r.get(6)?,cpv_codes:db::parse_string_list(&r.get::<_,String>(7)?),status:r.get(8)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(())
}

pub struct WhereClause { pub sql:String, pub params:Vec<Value> }
pub fn build_where(f: &SearchFilters) -> WhereClause {
    let mut clauses=vec!["NOT EXISTS (SELECT 1 FROM user_signals us WHERE us.notice_id=n.id AND us.signal='hide')".to_string()];
    let mut params=Vec::new();
    macro_rules! text { ($val:expr,$sql:expr) => { if let Some(v)=$val.as_ref().filter(|x| !x.trim().is_empty() && x.as_str() != "all") { clauses.push($sql.to_string()); params.push(Value::Text(v.clone())); } }; }
    text!(f.kind,"n.kind = ?"); text!(f.source,"n.source = ?"); text!(f.region,"n.region = ?"); text!(f.province,"n.province = ?"); text!(f.buyer_id,"n.buyer_id = ?");
    text!(f.supplier_id,"EXISTS (SELECT 1 FROM awards wa WHERE wa.notice_id=n.id AND wa.supplier_id=?)");
    text!(f.category,"n.contract_nature = ?");
    if let Some(v)=f.buyer.as_ref().filter(|s| !s.trim().is_empty()) { clauses.push("lower(n.buyer_name) LIKE ?".into()); params.push(Value::Text(format!("%{}%",v.trim().to_lowercase()))); }
    if let Some(v)=f.soa_category.as_ref().filter(|s| !s.trim().is_empty()) { clauses.push("upper(COALESCE(n.title,'') || ' ' || COALESCE(n.description,'')) LIKE ?".into()); params.push(Value::Text(format!("%{}%",v.trim().to_uppercase()))); }
    if let Some(v)=f.cpv_prefix.as_ref().filter(|s| !s.trim().is_empty()) { clauses.push("EXISTS (SELECT 1 FROM notice_cpv wc WHERE wc.notice_id=n.id AND wc.cpv LIKE ?)".into()); params.push(Value::Text(format!("{}%",v.trim()))); }
    if let Some(list)=&f.cpv_prefixes { let list:Vec<_>=list.iter().filter(|s|!s.trim().is_empty()).take(100).collect(); if !list.is_empty() { clauses.push(format!("EXISTS (SELECT 1 FROM notice_cpv wc WHERE wc.notice_id=n.id AND ({}))",vec!["wc.cpv LIKE ?";list.len()].join(" OR "))); for v in list { params.push(Value::Text(format!("{}%",v.trim()))); } } }
    macro_rules! number { ($val:expr,$sql:expr) => { if let Some(v)=$val.filter(|v| v.is_finite()) { clauses.push($sql.into()); params.push(Value::Real(v)); } }; }
    number!(f.min_value,"n.estimated_value >= ?"); number!(f.max_value,"n.estimated_value <= ?"); number!(f.min_discount,"n.discount_pct >= ?"); number!(f.max_discount,"n.discount_pct <= ?");
    text!(f.deadline_from,"date(n.deadline_at) >= date(?)"); text!(f.deadline_to,"date(n.deadline_at) <= date(?)"); text!(f.published_from,"date(n.published_at) >= date(?)"); text!(f.published_to,"date(n.published_at) <= date(?)");
    if f.only_awarded.unwrap_or(false) { clauses.push("n.kind='award'".into()); }
    if f.only_open.unwrap_or(false) { clauses.push("n.kind='call'".into()); }
    if f.only_open.unwrap_or(false)||f.hide_expired.unwrap_or(false) { clauses.push("(n.deadline_at IS NULL OR date(n.deadline_at)>=date('now','localtime'))".into()); }
    WhereClause { sql:format!("WHERE {}",clauses.join(" AND ")),params }
}

/// Il centroide dell'ente richiede almeno tre gare vettorizzate distinte.
pub fn prediction_centroid(conn:&Connection, request:&SearchRequest) -> Result<Option<(Vec<f32>,String)>> {
    let (sql, arg, minimum, label) = if let Some(id)=request.notice_id.as_deref().filter(|s|!s.is_empty()) {
        ("SELECT e.embedding FROM notice_embedding e WHERE e.notice_id=?",Some(id),1,"Gara di riferimento".to_string())
    } else if let (Some(kind),Some(id))=(request.entity_type.as_deref(),request.entity_id.as_deref()) {
        let sql=match kind { "buyer"=>"SELECT e.embedding FROM notice_embedding e JOIN notices n ON n.id=e.notice_id WHERE n.buyer_id=?", "supplier"=>"SELECT e.embedding FROM notice_embedding e WHERE EXISTS (SELECT 1 FROM awards a WHERE a.notice_id=e.notice_id AND a.supplier_id=?)", _=>bail!("tipo ente non valido") };
        let name:Option<String>=if kind=="buyer" { conn.query_row("SELECT buyer_name FROM notices WHERE buyer_id=? AND buyer_name IS NOT NULL LIMIT 1",[id],|r|r.get(0)).optional()? } else { conn.query_row("SELECT supplier_name FROM awards WHERE supplier_id=? AND supplier_name IS NOT NULL LIMIT 1",[id],|r|r.get(0)).optional()? };
        (sql,Some(id),3,name.unwrap_or_else(||id.to_string()))
    } else {
        ("SELECT e.embedding FROM notice_embedding e JOIN user_signals s ON s.notice_id=e.notice_id AND s.signal='interest'",None,1,"Gare interessanti".to_string())
    };
    let mut statement=conn.prepare(sql)?;
    let mut rows=if let Some(arg)=arg { statement.query([arg])? } else { statement.query([])? };
    let mut sum:Vec<f32>=Vec::new(); let mut count=0;
    while let Some(row)=rows.next()? {
        let vector=embed::from_blob(&row.get::<_,Vec<u8>>(0)?);
        if vector.is_empty() || vector.iter().any(|x|!x.is_finite()) {continue;}
        if sum.is_empty() {sum=vec![0.0;vector.len()];}
        if vector.len()!=sum.len() {continue;}
        for (s,v) in sum.iter_mut().zip(vector) {*s+=v;} count+=1;
    }
    if count<minimum {return Ok(None);}
    let norm=sum.iter().map(|v|v*v).sum::<f32>().sqrt();
    if !norm.is_finite() || norm==0.0 {return Ok(None);}
    for v in &mut sum {*v/=norm;}
    Ok(Some((sum,label)))
}

fn fts_query(query:&str) -> String {
    query.split(|c:char|!c.is_alphanumeric()).filter(|s| !s.is_empty()).take(24)
        .map(|word|format!("\"{}\"*",word.replace('"',""))).collect::<Vec<_>>().join(" OR ")
}
pub fn run(conn:&Connection, request:&SearchRequest, query_vector:Option<&[f32]>) -> Result<SearchOutcome> {
    let start=Instant::now();
    let predictions=request.mode.as_deref()==Some("predictions");
    let mut filters=request.filters.clone();
    let (vector,label,warning)=if predictions {
        filters.only_open=Some(true);
        match prediction_centroid(conn,request)? {
            Some((v,label))=>(Some(v),Some(label),None),
            None=>return Ok(SearchOutcome {items:vec![],total:0,semantic:false,warning:Some("Storico insufficiente: servono gare con embedding disponibili (almeno tre per un ente).".into()),took_ms:start.elapsed().as_millis(),mode:"predictions".into(),label:None})
        }
    } else { (query_vector.map(|v|v.to_vec()),None,None) };
    let use_vector=vector.as_ref().map(|v|!v.is_empty()).unwrap_or(false) && !request.keyword_only.unwrap_or(false);
    let keyword=!predictions && !use_vector && !request.query.trim().is_empty();
    let mut clause=build_where(&filters);
    if keyword { let fts=fts_query(&request.query); if fts.is_empty() { return Ok(SearchOutcome {items:vec![],total:0,semantic:false,warning:Some("Inserisci almeno una parola da cercare.".into()),took_ms:start.elapsed().as_millis(),mode:"keyword".into(),label:None}); } clause.sql.push_str(" AND n.rowid IN (SELECT rowid FROM notices_fts WHERE notices_fts MATCH ?)"); clause.params.push(Value::Text(fts)); }
    if predictions { if let Some(id)=request.notice_id.as_ref() {clause.sql.push_str(" AND n.id <> ?");clause.params.push(Value::Text(id.clone()));} }
    let limit=request.limit.unwrap_or(40).clamp(1,MAX_RESULTS) as usize;
    let offset=request.offset.unwrap_or(0).max(0) as usize;
    let (mut items,total):(Vec<NoticeHit>,i64)=if use_vector {
        // Prima si classificano solo id e vettori: le sottoquery della scheda
        // completa vengono eseguite soltanto per la pagina richiesta.
        let sql=format!("SELECT n.id,e.embedding FROM notices n JOIN notice_embedding e ON e.notice_id=n.id {}",clause.sql);
        let mut stmt=conn.prepare(&sql)?;
        let mut rows=stmt.query(params_from_iter(clause.params.iter()))?;
        let mut scores:Vec<(String,f32)>=Vec::new(); let target=vector.as_deref().unwrap();
        while let Some(row)=rows.next()? {
            let blob:Vec<u8>=row.get(1)?; let v=embed::from_blob(&blob);
            if v.len()!=target.len() {continue;}
            let score=embed::dot(target,&v);
            if !score.is_finite() || (score as f64)<filters.min_similarity.unwrap_or(0.0).clamp(0.0,1.0) {continue;}
            scores.push((row.get(0)?,score));
        }
        scores.sort_by(|a,b|b.1.total_cmp(&a.1).then_with(||a.0.cmp(&b.0)));
        let count=scores.len() as i64;
        let selected:Vec<_>=scores.into_iter().skip(offset).take(limit).collect();
        let sql=format!("SELECT {HIT_COLUMNS} FROM notices n WHERE n.id=?");
        let mut stmt=conn.prepare(&sql)?;
        let mut hits=Vec::with_capacity(selected.len());
        for (id,score) in selected {
            let mut hit=stmt.query_row([id],hit_from_row)?;
            hit.similarity=Some(score); hit.why=Some("Similarità semantica".into()); hits.push(hit);
        }
        (hits,count)
    } else {
        let count_sql=format!("SELECT COUNT(*) FROM notices n {}",clause.sql);
        let count:i64=conn.query_row(&count_sql,params_from_iter(clause.params.iter()),|r|r.get(0))?;
        let order=match request.sort.as_deref() {Some("deadline")=>"n.deadline_at IS NULL, n.deadline_at ASC",Some("value")=>"n.estimated_value DESC",Some("discount")=>"n.discount_pct DESC",_=>"n.published_at DESC"};
        let sql=format!("SELECT {HIT_COLUMNS} FROM notices n {} ORDER BY {order}, n.id LIMIT ? OFFSET ?",clause.sql);
        let mut p=clause.params.clone();p.push(Value::Integer(limit as i64));p.push(Value::Integer(offset.min(i64::MAX as usize) as i64));
        let mut stmt=conn.prepare(&sql)?;
        let hits=stmt.query_map(params_from_iter(p.iter()),hit_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        (hits,count)
    };
    attach_lots(conn,&mut items)?;
    Ok(SearchOutcome {items,total,semantic:use_vector,warning:warning.or_else(|| if keyword && request.mode.as_deref()==Some("semantic") {Some("Ricerca semantica non disponibile: risultati per parole chiave.".into())} else {None}),took_ms:start.elapsed().as_millis(),mode:if predictions {"predictions"} else if use_vector {"semantic"} else if keyword {"keyword"} else {"filtered"}.into(),label})
}

pub fn set_signal(conn:&Connection, id:&str, signal:&str)->Result<()> {
    if !["hide","interest"].contains(&signal) {bail!("segnale non valido");}
    conn.execute("INSERT INTO user_signals(notice_id,signal,created_at) VALUES (?,?,?) ON CONFLICT(notice_id,signal) DO UPDATE SET created_at=excluded.created_at",params![id,signal,db::now_iso()])?; Ok(())
}
pub fn clear_signal(conn:&Connection,id:&str,signal:Option<&str>)->Result<()> {
    if let Some(signal)=signal {if !["hide","interest"].contains(&signal) {bail!("segnale non valido");} conn.execute("DELETE FROM user_signals WHERE notice_id=? AND signal=?",params![id,signal])?;} else {conn.execute("DELETE FROM user_signals WHERE notice_id=?",[id])?;} Ok(())
}

pub fn notice_detail(conn:&Connection,id:&str)->Result<Option<NoticeDetail>> {
    let sql=format!("SELECT {HIT_COLUMNS} FROM notices n WHERE n.id=?");
    let Some(mut hit)=conn.query_row(&sql,[id],hit_from_row).optional()? else {return Ok(None)};
    attach_lots(conn,std::slice::from_mut(&mut hit))?;
    let (procedure_type,contract_nature):(Option<String>,Option<String>)=conn.query_row("SELECT procedure_type,contract_nature FROM notices WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let mut stmt=conn.prepare("SELECT id,supplier_id,COALESCE(supplier_name,''),awarded_value,estimated_value,discount_pct,awarded_at,region,cpv_codes FROM awards WHERE notice_id=? ORDER BY awarded_at DESC")?;
    let awards=stmt.query_map([id],|r|Ok(AwardRow {id:r.get(0)?,supplier_id:r.get(1)?,supplier_name:r.get(2)?,awarded_value:r.get(3)?,estimated_value:r.get(4)?,discount_pct:r.get(5)?,awarded_at:r.get(6)?,notice_id:id.into(),notice_title:hit.title.clone(),region:r.get(7)?,cpv_codes:db::parse_string_list(&r.get::<_,String>(8)?),url:hit.url.clone()}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut timeline=Vec::new();
    if let Some(date)=&hit.published_at {timeline.push(TimelineEvent {label:"Pubblicazione".into(),date:date.clone(),kind:"published".into()});}
    if let Some(date)=&hit.deadline_at {timeline.push(TimelineEvent {label:"Scadenza".into(),date:date.clone(),kind:"deadline".into()});}
    if let Some(date)=&hit.esito_at {timeline.push(TimelineEvent {label:"Esito".into(),date:date.clone(),kind:"award".into()});}
    Ok(Some(NoticeDetail {cpv_context:awards::cpv_discount_context(conn,id)?,similar:awards::similar_to(conn,id,6)?,notice:hit,procedure_type,contract_nature,awards,timeline}))
}
pub fn stats(conn:&Connection)->Result<Stats> {
    let w=build_where(&SearchFilters::default());
    let sql=format!("SELECT count(*),sum(n.kind='call'),sum(n.kind='award'),min(n.published_at),max(n.published_at),avg(n.discount_pct),sum(n.source='ted'),sum(n.source='anac'),sum(EXISTS(SELECT 1 FROM notice_flags f WHERE f.notice_id=n.id AND (f.pnrr=1 OR f.pnrr_pnc=1))) FROM notices n {}",w.sql);
    let (notices,calls,awarded,earliest,latest,avg_discount,ted,anac,pnrr)=conn.query_row(&sql,[],|r|Ok((r.get(0)?,r.get::<_,Option<i64>>(1)?.unwrap_or(0),r.get::<_,Option<i64>>(2)?.unwrap_or(0),r.get(3)?,r.get(4)?,r.get(5)?,r.get::<_,Option<i64>>(6)?.unwrap_or(0),r.get::<_,Option<i64>>(7)?.unwrap_or(0),r.get::<_,Option<i64>>(8)?.unwrap_or(0))))?;
    let visible = "NOT EXISTS (SELECT 1 FROM user_signals s WHERE s.notice_id=n.id AND s.signal='hide')";
    let count = |sql:&str| -> Result<i64> { Ok(conn.query_row(sql, [], |r|r.get(0))?) };
    Ok(Stats {notices,calls,awarded,earliest,latest,avg_discount,ted,anac,pnrr,
        awards:count(&format!("SELECT count(*) FROM awards a JOIN notices n ON n.id=a.notice_id WHERE {visible}"))?,
        suppliers:count(&format!("SELECT count(DISTINCT a.supplier_id) FROM awards a JOIN notices n ON n.id=a.notice_id WHERE {visible}"))?,
        buyers:count(&format!("SELECT count(DISTINCT n.buyer_id) FROM notices n WHERE {visible}"))?,
        embedded:count(&format!("SELECT count(*) FROM notice_embedding e JOIN notices n ON n.id=e.notice_id WHERE {visible}"))?,
        board_items:count(&format!("SELECT count(*) FROM board_items b JOIN notices n ON n.id=b.notice_id WHERE {visible}"))?,
        hidden:count("SELECT count(*) FROM user_signals WHERE signal='hide'")?,
        followed:count("SELECT count(*) FROM followed_entities")?,
        lots:count(&format!("SELECT count(*) FROM lots l JOIN notices n ON n.id=l.notice_id WHERE {visible}"))?})
}
pub fn insert_saved_search(conn:&Connection,name:&str,query:&str,filters:&SearchFilters,min_similarity:f64)->Result<i64> {
    if name.trim().is_empty() {bail!("inserisci un nome per la ricerca");}
    if !min_similarity.is_finite() {bail!("soglia non valida");}
    conn.execute("INSERT INTO saved_searches(name,query,filters,min_similarity,created_at) VALUES(?,?,?,?,?)",params![name.trim(),query.trim(),serde_json::to_string(filters)?,min_similarity.clamp(0.0,1.0),db::now_iso()])?; Ok(conn.last_insert_rowid())
}
pub fn set_saved_search_embedding(conn:&Connection,id:i64,embedding:&[u8],model:&str)->Result<()> {
    conn.execute("INSERT INTO search_embedding(search_id,embedding,model,updated_at) VALUES(?,?,?,?) ON CONFLICT(search_id) DO UPDATE SET embedding=excluded.embedding,model=excluded.model,updated_at=excluded.updated_at",params![id,embedding,model,db::now_iso()])?; Ok(())
}
pub fn list_saved_searches(conn:&Connection)->Result<Vec<SavedSearch>> {
    let mut stmt=conn.prepare("SELECT s.id,s.name,s.query,s.filters,s.frequency,s.active,s.min_similarity,s.last_run_at,s.created_at,EXISTS(SELECT 1 FROM search_embedding e WHERE e.search_id=s.id) FROM saved_searches s ORDER BY s.id DESC")?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?,r.get::<_,f64>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,String>(8)?,r.get::<_,i64>(9)?)))?;
    let mut result=Vec::new();
    for row in rows {let (id,name,query,json,frequency,active,min_similarity,last_run_at,created_at,has_embedding)=row?; let filters:SearchFilters=serde_json::from_str(&json)?;
        let req=SearchRequest {query:query.clone(),filters:filters.clone(),limit:Some(1),keyword_only:Some(true),..Default::default()};
        let matches=run(conn,&req,None)?.total;
        result.push(SavedSearch {id,name,query,filters,frequency,active:active!=0,min_similarity,last_run_at,created_at,has_embedding:has_embedding!=0,matches});
    } Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database()->Connection {
        let conn=Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("schema.sql")).unwrap();
        conn.execute_batch("INSERT INTO notices(id,notice_type,kind,title,published_at,deadline_at) VALUES('a','cn-standard','call','Servizi pulizia','2026-01-01','2999-01-01'),('b','cn-standard','call','Servizi stradali','2026-01-01','2999-01-01'); INSERT INTO notice_embedding(notice_id,embedding,model,dims) VALUES('a',X'0000803F00000000','test',2),('b',X'000000000000803F','test',2);").unwrap();conn
    }
    #[test]
    fn filtered_and_keyword_exclude_hidden() {
        let conn=database();set_signal(&conn,"a","hide").unwrap();
        let all=run(&conn,&SearchRequest::default(),None).unwrap();assert_eq!(all.total,1);assert_eq!(all.items[0].id,"b");
        let q=SearchRequest {query:"pulizia".into(),keyword_only:Some(true),..Default::default()};
        assert_eq!(run(&conn,&q,None).unwrap().total,0);
        clear_signal(&conn,"a",Some("hide")).unwrap();assert_eq!(run(&conn,&q,None).unwrap().total,1);
    }
    #[test]
    fn vector_ranking_and_threshold() {
        let conn=database();let q=SearchRequest {query:"test".into(),filters:SearchFilters {min_similarity:Some(0.5),..Default::default()},..Default::default()};
        let result=run(&conn,&q,Some(&[1.0,0.0])).unwrap();assert_eq!(result.total,1);assert_eq!(result.items[0].id,"a");assert_eq!(result.items[0].similarity,Some(1.0));
    }
    #[test]
    fn predictions_without_history_never_return_random_results() {
        let conn=database();let q=SearchRequest {mode:Some("predictions".into()),entity_type:Some("buyer".into()),entity_id:Some("missing".into()),..Default::default()};
        let result=run(&conn,&q,None).unwrap();assert_eq!(result.total,0);assert!(result.warning.is_some());
    }
}
