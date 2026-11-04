import { useCallback, useEffect, useState } from "react";
import {
  api,
  onEmbedProgress,
  onIngestProgress,
  type DataSummary,
  type EmbedProgress,
  type EmbeddingStatus,
  type IngestProgress,
  type NoticeHit,
  type Stats,
} from "../api";
import { dateIt, dateTimeIt, daysAgo, isoDate, num, pct, todayStamp } from "../lib/format";
import { Badge, Empty, Field, Progress, Spinner } from "../components/ui";
import { IconArrow, IconDownload } from "../components/icons";

const TED_TYPES: { id: string; label: string }[] = [
  { id: "cn-standard", label: "Bandi" },
  { id: "cn-social", label: "Bandi sociali" },
  { id: "can-standard", label: "Aggiudicazioni" },
  { id: "can-social", label: "Aggiudicazioni sociali" },
  { id: "veat", label: "Esiti volontari (VEAT)" },
];

type Source = "ted" | "anac";

export default function DataPage({
  notify,
  onStatsChanged,
  stats,
}: {
  notify: (message: string, tone?: "info" | "error") => void;
  onStatsChanged: () => void;
  stats: Stats | null;
}) {
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [source, setSource] = useState<Source>("ted");
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(todayStamp());
  const [types, setTypes] = useState<string[]>(["cn-standard", "can-standard"]);
  const [includeUpdates, setIncludeUpdates] = useState(true);
  const [running, setRunning] = useState<Source | null>(null);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [embedding, setEmbedding] = useState(false);
  const [embedProgress, setEmbedProgress] = useState<EmbedProgress | null>(null);
  const [embedStatus, setEmbedStatus] = useState<EmbeddingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState<NoticeHit[] | null>(null);
  const [hiddenLoading, setHiddenLoading] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api.dataSummary());
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadSummary();
    api
      .embeddingStatus()
      .then(setEmbedStatus)
      .catch(() => setEmbedStatus(null));
  }, [loadSummary]);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    void onIngestProgress((value) => {
      setProgress(value);
      setLog((previous) => [value.message, ...previous].slice(0, 10));
    }).then((fn) => unlisteners.push(fn));
    void onEmbedProgress((value) => setEmbedProgress(value)).then((fn) => unlisteners.push(fn));
    return () => unlisteners.forEach((fn) => fn());
  }, []);

  const applyPreset = (days: number) => {
    const end = new Date();
    const start = new Date(Date.now() - days * 86_400_000);
    setFrom(isoDate(start));
    setTo(isoDate(end));
  };

  const runIngest = async () => {
    if (running) return;
    if (from > to) {
      notify("La data iniziale è successiva alla finale", "error");
      return;
    }
    if (source === "ted" && !types.length) {
      notify("Seleziona almeno un tipo di avviso TED", "error");
      return;
    }
    setRunning(source);
    setLog([]);
    setProgress(null);
    try {
      if (source === "ted") {
        const result = await api.ingestRange(from, to, types);
        notify(`TED: ${num(result.saved)} avvisi salvati (${num(result.awards)} aggiudicazioni)`);
        setLog((previous) => [
          `TED completato: ${result.fetched} letti, ${result.saved} salvati, ${result.skipped} scartati`,
          ...previous,
        ]);
      } else {
        const result = await api.ingestAnacRange(from, to, includeUpdates);
        notify(
          `ANAC: ${num(result.saved)} CIG salvati (${num(result.awards)} aggiudicazioni aggiornate)`,
        );
        setLog((previous) => [
          `ANAC completato: ${result.fetched} letti, ${result.saved} salvati, ${result.skipped} scartati`,
          ...previous,
        ]);
      }
      await loadSummary();
      onStatsChanged();
    } catch (error) {
      const message = String(error);
      setProgress(null);
      setLog((previous) => [
        `Importazione interrotta: ${message}. I dati già salvati restano disponibili; è possibile riprovare.`,
        ...previous,
      ].slice(0, 10));
      notify(message, "error");
      await loadSummary();
      onStatsChanged();
    } finally {
      setRunning(null);
    }
  };

  // Senza questo elenco "nascondi" era irreversibile dall'interfaccia: la gara
  // spariva da ogni ricerca e non c'era modo di ritrovarla.
  const loadHidden = useCallback(async () => {
    setHiddenLoading(true);
    try {
      setHidden(await api.hiddenNotices());
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setHiddenLoading(false);
    }
  }, [notify]);

  const restoreNotice = async (id: string) => {
    try {
      await api.clearUserSignal(id, "hide");
      setHidden((previous) => previous?.filter((item) => item.id !== id) ?? previous);
      notify("Gara ripristinata: torna nelle ricerche");
      onStatsChanged();
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const runEmbedding = async () => {
    if (embedding) return;
    setEmbedding(true);
    setEmbedProgress(null);
    try {
      const result = await api.embedPending();
      notify(`Similarità calcolata per ${num(result.done)} avvisi`);
      await loadSummary();
      onStatsChanged();
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setEmbedding(false);
    }
  };

  const pending = stats ? Math.max(0, stats.notices - stats.embedded) : 0;
  const coverage = stats && stats.notices > 0 ? stats.embedded / stats.notices : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto bg-page px-6 py-4">
        {stats && stats.notices === 0 && (
          <div className="card mb-3 border-amber-300 bg-amber-50/60 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-[14px] font-semibold text-heading">Scarica i bandi per iniziare</h2>
                <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-slate-600">
                  L'archivio è sul tuo computer e parte vuoto. Non serve alcun account: scegli una
                  fonte, imposta l'intervallo e avvia il download. Puoi continuare a usare l'app
                  mentre lavora.
                </p>
              </div>
              <span className="rounded border border-amber-300 bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                primo avvio
              </span>
            </div>
            <ol className="mt-3 grid gap-2 text-[11.5px] text-slate-700 sm:grid-cols-3">
              <li className="rounded border border-line bg-white px-3 py-2.5">
                <div className="font-semibold text-heading">1 · TED, ultimi 90 giorni</div>
                <p className="mt-0.5 text-[10.5px] text-slate-500">
                  Bandi e aggiudicazioni sopra soglia UE.
                </p>
                <button
                  className="btn mt-2 w-full px-2 py-1 text-[11px]"
                  onClick={() => {
                    setSource("ted");
                    applyPreset(90);
                    document.getElementById("ingest-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  disabled={Boolean(running)}
                >
                  Imposta TED · 90 giorni
                </button>
              </li>
              <li className="rounded border border-line bg-white px-3 py-2.5">
                <div className="font-semibold text-heading">2 · ANAC, ultimo mese</div>
                <p className="mt-0.5 text-[10.5px] text-slate-500">
                  Procedure nazionali e sotto soglia (CIG).
                </p>
                <button
                  className="btn mt-2 w-full px-2 py-1 text-[11px]"
                  onClick={() => {
                    setSource("anac");
                    applyPreset(30);
                    document.getElementById("ingest-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  disabled={Boolean(running)}
                >
                  Imposta ANAC · ultimo mese
                </button>
              </li>
              <li className="rounded border border-line bg-white px-3 py-2.5">
                <div className="font-semibold text-heading">3 · Calcola similarità</div>
                <p className="mt-0.5 text-[10.5px] text-slate-500">
                  Dopo il download premi «Calcola similarità (embedding)» nella sezione qui sotto:
                  attiva la ricerca per significato.
                </p>
              </li>
            </ol>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <StatBox label="Avvisi" value={stats ? num(stats.notices) : "—"} />
          <StatBox label="TED" value={stats ? num(stats.ted) : "—"} tone="blue" />
          <StatBox label="ANAC" value={stats ? num(stats.anac) : "—"} tone="amber" />
          <StatBox label="Bandi" value={stats ? num(stats.calls) : "—"} />
          <StatBox label="Aggiudicazioni" value={stats ? num(stats.awarded) : "—"} />
          <StatBox
            label="Vettorizzati"
            value={stats ? num(stats.embedded) : "—"}
            hint={stats ? `${pct(coverage * 100, 0)} dell'archivio` : undefined}
            tone="accent"
          />
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <StatBox label="Lotti" value={stats ? num(stats.lots) : "—"} />
          <StatBox label="PNRR / PNC" value={stats ? num(stats.pnrr) : "—"} tone="green" />
          <StatBox label="Imprese" value={stats ? num(stats.suppliers) : "—"} />
          <StatBox label="Enti seguiti" value={stats ? num(stats.followed) : "—"} />
          <StatBox label="Gare nascoste" value={stats ? num(stats.hidden) : "—"} />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="card p-4" id="ingest-panel">
            <div className="flex items-center justify-between">
              <div className="flex rounded border border-slate-300 bg-slate-50 p-0.5" role="tablist" aria-label="Fonte dati">
                <button
                  role="tab"
                  aria-selected={source === "ted"}
                  onClick={() => setSource("ted")}
                  className={`rounded px-3 py-1 text-[11.5px] font-medium transition-colors ${
                    source === "ted" ? "bg-white text-cyan-900 shadow-sm ring-1 ring-slate-300" : "text-slate-600"
                  }`}
                >
                  TED (UE)
                </button>
                <button
                  role="tab"
                  aria-selected={source === "anac"}
                  onClick={() => setSource("anac")}
                  className={`rounded px-3 py-1 text-[11.5px] font-medium transition-colors ${
                    source === "anac" ? "bg-white text-cyan-900 shadow-sm ring-1 ring-slate-300" : "text-slate-600"
                  }`}
                >
                  ANAC (nazionale)
                </button>
              </div>
              <span className="text-[10px] text-slate-500">
                {source === "ted" ? "sopra soglia UE" : "sotto soglia e procedure nazionali"}
              </span>
            </div>

            <div className="mt-2 text-[11px] leading-relaxed text-slate-600">
              {source === "ted" ? (
                <>
                  Solo stazioni appaltanti italiane. Gli intervalli lunghi richiedono qualche minuto;
                  puoi continuare a usare l'app durante il download.
                </>
              ) : (
                <>
                  Pacchetti mensili CIG del BDNCP (CKAN, senza autenticazione). Con gli aggiornamenti
                  attivi vengono applicati anche esiti e partecipanti dei dataset settimanali.
                </>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {[
                { label: "30 giorni", days: 30 },
                { label: "90 giorni", days: 90 },
                { label: "6 mesi", days: 180 },
                { label: "1 anno", days: 365 },
                { label: "3 anni", days: 1095 },
              ].map((preset) => (
                <button
                  key={preset.days}
                  className="rounded border border-slate-300 px-2 py-1 text-[10.5px] text-slate-600 hover:border-cyan-700 hover:text-cyan-900"
                  onClick={() => applyPreset(preset.days)}
                  disabled={Boolean(running)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Dal">
                <input
                  type="date"
                  className="input"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  disabled={Boolean(running)}
                />
              </Field>
              <Field label="Al">
                <input
                  type="date"
                  className="input"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  disabled={Boolean(running)}
                />
              </Field>
            </div>

            {source === "ted" ? (
              <div className="mt-3">
                <span className="label">Tipi di avviso</span>
                <div className="flex flex-wrap gap-1.5">
                  {TED_TYPES.map((type) => {
                    const active = types.includes(type.id);
                    return (
                      <button
                        key={type.id}
                        onClick={() =>
                          setTypes((previous) =>
                            active
                              ? previous.filter((value) => value !== type.id)
                              : [...previous, type.id],
                          )
                        }
                        disabled={Boolean(running)}
                        aria-pressed={active}
                        className={`rounded border px-2 py-1 text-[10.5px] transition-colors ${
                          active
                            ? "border-cyan-700 bg-cyan-50 text-cyan-900"
                            : "border-slate-300 text-slate-600 hover:border-cyan-600"
                        }`}
                      >
                        {type.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <label className="mt-3 flex items-start gap-2 rounded border border-line bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={includeUpdates}
                  onChange={(event) => setIncludeUpdates(event.target.checked)}
                  disabled={Boolean(running)}
                  className="mt-0.5 accent-cyan-800"
                />
                <span>
                  <span className="font-medium text-slate-700">Applica esiti e partecipanti</span>
                  <span className="block text-[10px] leading-relaxed text-slate-500">
                    Scarica i delta settimanali di aggiudicazione e partecipanti e aggiorna i CIG già
                    presenti. I vincitori sono disponibili solo quando la fonte li pubblica; in
                    assenza, la gara resta senza aggiudicatario.
                  </span>
                </span>
              </label>
            )}

            <button
              className="btn btn-primary mt-4 w-full py-2.5"
              onClick={runIngest}
              disabled={Boolean(running)}
            >
              {running === source
                ? source === "ted"
                  ? "Scarico da TED…"
                  : "Scarico da ANAC…"
                : source === "ted"
                  ? "Avvia download TED"
                  : "Avvia download ANAC"}
              {!running && <IconArrow />}
            </button>

            {(running || progress) && (
              <div className="mt-3 rounded border border-line bg-slate-50 px-3 py-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
                  <span className="min-w-0 truncate text-slate-700">
                    {progress?.message ?? "connessione alla fonte…"}
                  </span>
                  <span className="tabular shrink-0 text-slate-500">
                    {num(progress?.saved ?? 0)} salvati
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className={`h-full w-1/3 rounded-full bg-cyan-700 ${
                      running ? "animate-pulse" : "w-full"
                    }`}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-slate-500">
                  <span>letti {num(progress?.fetched ?? 0)}</span>
                  <span>aggiudicazioni {num(progress?.awards ?? 0)}</span>
                  {progress?.noticeType && <span className="truncate">{progress.noticeType}</span>}
                </div>
              </div>
            )}

            {log.length > 0 && (
              <div className="mt-2 max-h-28 space-y-0.5 overflow-y-auto rounded bg-slate-50 px-2 py-1.5 font-mono text-[9.5px] text-slate-500">
                {log.map((line, index) => (
                  <div key={index}>· {line}</div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="card p-4" id="embedding-panel">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
                    Ricerca semantica
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                    Embedding calcolati in locale con multilingual-e5-small (384 dimensioni). Finché
                    mancano, la ricerca usa le parole chiave.
                  </p>
                </div>
                <Badge tone={embedStatus?.ready ? "green" : "amber"}>
                  {embedStatus ? (embedStatus.ready ? "pronto" : "non pronto") : "verifico"}
                </Badge>
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-slate-600">
                  {pending > 0 ? `${num(pending)} avvisi da vettorizzare` : "tutto vettorizzato"}
                </span>
                <span className="tabular font-semibold text-heading">{pct(coverage * 100, 0)}</span>
              </div>
              <div className="mt-2">
                <Progress value={stats?.embedded ?? 0} total={Math.max(stats?.notices ?? 0, 1)} />
              </div>
              {embedStatus?.error && (
                <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[10px] text-rose-800">
                  {embedStatus.error}
                </div>
              )}
              <button
                className="btn mt-3 w-full py-2"
                onClick={runEmbedding}
                disabled={embedding || !stats || pending === 0}
              >
                <IconDownload /> {embedding ? "Calcolo…" : "Calcola similarità (embedding)"}
              </button>
              {embedProgress && (
                <div className="mt-2">
                  <Progress value={embedProgress.done} total={Math.max(embedProgress.total, 1)} />
                  <div className="mt-1 text-[10px] text-slate-500">{embedProgress.message}</div>
                </div>
              )}
            </div>

            <div className="card p-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
                Copertura
              </div>
              <dl className="mt-2 space-y-1.5 text-[11px]">
                <Row label="Primo avviso" value={stats?.earliest ?? "—"} />
                <Row label="Ultimo avviso" value={stats?.latest ?? "—"} />
                <Row label="Imprese vincitrici" value={stats ? num(stats.suppliers) : "—"} />
                <Row label="Stazioni appaltanti" value={stats ? num(stats.buyers) : "—"} />
                <Row label="Ribasso medio" value={pct(stats?.avgDiscount)} accent />
                <Row label="Lotti registrati" value={stats ? num(stats.lots) : "—"} />
                <Row label="Gare in bacheca" value={stats ? num(stats.boardItems) : "—"} />
              </dl>
              <p className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-slate-500">
                ANAC non pubblica sempre il vincitore nei pacchetti mensili. Quando il dataset non lo
                riporta, la gara resta consultabile ma senza aggiudicatario.
              </p>
            </div>
          </div>
        </div>

        {stats && stats.hidden > 0 && (
          <div className="card mt-4 overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
                Gare nascoste ({num(stats.hidden)})
              </span>
              <button
                className="btn px-2.5 py-1 text-[11px]"
                onClick={() => {
                  if (hidden === null) void loadHidden();
                  else setHidden(null);
                }}
                aria-expanded={hidden !== null}
              >
                {hidden === null ? "Mostra elenco" : "Nascondi elenco"}
              </button>
            </div>
            {hidden !== null &&
              (hiddenLoading ? (
                <div className="p-4">
                  <Spinner />
                </div>
              ) : hidden.length === 0 ? (
                <div className="p-4">
                  <Empty title="Nessuna gara nascosta" hint="Non hai nascosto nessun avviso." />
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {hidden.map((notice) => (
                    <li key={notice.id} className="flex items-start gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-medium text-slate-800">
                          {notice.title}
                        </div>
                        <div className="mt-0.5 text-[10.5px] text-slate-500">
                          {notice.buyerName ?? "Ente non indicato"} · {dateIt(notice.publishedAt)} ·{" "}
                          {notice.source === "anac" ? "ANAC" : "TED"}
                        </div>
                      </div>
                      <button
                        className="btn shrink-0 px-2.5 py-1 text-[11px]"
                        onClick={() => void restoreNotice(notice.id)}
                      >
                        Ripristina
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        )}

        <div className="card mt-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
              Storico importazioni
            </span>
            <span className="text-[10px] text-slate-500">ultime 12 esecuzioni</span>
          </div>
          {loading ? (
            <div className="p-5">
              <Spinner />
            </div>
          ) : !summary || summary.runs.length === 0 ? (
            <div className="p-4">
              <Empty
                title="Nessuna importazione"
                hint="Avvia il primo download da TED o da ANAC con il pannello qui sopra."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="th w-[70px]">Fonte</th>
                    <th className="th">Inizio</th>
                    <th className="th">Periodo</th>
                    <th className="th text-right">Letti</th>
                    <th className="th text-right">Salvati</th>
                    <th className="th text-right">Scartati</th>
                    <th className="th text-right">Aggiudicazioni</th>
                    <th className="th">Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.runs.map((run) => (
                    <tr key={run.id} className="row-hover">
                      <td className="td">
                        <Badge tone={run.source === "anac" ? "amber" : "blue"}>
                          {run.source === "anac" ? "ANAC" : "TED"}
                        </Badge>
                      </td>
                      <td className="td whitespace-nowrap">{dateTimeIt(run.startedAt)}</td>
                      <td className="td whitespace-nowrap text-slate-500">
                        {run.fromDate ?? "—"} → {run.toDate ?? "—"}
                      </td>
                      <td className="td text-right tabular">{num(run.fetched)}</td>
                      <td className="td text-right tabular">{num(run.saved)}</td>
                      <td className="td text-right tabular text-slate-500">{num(run.skipped)}</td>
                      <td className="td text-right tabular">{num(run.awards)}</td>
                      <td className="td">
                        <Badge
                          tone={
                            run.status === "done" ? "green" : run.status === "error" ? "red" : "amber"
                          }
                        >
                          {run.status}
                        </Badge>
                        {run.message && (
                          <div className="mt-1 max-w-[320px] text-[10px] leading-snug text-rose-700">
                            {run.message}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "accent" | "blue" | "amber" | "green";
}) {
  const color =
    tone === "accent"
      ? "text-cyan-900"
      : tone === "blue"
        ? "text-sky-800"
        : tone === "amber"
          ? "text-amber-800"
          : tone === "green"
            ? "text-emerald-800"
            : "text-heading";
  return (
    <div className="card px-3 py-2.5">
      <div className="text-[9px] font-bold uppercase tracking-[0.09em] text-slate-500">{label}</div>
      <div className={`mt-0.5 tabular text-[19px] font-bold leading-none ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-[9.5px] text-slate-500">{hint}</div>}
    </div>
  );
}

function Row({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`tabular ${accent ? "font-semibold text-cyan-900" : "text-slate-700"}`}>{value}</dd>
    </div>
  );
}
