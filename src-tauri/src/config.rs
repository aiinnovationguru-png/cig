use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub settings_path: PathBuf,
    pub exports_dir: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&data_dir)?;
        let exports_dir = data_dir.join("export");
        fs::create_dir_all(&exports_dir)?;
        Ok(Self {
            db_path: data_dir.join("cig.db"),
            settings_path: data_dir.join("settings.json"),
            exports_dir,
            data_dir,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: String,
    pub smtp_user: String,
    pub smtp_password: String,
    pub smtp_from: String,
    pub alert_recipient: String,
    pub alert_hour: u8,
    /// Fuso orario dello scheduler: "local" (sistema) oppure "utc".
    pub digest_timezone: String,
    /// "local" (modello multilingua offline) oppure "api" (endpoint OpenAI-compatibile).
    pub embedding_provider: String,
    pub api_base_url: String,
    pub api_key: String,
    pub api_model: String,
    /// Giorni di storico considerati dal digest giornaliero.
    pub digest_days: u32,
    /// Numero massimo di gare inserite in un singolo digest.
    pub digest_max_notices: u32,
    /// All'apertura della ricerca, nascondere le gare già scadute.
    pub hide_expired_default: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            smtp_host: String::new(),
            smtp_port: 587,
            smtp_security: "starttls".into(),
            smtp_user: String::new(),
            smtp_password: String::new(),
            smtp_from: String::new(),
            alert_recipient: String::new(),
            alert_hour: 7,
            digest_timezone: "local".into(),
            embedding_provider: "local".into(),
            api_base_url: "https://api.openai.com/v1".into(),
            api_key: String::new(),
            api_model: "text-embedding-3-small".into(),
            digest_days: 1,
            digest_max_notices: 12,
            hide_expired_default: true,
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<Settings>(&text) {
                Ok(settings) => settings.sanitized(),
                Err(_) => {
                    // Non si buttano via credenziali e preferenze in silenzio: una
                    // copia del file illeggibile resta accanto a quello nuovo.
                    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
                    let backup = path.with_extension(format!("json.corrotto-{stamp}"));
                    let _ = fs::copy(path, backup);
                    Settings::default()
                }
            },
            Err(_) => Settings::default(),
        }
    }

    /// I valori arrivano anche da un file modificato a mano: qui si riportano
    /// nei limiti accettati dal resto dell'app.
    pub(crate) fn sanitized(mut self) -> Self {
        if self.smtp_port == 0 {
            self.smtp_port = 587;
        }
        if !matches!(self.smtp_security.as_str(), "starttls" | "tls" | "none") {
            self.smtp_security = "starttls".into();
        }
        if self.alert_hour > 23 {
            self.alert_hour = 7;
        }
        if !matches!(self.digest_timezone.as_str(), "local" | "utc") {
            self.digest_timezone = "local".into();
        }
        self.digest_days = self.digest_days.clamp(1, 30);
        self.digest_max_notices = self.digest_max_notices.clamp(1, 50);
        if !matches!(self.embedding_provider.as_str(), "local" | "api") {
            self.embedding_provider = "local".into();
        }
        self
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(&self.clone().sanitized()).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
        })?;
        // File unico nella stessa directory: persist sostituisce il file esistente
        // senza cancellarlo prima, anche su Windows. In caso di errore il vecchio
        // file rimane disponibile; i file temporanei non si scontrano tra salvataggi.
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        tmp.write_all(json.as_bytes())?;
        tmp.as_file().sync_all()?;
        tmp.persist(path).map_err(|err| err.error)?;
        Ok(())
    }

    pub fn smtp_configured(&self) -> bool {
        !self.smtp_host.trim().is_empty()
            && !self.smtp_from.trim().is_empty()
            && !self.alert_recipient.trim().is_empty()
    }

    pub fn embeddings_ready(&self) -> bool {
        self.embedding_provider == "local" || !self.api_key.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_replaces_existing_settings_and_sanitizes_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "old settings").unwrap();
        let settings = Settings { alert_hour: 99, smtp_port: 0, ..Settings::default() };
        settings.save(&path).unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.alert_hour, 7);
        assert_eq!(loaded.smtp_port, 587);
    }

    #[test]
    fn failed_save_never_removes_existing_target_directory() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        fs::create_dir(&target).unwrap();
        let marker = target.join("keep.txt");
        fs::write(&marker, b"preserve").unwrap();
        assert!(Settings::default().save(&target).is_err());
        assert_eq!(fs::read(&marker).unwrap(), b"preserve");
    }
}
