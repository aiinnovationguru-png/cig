//! Conversione dei risultati TED nel formato condiviso con ANAC.
use serde_json::Value;
use std::sync::OnceLock;
use regex::Regex;

#[derive(Debug, Clone)]
pub struct NormalizedFlags { pub cig: Option<String>, pub cup: Option<String>, pub pnrr: bool, pub pnrr_pnc: bool, pub esito: Option<String>, pub esito_at: Option<String>, pub cig_accordo_quadro: Option<String>, pub lot_count: Option<i64>, pub source_dataset: Option<String> }
#[derive(Debug, Clone)]
pub struct NormalizedLot { pub lot_number: i64, pub title: Option<String>, pub description: Option<String>, pub estimated_value: Option<f64>, pub awarded_value: Option<f64>, pub cpv_codes: Vec<String>, pub status: Option<String> }
#[derive(Debug, Clone)]
pub struct NormalizedAward { pub supplier_id:String, pub supplier_name:String, pub awarded_value:Option<f64>, pub awarded_at:Option<String> }
#[derive(Debug, Clone)]
pub struct NormalizedNotice {
    pub id:String, pub source:String, pub notice_type:String, pub kind:String, pub title:String,
    pub description:Option<String>, pub buyer_id:Option<String>, pub buyer_name:Option<String>, pub buyer_city:Option<String>,
    pub cpv_codes:Vec<String>, pub contract_nature:Option<String>, pub procedure_type:Option<String>,
    pub estimated_value:Option<f64>, pub awarded_value:Option<f64>, pub currency:String, pub published_at:Option<String>,
    pub published_on:Option<String>, pub deadline_at:Option<String>, pub place_city:Option<String>, pub province:Option<String>,
    pub region:Option<String>, pub url:Option<String>, pub discount_pct:Option<f64>, pub awards:Vec<NormalizedAward>,
    pub lots:Vec<NormalizedLot>, pub flags:Option<NormalizedFlags>,
}

