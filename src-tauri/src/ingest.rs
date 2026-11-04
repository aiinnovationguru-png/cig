//! Ingestione idempotente e transazionale delle fonti TED e ANAC.
use std::{collections::{HashMap, HashSet}, path::{Path,PathBuf}};
use anyhow::{bail, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json,Value};
use crate::{db, ted::normalize::{self,NormalizedNotice}};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all="camelCase")]
pub struct IngestStats {pub fetched:u64,pub saved:u64,pub skipped:u64,pub awards:u64,pub per_type:HashMap<String,u64>,pub started_at:String,pub finished_at:Option<String>}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct IngestProgress {pub phase:String,pub message:String,pub fetched:u64,pub saved:u64,pub awards:u64,pub notice_type:Option<String>,pub current:u64,pub total:u64}
pub struct BatchRow {pub notice:NormalizedNotice,pub raw:Value}
#[derive(Default)]
pub struct BatchStats {pub notices:u64,pub awards:u64}
pub fn all_notice_types()->Vec<String> { ["cn-standard","cn-social","can-standard","can-social","veat"].iter().map(|s|s.to_string()).collect() }

pub fn save_batch(path:&Path,batch:&[BatchRow])->Result<BatchStats> {
    let mut conn=db::Db::connect(path)?; let tx=conn.transaction()?;let mut result=BatchStats::default();
    for row in batch {
        let n=&row.notice;
        let existing=if let Some(cig)=n.flags.as_ref().and_then(|f|f.cig.as_ref()) {
            tx.query_row("SELECT notice_id FROM notice_flags WHERE cig=? ORDER BY notice_id LIMIT 1",[cig],|r|r.get::<_,String>(0)).optional()?
        } else {None};
        let id=existing.as_deref().unwrap_or(&n.id);
        let raw=serde_json::to_string(&row.raw)?;
        let previous:Option<(String,Option<String>,Option<String>,Option<String>)>=tx.query_row("SELECT title,description,buyer_name,text_hash FROM notices WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let old_hash=previous.map(|(title,description,buyer,stored)| stored.unwrap_or_else(|| db::text_hash(&title,description.as_deref(),buyer.as_deref())));
        tx.execute("INSERT INTO notices(id,source,notice_type,kind,title,description,buyer_id,buyer_name,buyer_city,cpv_codes,contract_nature,procedure_type,estimated_value,awarded_value,discount_pct,currency,published_at,published_on,deadline_at,place_city,province,region,url,raw,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
          source=CASE WHEN notices.source='ted' OR excluded.source='ted' THEN 'ted' ELSE excluded.source END,
          notice_type=CASE WHEN notices.source='ted' AND excluded.source<>'ted' THEN notices.notice_type ELSE excluded.notice_type END,
          kind=CASE WHEN notices.kind='award' OR excluded.kind='award' THEN 'award' ELSE excluded.kind END,
          title=CASE WHEN notices.source='ted' AND excluded.source<>'ted' THEN notices.title ELSE excluded.title END,
          description=CASE WHEN notices.source='ted' AND excluded.source<>'ted' THEN COALESCE(notices.description,excluded.description) ELSE COALESCE(excluded.description,notices.description) END,
          buyer_id=COALESCE(notices.buyer_id,excluded.buyer_id), buyer_name=COALESCE(notices.buyer_name,excluded.buyer_name), buyer_city=COALESCE(notices.buyer_city,excluded.buyer_city),
          contract_nature=COALESCE(excluded.contract_nature,notices.contract_nature),procedure_type=COALESCE(excluded.procedure_type,notices.procedure_type),
          estimated_value=COALESCE(excluded.estimated_value,notices.estimated_value),awarded_value=COALESCE(excluded.awarded_value,notices.awarded_value),discount_pct=COALESCE(excluded.discount_pct,notices.discount_pct),
          published_at=COALESCE(notices.published_at,excluded.published_at),published_on=COALESCE(notices.published_on,excluded.published_on),deadline_at=COALESCE(excluded.deadline_at,notices.deadline_at),
          place_city=COALESCE(notices.place_city,excluded.place_city),province=COALESCE(notices.province,excluded.province),region=COALESCE(notices.region,excluded.region),
          url=CASE WHEN excluded.source='ted' THEN excluded.url ELSE COALESCE(notices.url,excluded.url) END,
          raw=CASE WHEN excluded.source='ted' THEN excluded.raw ELSE COALESCE(notices.raw,excluded.raw) END,updated_at=excluded.updated_at",
          params![id,n.source,n.notice_type,n.kind,n.title,n.description,n.buyer_id,n.buyer_name,n.buyer_city,db::to_string_list_json(&n.cpv_codes),n.contract_nature,n.procedure_type,n.estimated_value,n.awarded_value,n.discount_pct,n.currency,n.published_at,n.published_on,n.deadline_at,n.place_city,n.province,n.region,n.url,raw,db::now_iso()])?;
        if let (Some(buyer_id),Some(name))=(&n.buyer_id,&n.buyer_name) {tx.execute("INSERT INTO buyers(id,name,country,city,updated_at) VALUES(?,?,'IT',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,city=COALESCE(excluded.city,buyers.city),updated_at=excluded.updated_at",params![buyer_id,name,n.buyer_city,db::now_iso()])?;}
        for cpv in &n.cpv_codes {tx.execute("INSERT OR IGNORE INTO notice_cpv(notice_id,cpv) VALUES (?,?)",params![id,cpv])?;}
        let current:String=tx.query_row("SELECT cpv_codes FROM notices WHERE id=?",[id],|r|r.get(0))?;
        let mut codes=db::parse_string_list(&current);
        for code in &n.cpv_codes { if !codes.contains(code) { codes.push(code.clone()); } }
        tx.execute("UPDATE notices SET cpv_codes=? WHERE id=?",params![db::to_string_list_json(&codes),id])?;
        let (title,description,buyer):(String,Option<String>,Option<String>)=tx.query_row("SELECT title,description,buyer_name FROM notices WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let new_hash=db::text_hash(&title,description.as_deref(),buyer.as_deref());
        if old_hash.as_deref().map(|h|h!=new_hash).unwrap_or(false) {tx.execute("DELETE FROM notice_embedding WHERE notice_id=?",[id])?;}
        tx.execute("UPDATE notices SET text_hash=? WHERE id=?",params![new_hash,id])?;
        if let Some(f)=&n.flags {tx.execute("INSERT INTO notice_flags(notice_id,cig,cup,pnrr,pnrr_pnc,esito,esito_at,cig_accordo_quadro,lot_count,source_dataset,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(notice_id) DO UPDATE SET cig=COALESCE(notice_flags.cig,excluded.cig),cup=COALESCE(notice_flags.cup,excluded.cup),pnrr=MAX(notice_flags.pnrr,excluded.pnrr),pnrr_pnc=MAX(notice_flags.pnrr_pnc,excluded.pnrr_pnc),esito=COALESCE(excluded.esito,notice_flags.esito),esito_at=COALESCE(excluded.esito_at,notice_flags.esito_at),cig_accordo_quadro=COALESCE(excluded.cig_accordo_quadro,notice_flags.cig_accordo_quadro),lot_count=COALESCE(excluded.lot_count,notice_flags.lot_count),source_dataset=COALESCE(excluded.source_dataset,notice_flags.source_dataset),updated_at=excluded.updated_at",params![id,f.cig,f.cup,f.pnrr as i64,f.pnrr_pnc as i64,f.esito,f.esito_at,f.cig_accordo_quadro,f.lot_count,f.source_dataset,db::now_iso()])?;}
        for lot in &n.lots {tx.execute("INSERT INTO lots(id,notice_id,lot_number,title,description,estimated_value,awarded_value,cpv_codes,status,position) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=COALESCE(excluded.title,lots.title),description=COALESCE(excluded.description,lots.description),estimated_value=COALESCE(excluded.estimated_value,lots.estimated_value),awarded_value=COALESCE(excluded.awarded_value,lots.awarded_value),cpv_codes=excluded.cpv_codes,status=COALESCE(excluded.status,lots.status)",params![format!("{id}-lot-{}",lot.lot_number),id,lot.lot_number,lot.title,lot.description,lot.estimated_value,lot.awarded_value,db::to_string_list_json(&lot.cpv_codes),lot.status,lot.lot_number])?;}
        for a in &n.awards {tx.execute("INSERT INTO suppliers(id,name,country,updated_at) VALUES (?,?,'IT',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at",params![a.supplier_id,a.supplier_name,db::now_iso()])?; tx.execute("INSERT INTO awards(id,notice_id,supplier_id,supplier_name,awarded_value,estimated_value,currency,awarded_at,cpv_codes,region) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET awarded_value=COALESCE(excluded.awarded_value,awards.awarded_value),awarded_at=COALESCE(excluded.awarded_at,awards.awarded_at)",params![format!("{id}:{}",a.supplier_id),id,a.supplier_id,a.supplier_name,a.awarded_value,n.estimated_value,n.currency,a.awarded_at,db::to_string_list_json(&n.cpv_codes),n.region])?;result.awards+=1;}
        result.notices+=1;
    }
    tx.commit()?; Ok(result)
}

pub async fn run(path:PathBuf,from:String,to:String,types:Vec<String>,progress:impl Fn(IngestProgress)+Send+Sync)->Result<IngestStats> {
    let from_date=chrono::NaiveDate::parse_from_str(&from,"%Y-%m-%d").context("data iniziale non valida")?;
    let to_date=chrono::NaiveDate::parse_from_str(&to,"%Y-%m-%d").context("data finale non valida")?;
    if from_date>to_date {bail!("la data iniziale è successiva alla finale");}
    let allowed=all_notice_types(); if types.is_empty() || types.iter().any(|s|!allowed.contains(s)) {bail!("tipo avviso TED non valido");}
    let mut stats=IngestStats {started_at:db::now_iso(),..Default::default()};
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(90)).user_agent("CIG-Italia/0.1").build()?;
    let q=format!("buyer-country=ITA AND publication-date>={} AND publication-date<={} AND notice-type IN ({})",from_date.format("%Y%m%d"),to_date.format("%Y%m%d"),types.join(" "));
    let mut token:Option<String>=None;let mut tokens=HashSet::new();
    loop {
        progress(IngestProgress {phase:"download".into(),message:"TED · scarico gli avvisi".into(),fetched:stats.fetched,saved:stats.saved,awards:stats.awards,notice_type:None,current:stats.fetched,total:0});
        let mut body=json!({"query":q,"fields":["publication-number","notice-title","buyer-name","buyer-identifier","buyer-city","buyer-country","description-lot","description-proc","publication-date","notice-type","form-type","classification-cpv","contract-nature","procedure-type","estimated-value-proc","estimated-value-cur-proc","deadline-receipt-tender-date-lot","winner-name","total-value","total-value-cur"],"limit":100,"scope":"ALL","paginationMode":"ITERATION"});
        if let Some(t)=&token {body["iterationNextToken"]=json!(t);}
        let response=client.post("https://api.ted.europa.eu/v3/notices/search").json(&body).send().await.context("richiesta TED fallita")?;
        let status=response.status(); if !status.is_success(){let body=response.text().await.unwrap_or_default();bail!("TED ha risposto {status}: {}",body.chars().take(500).collect::<String>());}
        let data:Value=response.json().await.context("risposta TED non valida")?;
        let notices=data.get("notices").and_then(Value::as_array).context("risposta TED priva di avvisi")?;
        if notices.is_empty(){break;}
        stats.fetched+=notices.len() as u64;
        let mut batch=Vec::new();
        for raw in notices {if let Some(notice)=normalize::normalize(raw) { *stats.per_type.entry(notice.notice_type.clone()).or_default()+=1;batch.push(BatchRow {notice,raw:raw.clone()}); } else {stats.skipped+=1;}}
        let saved=save_batch(&path,&batch)?;stats.saved+=saved.notices;stats.awards+=saved.awards;
        let next=data.get("iterationNextToken").and_then(Value::as_str).filter(|s|!s.is_empty()).map(str::to_owned);
        match next {Some(next)=>{if !tokens.insert(next.clone()){bail!("TED ha restituito un cursore duplicato: importazione interrotta");}token=Some(next)},None=>break}
    }
    stats.finished_at=Some(db::now_iso());
    progress(IngestProgress {phase:"done".into(),message:"TED · importazione completata".into(),fetched:stats.fetched,saved:stats.saved,awards:stats.awards,notice_type:None,current:stats.fetched,total:stats.fetched});
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reimport_and_cross_source_cig_keep_user_signals() {
        let dir=std::env::temp_dir().join(format!("cig-ingest-{}-{:?}",std::process::id(),std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();let path=dir.join("db.sqlite");
        drop(db::Db::open(&path).unwrap());
        let raw=json!({"publication-number":"123-2026","notice-type":"cn-standard","notice-title":{"ita":"Gara"},"description-lot":{"ita":"CIG: BAEA6A55C3"}});
        let notice=normalize::normalize(&raw).unwrap();
        save_batch(&path,&[BatchRow {notice:notice.clone(),raw:raw.clone()}]).unwrap();
        {let conn=db::Db::connect(&path).unwrap();conn.execute("INSERT INTO user_signals(notice_id,signal) VALUES (?,'interest')",[&notice.id]).unwrap();}
        let mut anac=notice.clone();anac.id="anac-test".into();anac.source="anac".into();anac.title="Nome ANAC".into();
        save_batch(&path,&[BatchRow {notice:anac,raw:json!({})},BatchRow {notice:notice.clone(),raw}]).unwrap();
        let conn=db::Db::connect(&path).unwrap();
        let (count,title):(i64,String)=conn.query_row("SELECT count(*),max(title) FROM notices",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(count,1);assert_eq!(title,"Gara");
        assert_eq!(conn.query_row("SELECT count(*) FROM user_signals WHERE notice_id=?",[&notice.id],|r|r.get::<_,i64>(0)).unwrap(),1);
        drop(conn);let _=std::fs::remove_dir_all(dir);
    }
}
