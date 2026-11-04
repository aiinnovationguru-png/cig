# CIG — Intelligence appalti Italia

> **Stato del repository:** ricostruzione in corso. Sono stati ricostruiti i
> moduli mancanti, ma **la build Rust/Tauri completa e i flussi end-to-end non
> sono ancora verificati**. I test locali coprono il frontend, lo schema SQLite
> e alcune funzioni Rust isolate; non attestano che ingestione, ricerca,
> export, email o modello di embedding funzionino in produzione. In particolare
> la copertura dei campi TED, le riconciliazioni tra fonti e i download reali
> richiedono verifica su dati reali. Le funzionalità sotto descrivono gli
> obiettivi del progetto, non una garanzia di completezza.
>
> La versione desktop mantiene l'architettura locale. È disponibile anche
> un'anteprima web separata, con archivio opzionale su Supabase.

Applicazione desktop per trovare, valutare e seguire le gare pubbliche italiane.
Backend **Rust**, interfaccia **Tauri 2 + React**: nessun server da ospitare,
nessun account cloud obbligatorio, i dati restano sul computer.

## Anteprima web (Supabase)

Con Node.js 22, avvia il frontend nel browser con `npm install` e `npm run dev`. Per impostazione
predefinita usa il progetto Supabase di prova collegato a questo repository;
URL e chiave **pubblicabile** sono nel codice client e non sono credenziali
privilegiate. Per usare un altro progetto, copia `.env.example` in `.env.local`
e imposta URL e chiave pubblicabile. Non inserire mai service-role o secret key
nelle variabili `VITE_*` o nel frontend.

Senza accesso, l'app mostra tre gare fittizie e salva le modifiche solo nella
sessione del browser. Dopo l'accesso, l'archivio è separato dalla demo e usa le
tabelle `public.cig_web_notices` e `public.cig_web_evaluations`: le migrazioni
in `supabase/migrations/` abilitano RLS e limitano lettura e modifiche al
proprietario autenticato. Nessun dato della desktop viene importato automaticamente.

Nell'anteprima sono disponibili creazione e modifica manuale, ricerca testuale,
filtro per regione, bacheca con trascinamento o menu accessibile, calendario
mensile ed export Excel dei risultati filtrati. La valutazione delle relazioni
accetta testo incollato, TXT o PDF con testo selezionabile (fino a 15 MB e
100 pagine; niente OCR), consente di modificare i criteri e mostra
corrispondenze letterali, frasi e un punteggio indicativo proporzionale alle
parole trovate: non interpreta il contesto, non è un punteggio ufficiale e non
sostituisce una verifica esperta. Si salva solo su richiesta: in demo nella
sessione, da autenticati nel proprio archivio. La ricerca TED tramite funzione
Supabase autenticata permette di cercare gli avvisi italiani recenti (massimo 90
giorni, prime 20 pagine) e salvarli individualmente senza sovrascrivere note o
stato. La funzione e la migrazione sono nel repository; il flusso con un account
reale non è ancora stato verificato end-to-end. Importazione ANAC, ricerca
semantica, analisi automatica dei disciplinari, alert email e le restanti funzioni desktop non sono
ancora collegate nel browser.

La registrazione richiede conferma email: il progetto deve consentire l'URL di
ritorno in Supabase Auth e avere la consegna email configurata per i destinatari
desiderati. L'URL dell'anteprima Arena corrente è stato aggiunto alla allowlist
senza rimuovere quello preesistente; è temporaneo e andrà aggiornato per un
altro host. La registrazione, il recupero password e il salvataggio online non sono ancora stati
verificati end-to-end con un account reale. L'anteprima non è un deployment
pubblico permanente e non equivale alla versione desktop completa. È predisposto
un workflow per GitHub Pages (`.github/workflows/pages.yml`), ma Pages non è
ancora abilitato nel repository: l'integrazione GitHub ha risposto 403 alla
richiesta di attivazione. Dopo l'abilitazione da parte di un amministratore e
l'integrazione del workflow su `main`, il percorso previsto è
`https://aiinnovationguru-png.github.io/cig/`; non è attualmente pubblicato.