pub fn slugify(s:&str)->String {
    let result=s.to_lowercase().chars().map(|c| if c.is_alphanumeric() {c} else {'-'}).collect::<String>();
    result.split('-').filter(|s|!s.is_empty()).collect::<Vec<_>>().join("-")
}
fn first(v:&Value)->Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty()=>Some(s.trim().to_string()),
        Value::Number(n)=>Some(n.to_string()),
        Value::Array(a)=>a.iter().find_map(first),
        Value::Object(m)=>m.get("ita").and_then(first).or_else(||m.get("eng").and_then(first)).or_else(||m.values().find_map(first)),
        _=>None,
    }
}
fn field(v:&Value,keys:&[&str])->Option<String> {keys.iter().find_map(|k|v.get(*k).and_then(first))}
fn collect_strings(v:&Value, out:&mut Vec<String>) {
    match v {Value::String(s)=>out.push(s.clone()),Value::Array(a)=>for v in a {collect_strings(v,out)},Value::Object(m)=>for v in m.values(){collect_strings(v,out)},_=>{}}
}
pub fn extract_flags_from_notice(value:&Value)->NormalizedFlags {
    static CIG:OnceLock<Regex>=OnceLock::new();static CUP:OnceLock<Regex>=OnceLock::new();
    let cig=CIG.get_or_init(||Regex::new(r"(?i)\bCIG\s*[:#-]?\s*([A-Z0-9]{10})\b").unwrap());
    let cup=CUP.get_or_init(||Regex::new(r"(?i)\bCUP\s*[:#-]?\s*([A-Z0-9]{15})\b").unwrap());
    let mut texts=Vec::new();collect_strings(value,&mut texts);
    let cig=texts.iter().find_map(|s|cig.captures(s).map(|c|c[1].to_ascii_uppercase()));
    let cup=texts.iter().find_map(|s|cup.captures(s).map(|c|c[1].to_ascii_uppercase()));
    let pnrr=texts.iter().any(|s|s.to_uppercase().contains("PNRR"));
    let pnrr_pnc=pnrr || texts.iter().any(|s|s.to_uppercase().contains("PNC"));
    NormalizedFlags {cig,cup,pnrr,pnrr_pnc,esito:None,esito_at:None,cig_accordo_quadro:None,lot_count:None,source_dataset:None}
}
fn values(v:&Value)->Vec<String> {
    match v {
        Value::Array(items)=>items.iter().flat_map(values).collect(),
        Value::Object(map)=>map.get("ita").or_else(||map.get("eng")).or_else(||map.values().next()).map(values).unwrap_or_default(),
        _=>first(v).into_iter().collect(),
    }
}
pub fn normalize(value:&Value)->Option<NormalizedNotice> {
    let publication=field(value,&["publication-number"])?;
    let title=field(value,&["notice-title","title-procedure","title-lot"])?;
    let notice_type=field(value,&["notice-type"]).unwrap_or_default();
    let form=field(value,&["form-type"]).unwrap_or_default();
    let kind=if form=="result" || (notice_type.starts_with("can-") || notice_type=="veat") {"award"} else if form=="competition" || notice_type.starts_with("cn-") {"call"} else {"other"};
    let buyer_name=field(value,&["buyer-name"]);
    let buyer_id=field(value,&["buyer-identifier"]).map(|s|s.chars().filter(|c|c.is_ascii_alphanumeric()).collect::<String>().to_uppercase())
        .filter(|s|!s.is_empty()).map(|s|format!("buyer-cf-{s}"))
        .or_else(||buyer_name.as_ref().map(|s|format!("buyer-ted-{}",slugify(s))));
    let awarded_value=field(value,&["total-value"]).and_then(|s|s.parse::<f64>().ok()).filter(|v|v.is_finite());
    let winners=if kind=="award" {value.get("winner-name").map(values).unwrap_or_default()} else {Vec::new()};
    let mut seen=std::collections::HashSet::new();
    let awards=winners.iter().filter_map(|name| {let slug=slugify(name);if slug.is_empty()||!seen.insert(slug.clone()){return None;}
        Some(NormalizedAward {supplier_id:format!("name-{slug}"),supplier_name:name.to_string(),awarded_value:if winners.len()==1 {awarded_value}else{None},awarded_at:None})
    }).collect();
    let mut codes=Vec::new(); if let Some(value)=value.get("classification-cpv") {let mut all=Vec::new();collect_strings(value,&mut all);for s in all {if !codes.contains(&s) {codes.push(s);}}}
    let published_on=field(value,&["publication-date"]).and_then(|s|s.get(..10).map(str::to_string));
    let flags=extract_flags_from_notice(value);
    Some(NormalizedNotice {id:format!("ted-{publication}"),source:"ted".into(),notice_type,kind:kind.into(),title,
        description:field(value,&["description-proc","description-lot","notice-description"]),buyer_id,buyer_name,buyer_city:field(value,&["buyer-city"]),cpv_codes:codes,
        contract_nature:field(value,&["contract-nature"]),procedure_type:field(value,&["procedure-type"]),
        estimated_value:field(value,&["estimated-value-proc","estimated-value-lot"]).and_then(|s|s.parse().ok()),
        awarded_value,currency:field(value,&["estimated-value-cur-proc","total-value-cur"]).unwrap_or_else(||"EUR".into()),
        published_at:published_on.as_ref().map(|s|format!("{s}T00:00:00Z")),published_on,deadline_at:field(value,&["deadline-receipt-tender-date-lot","deadline"]),
        place_city:field(value,&["place-of-performance-city-lot"]),province:None,region:None,url:Some(format!("https://ted.europa.eu/it/notice/-/detail/{publication}")),discount_pct:None,awards,lots:vec![],flags:Some(flags)})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_italian_ted_result_and_flags_without_inventing_fields() {
        let value=serde_json::json!({"publication-number":"123456-2026","notice-type":"can-standard","form-type":"result", "notice-title":{"ita":["Lavori pubblici"]}, "description-lot":{"ita":["CIG: BAEA6A55C3 CUP: J81B21003260002 PNRR"]}, "buyer-name":{"ita":["Comune"]},"winner-name":{"ita":["Impresa A"]},"total-value":1000,"publication-date":"2026-01-03","classification-cpv":["45000000"]});
        let n=normalize(&value).unwrap();
        assert_eq!(n.kind,"award");assert_eq!(n.awards.len(),1);assert_eq!(n.awards[0].awarded_value,Some(1000.0));
        let flags=n.flags.unwrap();assert_eq!(flags.cig.as_deref(),Some("BAEA6A55C3"));assert_eq!(flags.cup.as_deref(),Some("J81B21003260002"));assert!(flags.pnrr);
    }
    #[test]
    fn does_not_assign_total_award_value_to_multiple_winners() {
        let value=serde_json::json!({"publication-number":"1-2026","notice-type":"can-standard","notice-title":{"ita":"Risultato"},"winner-name":{"ita":["A","B"]},"total-value":100});
        let n=normalize(&value).unwrap();assert_eq!(n.awards.len(),2);assert!(n.awards.iter().all(|a|a.awarded_value.is_none()));
    }
}
