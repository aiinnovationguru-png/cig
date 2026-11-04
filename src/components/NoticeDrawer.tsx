import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  type DocumentAnalysis,
  type EntityType,
  type NoticeDetail,
  type NoticeDocument,
  type NoticeHit,
  type SearchFilters,
} from "../api";
import { dateIt, daysLeft, euro, kindLabel, num, pct, truncate } from "../lib/format";
import { Badge, Bar, Empty, Spinner, useDialogFocus } from "./ui";
import {
  IconArrow,
  IconBell,
  IconBuilding,
  IconClose,
  IconDownload,
  IconEyeOff,
  IconPlus,
  IconSearch,
  IconSpark,
  IconStar,
  IconUser,
} from "./icons";

type Tab = "riepilogo" | "lotti" | "aggiudicazioni" | "simili" | "cpv" | "documenti";

export default function NoticeDrawer({
  id,
  onClose,
  onOpen,
  onOpenEntity,
  onPredictNotice,
  notify,
  onStatsChanged,
  onSignalChanged,
  onFollowChanged,
}: {
  id: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onOpenEntity: (entityType: EntityType, entityId: string) => void;
  onPredictNotice: (notice: NoticeHit) => void;
  notify: (message: string, tone?: "info" | "error") => void;
  onStatsChanged: () => void;
  onSignalChanged: () => void;
  onFollowChanged: () => void;
}) {
  const [detail, setDetail] = useState<NoticeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("riepilogo");
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertBusy, setAlertBusy] = useState<"buyer" | "search" | null>(null);
  const [documents, setDocuments] = useState<NoticeDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<DocumentAnalysis | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const panelRef = useDialogFocus<HTMLDivElement>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setTab("riepilogo");
    setDocuments([]);
    setAnalysis(null);
    setSelectedDocument(null);
    api
      .noticeDetail(id)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch((error) => notify(String(error), "error"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, notify]);

  // I documenti si caricano solo quando serve la scheda: il resto della gara
  // non deve aspettare la lettura dei PDF.
  useEffect(() => {
    if (tab !== "documenti") return;
    let cancelled = false;
    setDocumentsLoading(true);
    api
      .noticeDocuments(id)
      .then((value) => {
        if (!cancelled) setDocuments(value);
      })
      .catch((error) => notify(String(error), "error"))
      .finally(() => {
        if (!cancelled) setDocumentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, id, notify]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const notice = detail?.notice;

  const updateSignal = (signal: "interest" | "hide" | null) => {
    setDetail((previous) =>
      previous ? { ...previous, notice: { ...previous.notice, signal } } : previous,
    );
  };

  const addToBoard = async () => {
    setBusy(true);
    try {
      await api.boardAdd(id, "valutare");
      notify("Gara aggiunta alla bacheca");
      onStatsChanged();
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const toggleInterest = async () => {
    if (!notice) return;
    try {
      if (notice.signal === "interest") {
        await api.clearUserSignal(notice.id, "interest");
        updateSignal(null);
        notify("Gara rimossa dagli interessi");
      } else {
        await api.setUserSignal(notice.id, "interest");
        updateSignal("interest");
        notify("Gara segnalata come interessante");
      }
      onSignalChanged();
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const hide = async () => {
    if (!notice) return;
    try {
      await api.setUserSignal(notice.id, "hide");
      onSignalChanged();
      notify("Gara nascosta: non comparirà più nelle ricerche");
      onClose();
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const followBuyerForAlert = async () => {
    if (!notice?.buyerId) return;
    setAlertBusy("buyer");
    try {
      await api.followEntity("buyer", notice.buyerId, notice.buyerName ?? undefined);
      onFollowChanged();
      onStatsChanged();
      notify("Stazione appaltante seguita: le sue gare entreranno nel digest");
      setAlertOpen(false);
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setAlertBusy(null);
    }
  };

  const saveAlertSearch = async () => {
    if (!notice) return;
    const cpvPrefix = notice.cpvCodes
      .map((code) => code.replace(/\D/g, ""))
      .find((code) => code.length >= 2)
      ?.slice(0, 2);
    const filters: SearchFilters = {
      kind: "call",
      onlyOpen: true,
      hideExpired: true,
    };
    if (cpvPrefix) filters.cpvPrefix = cpvPrefix;
    if (notice.region) filters.region = notice.region;
    if (!cpvPrefix && !notice.region && notice.buyerId) filters.buyerId = notice.buyerId;
    if (!filters.cpvPrefix && !filters.region && !filters.buyerId) {
      notify("Questa gara non ha CPV, regione o ente con cui creare un alert", "error");
      return;
    }
    setAlertBusy("search");
    try {
      await api.saveSearch(
        `Gare come «${truncate(notice.title, 55)}»`,
        "",
        filters,
        0.6,
      );
      notify("Ricerca salvata: entrerà nel digest email");
      onStatsChanged();
      setAlertOpen(false);
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setAlertBusy(null);
    }
  };

  const alertHasFilters = Boolean(
    notice?.cpvCodes.length || notice?.region || notice?.buyerId,
  );

  const exportNotice = async () => {
    if (!notice) return;
    setBusy(true);
    try {
      const path = await api.exportNotice(notice.id);
      notify(`Scheda esportata: ${path}`);
      await revealItemInDir(path);
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(`${label} copiato`);
    } catch {
      notify("Impossibile copiare negli appunti", "error");
    }
  };

  const loadAnalysis = async (documentId: string, refresh: boolean) => {
    setSelectedDocument(documentId);
    setAnalysisBusy(true);
    try {
      const value = await api.analyzeNoticeDocument(documentId, refresh);
      setAnalysis(value);
      setDocuments((previous) =>
        previous.map((document) =>
          document.id === documentId ? { ...document, analyzed: true } : document,
        ),
      );
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setAnalysisBusy(false);
    }
  };

  const uploadDocuments = async () => {
    setUploading(true);
    try {
      const picked = await openFileDialog({
        multiple: true,
        title: "Scegli il disciplinare o il capitolato",
        filters: [{ name: "Documenti di gara", extensions: ["pdf", "txt", "md"] }],
      });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;

      let firstId: string | null = null;
      for (const path of paths) {
        const added = await api.addNoticeDocument(id, path);
        firstId = firstId ?? added.id;
      }
      setDocuments(await api.noticeDocuments(id));
      notify(paths.length === 1 ? "Documento caricato" : `${paths.length} documenti caricati`);
      if (firstId) await loadAnalysis(firstId, false);
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setUploading(false);
    }
  };

  const removeDocument = async (document: NoticeDocument) => {
    try {
      await api.removeNoticeDocument(document.id);
      setDocuments((previous) => previous.filter((item) => item.id !== document.id));
      if (selectedDocument === document.id) {
        setSelectedDocument(null);
        setAnalysis(null);
      }
      notify("Documento rimosso");
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const remaining = daysLeft(notice?.deadlineAt);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "riepilogo", label: "Riepilogo" },
    { id: "lotti", label: "Lotti", count: notice?.lotCount ?? 0 },
    { id: "aggiudicazioni", label: "Aggiudicazioni", count: detail?.awards.length ?? 0 },
    { id: "simili", label: "Simili", count: detail?.similar.length ?? 0 },
    { id: "cpv", label: "Intelligence CPV" },
    { id: "documenti", label: "Documenti", count: documents.length || undefined },
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-[1px]" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex h-full w-[760px] max-w-[94vw] flex-col border-l border-line bg-white shadow-2xl focus:outline-none"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Scheda della gara"
      >
        <div className="shrink-0 border-b border-line px-6 pb-3 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                {notice ? (
                  <>
                    <Badge tone={notice.source === "anac" ? "amber" : "blue"}>
                      {notice.source === "anac" ? "ANAC" : "TED"}
                    </Badge>
                    <Badge tone={notice.kind === "award" ? "green" : "amber"}>
                      {kindLabel(notice.kind)}
                    </Badge>
                    {notice.pnrr && <Badge tone="green">PNRR</Badge>}
                    {notice.pnrrPnc && <Badge tone="blue">PNC</Badge>}
                    {notice.signal === "interest" && <Badge tone="blue">interessante</Badge>}
                    {notice.cig && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                        CIG {notice.cig}
                      </span>
                    )}
                  </>
                ) : (
                  <Badge>Avviso</Badge>
                )}
              </div>
              <h2 className="mt-2 text-[17px] font-semibold leading-snug text-heading">
                {notice?.title ?? "Caricamento…"}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-500">
                {notice?.buyerId && notice.buyerName ? (
                  <button
                    className="inline-flex items-center gap-1 text-slate-600 hover:text-cyan-800 hover:underline"
                    onClick={() => onOpenEntity("buyer", notice.buyerId!)}
                  >
                    <IconBuilding size={11} /> {notice.buyerName}
                  </button>
                ) : (
                  <span>{notice?.buyerName ?? "Stazione appaltante non indicata"}</span>
                )}
                {[notice?.placeCity, notice?.region, notice?.province].filter(Boolean).length > 0 && (
                  <span>
                    · {[notice?.placeCity, notice?.region, notice?.province].filter(Boolean).join(" · ")}
                  </span>
                )}
                {notice?.similarity != null && (
                  <Badge tone="blue">
                    <IconSpark size={9} /> {pct(notice.similarity * 100, 0)} affine
                  </Badge>
                )}
              </div>
            </div>
            <button className="btn btn-ghost shrink-0 px-2 py-1" onClick={onClose} aria-label="Chiudi">
              <IconClose />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {notice?.url && (
              <button
                className="btn btn-primary px-2.5 py-1.5 text-[11.5px]"
                onClick={() => void openUrl(notice.url!)}
              >
                Apri su {notice.source === "anac" ? "ANAC" : "TED"} <IconArrow size={12} />
              </button>
            )}
            <button className="btn px-2.5 py-1.5 text-[11.5px]" onClick={addToBoard} disabled={busy}>
              <IconPlus size={12} /> Bacheca
            </button>
            <button
              className="btn px-2.5 py-1.5 text-[11.5px]"
              onClick={toggleInterest}
              aria-pressed={notice?.signal === "interest"}
            >
              <IconStar size={12} />
              {notice?.signal === "interest" ? "Interessante" : "Mi interessa"}
            </button>
            <button className="btn btn-ghost px-2.5 py-1.5 text-[11.5px]" onClick={exportNotice} disabled={busy}>
              <IconDownload size={12} /> Excel
            </button>
            <button className="btn btn-ghost px-2.5 py-1.5 text-[11.5px] text-slate-500" onClick={hide}>
              <IconEyeOff size={12} /> Nascondi
            </button>
            <button
              className="btn px-2.5 py-1.5 text-[11.5px]"
              onClick={() => setAlertOpen((value) => !value)}
              aria-expanded={alertOpen}
              aria-controls="notice-alert-panel"
            >
              <IconBell size={12} /> Crea alert
            </button>
            {notice?.kind === "call" && remaining !== null && (
              <span
                className={`ml-auto rounded px-2 py-1 text-[11px] font-semibold ${
                  remaining < 0
                    ? "bg-slate-100 text-slate-500"
                    : remaining <= 7
                      ? "bg-rose-50 text-rose-700"
                      : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {remaining < 0
                  ? "scaduto"
                  : `${remaining} ${remaining === 1 ? "giorno" : "giorni"} alla scadenza`}
              </span>
            )}
          </div>

          {alertOpen && notice && (
            <div
              id="notice-alert-panel"
              className="mt-2 rounded border border-cyan-200 bg-cyan-50/70 px-3 py-2.5 text-[11.5px] text-slate-700"
            >
              <div className="font-semibold text-heading">Avvisami per gare come questa</div>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-slate-500">
                Scegli un ente da seguire o salva una ricerca precompilata: entrambi alimentano il
                digest email giornaliero.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  className="btn bg-white px-2.5 py-1.5 text-[11px]"
                  onClick={followBuyerForAlert}
                  disabled={!notice.buyerId || alertBusy !== null}
                  title={!notice.buyerId ? "La gara non indica un identificativo dell'ente" : undefined}
                >
                  <IconBuilding size={11} />
                  {alertBusy === "buyer"
                    ? "Seguo…"
                    : notice.buyerName
                      ? `Segui ${truncate(notice.buyerName, 38)}`
                      : "Segui la stazione appaltante"}
                </button>
                <button
                  className="btn bg-white px-2.5 py-1.5 text-[11px]"
                  onClick={saveAlertSearch}
                  disabled={!alertHasFilters || alertBusy !== null}
                >
                  <IconSearch size={11} /> {alertBusy === "search" ? "Salvo…" : "Salva ricerca su CPV e territorio"}
                </button>
                <button
                  className="btn btn-ghost px-2.5 py-1.5 text-[11px] text-cyan-800"
                  onClick={() => {
                    setAlertOpen(false);
                    onPredictNotice(notice);
                  }}
                >
                  <IconSpark size={11} /> Vedi gare simili
                </button>
              </div>
            </div>
          )}

          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
            «Mi interessa» insegna all'app che tipo di gara cerchi: le gare simili compaiono nelle
            previsioni e nel digest. «Nascondi» la toglie dalle ricerche (la ritrovi in Archivio dati).
          </p>

          <div className="mt-3 flex gap-0.5 overflow-x-auto" role="tablist" aria-label="Sezioni della scheda">
            {tabs.map((item) => (
              <button
                key={item.id}
                id={`notice-tab-${item.id}`}
                role="tab"
                aria-selected={tab === item.id}
                aria-controls="notice-tabpanel"
                onClick={() => setTab(item.id)}
                className={`shrink-0 border-b-2 px-3 py-1.5 text-[11.5px] font-medium transition-colors ${
                  tab === item.id
                    ? "border-cyan-800 text-cyan-900"
                    : "border-transparent text-slate-500 hover:text-heading"
                }`}
              >
                {item.label}
                {item.count != null && item.count > 0 && (
                  <span className="ml-1 rounded bg-slate-100 px-1 text-[9.5px] text-slate-600">
                    {item.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="p-6">
            <Spinner label="Carico la scheda…" />
          </div>
        ) : !notice ? (
          <div className="p-6">
            <Empty title="Gara non trovata" hint="L'avviso non è presente nell'archivio locale." />
          </div>
        ) : (
          <div
            className="flex-1 overflow-y-auto px-6 py-4"
            id="notice-tabpanel"
            role="tabpanel"
            aria-labelledby={`notice-tab-${tab}`}
          >
            {tab === "riepilogo" && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Fact label="Importo base" value={euro(notice.estimatedValue)} />
                  <Fact label="Aggiudicato" value={euro(notice.awardedValue)} />
                  <Fact
                    label="Ribasso"
                    value={notice.discountPct === null ? "—" : pct(notice.discountPct)}
                    tone={
                      notice.discountPct === null
                        ? "default"
                        : notice.discountPct >= 0
                          ? "success"
                          : "danger"
                    }
                  />
                  <Fact label="Pubblicato" value={dateIt(notice.publishedAt)} />
                  <Fact label="Scadenza" value={dateIt(notice.deadlineAt)} />
                  <Fact label="Esito" value={notice.esito ?? "—"} />
                  <Fact label="Procedura" value={detail?.procedureType ?? "—"} />
                  <Fact label="Natura" value={detail?.contractNature ?? "—"} />
                  <Fact label="Lotti" value={num(notice.lotCount)} />
                  <Fact label="CIG" value={notice.cig ?? "—"} mono />
                  <Fact label="CUP" value={notice.cup ?? "—"} mono />
                  <Fact label="Fonte" value={notice.source === "anac" ? "ANAC / BDNCP" : "TED / UE"} />
                </div>

                {(notice.pnrr || notice.pnrrPnc) && (
                  <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] text-emerald-900">
                    <span className="font-semibold">
                      {notice.pnrr ? "Finanziamento PNRR" : "Finanziamento PNC"}
                    </span>
                    {notice.pnrr && notice.pnrrPnc ? " e PNC" : ""} — la procedura è collegata al
                    Piano nazionale di ripresa e resilienza.
                  </div>
                )}

                {notice.description && (
                  <section className="mt-5">
                    <SectionTitle>Oggetto</SectionTitle>
                    <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-slate-700">
                      {truncate(notice.description, 3200)}
                    </p>
                  </section>
                )}

                {notice.cpvCodes.length > 0 && (
                  <section className="mt-4">
                    <SectionTitle>Codici CPV</SectionTitle>
                    <div className="flex flex-wrap gap-1.5">
                      {notice.cpvCodes.map((code) => (
                        <span
                          key={code}
                          className="rounded border border-line bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
                        >
                          {code}
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                {detail && detail.timeline.length > 0 && (
                  <section className="mt-5">
                    <SectionTitle>Cronologia</SectionTitle>
                    <Timeline events={detail.timeline} />
                  </section>
                )}

                {detail && detail.awards.length > 0 && (
                  <section className="mt-5">
                    <SectionTitle>Esito in sintesi</SectionTitle>
                    <div className="overflow-hidden rounded border border-line">
                      {detail.awards.slice(0, 4).map((award) => (
                        <div
                          key={award.id}
                          className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0"
                        >
                          <div className="min-w-0">
                            <SupplierLink
                              name={award.supplierName}
                              supplierId={award.supplierId}
                              onOpenEntity={onOpenEntity}
                            />
                            <div className="text-[10.5px] text-slate-500">
                              {award.discountPct === null
                                ? "importo non pubblicato"
                                : `ribasso ${pct(award.discountPct)}`}
                              {award.awardedAt ? ` · ${dateIt(award.awardedAt)}` : ""}
                            </div>
                          </div>
                          <span className="tabular shrink-0 text-[12px] text-slate-700">
                            {euro(award.awardedValue)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <div className="mt-5 flex items-center justify-between border-t border-line pt-3 text-[10.5px] text-slate-500">
                  <span>
                    Fonte {notice.source === "anac" ? "ANAC / BDNCP" : "TED"} · dati pubblici
                  </span>
                  <button
                    className="inline-flex items-center gap-1 text-cyan-800 hover:underline"
                    onClick={() => onPredictNotice(notice)}
                  >
                    <IconSpark size={11} /> Cerca gare come queste
                  </button>
                </div>
              </>
            )}

            {tab === "lotti" && (
              <section>
                <SectionTitle>Lotti della procedura</SectionTitle>
                {!notice.lots.length ? (
                  <Empty
                    title="Nessun lotto separato"
                    hint={
                      notice.lotCount > 0
                        ? "La fonte segnala lotti ma non ne pubblica il dettaglio nella banca dati locale."
                        : "Questa gara non è suddivisa in lotti oppure la fonte non ne pubblica il dettaglio."
                    }
                  />
                ) : (
                  <div className="overflow-hidden rounded border border-line">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          <th className="th w-10">#</th>
                          <th className="th">Oggetto</th>
                          <th className="th w-[120px] text-right">Importo</th>
                          <th className="th w-[120px] text-right">Aggiudicato</th>
                          <th className="th w-[90px]">Stato</th>
                        </tr>
                      </thead>
                      <tbody>
                        {notice.lots.map((lot) => (
                          <tr key={lot.id} className="border-t border-line">
                            <td className="td text-slate-500">{lot.lotNumber}</td>
                            <td className="td">
                              <div className="text-slate-700">{lot.title ?? "—"}</div>
                              {lot.description && lot.description !== lot.title && (
                                <div className="mt-0.5 line-clamp-2 text-[10.5px] text-slate-500">
                                  {lot.description}
                                </div>
                              )}
                              {lot.cpvCodes.length > 0 && (
                                <div className="mt-0.5 font-mono text-[9.5px] text-slate-500">
                                  {lot.cpvCodes.join(", ")}
                                </div>
                              )}
                            </td>
                            <td className="td text-right tabular">{euro(lot.estimatedValue)}</td>
                            <td className="td text-right tabular">{euro(lot.awardedValue)}</td>
                            <td className="td text-slate-500">{lot.status ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {tab === "aggiudicazioni" && (
              <section>
                <SectionTitle>Aggiudicazioni registrate</SectionTitle>
                {!detail || detail.awards.length === 0 ? (
                  <Empty
                    title="Nessuna aggiudicazione"
                    hint={
                      notice.source === "anac"
                        ? "I dataset ANAC settimanali non sempre riportano il vincitore. La gara può essere aggiudicata senza che il dettaglio sia disponibile nell'archivio locale."
                        : "L'avviso non contiene ancora un esito di aggiudicazione."
                    }
                  />
                ) : (
                  <div className="space-y-2">
                    {detail.awards.map((award) => (
                      <div key={award.id} className="rounded border border-line bg-white px-3 py-2.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <SupplierLink
                              name={award.supplierName}
                              supplierId={award.supplierId}
                              onOpenEntity={onOpenEntity}
                              large
                            />
                            <div className="mt-0.5 text-[10.5px] text-slate-500">
                              {[award.region, award.awardedAt ? dateIt(award.awardedAt) : null]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="tabular text-[12.5px] text-slate-700">
                              {euro(award.awardedValue)}
                            </div>
                            <div className="text-[10.5px] text-slate-500">
                              base {euro(award.estimatedValue)}
                            </div>
                          </div>
                        </div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <Bar value={Math.max(0, award.discountPct ?? 0)} max={40} />
                          <span className="tabular w-14 text-right text-[10.5px] text-slate-600">
                            {pct(award.discountPct)}
                          </span>
                        </div>
                        {award.cpvCodes.length > 0 && (
                          <div className="mt-1 font-mono text-[9.5px] text-slate-500">
                            {award.cpvCodes.join(", ")}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {tab === "simili" && (
              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <SectionTitle>Contratti simili già aggiudicati</SectionTitle>
                  <button
                    className="btn btn-primary px-2.5 py-1.5 text-[11px]"
                    onClick={() => onPredictNotice(notice)}
                  >
                    <IconSpark size={11} /> Gare come queste
                  </button>
                </div>
                {!detail || detail.similar.length === 0 ? (
                  <Empty
                    title="Nessun contratto simile"
                    hint="Servono aggiudicazioni con embedding calcolati. Prova ad aggiornare l'archivio e a vettorizzare gli avvisi mancanti."
                  />
                ) : (
                  <div className="space-y-2">
                    {detail.similar.map((item) => (
                      <button
                        key={item.noticeId}
                        onClick={() => onOpen(item.noticeId)}
                        className="w-full rounded border border-line bg-white px-3 py-2.5 text-left transition-colors hover:border-cyan-600 hover:bg-cyan-50/40"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[12.5px] font-medium leading-snug text-heading">
                              {truncate(item.title, 140)}
                            </div>
                            <div className="mt-0.5 text-[10.5px] text-slate-500">
                              {[item.buyerName, item.region].filter(Boolean).join(" · ")}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-600">
                              {item.suppliers.length > 1
                                ? `${truncate(item.suppliers[0], 40)} +${item.suppliers.length - 1}`
                                : (item.suppliers[0] ?? "vincitore non indicato")}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="tabular text-[12px] text-slate-700">
                              {euro(item.awardedValue)}
                            </div>
                            <div
                              className={`tabular text-[10.5px] ${
                                (item.discountPct ?? 0) >= 0 ? "text-emerald-700" : "text-rose-700"
                              }`}
                            >
                              {pct(item.discountPct)}
                            </div>
                            <div className="mt-1 text-[10px] text-cyan-800">
                              {pct(item.similarity * 100, 0)} simile
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            {tab === "cpv" && (
              <section>
                <SectionTitle>Ribassi osservati sugli stessi CPV</SectionTitle>
                {!detail || detail.cpvContext.length === 0 ? (
                  <Empty
                    title="Dati insufficienti"
                    hint="Non ci sono ancora abbastanza aggiudicazioni sugli stessi codici CPV per calcolare un confronto."
                  />
                ) : (
                  <div className="space-y-3">
                    {detail.cpvContext.map((row) => (
                      <div key={row.key} className="rounded border border-line bg-white px-3 py-2.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-mono text-[11.5px] font-semibold text-slate-700">
                            {row.key}
                          </span>
                          <span className="text-[10.5px] text-slate-500">
                            {num(row.contracts)} contratti · {euro(row.totalValue)}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <Bar value={Math.max(0, row.avgDiscount ?? 0)} max={40} />
                          <span className="tabular w-16 text-right text-[11px] text-slate-700">
                            medio {pct(row.avgDiscount)}
                          </span>
                        </div>
                        <div className="mt-1 text-[10px] text-slate-500">
                          min {pct(row.worstDiscount)} · max {pct(row.bestDiscount)}
                          {row.lastAward ? ` · ultimo ${dateIt(row.lastAward)}` : ""}
                        </div>
                      </div>
                    ))}
                    <p className="text-[10.5px] leading-relaxed text-slate-500">
                      Il ribasso è calcolato sull'importo base pubblicato. I contratti senza importo
                      non entrano nella media.
                    </p>
                  </div>
                )}
              </section>
            )}

            {tab === "documenti" && (
              <section>
                <SectionTitle>Documenti di gara</SectionTitle>
                <div className="space-y-2">
                  <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold text-slate-700">
                          Disciplinare, capitolato o bando integrale
                        </div>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                          Il file resta su questo computer. Il testo viene diviso per pagina e analizzato
                          con regole deterministiche: ogni risultato cita la pagina esatta, così puoi
                          verificarlo in un clic.
                        </p>
                      </div>
                      <button
                        className="btn btn-primary shrink-0 px-2.5 py-1.5 text-[11px]"
                        onClick={() => void uploadDocuments()}
                        disabled={uploading}
                      >
                        <IconPlus size={11} /> {uploading ? "Carico…" : "Carica PDF"}
                      </button>
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-500">
                      PDF, TXT o MD · fino a 60 MB · i PDF scansionati richiedono OCR e non sono supportati
                    </p>
                  </div>

                  {documentsLoading && (
                    <div className="text-[11px] text-slate-500">Carico l'elenco dei documenti…</div>
                  )}

                  {!documentsLoading && documents.length === 0 && (
                    <div className="rounded border border-line bg-white px-3 py-2.5 text-[11px] leading-relaxed text-slate-500">
                      Nessun documento caricato per questa gara. L'analisi funziona offline e non
                      inventa nulla: se una sezione non è nel testo, resta vuota.
                    </div>
                  )}

                  {documents.map((document) => (
                    <div
                      key={document.id}
                      className={`rounded border px-3 py-2 ${
                        selectedDocument === document.id
                          ? "border-cyan-700 bg-cyan-50/40"
                          : "border-line bg-white"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          className="min-w-0 flex-1 text-left"
                          onClick={() => void loadAnalysis(document.id, false)}
                        >
                          <span className="block truncate text-[11.5px] font-semibold text-slate-700">
                            {document.filename}
                          </span>
                          <span className="text-[10px] text-slate-500">
                            {document.pages} {document.pages === 1 ? "pagina" : "pagine"} ·{" "}
                            {documentChars(document.chars)} · caricato il {dateIt(document.addedAt)}
                          </span>
                        </button>
                        {document.analyzed && <Badge tone="green">analizzato</Badge>}
                        <button
                          className="btn px-2 py-1 text-[10.5px]"
                          onClick={() => void loadAnalysis(document.id, document.analyzed)}
                          disabled={analysisBusy}
                        >
                          {analysisBusy && selectedDocument === document.id
                            ? "Analizzo…"
                            : document.analyzed
                              ? "Ricalcola"
                              : "Analizza"}
                        </button>
                        <button
                          className="btn px-2 py-1 text-[10.5px] text-rose-700"
                          onClick={() => void removeDocument(document)}
                        >
                          Rimuovi
                        </button>
                      </div>
                    </div>
                  ))}

                  {analysis && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-[0.11em] text-slate-500">
                          Analisi
                        </span>
                        <span className="max-w-[240px] truncate text-[11px] text-slate-600">
                          {analysis.filename}
                        </span>
                        <span className="text-[10px] text-slate-500">
                          · {analysis.pages} {analysis.pages === 1 ? "pagina" : "pagine"} ·{" "}
                          {analysis.sections.filter((section) => section.found).length} sezioni con
                          riferimenti
                        </span>
                      </div>

                      {analysis.warnings.map((warning) => (
                        <div
                          key={warning}
                          className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-amber-900"
                        >
                          {warning}
                        </div>
                      ))}

                      {analysis.sections.map((section) => (
                        <div key={section.id} className="overflow-hidden rounded border border-line bg-white">
                          <div className="border-b border-line bg-slate-50 px-3 py-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] font-semibold text-slate-700">
                                {section.label}
                              </span>
                              <Badge tone={section.found ? "blue" : "neutral"}>
                                {section.items.length}
                              </Badge>
                            </div>
                            <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                              {section.summary}
                            </p>
                          </div>
                          {section.found ? (
                            <div>
                              {section.items.map((item, index) => (
                                <div
                                  key={`${section.id}-${index}`}
                                  className="border-t border-line px-3 py-2 first:border-t-0"
                                >
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[9.5px] text-slate-600">
                                      pag. {item.page}
                                    </span>
                                    <span className="text-[10px] text-slate-500">{item.label}</span>
                                    {item.note && <Badge tone="amber">{item.note}</Badge>}
                                  </div>
                                  <p className="mt-1 text-[11px] leading-relaxed text-slate-700">
                                    «{item.quote}»
                                  </p>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="px-3 py-2 text-[10.5px] leading-relaxed text-slate-500">
                              {section.hint}
                            </p>
                          )}
                        </div>
                      ))}

                      <p className="text-[10px] leading-relaxed text-slate-500">
                        Analisi deterministica sul testo estratto: non sostituisce la lettura del
                        disciplinare. Le sezioni vuote dicono che il documento caricato non ne parla, non
                        che il requisito non esista.
                      </p>
                    </div>
                  )}

                  <div className="rounded border border-line bg-white px-3 py-2.5">
                    <div className="text-[11px] font-semibold text-slate-700">Avviso originale</div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                      La documentazione ufficiale resta sulla piattaforma di origine: scarica il
                      disciplinare e caricalo qui sopra per analizzarlo offline.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {notice.url ? (
                        <button
                          className="btn btn-primary px-2.5 py-1.5 text-[11px]"
                          onClick={() => void openUrl(notice.url!)}
                        >
                          Apri su {notice.source === "anac" ? "ANAC" : "TED"} <IconArrow size={11} />
                        </button>
                      ) : (
                        <span className="text-[10.5px] text-slate-500">URL non disponibile.</span>
                      )}
                      <button
                        className="btn px-2.5 py-1.5 text-[11px]"
                        onClick={() => void copy(notice.id, "Identificativo")}
                      >
                        Copia ID
                      </button>
                      {notice.cig && (
                        <button
                          className="btn px-2.5 py-1.5 text-[11px]"
                          onClick={() => void copy(notice.cig!, "CIG")}
                        >
                          Copia CIG
                        </button>
                      )}
                      {notice.cup && (
                        <button
                          className="btn px-2.5 py-1.5 text-[11px]"
                          onClick={() => void copy(notice.cup!, "CUP")}
                        >
                          Copia CUP
                        </button>
                      )}
                      <button className="btn px-2.5 py-1.5 text-[11px]" onClick={exportNotice}>
                        <IconDownload size={11} /> Esporta scheda
                      </button>
                    </div>
                  </div>

                  <div className="rounded border border-line bg-slate-50 px-3 py-2.5 text-[11px] leading-relaxed text-slate-600">
                    <div className="font-semibold text-slate-700">Tracciabilità</div>
                    <dl className="mt-1 grid grid-cols-[110px_1fr] gap-x-2 gap-y-1">
                      <dt className="text-slate-500">Identificativo</dt>
                      <dd className="break-all font-mono text-[10.5px]">{notice.id}</dd>
                      <dt className="text-slate-500">Fonte</dt>
                      <dd>{notice.source === "anac" ? "ANAC / BDNCP" : "TED — Tenders Electronic Daily"}</dd>
                      <dt className="text-slate-500">Tipo avviso</dt>
                      <dd>{notice.noticeType || "—"}</dd>
                      <dt className="text-slate-500">CIG</dt>
                      <dd className="font-mono text-[10.5px]">{notice.cig ?? "—"}</dd>
                      <dt className="text-slate-500">CUP</dt>
                      <dd className="font-mono text-[10.5px]">{notice.cup ?? "—"}</dd>
                    </dl>
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function documentChars(chars: number): string {
  if (chars >= 1000) {
    const compact = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 }).format(chars / 1000);
    return `${compact} mila caratteri`;
  }
  return `${chars} caratteri`;
}

function Fact({
  label,
  value,
  tone = "default",
  mono = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "danger";
  mono?: boolean;
}) {
  const color =
    tone === "success" ? "text-emerald-700" : tone === "danger" ? "text-rose-700" : "text-slate-700";
  return (
    <div className="rounded border border-line bg-slate-50/70 px-2.5 py-2">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-slate-500">{label}</div>
      <div className={`mt-0.5 text-[12px] ${color} ${mono ? "break-all font-mono text-[10.5px]" : "tabular"}`}>
        {value}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.12em] text-slate-500">
      {children}
    </h3>
  );
}

function SupplierLink({
  name,
  supplierId,
  onOpenEntity,
  large = false,
}: {
  name: string;
  supplierId: string | null;
  onOpenEntity: (entityType: EntityType, entityId: string) => void;
  large?: boolean;
}) {
  if (!supplierId) {
    return <span className={`text-slate-700 ${large ? "text-[13px] font-medium" : "text-[12px]"}`}>{name}</span>;
  }
  return (
    <button
      className={`inline-flex items-center gap-1 text-left text-slate-700 underline-offset-2 hover:text-cyan-800 hover:underline ${
        large ? "text-[13px] font-medium" : "text-[12px]"
      }`}
      onClick={() => onOpenEntity("supplier", supplierId)}
      title="Apri il profilo dell'impresa"
    >
      <IconUser size={large ? 12 : 10} /> {name}
    </button>
  );
}

function Timeline({ events }: { events: { label: string; date: string; kind: string }[] }) {
  return (
    <ol className="relative ml-1 border-l border-slate-200">
      {events.map((event, index) => {
        const color =
          event.kind === "award"
            ? "bg-emerald-600"
            : event.kind === "deadline"
              ? "bg-amber-500"
              : event.kind === "outcome"
                ? "bg-cyan-700"
                : "bg-slate-400";
        return (
          <li key={`${event.kind}-${event.date}-${index}`} className="relative pb-3 pl-4 last:pb-0">
            <span className={`absolute -left-[4.5px] top-1 h-2 w-2 rounded-full ${color}`} />
            <div className="text-[11.5px] text-slate-700">{event.label}</div>
            <div className="text-[10px] text-slate-500">{dateIt(event.date)}</div>
          </li>
        );
      })}
    </ol>
  );
}