## Cosa fa

- **Ricerca semantica** sui bandi: scrivi in italiano cosa cerchi, il modello
  multilingua trova gli avvisi affini anche senza le stesse parole.
- **Ricerca filtrata** per fonte (TED/ANAC), tipo, regione, provincia, CPV,
  categoria SOA, importo, ribasso, scadenza e stazione appaltante.
- **Previsioni** («gare come queste»): dal profilo storico di un'impresa, di una
  stazione appaltante, da una gara di riferimento o dalle gare segnalate come
  interessanti. Le previsioni mostrano solo procedure ancora aperte.
- **Segnali permanenti**: una gara nascosta sparisce da ricerche, digest e
  previsioni; una gara interessante alimenta il centroide delle previsioni.
- **Scheda gara** con sei sezioni: sintesi, lotti, aggiudicazioni, CPV,
  cronologia e contratti simili.
- **Analisi del disciplinare offline**: carichi il PDF del disciplinare o del
  capitolato e ottieni criteri di aggiudicazione, requisiti di partecipazione,
  garanzie, termini e clausole di rischio, ognuno con la frase esatta e il
  numero di pagina da cui proviene.
- **Profili ente**: storico, valore totale, distribuzione dei ribassi, CPV e
  regioni principali, controparti, gare aperte, follow con soglia dedicata.
- **Intelligence sulle aggiudicazioni**: vincitori ricorrenti, ribasso medio per
  settore/regione/ente, contratti simili già aggiudicati.
- **Bacheca** kanban (da valutare → preparata → presentata → vinta/persa) con
  drag & drop, note, scadenze, calendario ed **export Excel**.
- **Valutazione della relazione tecnica**: copertura dei requisiti, frasi di
  evidenza, lacune e punteggio suggerito criterio per criterio.
- **Digest email unico**: ricerche salvate ed enti seguiti nello stesso
  messaggio, con anteprima, deduplica e limite di gare.

## Stack

| Parte | Scelta |
|---|---|
| Backend | Rust, `rusqlite` (SQLite con FTS5), `reqwest`, `lettre`, `rust_xlsxwriter` |
| Ricerca semantica | `fastembed` + `multilingual-e5-small` (384 dim, L2-normalizzato, offline) oppure API OpenAI-compatibile |
| Frontend | React 19 + TypeScript + Vite + Tailwind 4 |
| Shell | Tauri 2 |

Gli embedding sono vettori L2-normalizzati salvati come BLOB; la similarità è un
prodotto scalare calcolato in Rust. Nessuna estensione nativa da installare.

## Avvio

```bash
npm install
npm run app        # sviluppo (Vite + Tauri)
npm run bundle     # installer MSI/NSIS
```

Su Windows servono Rust stable con toolchain MSVC, Visual Studio Build Tools e
WebView2. Su Linux servono anche le dipendenze di sistema Tauri, tra cui
WebKitGTK 4.1. Non sono impostati percorsi SDK specifici di una macchina.

La prima esecuzione scarica il modello di embedding (~470 MB) in
`%APPDATA%\it.cig.intelligence\models`; poi funziona offline. La cache è stabile
e viene riusata a ogni avvio. Se la cartella viene copiata insieme al database,
l'app resta utilizzabile anche senza rete.

## Fonti dati

### TED (sopra soglia UE)

**TED** (Tenders Electronic Daily, Commissione europea), filtrato su
`buyer-country = ITA`. Dalla pagina **Dati** scegli l'intervallo e i tipi di
avviso (bandi, aggiudicazioni, VEAT), poi lancia il download. Al termine puoi
calcolare gli embedding mancanti.

I TED italiani riportano spesso `CIG: …` e `CUP: …` nel testo della descrizione:
l'app li estrae e li salva in `notice_flags`, così lo stesso contratto può essere
riconciliato con ANAC. Non tutti gli avvisi TED contengono il CIG.

### ANAC / BDNCP (nazionale e sotto soglia)

Dalla pagina **Dati** puoi lanciare l'ingestione ANAC per un intervallo di mesi.
Sono supportati due formati:

