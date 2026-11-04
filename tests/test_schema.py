import pathlib
import sqlite3
import unittest

SCHEMA = (pathlib.Path(__file__).parents[1] / 'src-tauri/src/schema.sql').read_text(encoding='utf-8')


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys = ON')
        self.db.executescript(SCHEMA)

    def tearDown(self):
        self.db.close()

    def test_idempotence_and_fts_triggers(self):
        self.db.executescript(SCHEMA)
        self.db.execute("INSERT INTO notices (id,notice_type,kind,title) VALUES ('n','x','call','servizi pulizia')")
        self.assertEqual(self.match('pulizia'), 1)
        self.db.execute("UPDATE notices SET title='gestione rifiuti' WHERE id='n'")
        self.assertEqual(self.match('pulizia'), 0)
        self.assertEqual(self.match('rifiuti'), 1)
        self.db.execute("DELETE FROM notices WHERE id='n'")
        self.assertEqual(self.match('rifiuti'), 0)

    def match(self, query):
        return self.db.execute('SELECT count(*) FROM notices_fts WHERE notices_fts MATCH ?', (query,)).fetchone()[0]

    def test_signals_coexist_and_cascade(self):
        self.db.execute("INSERT INTO notices (id,notice_type,kind,title) VALUES ('n','x','call','gara')")
        self.db.executemany('INSERT INTO user_signals(notice_id,signal) VALUES (?,?)', [('n','hide'),('n','interest')])
        self.assertEqual(self.db.execute('SELECT count(*) FROM user_signals').fetchone()[0], 2)
        self.db.execute("DELETE FROM notices WHERE id='n'")
        self.assertEqual(self.db.execute('SELECT count(*) FROM user_signals').fetchone()[0], 0)

    def test_supplier_suggestion_aggregates_awards(self):
        import re
        source = (pathlib.Path(__file__).parents[1] / 'src-tauri/src/entities.rs').read_text(encoding='utf-8')
        query = re.search(r'"(SELECT s\.id, s\.name, COUNT\(a\.id\).*?LIMIT \?)"', source, re.S).group(1)
        self.db.execute("INSERT INTO suppliers (id,name) VALUES ('s','Impresa')")
        self.db.execute("INSERT INTO notices (id,notice_type,kind,title) VALUES ('n','x','award','gara')")
        self.db.executemany("INSERT INTO awards (id,notice_id,supplier_id,supplier_name,awarded_value) VALUES (?,?,?,?,?)", [('a','n','s','Impresa',100), ('b','n','s','Impresa',200)])
        self.assertEqual(self.db.execute(query, ('%impresa%', 30)).fetchone(), ('s', 'Impresa', 2, 300))

    def test_ingestion_upsert_keeps_primary_ted_data_and_user_links(self):
        import re
        source = (pathlib.Path(__file__).parents[1] / 'src-tauri/src/ingest.rs').read_text(encoding='utf-8')
        query = re.search(r'"(INSERT INTO notices\(id,source,notice_type,kind,title,description.*?updated_at=excluded.updated_at)"', source, re.S).group(1)
        def save(src, title, description):
            self.db.execute(query, ('n', src, 'cn-standard', 'call', title, description, None, None, None, '[]', None, None, None, None, None, 'EUR', None, None, None, None, None, None, None, '{}', 'now'))
        save('anac', 'ANAC', 'descrizione')
        self.db.execute("INSERT INTO user_signals(notice_id,signal) VALUES ('n','interest')")
        save('ted', 'TED', None)
        save('anac', 'ANAC aggiornato', None)
        self.assertEqual(self.db.execute("SELECT source,title,description FROM notices WHERE id='n'").fetchone(), ('ted', 'TED', 'descrizione'))
        self.assertEqual(self.db.execute("SELECT signal FROM user_signals WHERE notice_id='n'").fetchone(), ('interest',))

    def test_embedding_commit_skips_changed_text(self):
        import re
        source = (pathlib.Path(__file__).parents[1] / 'src-tauri/src/commands.rs').read_text(encoding='utf-8')
        query = re.search(r'"(INSERT INTO notice_embedding \(notice_id, embedding, model, dims, updated_at\).*?model = excluded.model, dims = excluded.dims, updated_at = excluded.updated_at)"', source, re.S).group(1)
        self.db.execute("INSERT INTO notices (id,notice_type,kind,title) VALUES ('n','x','call','nuovo testo')")
        args = ('n', b'1234', 'model', 1, 'now', 'n', 'vecchio testo', None, None)
        self.db.execute(query, args)
        self.assertEqual(self.db.execute('SELECT count(*) FROM notice_embedding').fetchone()[0], 0)
        args = ('n', b'1234', 'model', 1, 'now', 'n', 'nuovo testo', None, None)
        self.db.execute(query, args)
        self.assertEqual(self.db.execute('SELECT count(*) FROM notice_embedding').fetchone()[0], 1)

    def test_duplicate_notice_document_reassignment(self):
        self.db.executemany("INSERT INTO notices(id,notice_type,kind,title) VALUES (?,?,?,?)", [('a','x','call','a'),('b','x','call','b')])
        self.db.executemany("INSERT INTO notice_documents(id,notice_id,filename,hash,pages,chars,page_texts) VALUES (?,?,?,?,?,?,?)", [('d1','a','uno.txt','same',1,1,'[]'),('d2','b','due.txt','same',1,1,'[]'),('d3','b','tre.txt','unique',1,1,'[]')])
        self.db.execute("INSERT INTO document_analysis(document_id,version,payload) VALUES ('d2',1,'{}')")
        self.db.execute("INSERT OR IGNORE INTO document_analysis (document_id, version, payload, created_at) SELECT ?, version, payload, created_at FROM document_analysis WHERE document_id = ?", ('d1','d2'))
        self.db.execute("UPDATE notice_documents SET notice_id = ? WHERE id = ?", ('a','d3'))
        self.db.execute("DELETE FROM notices WHERE id='b'")
        self.assertEqual(self.db.execute("SELECT id FROM notice_documents ORDER BY id").fetchall(), [('d1',), ('d3',)])
        self.assertEqual(self.db.execute("SELECT document_id FROM document_analysis").fetchone(), ('d1',))

    def test_board_query_uses_28_notice_columns(self):
        import re
        source = (pathlib.Path(__file__).parents[1] / 'src-tauri/src/search.rs').read_text(encoding='utf-8')
        hit = re.search(r'pub const HIT_COLUMNS: &str = "(.*?)";', source, re.S).group(1).replace('\\\n', ' ')
        self.db.execute("INSERT INTO notices (id,notice_type,kind,title) VALUES ('n','x','call','gara')")
        self.db.execute("INSERT INTO board_items (notice_id,column_key,position,note) VALUES ('n','valutare',4,'nota')")
        row = self.db.execute(f"SELECT {hit}, b.column_key, b.position, b.note, b.updated_at FROM board_items b JOIN notices n ON n.id=b.notice_id").fetchone()
        self.assertEqual(row[28:31], ('valutare', 4, 'nota'))

    def test_rebuild_indexes_legacy_rows(self):
        db = sqlite3.connect(':memory:')
        # A realistic existing notices table, without the FTS index yet.
        db.executescript("CREATE TABLE notices(id TEXT PRIMARY KEY, source TEXT DEFAULT 'ted', notice_type TEXT, kind TEXT, title TEXT, description TEXT, buyer_id TEXT, buyer_name TEXT, buyer_city TEXT, cpv_codes TEXT DEFAULT '[]', contract_nature TEXT, procedure_type TEXT, estimated_value REAL, awarded_value REAL, discount_pct REAL, currency TEXT, published_at TEXT, published_on TEXT, deadline_at TEXT, place_city TEXT, province TEXT, region TEXT, url TEXT, raw TEXT, text_hash TEXT, embedded_at TEXT, created_at TEXT, updated_at TEXT); INSERT INTO notices(id,notice_type,kind,title) VALUES('old','x','call','gara storica');")
        db.executescript(SCHEMA)
        self.assertEqual(db.execute("SELECT count(*) FROM notices_fts WHERE notices_fts MATCH 'storica'").fetchone()[0], 1)
        db.close()

if __name__ == '__main__':
    unittest.main()
