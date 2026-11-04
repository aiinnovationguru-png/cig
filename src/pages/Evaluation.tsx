import { useCallback, useEffect, useState } from "react";
import { api, type Criterion, type Evaluation, type SavedEvaluation } from "../api";
import { dateTimeIt, pct } from "../lib/format";
import { Bar, Field, Spinner, Stat } from "../components/ui";
import { IconArrow, IconSpark } from "../components/icons";

export default function EvaluationPage({
  notify,
}: {
  notify: (message: string, tone?: "info" | "error") => void;
}) {
  const [report, setReport] = useState("");
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [result, setResult] = useState<Evaluation | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedEvaluation[]>([]);

  const loadSaved = useCallback(async () => {
    try {
      setSaved(await api.listEvaluations());
    } catch {
      setSaved([]);
    }
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  useEffect(() => {
    api
      .evaluate({ report: "", criteria: [] })
      .then((output) => setCriteria(output.criteria))
      .catch((error) => notify(String(error), "error"));
  }, [notify]);

  const analyze = async (save = false) => {
    if (!report.trim()) {
      notify("Incolla prima il testo della relazione tecnica", "error");
      return;
    }
    save ? setSaving(true) : setLoading(true);
    try {
      const output = await api.evaluate({
        report,
        criteria,
        reportTitle: title || null,
        save,
      });
      setResult(output.evaluation);
      if (save) {
        notify("Valutazione salvata");
        await loadSaved();
      }
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setLoading(false);
      setSaving(false);
    }
  };

  // Riporta nell'editor una valutazione archiviata: senza questo lo storico
  // sarebbe solo un elenco di righe in sola lettura.
  const openSaved = (item: SavedEvaluation) => {
    setTitle(item.reportTitle ?? "");
    if (item.reportText) setReport(item.reportText);
    if (item.criteria.length > 0) setCriteria(item.criteria);
    setResult(item.result);
  };

  const removeSaved = async (id: number) => {
    try {
      await api.deleteEvaluation(id);
      setSaved((previous) => previous.filter((item) => item.id !== id));
      notify("Valutazione eliminata");
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const updateCriterion = (id: string, patch: Partial<Criterion>) => {
    setCriteria((previous) =>
      previous.map((criterion) => (criterion.id === id ? { ...criterion, ...patch } : criterion)),
    );
  };

  // Cambiare un peso o un punteggio manuale aggiorna subito l'analisi.
  const hasResult = result !== null;
  useEffect(() => {
    if (!hasResult) return;
    const timer = setTimeout(() => {
      void api
        .evaluate({ report, criteria })
        .then((output) => setResult(output.evaluation))
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(timer);
  }, [criteria, report, hasResult]);

  const maxScore = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-white px-6 py-2.5">
        <p className="text-[11.5px] text-muted">
          Incolla la relazione: per ogni criterio vedrai copertura, evidenze e punteggio suggerito.
        </p>
        <div className="flex gap-2">
          <button className="btn px-3 py-1.5 text-[12px]" onClick={() => void analyze(true)} disabled={saving}>
            {saving ? "Salvo…" : "Salva valutazione"}
          </button>
          <button
            className="btn btn-primary px-3.5 py-1.5 text-[12px]"
            onClick={() => void analyze(false)}
            disabled={loading}
          >
            {loading ? "Analizzo…" : "Analizza"} <IconArrow />
          </button>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-0 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:overflow-hidden">
        <div className="border-line px-6 py-4 xl:overflow-y-auto xl:border-r">
          <div className="space-y-3">
            {title && <div className="text-[13px] font-medium text-heading">{title}</div>}
            <Field label="Titolo della relazione">
              <input
                className="input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="es. Offerta tecnica — lotto 2"
              />
            </Field>
            <Field label="Testo della relazione" hint={`${report.split(/\s+/).filter(Boolean).length} parole`}>
              <textarea
                className="input h-[240px] resize-y font-mono text-[11.5px] leading-relaxed"
                value={report}
                onChange={(event) => setReport(event.target.value)}
                placeholder="Incolla qui il testo dell'offerta tecnica o della relazione illustrativa…"
              />
            </Field>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Criteri di valutazione
              </span>
              <span className="text-[10.5px] tabular text-slate-500">max {maxScore} punti</span>
            </div>
            <div className="space-y-2">
              {criteria.map((criterion) => (
                <div
                  key={criterion.id}
                  className="rounded-lg border border-line bg-slate-50 px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[12px] font-medium leading-snug text-copy">
                      {criterion.label}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <input
                        type="number"
                        className="input h-7 w-14 px-1.5 py-0 text-right text-[11px]"
                        value={criterion.weight}
                        min={0}
                        max={100}
                        onChange={(event) =>
                          updateCriterion(criterion.id, { weight: Number(event.target.value) })
                        }
                        title="Peso del criterio"
                      />
                      <span className="text-[10px] text-slate-500">pt</span>
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {criterion.requirements.slice(0, 6).map((requirement) => (
                      <span
                        key={requirement}
                        className="rounded bg-white px-1.5 py-0.5 text-[9.5px] text-slate-500 ring-1 ring-line"
                      >
                        {requirement}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Valutazioni salvate
              </span>
              <span className="tabular text-[10.5px] text-slate-500">{saved.length}</span>
            </div>
            {saved.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-slate-500">
                Nessuna valutazione archiviata: «Salva valutazione» conserva testo, criteri e risultato.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {saved.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded border border-line bg-slate-50 px-2.5 py-1.5"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => openSaved(item)}
                    >
                      <span className="block truncate text-[11.5px] text-copy">
                        {item.reportTitle || "Senza titolo"}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {dateTimeIt(item.createdAt)} · {item.totalScore.toFixed(1)} su {item.maxScore}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost shrink-0 px-1.5 py-0.5 text-[10.5px]"
                      onClick={() => void removeSaved(item.id)}
                      aria-label={`Elimina ${item.reportTitle || "valutazione"}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="px-6 py-4 xl:overflow-y-auto">
          {loading && !result ? (
            <Spinner label="Analizzo il documento…" />
          ) : !result ? (
            <div className="mt-16 px-6 text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-slate-50 text-amber-800">
                <IconSpark size={20} />
              </div>
              <div className="mt-3 text-[13px] font-medium text-heading">Nessuna analisi</div>
              <p className="mx-auto mt-1 max-w-sm text-[11.5px] leading-relaxed text-slate-500">
                Incolla la relazione e premi «Analizza»: per ogni criterio vedrai le frasi che
                coprono i requisiti, quelle mancanti e un punteggio suggerito.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2.5">
                <Stat
                  label="Punteggio"
                  value={`${result.totalScore.toFixed(1)}`}
                  hint={`su ${result.maxScore}`}
                  tone="accent"
                />
                <Stat label="Copertura" value={pct(result.coverage * 100, 0)} />
                <Stat label="Parole" value={result.wordCount.toLocaleString("it-IT")} />
              </div>

              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-900">
                {result.summary}
              </div>

              {result.signals.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {result.signals.map((signal) => (
                    <span
                      key={signal.label}
                      className="rounded-md border border-line bg-slate-50 px-2 py-1 text-[10.5px] text-slate-600"
                    >
                      <span className="text-slate-500">{signal.label}: </span>
                      {signal.value}
                    </span>
                  ))}
                </div>
              )}

              {result.criteria.map((criterion) => {
                const source = criteria.find((item) => item.id === criterion.id);
                return (
                  <div key={criterion.id} className="card px-3.5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-[12.5px] font-medium leading-snug text-copy">
                        {criterion.label}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="tabular text-[13px] font-semibold text-amber-700">
                          {criterion.appliedScore.toFixed(1)}
                        </div>
                        <div className="text-[9.5px] text-slate-500">su {criterion.weight}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Bar
                        value={criterion.coverage}
                        max={1}
                        tone={
                          criterion.coverage >= 0.66
                            ? "green"
                            : criterion.coverage >= 0.34
                              ? "amber"
                              : "red"
                        }
                      />
                      <span className="tabular w-9 text-right text-[10px] text-slate-500">
                        {pct(criterion.coverage * 100, 0)}
                      </span>
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[10px] text-slate-500">punteggio manuale</span>
                      <input
                        type="number"
                        step={0.5}
                        min={0}
                        max={source?.weight ?? criterion.weight}
                        className="input h-7 w-16 px-1.5 py-0 text-right text-[11px]"
                        value={source?.manualScore ?? ""}
                        placeholder={criterion.suggestedScore.toFixed(1)}
                        onChange={(event) =>
                          updateCriterion(criterion.id, {
                            manualScore: event.target.value ? Number(event.target.value) : null,
                          })
                        }
                      />
                      <span className="text-[10px] text-slate-500">
                        suggerito {criterion.suggestedScore.toFixed(1)}
                      </span>
                    </div>

                    {criterion.evidence.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {criterion.evidence.map((evidence, index) => (
                          <blockquote
                            key={index}
                            className="border-l-2 border-emerald-400 pl-2 text-[11px] leading-relaxed text-slate-600"
                          >
                            {evidence.sentence}
                          </blockquote>
                        ))}
                      </div>
                    )}

                    {criterion.gaps.length > 0 && (
                      <div className="mt-2 text-[10.5px] text-rose-700">
                        Da coprire: {criterion.gaps.join(", ")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
