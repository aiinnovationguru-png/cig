use std::process::Command;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct ApiCallArgs {
    pub site: String,
    pub op: String,
    pub args: serde_json::Value,
}

#[tauri::command]
pub fn api_anything_sites(query: Option<String>) -> Result<serde_json::Value, String> {
    let mut cmd = Command::new("npx");
    cmd.args(["-y", "api-anything"]);
    if let Some(q) = query {
        cmd.args(["search", &q]);
    } else {
        cmd.args(["sites"]);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(&text).map_err(|e| format!("JSON error: {e} | output: {text}"))
}

#[tauri::command]
pub fn api_anything_ops(site: String) -> Result<serde_json::Value, String> {
    let out = Command::new("npx")
        .args(["-y", "api-anything", "ops", &site])
        .output()
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&out.stdout).map_err(|e| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn api_anything_call(site: String, op: String, args_json: String) -> Result<serde_json::Value, String> {
    let out = Command::new("npx")
        .args(["-y", "api-anything", "call", &site, &op])
        .arg(&args_json)
        .output()
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&out.stdout).map_err(|_| String::from_utf8_lossy(&out.stdout).into_owned())
}
