# CIG — Intelligence appalti Italia
## Prompt di implementazione completa (prodotto finale v1)

Sei un senior full-stack engineer. Devi completare (o ricostruire in coerenza) l’app desktop **CIG**: tool **locale** per imprese e professionisti che partecipano alle gare pubbliche **solo in Italia**.

### Stack obbligatorio
- Backend: Rust + Tauri 2
- DB: SQLite via `rusqlite` (FTS5, trigger già previsti)
- Embedding: `fastembed` + `multilingual-e5-small` (offline, 384 dim, vettori L2-normalizzati; similarità = dot product)
- Frontend: React 19 + TypeScript + Vite + Tailwind 4
- Email: `lettre` (SMTP)
- Export: `rust_xlsxwriter`
- HTTP: `reqwest` (rustls)

Niente server da ospitare. Dati e modello sul PC dell’utente. Nessun account cloud obbligatorio.

Se nel workspace esiste già il repo CIG (`src/`, `src-tauri/src/{ted,search,awards,board,alerts,evaluate,ingest,embed,commands,db,schema.sql}`), **estendi** quello. Non rifare da zero ciò che funziona (ingest TED, search semantic+FTS, board, alerts, evaluate).

---

## 0. Persona e definition of done

Utente: ufficio gare / commerciale impresa italiana, consulente, RTI.

Dopo ingest ~90 giorni TED+ANAC e embedding, deve poter:

1. Cercare in linguaggio naturale e vedere risultati ordinati per senso con **% similarità** e motivo breve.
2. Filtrare (territorio, importo, natura, source, aperti) con pannello fisso senza cambiare pagina.
3. **Nascondere** una gara e non rivederla più nelle ricerche.
4. Aprire un’impresa e vedere gare **aperte** simili al suo storico di vittorie (Predizioni).
5. **Seguire** quell’impresa e ricevere digest email la mattina.
6. Mettere gare in **bacheca**, spostarle di colonna, note, calendario scadenze, export Excel.
7. Incollare una **relazione tecnica** e vedere copertura criterio per criterio con evidenze.
8. Lavorare **offline** dopo l’ingest.

Se manca uno di questi 8 punti, v1 non è finita.

---

## 1. Fonti dati (solo Italia)

### 1.1 TED (mantenere/raffinare)
- Client esistente in `src-tauri/src/ted/`.
- Search API TED v3, filtro fisso buyer-country = ITA.
- Tipi: call (bandi) + award (aggiudicazioni).
- Normalizzazione già in `normalize.rs` → `NormalizedNotice`.
- Campo `source = "ted"`.

### 1.2 ANAC / BDNCP (nuovo, obbligatorio)
Modulo nuovo: `src-tauri/src/anac/`.

**Priorità implementativa**
1. Dump open data mensili scaricabili **senza auth** da https://dati.anticorruzione.it/ (sezione Dataset: JSON/CSV per mese).
2. Se stabile, OCDS REST su https://dati.anticorruzione.it/opendata/ocds_it.
3. PDND solo come nota in README se richiede registrazione: non bloccare v1.

**Mapping minimo ANAC → schema notices**
| Campo ANAC tipico | Campo CIG |
|---|---|
| cig / id gara | id (prefisso `anac:` se collisione) + notice_flags.cig |
| oggetto | title (+ description se presente) |
| stazioneAppaltante / cf | buyer_name, buyer_id |
| provincia | province → region via `geo.rs` |
| cpv / descrizioneCpv | cpv_codes + notice_cpv |
| importoComplessivo / base asta | estimated_value |
| dataPubblicazione | published_at / published_on |
| dataScadenzaOfferta | deadline_at |
| procedura / settore | procedure_type, contract_nature (map a works/services/supplies) |
| stato / esito | kind call vs award; se aggiudicato popola awards |
| aggiudicatario | suppliers + awards |
| pnrrPnc | notice_flags.pnrr |
| url | url |

- `source = "anac"`.
- Dedup: se stesso CIG già da TED, tieni il record più completo (più campi non null + awards) e aggiorna `source` o lascia TED come primario con flag.
- Ingest con progress event analogo a TED (`IngestProgress`).

