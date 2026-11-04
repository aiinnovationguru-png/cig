import { useCallback, useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  type EntityType,
  type FollowedEntity,
  type NoticeHit,
  type ProfileCount,
  type SearchFilters,
  type SearchOutcome,
  type SearchRequest,
  type SearchSeed,
} from "../api";
import { dateIt, daysLeft, euro, kindLabel, pct, truncate } from "../lib/format";
import { Badge, Empty, Field, Modal, Spinner } from "../components/ui";
import {
  IconArrow,
  IconBuilding,
  IconChevron,
  IconDownload,
  IconEyeOff,
  IconFilter,
  IconPlus,
  IconSearch,
  IconSpark,
  IconStar,
  IconUser,
} from "../components/icons";

const PAGE_SIZE = 30;

type Mode = "semantic" | "filtered" | "predictions";

type PredictionTarget =
  | { kind: "interest" }
  | { kind: "entity"; entityType: EntityType; entityId: string; name: string }
  | { kind: "notice"; noticeId: string; title: string };

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: "semantic",
    label: "Per significato",
    hint: "Descrivi la gara con parole tue: il modello cerca avvisi affini.",
  },
  {
    id: "filtered",
    label: "Con filtri",
    hint: "Territorio, importo, categoria e parole chiave, senza modello semantico.",
  },
  {
    id: "predictions",
    label: "Previsioni",
    hint: "Gare simili allo storico di un ente, a una gara o alle gare che hai segnalato.",
  },
];

const CATEGORIES = [
  { id: "works", label: "Lavori" },
  { id: "services", label: "Servizi" },
  { id: "supplies", label: "Forniture" },
] as const;

const SOA_CATEGORIES = [
  "OG1", "OG2", "OG3", "OG4", "OG5", "OG6", "OG7", "OG8", "OG9", "OG10", "OG11", "OG12", "OG13",
  "OS1", "OS2-A", "OS2-B", "OS3", "OS4", "OS5", "OS6", "OS7", "OS8", "OS9", "OS10", "OS11",
  "OS12-A", "OS12-B", "OS13", "OS14", "OS15", "OS16", "OS17", "OS18-A", "OS18-B", "OS19",
  "OS20-A", "OS20-B", "OS21", "OS22", "OS23", "OS24", "OS25", "OS26", "OS27", "OS28", "OS29",
  "OS30", "OS31", "OS32", "OS33", "OS34", "OS35",
] as const;

const CPV_HINTS: { code: string; label: string }[] = [
  { code: "72", label: "IT e software" },
  { code: "85", label: "Sanità" },
  { code: "90", label: "Ambiente e rifiuti" },
  { code: "30", label: "Informatica" },
  { code: "71", label: "Ingegneria" },
  { code: "55", label: "Ristorazione" },
  { code: "60", label: "Trasporti" },
];

