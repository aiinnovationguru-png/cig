import { useEffect, useState } from "react";
import { api, type EntityType, type IntelOutcome, type SearchFilters } from "../api";
import { euro, euroCompact, num, pct, truncate } from "../lib/format";
import { Bar, Empty, Spinner, Stat } from "../components/ui";
import { IconArrow } from "../components/icons";

const GROUPS: { id: string; label: string; hint: string }[] = [
  { id: "supplier", label: "Vincitori", hint: "chi si aggiudica più contratti" },
  { id: "cpv", label: "Settori", hint: "divisione CPV" },
  { id: "region", label: "Regioni", hint: "dove vengono aggiudicati" },
  { id: "buyer", label: "Stazioni appaltanti", hint: "chi bandisce di più" },
  { id: "nature", label: "Natura", hint: "lavori, servizi, forniture" },
];

export default function IntelPage({
  onOpen,
  onOpenEntity,
}: {
  onOpen: (id: string) => void;
  onOpenEntity: (entityType: EntityType, entityId: string) => void;
}) {
  const [groupBy, setGroupBy] = useState("supplier");
  const [region, setRegion] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [minDiscount, setMinDiscount] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<IntelOutcome | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.geoFilters().then((value) => setRegions(value.regions)).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const filters: SearchFilters = {
      region: region || undefined,
      minDiscount,
    };
    api
      .awardIntel(filters, groupBy)
      .then((value) => {
        if (!cancelled) setOutcome(value);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupBy, region, minDiscount]);

  const maxContracts = outcome ? Math.max(...outcome.rows.map((row) => row.contracts), 1) : 1;
  const maxYearValue = outcome ? Math.max(...outcome.years.map((year) => year.totalValue), 1) : 1;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-white px-6 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input h-9 w-[168px] py-1.5"
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            aria-label="Filtra per regione"
          >
            <option value="">Tutte le regioni</option>
            {regions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            className="input h-9 w-[190px] py-1.5"
            value={minDiscount ?? ""}
            onChange={(event) =>
              setMinDiscount(event.target.value ? Number(event.target.value) : null)
            }
            aria-label="Ribasso minimo"
          >
            <option value="">Qualsiasi ribasso</option>
            <option value="5">Ribasso ≥ 5%</option>
            <option value="10">Ribasso ≥ 10%</option>
            <option value="20">Ribasso ≥ 20%</option>
            <option value="30">Ribasso ≥ 30%</option>
          </select>
        </div>

        <div
          className="flex flex-wrap gap-1 rounded border border-slate-300 bg-slate-50 p-0.5"
          role="tablist"
          aria-label="Raggruppa per"
        >
          {GROUPS.map((group) => (
            <button
              key={group.id}
              role="tab"
              aria-selected={groupBy === group.id}
              onClick={() => setGroupBy(group.id)}
              className={`rounded px-3 py-1 text-[11.5px] transition-colors ${
                groupBy === group.id
                  ? "bg-white font-medium text-cyan-900 shadow-sm ring-1 ring-slate-300"
                  : "text-slate-600 hover:bg-slate-100 hover:text-heading"
              }`}
              title={group.hint}
            >
              {group.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Contratti aggiudicati" value={outcome ? num(outcome.totalAwards) : "—"} />
          <Stat label="Valore aggiudicato" value={outcome ? euroCompact(outcome.totalValue) : "—"} />
          <Stat
            label="Ribasso medio"
            value={outcome?.avgDiscount != null ? pct(outcome.avgDiscount) : "—"}
            tone="accent"
            hint="media semplice sui contratti con importo"
          />
        </div>

        {outcome && outcome.years.length > 1 && (
          <div className="card mt-4 px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Andamento per anno
              </span>
              <span className="text-[10.5px] text-muted">valore aggiudicato</span>
            </div>
            <div className="flex items-end gap-2">
              {outcome.years.slice(-10).map((year) => (
                <div key={year.year} className="flex flex-1 flex-col items-center gap-1">
                  <div className="text-[9.5px] tabular text-slate-500">
                    {euroCompact(year.totalValue)}
                  </div>
                  <div
                    className="w-full rounded-t bg-amber-500 transition-all hover:bg-amber-600"
                    style={{
                      height: `${Math.max(4, (year.totalValue / maxYearValue) * 84)}px`,
                    }}
                    title={`${year.contracts} contratti · ribasso medio ${pct(year.avgDiscount)}`}
                  />
                  <div className="text-[10px] text-slate-500">{year.year}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card mt-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              {GROUPS.find((group) => group.id === groupBy)?.label}
            </span>
            <span className="text-[10.5px] text-muted">ordinati per numero contratti</span>
          </div>

          {loading ? (
            <div className="p-6">
              <Spinner label="Calcolo le statistiche…" />
            </div>
          ) : !outcome || outcome.rows.length === 0 ? (
            <div className="p-5">
              <Empty
                title="Nessuna aggiudicazione"
                hint="Scarica gli avvisi di aggiudicazione dalla sezione Dati, poi torna qui."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="th w-8">#</th>
                  <th className="th">Soggetto</th>
                  <th className="th w-[120px] text-right">Contratti</th>
                  <th className="th w-[150px] text-right">Valore</th>
                  <th className="th w-[180px]">Ribasso medio</th>
                  <th className="th w-[110px] text-right">Ultimo</th>
                </tr>
              </thead>
              <tbody>
                {outcome.rows.map((row, index) => (
                  <tr key={row.key} className="row-hover">
                    <td className="td text-slate-500">{index + 1}</td>
                    <td className="td">
                      {(groupBy === "supplier" || groupBy === "buyer") && !row.key.includes(" ") ? (
                        <button
                          className="block max-w-[520px] truncate text-left text-copy underline-offset-2 hover:text-cyan-800 hover:underline"
                          onClick={() =>
                            onOpenEntity(groupBy as EntityType, row.key)
                          }
                          title="Apri il profilo dell'ente"
                        >
                          {row.label}
                        </button>
                      ) : (
                        <div className="max-w-[520px] truncate text-copy">{row.label}</div>
                      )}
                      <div className="mt-0.5 h-1 w-full max-w-[220px] overflow-hidden rounded-full bg-slate-200">
                        <div
                          className="h-full rounded-full bg-cyan-700"
                          style={{ width: `${(row.contracts / maxContracts) * 100}%` }}
                        />
                      </div>
                    </td>
                    <td className="td tabular text-right">{num(row.contracts)}</td>
                    <td className="td tabular text-right">{euro(row.totalValue)}</td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className="tabular w-12 text-right text-copy">
                          {pct(row.avgDiscount)}
                        </span>
                        <div className="flex-1">
                          <Bar value={row.avgDiscount ?? 0} max={40} />
                        </div>
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted">
                        min {pct(row.worstDiscount)} · max {pct(row.bestDiscount)}
                      </div>
                    </td>
                    <td className="td tabular text-right text-slate-500">
                      {row.lastAward?.slice(0, 7) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>

        {outcome && outcome.topContracts.length > 0 && (
          <div className="card mt-4 px-4 py-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Contratti più grandi
            </div>
            <div className="grid grid-cols-1 gap-1.5 lg:grid-cols-2">
              {outcome.topContracts.map((contract) => (
                <button
                  key={contract.key}
                  onClick={() => onOpen(contract.key)}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-slate-50 px-3 py-2 text-left transition-colors hover:border-cyan-300 hover:bg-white"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[12px] text-copy">
                      {truncate(contract.label, 90)}
                    </div>
                    <div className="text-[10.5px] text-slate-500">
                      ribasso {pct(contract.avgDiscount)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="tabular text-[12px] text-copy">
                      {euro(contract.totalValue)}
                    </span>
                    <IconArrow size={12} className="text-slate-500" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
