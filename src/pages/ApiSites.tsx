import { useCallback, useEffect, useState } from "react";
import { apiAnythingService } from "../lib/api-anything";
import { type CallResult, type SiteInfo, type OperationInfo } from "../lib/api-anything";
import { Badge, Empty, Spinner } from "../components/ui";
import { APPALTO_SPECS } from "../lib/appalto-specs";

export default function ApiSitesPage({ notify }: { notify: (message: string, tone?: "info" | "error") => void }) {
  const [sites, setSites] = useState<SiteInfo[]>([]);
  const [query, setQuery] = useState("");
  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [operations, setOperations] = useState<OperationInfo[]>([]);
  const [callResult, setCallResult] = useState<CallResult | null>(null);
  const [loadingSites, setLoadingSites] = useState(false);
  const [loadingOps, setLoadingOps] = useState(false);
  const [callSite, setCallSite] = useState("");
  const [callOp, setCallOp] = useState("");
  const [callArgs, setCallArgs] = useState("{}");
  const [calling, setCalling] = useState(false);

  const searchSites = useCallback(async () => {
    setLoadingSites(true);
    try {
      const result = await apiAnythingService.sites(query || undefined);
      if (result.ok && result.data) {
        setSites(result.data);
      } else {
        notify(result.error?.reason ?? "Errore ricerca", "error");
        setSites([]);
      }
    } catch {
      notify("Errore ricerca siti", "error");
      setSites([]);
    } finally {
      setLoadingSites(false);
    }
  }, [query, notify]);

  useEffect(() => {
    searchSites();
  }, [searchSites]);

  const loadOps = useCallback(async (site: string) => {
    setSelectedSite(site);
    setLoadingOps(true);
    setOperations([]);
    try {
      const result = await apiAnythingService.ops(site);
      if (result.ok && result.data) {
        setOperations(result.data);
      } else {
        notify(result.error?.reason ?? "Errore operazioni", "error");
        setOperations([]);
      }
    } catch {
      notify("Errore operazioni", "error");
      setOperations([]);
    } finally {
      setLoadingOps(false);
    }
  }, [notify]);

  const runCall = useCallback(async () => {
    if (!callSite || !callOp) return;
    setCalling(true);
    setCallResult(null);
    try {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(callArgs);
      } catch {
        args = {};
      }
      const result = await apiAnythingService.call<Record<string, unknown>>(callSite, callOp, args);
      if (result.ok) {
        setCallResult(result.data ?? { ok: true, data: null, class: "ok", tier: 1 });
        notify("Operazione completata", "info");
      } else {
        setCallResult({ ok: false, class: result.error?.class ?? "error", reason: result.error?.reason ?? "Errore", tier: 0 } as CallResult);
        notify(result.error?.reason ?? "Errore chiamata", "error");
      }
    } catch (e) {
      setCallResult({ ok: false, class: "error", reason: String(e), tier: 0 } as CallResult);
      notify("Errore chiamata", "error");
    } finally {
      setCalling(false);
    }
  }, [callSite, callOp, callArgs, notify]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto bg-page px-6 py-4">
        <h2 className="mb-3 text-[14px] font-semibold text-heading">Siti esterni (API Anything)</h2>
        <p className="mb-4 text-[11.5px] text-slate-600">
          Cerca operazioni condivise nel catalogo o sui siti predefiniti, chiama le API estratte e gestisci sessioni.
        </p>

        <div className="mb-5 rounded border border-amber-300 bg-amber-50/60 p-4">
          <h3 className="text-[12px] font-semibold text-amber-900">Operazioni predefinite per appalti pubblici</h3>
          <p className="mt-1 text-[11px] text-amber-800">Usa queste spec (TED e ANAC/BDNCP) per estrarre dati nel formato CIG: CIG, importo, regione, scadenza.</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {APPALTO_SPECS.map((spec) => (
              <div key={spec.name} className="rounded border border-amber-200 bg-white p-2 text-[11px]">
                <div className="font-semibold text-heading">{spec.displayName}</div>
                <div className="text-[10px] text-slate-500">{spec.operations.map(o => o.name).join(", ")}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-4 flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cerca sito o URL (es. ted, anac, start)"
            className="flex-1 rounded border border-line px-3 py-2 text-[12px]"
          />
          <button onClick={searchSites} disabled={loadingSites} className="btn px-3 py-2 text-[12px]">
            {loadingSites ? "..." : "Cerca"}
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded border border-line bg-white p-3">
            <h3 className="mb-2 text-[12px] font-semibold text-heading">Siti disponibili</h3>
            <div className="space-y-1">
              {sites.length === 0 && !loadingSites && <Empty title="Nessun sito trovato" />}
              {sites.map((s) => (
                <button
                  key={s.name}
                  onClick={() => loadOps(s.name)}
                  className={`w-full rounded px-2 py-1.5 text-left text-[11px] transition-colors ${
                    selectedSite === s.name ? "bg-cyan-50 font-medium text-cyan-900" : "hover:bg-slate-50 text-slate-700"
                  }`}
                >
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-1 text-[9px] text-slate-400">{(s.operations || []).length} operazioni</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded border border-line bg-white p-3 md:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[12px] font-semibold text-heading">
                {selectedSite ? `Operazioni: ${selectedSite}` : "Seleziona un sito"}
              </h3>
              <span className="text-[9px] text-slate-400">API Anything v0.3</span>
            </div>
            {selectedSite && (
              <div className="space-y-1">
                {loadingOps ? (
                  <Spinner />
                ) : operations.length === 0 ? (
                  <Empty title="Nessuna operazione disponibile" />
                ) : (
                  operations.map((op) => (
                    <div key={op.name} className="rounded border border-line px-2 py-2 text-[11px]">
                      <div className="font-medium text-heading">{op.name}</div>
                      <div className="text-[10px] text-slate-500">{op.description || "Nessuna descrizione"}</div>
                      <div className="mt-1 text-[9px] text-slate-400">Schema args: {JSON.stringify(op.argsSchema).slice(0, 80)}</div>
                      <button
                        onClick={() => { setCallSite(selectedSite); setCallOp(op.name); setCallArgs("{}"); setCallResult(null); }}
                        className="mt-1.5 rounded bg-cyan-800 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-cyan-900"
                      >
                        Chiama
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 rounded border border-line bg-white p-4">
          <h3 className="mb-3 text-[12px] font-semibold text-heading">Chiamata operazione</h3>
          <div className="mb-2 flex gap-2">
            <input
              type="text"
              value={callSite}
              onChange={(e) => setCallSite(e.target.value)}
              placeholder="Sito"
              className="w-32 rounded border border-line px-2 py-1.5 text-[11px]"
            />
            <input
              type="text"
              value={callOp}
              onChange={(e) => setCallOp(e.target.value)}
              placeholder="Operazione"
              className="w-40 rounded border border-line px-2 py-1.5 text-[11px]"
            />
            <textarea
              value={callArgs}
              onChange={(e) => setCallArgs(e.target.value)}
              placeholder='Args JSON (es. {"q":"gare"})'
              className="flex-1 rounded border border-line px-2 py-1.5 text-[11px] font-mono"
              rows={1}
            />
            <button
              onClick={runCall}
              disabled={calling || !callSite || !callOp}
              className="btn px-3 py-1.5 text-[11px]"
            >
              {calling ? "Chiamata..." : "Esegui"}
            </button>
          </div>
          {callResult && (
            <div className="rounded border border-line bg-slate-50 p-3 text-[11px] font-mono text-slate-800">
              <div className="mb-1 flex gap-2">
                <Badge tone={callResult.ok ? "green" : "red"}>{callResult.ok ? "OK" : callResult.class}</Badge>
                <span>Tier: {callResult.tier}</span>
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(callResult.data ?? callResult, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
