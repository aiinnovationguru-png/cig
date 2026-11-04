-- Archivio locale. Ogni istruzione è idempotente: non cancella dati esistenti.
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'ted', notice_type TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT, buyer_id TEXT, buyer_name TEXT,
  buyer_city TEXT, cpv_codes TEXT NOT NULL DEFAULT '[]', contract_nature TEXT,
  procedure_type TEXT, estimated_value REAL, awarded_value REAL, discount_pct REAL,
  currency TEXT NOT NULL DEFAULT 'EUR', published_at TEXT, published_on TEXT,
  deadline_at TEXT, place_city TEXT, province TEXT, region TEXT, url TEXT, raw TEXT,
  text_hash TEXT, embedded_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS notices_source_idx ON notices(source);
CREATE INDEX IF NOT EXISTS notices_buyer_idx ON notices(buyer_id);
CREATE INDEX IF NOT EXISTS notices_published_idx ON notices(published_at);
CREATE INDEX IF NOT EXISTS notices_deadline_idx ON notices(deadline_at);
CREATE INDEX IF NOT EXISTS notices_region_idx ON notices(region, province);
CREATE TABLE IF NOT EXISTS buyers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT, city TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT, city TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS awards (
  id TEXT PRIMARY KEY, notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  supplier_id TEXT, supplier_name TEXT, awarded_value REAL, estimated_value REAL,
  discount_pct REAL, currency TEXT DEFAULT 'EUR', awarded_at TEXT,
  cpv_codes TEXT NOT NULL DEFAULT '[]', region TEXT
);
CREATE INDEX IF NOT EXISTS awards_notice_idx ON awards(notice_id);
CREATE INDEX IF NOT EXISTS awards_supplier_idx ON awards(supplier_id);
CREATE TABLE IF NOT EXISTS notice_cpv (
  notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  cpv TEXT NOT NULL, PRIMARY KEY(notice_id, cpv)
);
CREATE INDEX IF NOT EXISTS notice_cpv_code_idx ON notice_cpv(cpv);
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY, notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  lot_number INTEGER NOT NULL, title TEXT, description TEXT, estimated_value REAL, awarded_value REAL, status TEXT,
  cpv_codes TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lots_notice_idx ON lots(notice_id);
CREATE TABLE IF NOT EXISTS notice_flags (
  notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
  cig TEXT, cup TEXT, pnrr INTEGER NOT NULL DEFAULT 0, pnrr_pnc INTEGER NOT NULL DEFAULT 0,
  esito TEXT, esito_at TEXT, cig_accordo_quadro TEXT, lot_count INTEGER,
  source_dataset TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS notice_flags_cig_idx ON notice_flags(cig);
CREATE TABLE IF NOT EXISTS notice_embedding (
  notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_signals (
  notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  signal TEXT NOT NULL CHECK (signal IN ('hide', 'interest')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(notice_id, signal)
);
CREATE INDEX IF NOT EXISTS user_signals_signal_idx ON user_signals(signal, created_at DESC);
CREATE TABLE IF NOT EXISTS board_items (
  notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
  column_key TEXT NOT NULL DEFAULT 'valutare', position INTEGER NOT NULL DEFAULT 0,
  note TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, query TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}', frequency TEXT NOT NULL DEFAULT 'daily',
  active INTEGER NOT NULL DEFAULT 1, min_similarity REAL NOT NULL DEFAULT 0.6,
  last_run_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS search_embedding (
  search_id INTEGER PRIMARY KEY REFERENCES saved_searches(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL, model TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS followed_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL CHECK(entity_type IN ('supplier','buyer')),
  entity_id TEXT NOT NULL, name TEXT NOT NULL, min_similarity REAL NOT NULL DEFAULT 0.75,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, saved_search_id INTEGER REFERENCES saved_searches(id) ON DELETE SET NULL,
  notice_ids TEXT NOT NULL DEFAULT '[]', recipient TEXT, subject TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT 'ted',
  started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, from_date TEXT, to_date TEXT,
  fetched INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
  awards INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'running', message TEXT
);
CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, notice_id TEXT REFERENCES notices(id) ON DELETE SET NULL,
  report_title TEXT, report_text TEXT NOT NULL, created_at TEXT NOT NULL, total_score REAL NOT NULL,
  max_score REAL NOT NULL, criteria_json TEXT NOT NULL, result_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notice_documents (
  id TEXT PRIMARY KEY, notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, hash TEXT NOT NULL, pages INTEGER NOT NULL, chars INTEGER NOT NULL,
  page_texts TEXT NOT NULL, added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(notice_id, hash)
);
CREATE TABLE IF NOT EXISTS document_analysis (
  document_id TEXT PRIMARY KEY REFERENCES notice_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS notices_fts USING fts5(title, description, buyer_name, content='notices', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS notices_fts_insert AFTER INSERT ON notices BEGIN
  INSERT INTO notices_fts(rowid,title,description,buyer_name) VALUES(new.rowid,new.title,new.description,new.buyer_name);
END;
CREATE TRIGGER IF NOT EXISTS notices_fts_delete AFTER DELETE ON notices BEGIN
  INSERT INTO notices_fts(notices_fts,rowid,title,description,buyer_name) VALUES('delete',old.rowid,old.title,old.description,old.buyer_name);
END;
CREATE TRIGGER IF NOT EXISTS notices_fts_update AFTER UPDATE OF title,description,buyer_name ON notices BEGIN
  INSERT INTO notices_fts(notices_fts,rowid,title,description,buyer_name) VALUES('delete',old.rowid,old.title,old.description,old.buyer_name);
  INSERT INTO notices_fts(rowid,title,description,buyer_name) VALUES(new.rowid,new.title,new.description,new.buyer_name);
END;

-- Indice FTS iniziale anche per archivi creati prima dell'installazione dei trigger.
INSERT INTO notices_fts(notices_fts) SELECT 'rebuild'
  WHERE NOT EXISTS (SELECT 1 FROM schema_meta WHERE key = 'notices_fts_v1');
INSERT OR IGNORE INTO schema_meta(key, value) VALUES('notices_fts_v1', '1');
