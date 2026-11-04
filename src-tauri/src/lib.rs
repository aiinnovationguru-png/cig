//! Inizializzazione dell’app desktop e comandi esposti alla UI.

pub mod alerts;
pub mod anac;
pub mod api_anything;
pub mod awards;
pub mod board;
pub mod commands;
pub mod config;
pub mod db;
pub mod documents;
pub mod embed;
pub mod entities;
pub mod evaluate;
mod evaluation_engine;
mod italian_numbers;
pub mod export;
pub mod geo;
pub mod ingest;
pub mod search;
pub mod ted;

use std::sync::{Arc, RwLock};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = config::Paths::new(app.path().app_data_dir()?)?;
            let settings = Arc::new(RwLock::new(config::Settings::load(&paths.settings_path)));
            let db = Arc::new(db::Db::open(&paths.db_path)?);
            if let Ok(current) = settings.read() {
                embed::warm_up(current.clone());
            }
            alerts::spawn_scheduler(app.handle().clone(), db.clone(), settings.clone(), |handle, message| {
                let _ = handle.emit("alert-status", message.to_owned());
            });
            app.manage(commands::AppState { db, settings, paths });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_stats,
            commands::search_notices,
            commands::notice_detail,
            commands::notice_documents,
            commands::add_notice_document,
            commands::remove_notice_document,
            commands::analyze_notice_document,
            commands::set_user_signal,
            commands::clear_user_signal,
            commands::follow_entity,
            commands::unfollow_entity,
            commands::list_followed_entities,
            commands::update_followed_entity,
            commands::entity_profile,
            commands::entity_suggestions,
            commands::predict_from_entity,
            commands::award_intel,
            commands::geo_filters,
            commands::board_list,
            commands::board_add,
            commands::board_update,
            commands::board_remove,
            commands::export_notice,
            commands::export_board,
            commands::export_search,
            commands::hidden_notices,
            commands::save_search,
            commands::list_saved_searches,
            commands::delete_saved_search,
            commands::set_saved_search_active,
            commands::send_test_email,
            commands::preview_digest,
            commands::send_digest,
            commands::evaluate_report,
            commands::list_evaluations,
            commands::delete_evaluation,
            commands::get_settings,
            commands::save_settings,
            commands::embedding_status,
            commands::embed_pending,
            commands::ingest_range,
            commands::ingest_anac_range,
            commands::data_summary,
            api_anything::api_anything_sites,
            api_anything::api_anything_ops,
            api_anything::api_anything_call,
        ])
        .run(tauri::generate_context!())
        .expect("impossibile avviare CIG");
}