export default function SearchPage({
  onOpen,
  onOpenEntity,
  notify,
  onStatsChanged,
  onSignalChanged,
  signalVersion,
  followedVersion,
  seed,
  onSeedApplied,
}: {
  onOpen: (id: string) => void;
  onOpenEntity: (entityType: EntityType, entityId: string) => void;
  notify: (message: string, tone?: "info" | "error") => void;
  onStatsChanged: () => void;
  onSignalChanged: () => void;
  signalVersion: number;
  followedVersion: number;
  seed: SearchSeed | null;
  onSeedApplied?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("semantic");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>({ hideExpired: true });
  const [defaultHideExpired, setDefaultHideExpired] = useState(true);
  const [similarity, setSimilarity] = useState(60);
  const [sort, setSort] = useState("published");
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [regions, setRegions] = useState<string[]>([]);
  const [provinces, setProvinces] = useState<{ code: string; region: string }[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveThreshold, setSaveThreshold] = useState(70);
  const [exporting, setExporting] = useState(false);
  const [prediction, setPrediction] = useState<PredictionTarget>({ kind: "interest" });
  const [followed, setFollowed] = useState<FollowedEntity[]>([]);
  const [entityType, setEntityType] = useState<EntityType>("supplier");
  const [entityQuery, setEntityQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ProfileCount[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const requestSeq = useRef(0);
  // Testo dell'ultima ricerca eseguita: serve a capire quando il campo passa
  // da una query a vuoto e quindi si può tornare all'elenco filtrato.
  const lastSearchedQuery = useRef("");
  const runSearchRef = useRef<(offset: number, append: boolean) => Promise<void>>(async () => undefined);

  useEffect(() => {
    api
      .geoFilters()
      .then((value) => {
        setRegions(value.regions);
        setProvinces(value.provinces);
      })
      .catch(() => undefined);
  }, []);

  // La preferenza «nascondi scaduti» si applica solo all'apertura: dopo può
  // essere cambiata liberamente con il filtro.
  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        setDefaultHideExpired(settings.hideExpiredDefault);
        setFilters((previous) => ({ ...previous, hideExpired: settings.hideExpiredDefault }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Una scheda gara o un profilo ente possono chiedere una previsione.
  useEffect(() => {
    if (!seed) return;
    setMode("predictions");
    if (seed.kind === "notice") {
      setPrediction({ kind: "notice", noticeId: seed.noticeId, title: seed.title });
    } else {
      setPrediction({
        kind: "entity",
        entityType: seed.entityType,
        entityId: seed.entityId,
        name: seed.name,
      });
    }
    // La richiesta è stata consumata: senza questo, tornando sulla pagina la
    // previsione verrebbe riapplicata ogni volta.
    onSeedApplied?.();
  }, [seed, onSeedApplied]);

  useEffect(() => {
    if (mode !== "predictions") return;
    api
      .listFollowedEntities()
      .then(setFollowed)
      .catch(() => setFollowed([]));
  }, [mode, followedVersion]);

  useEffect(() => {
    if (mode !== "predictions") return;
    const value = entityQuery.trim();
    if (value.length < 2) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      setSuggestLoading(true);
      api
        .entitySuggestions(entityType, value)
        .then(setSuggestions)
        .catch(() => setSuggestions([]))
        .finally(() => setSuggestLoading(false));
    }, 280);
    return () => clearTimeout(timer);
  }, [entityQuery, entityType, mode]);

  const patchFilters = (patch: Partial<SearchFilters>) =>
    setFilters((previous) => ({ ...previous, ...patch }));

  const buildRequest = useCallback(
    (offset: number): SearchRequest => {
      const effective: SearchFilters = {
        ...filters,
        minSimilarity: mode === "semantic" ? similarity / 100 : undefined,
      };
      if (mode === "predictions") {
        const request: SearchRequest = {
          query: "",
          filters: effective,
          limit: PAGE_SIZE,
          offset,
          mode: "predictions",
        };
        if (prediction.kind === "entity") {
          request.entityType = prediction.entityType;
          request.entityId = prediction.entityId;
        } else if (prediction.kind === "notice") {
          request.noticeId = prediction.noticeId;
        }
        return request;
      }
      return {
        query,
        filters: effective,
        limit: PAGE_SIZE,
        offset,
        mode,
        keywordOnly: mode === "filtered",
        sort: mode === "filtered" ? sort : undefined,
      };
    },
    [filters, mode, prediction, query, similarity, sort],
  );

  const runSearch = useCallback(
    async (offset: number, append: boolean) => {
      const seq = ++requestSeq.current;
      if (!append) lastSearchedQuery.current = query.trim();
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const effective: SearchFilters = {
          ...filters,
          minSimilarity: mode === "semantic" ? similarity / 100 : undefined,
        };
        const response =
          mode === "predictions" && prediction.kind === "entity"
            ? await api.predictFromEntity(
                prediction.entityType,
                prediction.entityId,
                effective,
                PAGE_SIZE,
                undefined,
                offset,
              )
            : await api.search(buildRequest(offset));
        if (seq !== requestSeq.current) return;
        setOutcome((previous) =>
          append && previous
            ? { ...response, items: [...previous.items, ...response.items] }
            : response,
        );
      } catch (error) {
        if (seq === requestSeq.current) notify(String(error), "error");
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [buildRequest, filters, mode, notify, prediction, similarity],
  );

  useEffect(() => {
    runSearchRef.current = runSearch;
  }, [runSearch]);

  const submitSearch = () => void runSearchRef.current(0, false);

  // Filtri, modalità, ordinamento e previsioni rilanciano la ricerca da soli.
  // Il testo libero no: una ricerca semantica per ogni tasto ricalcolava
  // l'embedding e rileggeva tutto l'archivio, rendendo la pagina inutilizzabile
  // durante la digitazione. Il testo si cerca con Invio o con «Cerca».
  const triggerKey = JSON.stringify({ mode, filters, sort, similarity, prediction });
  useEffect(() => {
    const timer = setTimeout(
      () => void runSearchRef.current(0, false),
      mode === "predictions" ? 180 : 150,
    );
    return () => clearTimeout(timer);
  }, [triggerKey]);

  // Svuotare il campo torna all'elenco completo senza dover premere Invio.
  useEffect(() => {
    if (query.trim() !== "") return;
    if (lastSearchedQuery.current === "") return;
    lastSearchedQuery.current = "";
    const timer = setTimeout(() => void runSearchRef.current(0, false), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Nascondere una gara dalla scheda deve aggiornare anche i risultati.
  useEffect(() => {
    if (signalVersion === 0) return;
    void runSearchRef.current(0, false);
  }, [signalVersion]);

  useEffect(() => {
    setOutcome(null);
  }, [mode]);

  const clearFilters = () => setFilters({ hideExpired: defaultHideExpired });

  const activeFilterCount = Object.entries(filters).filter(
    ([key, value]) =>
      key !== "hideExpired" &&
      key !== "minSimilarity" &&
      value !== undefined &&
      value !== null &&
      value !== "" &&
      value !== false,
  ).length;

  const predictionLabel =
    prediction.kind === "interest"
      ? "le gare che hai segnalato come interessanti"
      : prediction.kind === "notice"
        ? `la gara «${truncate(prediction.title, 70)}»`
        : prediction.name;

  const saveSearch = async () => {
    try {
      await api.saveSearch(
        saveName.trim() || truncate(query, 60) || "Ricerca senza titolo",
        query,
        filters,
        saveThreshold / 100,
      );
      notify("Ricerca salvata: entrerà nel digest email");
      setSaveOpen(false);
      setSaveName("");
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const exportExcel = async () => {
    setExporting(true);
    try {
      const result = await api.exportSearch(
        buildRequest(0),
        truncate(query, 40) || (mode === "predictions" ? "previsioni" : "gare"),
      );
      notify(
        result.truncated
          ? `Excel creato con ${result.rows.toLocaleString("it-IT")} righe su ${result.total.toLocaleString("it-IT")} risultati: restringi i filtri per esportarli tutti.`
          : `Excel creato: ${result.rows.toLocaleString("it-IT")} righe in ${result.path}`,
        result.truncated ? "error" : "info",
      );
      await revealItemInDir(result.path);
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setExporting(false);
    }
  };

  const addToBoard = async (id: string) => {
    try {
      await api.boardAdd(id, "valutare");
      notify("Aggiunto alla bacheca");
      onStatsChanged();
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const setSignal = async (hit: NoticeHit, signal: "interest" | "hide") => {
    try {
      if (hit.signal === signal) {
        await api.clearUserSignal(hit.id, signal);
        setOutcome((previous) =>
          previous
            ? {
                ...previous,
                items: previous.items.map((item) =>
                  item.id === hit.id ? { ...item, signal: null } : item,
                ),
              }
            : previous,
        );
        notify(signal === "interest" ? "Gara rimossa dagli interessi" : "Gara ripristinata");
      } else {
        await api.setUserSignal(hit.id, signal);
        if (signal === "hide") {
          setOutcome((previous) =>
            previous
              ? {
                  ...previous,
                  items: previous.items.filter((item) => item.id !== hit.id),
                  total: Math.max(0, previous.total - 1),
                }
              : previous,
          );
          notify("Gara nascosta: non comparirà più nelle ricerche");
        } else {
          setOutcome((previous) =>
            previous
              ? {
                  ...previous,
                  items: previous.items.map((item) =>
                    item.id === hit.id
                      ? {
                          ...item,
                          signal: "interest",
                          why: item.why ?? "Gara segnalata come interessante",
                        }
                      : item,
                  ),
                }
              : previous,
          );
          notify("Segnalata come interessante: alimenta le previsioni");
        }
      }
      onSignalChanged();
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const exportNotice = async (id: string) => {
    try {
      const path = await api.exportNotice(id);
      notify(`Scheda esportata: ${path}`);
      await revealItemInDir(path);
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const outcomeLabel =
    outcome?.mode === "predictions"
      ? outcome.label
        ? `Previsioni · ${outcome.label}`
        : "Previsioni"
      : outcome?.mode === "semantic"
        ? "Ricerca semantica"
        : outcome?.mode === "keyword"
          ? "Ricerca per parole chiave"
          : "Elenco filtrato";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line bg-white">
        <div className="px-6 pb-3 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 rounded border border-slate-300 bg-slate-50 p-0.5" role="tablist" aria-label="Modalità di ricerca">
              {MODES.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={mode === item.id}
                  aria-controls="search-results"
                  title={item.hint}
                  onClick={() => setMode(item.id)}
                  className={`rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
                    mode === item.id
                      ? "bg-white text-cyan-900 shadow-sm ring-1 ring-slate-300"
                      : "text-slate-600 hover:text-heading"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                className="btn btn-ghost px-2.5 py-1.5 text-[11.5px]"
                onClick={() => {
                  setSaveThreshold(similarity);
                  setSaveOpen(true);
                }}
                disabled={mode === "predictions" || !outcome}
                title={mode === "predictions" ? "Le previsioni non si salvano come ricerca" : undefined}
              >
                Salva ricerca
              </button>
              <button
                className="btn btn-ghost px-2.5 py-1.5 text-[11.5px]"
                onClick={exportExcel}
                disabled={exporting || !outcome?.items.length}
              >
                <IconDownload /> {exporting ? "Esporto…" : "Excel"}
              </button>
              <button
                className="btn px-2.5 py-1.5 text-[11.5px]"
                aria-expanded={panelOpen}
                onClick={() => setPanelOpen((value) => !value)}
              >
                <IconFilter /> Filtri
                {activeFilterCount > 0 && (
                  <span className="rounded bg-cyan-800 px-1.5 text-[10px] font-semibold text-white">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            </div>
          </div>

          <div className="mt-3 flex gap-2">
            {mode === "predictions" ? (
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded border border-cyan-200 bg-cyan-50/70 px-3 py-2">
                <IconSpark size={15} className="shrink-0 text-cyan-800" />
                <div className="min-w-0 text-[12px] text-slate-600">
                  Previsione basata su{" "}
                  <span className="font-semibold text-heading">{predictionLabel}</span>
                </div>
                <button
                  className="ml-auto shrink-0 text-[11px] font-medium text-cyan-800 hover:underline"
                  onClick={() => {
                    setPanelOpen(true);
                    document.getElementById("prediction-picker")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  Cambia
                </button>
              </div>
            ) : (
              <div className="relative min-w-0 flex-1">
                <IconSearch
                  size={17}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500"
                />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitSearch();
                  }}
                  aria-label="Descrivi la gara o l'appalto che cerchi"
                  placeholder={
                    mode === "semantic"
                      ? "Es. manutenzione strade provinciali in Sicilia"
                      : "Parole chiave facoltative: es. pulizia, verde, rifiuti"
                  }
                  className="input h-11 pl-10 text-[14px]"
                />
              </div>
            )}
            <button
              className="btn btn-primary h-11 px-5"
              onClick={submitSearch}
              disabled={loading}
            >
              {loading ? "Cerco…" : mode === "predictions" ? "Aggiorna" : "Cerca"}
            </button>
          </div>
          <p className="mt-1.5 text-[10.5px] text-muted">
            {MODES.find((item) => item.id === mode)?.hint}
            {mode !== "filtered" && query.trim() !== ""
              ? " Premi Invio per cercare: la ricerca non parte a ogni tasto."
              : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-slate-50 px-6 py-2">
          <div className="flex items-center gap-2 text-[11px] text-slate-600">
            {outcome ? (
              <>
                <span className="tabular text-[13px] font-bold text-heading">
                  {outcome.total.toLocaleString("it-IT")}
                </span>
                <span>{outcome.total === 1 ? "risultato" : "risultati"}</span>
                <span className="text-slate-400">·</span>
                <span>{outcomeLabel}</span>
                <span className="text-slate-400">·</span>
                <span>{outcome.tookMs} ms</span>
              </>
            ) : (
              <span>{loading ? "Ricerca in corso…" : "Pronto per cercare"}</span>
            )}
            {outcome?.warning && (
              <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10.5px] text-amber-900">
                {outcome.warning}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {mode === "filtered" && (
              <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
                Ordina
                <select
                  className="rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px]"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="published">pubblicazione</option>
                  <option value="deadline">scadenza</option>
                  <option value="value">importo</option>
                  <option value="discount">ribasso</option>
                </select>
              </label>
            )}
            {loading && outcome && (
              <span className="inline-flex items-center gap-1.5 text-[10.5px] text-cyan-800">
                <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-cyan-200 border-t-cyan-700" />
                aggiorno
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {panelOpen && (
          <aside className="flex w-[286px] shrink-0 flex-col border-r border-line bg-white" aria-label="Filtri di ricerca">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-heading">Filtri</span>
              <button
                className="text-[11px] text-slate-500 hover:text-cyan-800"
                onClick={clearFilters}
                disabled={activeFilterCount === 0}
              >
                Azzera
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {mode === "predictions" && (
                <section id="prediction-picker" className="mb-4 scroll-mt-2">
                  <PanelTitle>Da cosa prevedere</PanelTitle>
                  <div className="space-y-1.5">
                    <PredictionOption
                      active={prediction.kind === "interest"}
                      onClick={() => setPrediction({ kind: "interest" })}
                      icon={<IconStar size={13} />}
                      title="Le gare che ho segnalato"
                      hint="Centroide degli interessi"
                    />
                    {prediction.kind === "notice" && (
                      <PredictionOption
                        active
                        onClick={() => undefined}
                        icon={<IconSpark size={13} />}
                        title={truncate(prediction.title, 60)}
                        hint="Gara di riferimento"
                      />
                    )}
                    {followed.map((entity) => (
                      <PredictionOption
                        key={`${entity.entityType}-${entity.entityId}`}
                        active={
                          prediction.kind === "entity" &&
                          prediction.entityType === entity.entityType &&
                          prediction.entityId === entity.entityId
                        }
                        onClick={() =>
                          setPrediction({
                            kind: "entity",
                            entityType: entity.entityType,
                            entityId: entity.entityId,
                            name: entity.name,
                          })
                        }
                        icon={
                          entity.entityType === "supplier" ? (
                            <IconUser size={13} />
                          ) : (
                            <IconBuilding size={13} />
                          )
                        }
                        title={entity.name}
                        hint={`${entity.openNotices} gare aperte · seguito`}
                      />
                    ))}
                  </div>

                  {followed.length === 0 && (
                    <p className="mt-2 text-[10.5px] leading-relaxed text-slate-500">
                      Non segui ancora enti. Cerca un'impresa o una stazione appaltante qui sotto,
                      oppure aprine una scheda e premi «Segui».
                    </p>
                  )}

                  <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2.5">
                    <div className="flex items-center gap-1.5">
                      <select
                        aria-label="Tipo di ente da cercare"
                        className="rounded border border-slate-300 bg-white px-1.5 py-1 text-[10.5px]"
                        value={entityType}
                        onChange={(event) => {
                          setEntityType(event.target.value as EntityType);
                          setSuggestions([]);
                        }}
                      >
                        <option value="supplier">Imprese</option>
                        <option value="buyer">Stazioni appaltanti</option>
                      </select>
                      <input
                        className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                        value={entityQuery}
                        onChange={(event) => setEntityQuery(event.target.value)}
                        placeholder="Cerca un ente…"
                        aria-label="Cerca un ente da usare per le previsioni"
                      />
                    </div>
                    {suggestLoading && <div className="mt-1.5 text-[10px] text-slate-500">Cerco…</div>}
                    {!suggestLoading && entityQuery.trim().length >= 2 && suggestions.length === 0 && (
                      <div className="mt-1.5 text-[10px] text-slate-500">Nessun ente trovato.</div>
                    )}
                    {suggestions.length > 0 && (
                      <div className="mt-1.5 max-h-44 space-y-0.5 overflow-y-auto">
                        {suggestions.map((item) => (
                          <button
                            key={item.key}
                            className="block w-full rounded px-1.5 py-1 text-left text-[10.5px] text-slate-700 hover:bg-white hover:text-cyan-900"
                            onClick={() => {
                              setPrediction({
                                kind: "entity",
                                entityType,
                                entityId: item.key,
                                name: item.label,
                              });
                              setEntityQuery("");
                              setSuggestions([]);
                            }}
                          >
                            <span className="block truncate font-medium">{item.label}</span>
                            <span className="text-[9.5px] text-slate-500">
                              {item.count} contratti · {euro(item.value)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}

              {mode === "semantic" && (
                <section className="mb-4">
                  <PanelTitle>Affinità minima</PanelTitle>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={similarity}
                      onChange={(event) => setSimilarity(Number(event.target.value))}
                      aria-label="Soglia di affinità minima"
                      className="min-w-0 flex-1 accent-cyan-800"
                    />
                    <span className="tabular w-10 text-right text-[12px] font-semibold text-heading">
                      {similarity}%
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                    I punteggi del modello sono compressi: ogni gara è confrontata con la migliore e
                    resta solo ciò che le si avvicina. Alza la soglia per essere più severo,
                    abbassala per allargare.
                  </p>
                </section>
              )}
              <section className="mb-4">
                <PanelTitle>Fonte e tipo</PanelTitle>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Fonte">
                    <select
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.source ?? ""}
                      onChange={(event) => patchFilters({ source: event.target.value || undefined })}
                    >
                      <option value="">Tutte</option>
                      <option value="ted">TED (UE)</option>
                      <option value="anac">ANAC (nazionale)</option>
                    </select>
                  </Field>
                  <Field label="Tipo">
                    <select
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.kind ?? ""}
                      onChange={(event) => patchFilters({ kind: event.target.value || undefined })}
                    >
                      <option value="">Tutti</option>
                      <option value="call">Bandi</option>
                      <option value="award">Aggiudicazioni</option>
                    </select>
                  </Field>
                </div>
                <label className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-600">
                  <input
                    type="checkbox"
                    checked={filters.onlyOpen ?? false}
                    onChange={(event) => patchFilters({ onlyOpen: event.target.checked })}
                    className="accent-cyan-800"
                  />
                  solo procedure aperte
                </label>
              </section>

              <section className="mb-4">
                <PanelTitle>Territorio</PanelTitle>
                <div className="space-y-2">
                  <Field label="Regione">
                    <select
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.region ?? ""}
                      onChange={(event) =>
                        patchFilters({ region: event.target.value || undefined, province: undefined })
                      }
                    >
                      <option value="">Tutte</option>
                      {regions.map((region) => (
                        <option key={region} value={region}>
                          {region}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Provincia">
                    <select
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.province ?? ""}
                      onChange={(event) => patchFilters({ province: event.target.value || undefined })}
                    >
                      <option value="">Tutte</option>
                      {provinces
                        .filter((province) => !filters.region || province.region === filters.region)
                        .map((province) => (
                          <option key={province.code} value={province.code}>
                            {province.code}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
              </section>

              <section className="mb-4">
                <PanelTitle>Categoria</PanelTitle>
                <div className="grid grid-cols-3 gap-1">
                  {CATEGORIES.map((category) => (
                    <button
                      key={category.id}
                      onClick={() =>
                        patchFilters({
                          category: filters.category === category.id ? undefined : category.id,
                        })
                      }
                      aria-pressed={filters.category === category.id}
                      className={`rounded border px-1.5 py-1 text-[10.5px] font-medium transition-colors ${
                        filters.category === category.id
                          ? "border-cyan-800 bg-cyan-50 text-cyan-900"
                          : "border-slate-300 bg-white text-slate-600 hover:border-cyan-700"
                      }`}
                    >
                      {category.label}
                    </button>
                  ))}
                </div>
                <div className="mt-2 space-y-2">
                  <Field label="Codice CPV" hint="Anche solo le prime cifre, es. 45233">
                    <input
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.cpvPrefix ?? ""}
                      onChange={(event) => patchFilters({ cpvPrefix: event.target.value || undefined })}
                      placeholder="es. 45233"
                    />
                  </Field>
                  <Field label="Categoria SOA">
                    <input
                      className="input h-8 py-1 text-[11.5px] uppercase"
                      list="soa-category-options"
                      value={filters.soaCategory ?? ""}
                      onChange={(event) =>
                        patchFilters({ soaCategory: event.target.value.toUpperCase() || undefined })
                      }
                      placeholder="es. OG3 o OS21-B"
                    />
                    <datalist id="soa-category-options">
                      {SOA_CATEGORIES.map((code) => (
                        <option key={code} value={code} />
                      ))}
                    </datalist>
                  </Field>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {CPV_HINTS.map((hint) => (
                    <button
                      key={hint.code}
                      onClick={() =>
                        patchFilters({
                          cpvPrefix: filters.cpvPrefix === hint.code ? undefined : hint.code,
                        })
                      }
                      aria-pressed={filters.cpvPrefix === hint.code}
                      className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                        filters.cpvPrefix === hint.code
                          ? "border-cyan-800 bg-cyan-50 text-cyan-900"
                          : "border-slate-200 bg-white text-slate-500 hover:border-cyan-700"
                      }`}
                    >
                      {hint.label}
                    </button>
                  ))}
                </div>
              </section>

              <section className="mb-4">
                <PanelTitle>Stazione appaltante</PanelTitle>
                <Field label="Denominazione">
                  <input
                    className="input h-8 py-1 text-[11.5px]"
                    value={filters.buyer ?? ""}
                    onChange={(event) => patchFilters({ buyer: event.target.value || undefined })}
                    placeholder="es. Comune di Milano"
                  />
                </Field>
              </section>

              <section className="mb-4">
                <PanelTitle>Importi e ribasso</PanelTitle>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Minimo €">
                    <input
                      type="number"
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.minValue ?? ""}
                      onChange={(event) =>
                        patchFilters({
                          minValue: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                      placeholder="0"
                    />
                  </Field>
                  <Field label="Massimo €">
                    <input
                      type="number"
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.maxValue ?? ""}
                      onChange={(event) =>
                        patchFilters({
                          maxValue: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                      placeholder="senza limite"
                    />
                  </Field>
                  <Field label="Ribasso min %">
                    <input
                      type="number"
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.minDiscount ?? ""}
                      onChange={(event) =>
                        patchFilters({
                          minDiscount: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                      placeholder="es. 10"
                    />
                  </Field>
                  <Field label="Ribasso max %">
                    <input
                      type="number"
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.maxDiscount ?? ""}
                      onChange={(event) =>
                        patchFilters({
                          maxDiscount: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                      placeholder="es. 40"
                    />
                  </Field>
                </div>
              </section>

              <section className="mb-4">
                <PanelTitle>Date</PanelTitle>
                <div className="space-y-2">
                  <Field label="Pubblicato dal">
                    <input
                      type="date"
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.publishedFrom ?? ""}
                      onChange={(event) =>
                        patchFilters({ publishedFrom: event.target.value || undefined })
                      }
                    />
                  </Field>
                  <Field label="Pubblicato al">
                    <input
                      type="date"
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.publishedTo ?? ""}
                      onChange={(event) =>
                        patchFilters({ publishedTo: event.target.value || undefined })
                      }
                    />
                  </Field>
                  <Field label="Scadenza entro">
                    <input
                      type="date"
                      className="input h-8 py-1 text-[11.5px]"
                      value={filters.deadlineTo ?? ""}
                      onChange={(event) =>
                        patchFilters({ deadlineTo: event.target.value || undefined })
                      }
                    />
                  </Field>
                </div>
                <label className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-600">
                  <input
                    type="checkbox"
                    checked={filters.hideExpired ?? false}
                    onChange={(event) => patchFilters({ hideExpired: event.target.checked })}
                    className="accent-cyan-800"
                  />
                  nascondi scaduti
                </label>
              </section>

              <button className="btn w-full py-1.5 text-[11.5px]" onClick={clearFilters}>
                Azzera tutti i filtri
              </button>
            </div>
          </aside>
        )}

        <div
          className="min-w-0 flex-1 overflow-y-auto bg-page px-5 py-4"
          id="search-results"
          role="tabpanel"
          aria-label="Risultati della ricerca"
          aria-busy={loading}
        >
          {loading && !outcome ? (
            <div className="pt-12">
              <Spinner label="Cerco nell'archivio TED e ANAC…" />
            </div>
          ) : !outcome || outcome.items.length === 0 ? (
            <div className="pt-4">
              <Empty
                title={
                  mode === "predictions"
                    ? "Nessuna previsione disponibile"
                    : outcome?.warning
                      ? "Nessun risultato sopra la soglia"
                      : "Nessun risultato"
                }
                hint={
                  mode === "predictions"
                    ? "Servono gare aggiudicate, una gara di riferimento o qualche gara segnalata come interessante. Verifica che gli embedding siano stati calcolati e prova con un'altra gara di riferimento."
                    : "Prova ad allargare l'intervallo di date, a togliere qualche filtro o a descrivere la gara con parole diverse. Se il problema resta, controlla che gli embedding siano stati calcolati nella pagina Archivio dati."
                }
                action={
                  activeFilterCount > 0 ? (
                    <button className="btn" onClick={clearFilters}>
                      Azzera i filtri
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="overflow-hidden rounded border border-line bg-white">
              {outcome.items.map((hit) => (
                <NoticeCard
                  key={hit.id}
                  hit={hit}
                  onOpen={() => onOpen(hit.id)}
                  onOpenEntity={onOpenEntity}
                  onAdd={() => void addToBoard(hit.id)}
                  onExport={() => void exportNotice(hit.id)}
                  onInterest={() => void setSignal(hit, "interest")}
                  onHide={() => void setSignal(hit, "hide")}
                />
              ))}
            </div>
          )}

          {outcome && outcome.items.length > 0 && (
            <div className="flex items-center justify-between py-4">
              <span className="text-[11px] text-slate-500">
                {outcome.items.length} di {outcome.total.toLocaleString("it-IT")}
              </span>
              {outcome.items.length < outcome.total && (
                <button
                  className="btn px-3 py-1.5 text-[12px]"
                  onClick={() => void runSearch(outcome.items.length, true)}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Carico…" : "Carica altri"} <IconArrow />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Salva ricerca e attiva il digest">
        <div className="space-y-3">
          <Field label="Nome della ricerca">
            <input
              className="input"
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder={truncate(query, 60) || "es. Manutenzione verde Lombardia"}
            />
          </Field>
          <Field
            label="Soglia di affinità"
            hint="Nel digest entrano solo gli avvisi almeno così simili alla ricerca."
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={saveThreshold}
                onChange={(event) => setSaveThreshold(Number(event.target.value))}
                className="min-w-0 flex-1 accent-cyan-800"
              />
              <span className="tabular w-10 text-right text-[12px] font-semibold text-heading">
                {saveThreshold}%
              </span>
            </div>
          </Field>
          <div className="rounded border border-line bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-600">
            Verrà inviata una email al giorno con i nuovi avvisi compatibili. Configura SMTP nelle
            impostazioni per riceverla.
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn" onClick={() => setSaveOpen(false)}>
              Annulla
            </button>
            <button className="btn btn-primary" onClick={saveSearch}>
              Salva
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.11em] text-slate-500">
      {children}
    </h3>
  );
}

function PredictionOption({
  active,
  onClick,
  icon,
  title,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left transition-colors ${
        active
          ? "border-cyan-700 bg-cyan-50"
          : "border-slate-200 bg-white hover:border-cyan-600 hover:bg-slate-50"
      }`}
    >
      <span className={`mt-0.5 shrink-0 ${active ? "text-cyan-800" : "text-slate-500"}`}>{icon}</span>
      <span className="min-w-0">
        <span className={`block truncate text-[11px] font-medium ${active ? "text-cyan-900" : "text-slate-700"}`}>
          {title}
        </span>
        <span className="block truncate text-[9.5px] text-slate-500">{hint}</span>
      </span>
    </button>
  );
}

function sourceLabel(source: string): string {
  return source === "anac" ? "ANAC" : "TED";
}

function NoticeCard({
  hit,
  onOpen,
  onOpenEntity,
  onAdd,
  onExport,
  onInterest,
  onHide,
}: {
  hit: NoticeHit;
  onOpen: () => void;
  onOpenEntity: (entityType: EntityType, entityId: string) => void;
  onAdd: () => void;
  onExport: () => void;
  onInterest: () => void;
  onHide: () => void;
}) {
  const [lotsOpen, setLotsOpen] = useState(false);
  const remaining = daysLeft(hit.deadlineAt);
  const urgent = remaining !== null && remaining >= 0 && remaining <= 7;
  const expired = remaining !== null && remaining < 0;

  return (
    <article className="border-b border-line px-4 py-3.5 last:border-b-0 hover:bg-cyan-50/30">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={hit.source === "anac" ? "amber" : "blue"}>{sourceLabel(hit.source)}</Badge>
            <Badge tone={hit.kind === "award" ? "green" : "amber"}>{kindLabel(hit.kind)}</Badge>
            {hit.pnrr && <Badge tone="green">PNRR</Badge>}
            {hit.pnrrPnc && !hit.pnrr && <Badge tone="blue">PNC</Badge>}
            {hit.signal === "interest" && <Badge tone="blue">interessante</Badge>}
            {hit.region && <span className="text-[10.5px] text-slate-500">{hit.region}</span>}
            {hit.province && <span className="text-[10.5px] text-slate-500">({hit.province})</span>}
            {hit.cig && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9.5px] text-slate-600">
                CIG {hit.cig}
              </span>
            )}
            {hit.cpvCodes.slice(0, 2).map((code) => (
              <span key={code} className="font-mono text-[10px] text-slate-500">
                {code}
              </span>
            ))}
            {hit.similarity != null && (
              <span className="ml-auto inline-flex items-center gap-1 rounded border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-900">
                <IconSpark size={9} /> {pct(hit.similarity * 100, 0)}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={onOpen}
            className="mt-1 block line-clamp-2 text-left text-[13.5px] font-semibold leading-snug text-heading hover:text-cyan-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-700"
          >
            {hit.title}
          </button>

          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-500">
            {hit.buyerId && hit.buyerName ? (
              <button
                className="inline-flex items-center gap-1 text-slate-600 underline-offset-2 hover:text-cyan-800 hover:underline"
                onClick={() => onOpenEntity("buyer", hit.buyerId!)}
                title="Apri il profilo della stazione appaltante"
              >
                <IconBuilding size={11} /> {hit.buyerName}
              </button>
            ) : (
              <span>{hit.buyerName ?? "Stazione appaltante non indicata"}</span>
            )}
            {(hit.placeCity || hit.province) && (
              <span>· {[hit.placeCity, hit.province].filter(Boolean).join(" · ")}</span>
            )}
          </div>

          {hit.why && (
            <div className="mt-1 flex items-start gap-1 text-[10.5px] italic leading-snug text-cyan-900/80">
              <IconSpark size={10} className="mt-0.5 shrink-0" />
              <span>Perché: {hit.why}</span>
            </div>
          )}
        </div>

        <div className="w-[136px] shrink-0 text-right">
          <div className="tabular text-[12.5px] text-slate-700">{euro(hit.estimatedValue)}</div>
          {hit.awardedValue != null && (
            <div className="tabular text-[11px] text-slate-500">agg. {euro(hit.awardedValue)}</div>
          )}
          {hit.discountPct !== null && (
            <div
              className={`tabular text-[11px] ${
                hit.discountPct >= 0 ? "text-emerald-700" : "text-rose-700"
              }`}
            >
              ribasso {pct(hit.discountPct)}
            </div>
          )}
          {hit.deadlineAt && (
            <div
              className={`mt-0.5 text-[10.5px] ${
                urgent ? "font-semibold text-rose-700" : expired ? "text-slate-500" : "text-slate-600"
              }`}
            >
              {expired
                ? "scaduto"
                : urgent
                  ? `scade tra ${remaining} ${remaining === 1 ? "giorno" : "giorni"}`
                  : `scade ${dateIt(hit.deadlineAt)}`}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <button
          className={`btn btn-ghost px-1.5 py-1 text-[10.5px] ${
            hit.signal === "interest" ? "text-cyan-900" : ""
          }`}
          onClick={onInterest}
          aria-pressed={hit.signal === "interest"}
          title={hit.signal === "interest" ? "Rimuovi dagli interessi" : "Segnala come interessante"}
        >
          <IconStar size={12} /> {hit.signal === "interest" ? "Interessante" : "Mi interessa"}
        </button>
        <button
          className="btn btn-ghost px-1.5 py-1 text-[10.5px] text-slate-500"
          onClick={onHide}
          title="Nascondi definitivamente questa gara dalle ricerche"
        >
          <IconEyeOff size={12} /> Nascondi
        </button>
        <button className="btn btn-ghost px-1.5 py-1 text-[10.5px]" onClick={onAdd}>
          <IconPlus size={12} /> Bacheca
        </button>
        <button className="btn btn-ghost px-1.5 py-1 text-[10.5px]" onClick={onExport}>
          <IconDownload size={12} /> Excel
        </button>
        {hit.lotCount > 0 && (
          <button
            className="btn btn-ghost ml-auto px-1.5 py-1 text-[10.5px]"
            onClick={() => setLotsOpen((value) => !value)}
            aria-expanded={lotsOpen}
          >
            {hit.lotCount} {hit.lotCount === 1 ? "lotto" : "lotti"}
            <IconChevron
              size={12}
              className={`transition-transform ${lotsOpen ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>

      {lotsOpen && hit.lotCount > 0 && (
        <div className="mt-2 rounded border border-line bg-slate-50">
          {hit.lots.length === 0 ? (
            <div className="px-3 py-2 text-[10.5px] text-slate-500">
              Lotti registrati, dettaglio non disponibile per questa fonte.
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="th w-10">#</th>
                  <th className="th">Oggetto del lotto</th>
                  <th className="th w-[110px] text-right">Importo</th>
                  <th className="th w-[100px] text-right">Aggiudicato</th>
                </tr>
              </thead>
              <tbody>
                {hit.lots.map((lot) => (
                  <tr key={lot.id} className="border-t border-line">
                    <td className="td py-1.5 text-[11px] text-slate-500">{lot.lotNumber}</td>
                    <td className="td py-1.5 text-[11px]">
                      <div className="text-slate-700">{lot.title ?? lot.description ?? "—"}</div>
                      {lot.cpvCodes.length > 0 && (
                        <div className="font-mono text-[9.5px] text-slate-500">
                          {lot.cpvCodes.join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="td py-1.5 text-right text-[11px] tabular">{euro(lot.estimatedValue)}</td>
                    <td className="td py-1.5 text-right text-[11px] tabular">{euro(lot.awardedValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </article>
  );
}