**Non in v1:** scraping MePA o portali regionali instabili.

---

## 2. Schema DB — estensioni idempotenti

Aggiungere a `schema.sql` e garantire migrazione a runtime se DB già esiste:

```sql
-- su notices (se manca)
-- source TEXT NOT NULL DEFAULT 'ted'
-- (cig/cup possono stare in notice_flags)

CREATE TABLE IF NOT EXISTS user_signals (
  notice_id  TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  signal     TEXT NOT NULL CHECK (signal IN ('interest','hide')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notice_id, signal)
);

CREATE TABLE IF NOT EXISTS lots (
  id              TEXT PRIMARY KEY,
  notice_id       TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  title           TEXT,
  estimated_value REAL,
  cpv_codes       TEXT NOT NULL DEFAULT '[]',
  position        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lots_notice_idx ON lots (notice_id);

CREATE TABLE IF NOT EXISTS followed_entities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('supplier','buyer')),
  entity_id      TEXT NOT NULL,
  entity_name    TEXT NOT NULL,
  min_similarity REAL NOT NULL DEFAULT 0.75,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS notice_flags (
  notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
  pnrr      INTEGER NOT NULL DEFAULT 0,
  cig       TEXT,
  cup       TEXT
);

CREATE INDEX IF NOT EXISTS notices_source_idx ON notices (source);Regole:
hide → esclusione SQL in tutte le ricerche.
Aggiornamento notice (re-ingest) → cancella embedding di quel notice (già fatto in ingest TED) e rigenera in coda embed_pending.
FTS trigger esistenti restano validi.
3. Ricerca — comportamento preciso3.1 RequestEstendere SearchRequest / SearchFilters:
source: Option<"ted"|"anac"|"all"> (default all)
min_similarity: Option<f32> (0.0–1.0; UI 0–100)
filtri già presenti: kind, region, province, cpv_prefix, category, buyer, min/max value, min/max discount, deadline_, published_, only_awarded, hide_expired
Nuovo implicito: escludere notice_id presenti in user_signals con signal=hide
3.2 Ranking
Se query non vuota e embedding disponibile e non keyword_only:
Filtra candidati con build_where + exclude hide + source.
Score = dot(query_vec, notice_vec).
Ordina per score desc.
Applica min_similarity se impostato (default UI ~0.50–0.78).
Paginazione offset/limit dopo il rank.

Altrimenti FTS5 italiano (token OR con prefix *, stopword già gestite) + stessi filtri.
Query vuota: solo filtri + sort (published | deadline | value | discount).
3.3 “Perché è uscito”Per i top risultati semantic, se fattibile a basso costo:
similarità su titolo vs descrizione (chunk) vs label CPV; mostra la voce dominante + %.
Se troppo costoso in v1: mostra solo % globale in card; documenta il dettaglio come miglioramento.
3.4 UI Search
Layout: filtri fissi a sinistra (collassabili), risultati a destra.
Mode tabs: AI semantic | Filtrata | Predizioni.
Slider similarità visibile solo in semantic.
Chip filtri attivi + Clear + conteggio.
Card: titolo, località·buyer, badge natura/source/kind, importo, giorni rimanenti, %, azioni (apri, bacheca, interessa, nascondi, export riga).
Lotti collassabili sotto la card se lots non vuoti.
Empty state esplicito (es. “Prova a abbassare la similarità o togliere un filtro”).
4. Predizioni (algoritmo)Input: entity_type + entity_id (o ricerca per nome → disambiguazione).Algoritmo:
Raccogli notice collegati:
supplier → awards di quell’impresa (preferisci award; se pochi, integra call dove buyer match non serve)
buyer → notices con quel buyer_id

Minimo campioni: se < 3 notice con embedding, messaggio UI “storico insufficiente” e stop.
Carica embedding di quei notice; centroid = media componente-wise poi L2-normalize.
Rank solo kind=call aperti (hide_expired default true) per dot(centroid, notice_vec).
Escludi notice già dell’entità se irrilevanti; escludi hide.
Ritorna lista come SearchOutcome con semantic: true e similarity.
UI: “Gare aperte simili a ciò che ha vinto/pubblicato [Nome]”.5. Schede entityentity_profile(entity_type, entity_id):
nome, id
n. gare / n. vittorie
importo totale, mediana ribasso, distribuzione semplice (p25/p50/p75 se dati bastano)
top CPV (max 10), top regioni
ultime gare (lista)
bottone Segui / Smetti di seguire
Da Intel e da dettaglio gara: link “vedi profilo impresa/stazione”.6. Alert email6.1 Fonti del digest
saved_searches attive (già presente)
followed_entities attive (nuovo): stessa logica predizioni, threshold min_similarity, solo notice nuovi rispetto a last_run / non già inviati in alert_log
6.2 Contenuto email (obbligatorio)Per ogni item:
titolo
stazione appaltante
località / regione
importo
scadenza (data + giorni)
source (TED/ANAC)
% similarità se semantic
link/url
CIG se presente
Header: data, nome ricerca o “Seguiti: [Nome impresa]”.
Footer: come disattivare / aprire CIG.
Max item per digest: 12 (configurabile).
Se zero risultati → non inviare.
Idempotenza: non reinviare gli stessi notice_id per la stessa saved_search/entity nello stesso giorno (alert_log).6.3 SchedulerMantenere lo scheduler esistente; estenderlo alle followed_entities.
Comandi: preview_digest (nessun SMTP), send_digest, send_test_email.7. BachecaColonne (allineate al codice esistente se già presenti):
valutare — Da valutare
preparare — In preparazione
presentato — Presentato
vinto — Vinto
perso — Perso
Funzioni: drag&drop, note, giorni alla scadenza (rosso se ≤7), vista calendario mensile, export Excel.
Una notice = una card (UNIQUE notice_id).8. Dettaglio gara (drawer)
Header: titolo, buyer, località, badge, source, CIG/CUP/PNRR se in flags
Timeline: pubblicazione → scadenza (+ rettifiche se ricavabili dal raw)
Tab: Riepilogo | Lotti | Aggiudicazioni | Simili | Intelligence CPV | Documenti (link ufficiali)
Azioni: bacheca, interessa, nascondi, crea alert da questa gara (salva search precompilata o follow buyer)
Simili: già da awards::similar_to
Non bloccare su mappa: se geocode assente, mostra solo testo località
9. Intelligence aggiudicazioniMantenere/estendere awards.rs:
aggregazioni per supplier / buyer / cpv / region
ribasso medio, volumi
contesto ribasso CPV su una notice
Usata in pagina Intel e nel dettaglio (per decidere se e a quanto offrire).
10. Valutazione relazione tecnica
Input: testo incollato (file testo/docx semplice se già supportato)
Criteri default + editabili (peso, parole chiave)
Output per criterio: score stimato, evidenze (frasi), lacune, domande utili
Totale / max, coverage
Salvataggio in evaluations
Deterministico e verificabile — niente LLM black-box in v1
11. Archivio dati + embeddingUI Dati:
Ingest TED: from/to, tipi notice, progress
Ingest ANAC: mese o range, progress
Pulsante “Calcola embedding mancanti” + stato (embedding_status)
Stats: notices, calls, awards, embedded, earliest/latest, avg discount, board count
Pipeline embedding:
Testo = title + " " + description (troncato ~1200–2000 char)
Batch ragionevoli (es. 32–64) per non saturare RAM
Coda embed_pending: notice senza riga in notice_embedding o invalidati da update
Warm-up modello all’avvio (già previsto)
12. Export ExcelColonne minime utili all’ufficio gare:
titolo, cig, buyer, regione, provincia, cpv, natura, kind, source, importo_stimato, importo_aggiudicato, ribasso_pct, pubblicato, scadenza, url, colonna_bacheca, noteExport da: risultati ricerca, bacheca.13. Impostazioni
SMTP: host, port, user, password, from, to (multi se già previsto)
Ora digest / timezone locale
Giorni lookback digest
Path dati solo informativo
Opzione embedding: locale (default) / eventuale endpoint OpenAI-compat opzionale già previsto in settings — non obbligatorio
Preferenza hide_expired default
14. Onboarding primo avvioSe DB vuoto o notices=0:
Messaggio chiaro in home/Dati: “Scarica i bandi per iniziare”
Suggerimento: ultimi 90 giorni TED + ultimo mese ANAC
Dopo ingest: “Calcola similarità (embedding)”
Nessun account, nessuna carta
15. Performance e limiti
Non caricare tutti gli embedding in RAM se la tabella è enorme: per semantic ranking, stream per batch o filtra prima con SQL where e poi score.
Limit default ricerca 30–40; max 500.
Ingest: transazioni a batch (già ~80 su TED); stesso approccio ANAC.
UI non deve congelarsi: progress via event Tauri.
16. Comandi Tauri (set completo)Esistenti da preservare/estendere + nuovi:textget_stats
search_notices
notice_detail
award_intel
geo_filters
board_list / board_add / board_update / board_remove
export_board / export_search
save_search / list_saved_searches / delete_saved_search / set_saved_search_active
preview_digest / send_digest / send_test_email
evaluate_report / list_evaluations / delete_evaluation
get_settings / save_settings
embedding_status / embed_pending
ingest_range          # TED
ingest_anac_range     # NEW
data_summary
set_user_signal       # NEW interest|hide
clear_user_signal     # NEW
follow_entity         # NEW
unfollow_entity       # NEW
list_followed_entities
entity_profile        # NEW
predict_from_entity   # NEWPayload JSON in camelCase come nel frontend attuale.17. Navigazione UIView (allineate ad App.tsx esistente se presente):
ricerca — Cerca gare
bacheca — Le mie gare
intelligence — Analisi aggiudicazioni
valutazione — Valuta relazione
alert — Avvisi email
dati — Archivio dati
impostazioni
Lingua: italiano. Tone professionale, zero marketing in-app.18. Ordine di implementazione (obbligatorio)
Schema + migrazione + source + user_signals + exclude hide in search::build_where / run
Comandi signal + UI Interessa/Nascondi in card e drawer
Pannello filtri fisso + slider + card % similarità
Drawer: timeline, flags CIG/PNRR, azioni
predict_from_entity + mode Predizioni in Search
entity_profile + follow/unfollow + UI scheda
Alert: integrazioni followed_entities + contenuto email
Modulo anac + ingest_anac_range + UI Dati
Lotti se presenti nei raw
Polish: empty state, export colonne, onboarding, test
Per ogni blocco: Rust (schema/comandi) → api.ts → UI. Niente stub lasciati.19. Test e qualità
Unit: build_where con source/hide, dedup CIG, centroid L2, mapping natura ANAC, ted_date
Non rompere tests/pipeline.rs TED (ignored, rete)
README: fonti TED+ANAC, come ingestire, SMTP, limiti copertura (sotto soglia dipende da ANAC), privacy (dati locali)
Errori utente: toast leggibili, mai panic in UI
20. Fuori scope v1
Multi-paese
Sync cloud / multi-device obbligatorio
Chat LLM generica sui plichi senza citazione verificabile
Scraping portali regionali
Auto-riscrittura memorie tecniche (valutazione sì; rewrite no)
Paywall in-app
21. Criteri di accettazione per feature (checklist)Hide: gara nascosta non compare in semantic, FTS, predizioni, lista filtrata.

Predizioni: con ≥3 award embedded di un supplier, lista call aperti ordinata per score; UI mostra nome entity.

Alert entity: con follow attivo e nuove gare sopra threshold, preview_digest le include; send non duplica lo stesso giorno.

ANAC: ingest di un mese produce notices con source=anac e almeno title+buyer o title+cpv; search con source=anac li trova.

Filtri UI: cambiare regione e min similarity aggiorna risultati senza reload app.

Board: drag a “presentato”, nota salvata, export contiene nota e colonna.

Offline: dopo ingest+embed, search semantic funziona a rete disconnessa.