- dataset annuale `cig-{anno}` con file mensili
  `cig_csv_{anno}_{mese}.zip` (fino al 2025);
- dataset corrente `cig` con snapshot mensili `AAAAMMGG-cig_csv.zip` (dal 2026).

Il client prova prima l'URL mensile diretto, poi interroga il CKAN ANAC e sceglie
la risorsa CSV del mese. Gli archivi sono grandi: il primo download può durare
qualche minuto. La UI mostra fase, avanzamento, conteggi e storico delle
ingestioni.

L'ingestione ANAC crea un avviso per CIG, raccoglie tutti i CPV della riga
(prevalente per primo), mappa la provincia italiana sulla regione e valorizza
PNRR/PNC, CUP, esito e lotti. Se è disponibile un solo partecipante, l'app lo
tratta come aggiudicatario; **i dataset ANAC di base non pubblicano il vincitore
quando i partecipanti sono più di uno**, quindi in quel caso l'aggiudicazione
resta vuota. Gli aggiornamenti di aggiudicazione e partecipanti sono un
arricchimento opzionale e possono non coprire tutti i CIG.

### Deduplica TED ↔ ANAC

Lo stesso contratto può arrivare da entrambe le fonti con id di pubblicazione
diversi. La deduplica avviene per **CIG** (o per id se il CIG non è disponibile):
il record esistente non cambia id — quindi segnali, bacheca e collegamenti
restano validi — e i campi mancanti vengono uniti. Se una delle due fonti è TED,
la fonte del record diventa `ted`. I CIG duplicati vengono eliminati. Al primo
avvio dopo l'aggiornamento, l'app riconcilia una tantum anche i doppioni CIG già
presenti in archivio, conservando la scheda con più dati e i collegamenti utente.

## Dati locali (versione desktop)

- Database: `%APPDATA%\it.cig.intelligence\cig.db`
- Modello: `%APPDATA%\it.cig.intelligence\models`
- Export Excel: `%APPDATA%\it.cig.intelligence\export`

Le eventuali credenziali SMTP e chiavi API sono memorizzate in chiaro nel
file locale `settings.json`: proteggi l'account e i backup del computer.

Nessun dato viene inviato a servizi esterni, salvo:
- le richieste HTTP a TED/ANAC durante l'ingestione;
- l'eventuale provider di embedding via API, se configurato al posto del modello
  locale;
- l'invio SMTP del digest, se configurato.

## Ricerca e previsioni

- La soglia di affinità è uno slider 0–100 (default 60%).
- Le gare nascoste sono sempre escluse da `build_where`, quindi anche da digest,
  previsioni e statistiche.
- Le previsioni per un ente richiedono almeno **3 gare con embedding** nel suo
  storico: con meno dati il centroide copierebbe una singola gara. In quel caso
  l'app lo spiega invece di restituire risultati casuali.
- Le previsioni cercano solo `kind = 'call'` con scadenza futura o non indicata.

## Documenti di gara

Dalla scheda di una gara, sezione **Documenti**, puoi caricare il disciplinare,
il capitolato o il bando integrale (PDF, TXT o MD, fino a 60 MB). Il file resta
sul computer: viene letto da Rust, diviso **pagina per pagina** e analizzato con
regole deterministiche, senza modelli generativi e senza rete.

Per ogni documento l'analisi mostra cinque sezioni:

- criteri di aggiudicazione (con punteggi e tipo di procedura);
- requisiti di partecipazione (fatturato, attestazioni, categorie);
- garanzie e coperture (percentuali di cauzione, polizze);
- termini e scadenze (date esplicite di presentazione);
- clausole da leggere (penali, recesso, subappalto, revisione prezzi).

Ogni voce cita la **frase esatta** e la **pagina**; le righe spezzate dal PDF
vengono ricomposte prima dell'analisi, altrimenti le citazioni sarebbero
frammenti di mezza riga. Le sezioni senza riscontri restano vuote e lo dicono:
un requisito assente dal testo caricato non viene inventato. Lo stesso file
ricaricato non crea doppioni (impronta del contenuto) e l'analisi resta in cache
finché non premi «Ricalcola».

## Alert email

In **Impostazioni** inserisci server SMTP, credenziali, mittente e destinatario
(es. Gmail con password per app, Brevo, Mailgun). Il digest:

- unisce ricerche salvate attive ed enti seguiti attivi in **una sola email**;
- deduplica le gare tra le sezioni;
- rispetta la soglia di ogni ricerca e di ogni ente;
- usa l'ora e il fuso orario configurati (locale del sistema oppure UTC);
- è limitato da `digest_max_notices` (default 12);
- non parte se non c'è nulla di nuovo;
- non ripete le gare già inviate nello stesso giorno (`alert_log`);
- può essere inviato a mano, ma lo scheduler evita il doppio invio giornaliero.

Con un modello multilingua compatto le similarità assolute sono compresse
(quasi tutte le gare italiane stanno tra 0,80 e 0,90), quindi il digest non si
basa solo su una soglia fissa: prende i risultati più vicini al migliore.

## Valutazione della relazione tecnica

L'analisi è deterministica e verificabile: cerca nel testo le parole chiave dei
requisiti di ogni criterio, mostra le frasi trovate e calcola la copertura. Il
punteggio suggerito è un aiuto, non un giudizio: i pesi e i punteggi manuali
restano modificabili e la valutazione viene salvata con il testo analizzato.

## Struttura

```
src/                     interfaccia React
src-tauri/src/
  ted/                   normalizzazione dei risultati TED
  anac/                  client CKAN, ZIP mensili CIG e normalizzazione ANAC
  ingest.rs              scrittura idempotente, merge e deduplica per CIG
  search.rs              filtri, FTS5, similarità, previsioni, schede, segnali
  entities.rs            profili ente, follow e suggerimenti
  awards.rs              contratti simili e statistiche sui ribassi
  documents.rs           documenti di gara, testo per pagina e analisi citata
  board.rs               bacheca
  evaluate.rs            analisi della relazione tecnica
  alerts.rs              digest combinato e scheduler
  export.rs              Excel
  commands.rs            comandi IPC
  db.rs                  apertura, migrazioni e backfill CIG/CUP
examples/smoke.rs        verifica sul database reale
examples/anac_smoke.rs   verifica ingestione ANAC su copia del database
tests/                   test dei contratti UI e dello schema SQLite
```

## Verifica

```bash
npm ci
npm test                         # contratti statici frontend/Tauri
npm run build                    # typecheck e build frontend
python -m unittest discover -s tests -p "test_*.py" -v  # schema SQLite
cargo test --manifest-path src-tauri/Cargo.toml --lib  # backend, se disponibili dipendenze e toolchain
```

La workflow GitHub Actions verifica questi passaggi su Windows quando viene
eseguita. I test SQLite e frontend non sostituiscono un test end-to-end con TED,
ANAC, SMTP e un modello di embedding realmente disponibili.

## Limiti noti (v1)

- TED copre le gare sopra soglia UE; ANAC copre il nazionale e il sotto soglia,
  ma i due archivi possono avere tempi e coperture diversi.
- Il CIG è estratto dal testo TED quando presente; se manca, la deduplica tra
  fonti non è possibile per quel record.
- I dataset ANAC di base non espongono il vincitore in caso di più partecipanti e
  spesso non riportano l'importo di aggiudicazione: nelle schede ente l'importo
  totale e il ribasso possono quindi risultare parziali o a zero quando lo
  storico dell'impresa viene solo da ANAC.
- L'analisi dei documenti non usa un LLM: riconosce parole chiave e frasi, non
  interpreta. Non sostituisce la lettura del disciplinare, non fa OCR sui PDF
  scansionati e non risponde a domande libere sul testo.
- Non sono inclusi scraping di portali regionali, account cloud, sincronizzazione
  multi-dispositivo, chat LLM generica e riscrittura automatica della relazione
  tecnica.
- Il modello locale è addestrato per l'ordinamento semantico, non per una
  classificazione assoluta di pertinenza: la soglia va tarata sul proprio settore.
