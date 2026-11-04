import { useEffect, useMemo, useState } from "react";
import { api, type EntityProfile, type EntityType, type ProfileCount } from "../api";
import { dateIt, daysLeft, euro, euroCompact, num, pct, truncate } from "../lib/format";
import { Badge, Empty, Spinner, useDialogFocus } from "./ui";
import {
  IconBuilding,
  IconClose,
  IconSpark,
  IconStar,
  IconUser,
} from "./icons";

export default function EntityDrawer({
  entityType,
  entityId,
  onClose,
  onOpenNotice,
  onOpenEntity,
  onPredict,
  onFollowChanged,
  notify,
}: {
  entityType: EntityType;
  entityId: string;
  onClose: () => void;
  onOpenNotice: (id: string) => void;
  onOpenEntity: (entityType: EntityType, entityId: string) => void;
  onPredict: (entityType: EntityType, entityId: string, name: string) => void;
  onFollowChanged: () => void;
  notify: (message: string, tone?: "info" | "error") => void;
}) {
  const [profile, setProfile] = useState<EntityProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const panelRef = useDialogFocus<HTMLDivElement>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProfile(null);
    api
      .entityProfile(entityType, entityId)
      .then((value) => {
        if (!cancelled) setProfile(value);
      })
      .catch((error) => notify(String(error), "error"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId, notify]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const toggleFollow = async () => {
    if (!profile) return;
    setBusy(true);
    try {
      if (profile.followed) {
        await api.unfollowEntity(profile.entityType, profile.entityId);
        setProfile({ ...profile, followed: false });
        notify("Ente rimosso dagli enti seguiti");
      } else {
        await api.followEntity(profile.entityType, profile.entityId, profile.name);
        setProfile({ ...profile, followed: true });
        notify("Ente seguito: riceverai le gare compatibili nel digest");
      }
      onFollowChanged();
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const distribution = useMemo(() => buildDistribution(profile), [profile]);
  const typeLabel = entityType === "supplier" ? "Impresa" : "Stazione appaltante";

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-[1px]" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex h-full w-[780px] max-w-[94vw] flex-col border-l border-line bg-white shadow-2xl focus:outline-none"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Profilo ${typeLabel.toLowerCase()}`}
      >
        <div className="shrink-0 border-b border-line px-6 pb-3 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded border border-cyan-200 bg-cyan-50 text-cyan-800">
                {entityType === "supplier" ? <IconUser size={19} /> : <IconBuilding size={19} />}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={entityType === "supplier" ? "blue" : "amber"}>{typeLabel}</Badge>
                  {profile?.followed && <Badge tone="green">seguito</Badge>}
                  {profile && profile.contracts === 0 && <Badge>nessun contratto</Badge>}
                </div>
                <h2 className="mt-1 text-[17px] font-semibold leading-snug text-heading">
                  {profile?.name ?? "Caricamento…"}
                </h2>
                <div className="mt-0.5 break-all font-mono text-[10px] text-slate-500">{entityId}</div>
              </div>
            </div>
            <button className="btn btn-ghost shrink-0 px-2 py-1" onClick={onClose} aria-label="Chiudi">
              <IconClose />
            </button>
          </div>

          {profile && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <button
                className={`btn px-2.5 py-1.5 text-[11.5px] ${profile.followed ? "" : "btn-primary"}`}
                onClick={toggleFollow}
                disabled={busy}
              >
                <IconStar size={12} /> {profile.followed ? "Non seguire più" : "Segui"}
              </button>
              <button
                className="btn px-2.5 py-1.5 text-[11.5px]"
                onClick={() => onPredict(profile.entityType, profile.entityId, profile.name)}
              >
                <IconSpark size={12} /> Gare come queste
              </button>
              <span className="ml-auto text-[10.5px] text-slate-500">
                {profile.firstAt ? `dal ${dateIt(profile.firstAt)}` : "nessun dato storico"}
                {profile.lastAt ? ` al ${dateIt(profile.lastAt)}` : ""}
              </span>
            </div>
          )}
        </div>

        {loading ? (
          <div className="p-6">
            <Spinner label="Carico il profilo…" />
          </div>
        ) : !profile ? (
          <div className="p-6">
            <Empty title="Profilo non disponibile" hint="L'ente non è presente nell'archivio locale." />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="grid grid-cols-4 gap-2">
              <Metric label="Contratti" value={num(profile.contracts)} />
              <Metric label="Valore aggiudicato" value={euroCompact(profile.totalValue)} />
              <Metric label="Ribasso medio" value={pct(profile.avgDiscount)} tone="accent" />
              <Metric label="Ribasso mediano" value={pct(profile.medianDiscount)} tone="accent" />
            </div>

            <section className="mt-4 rounded border border-line bg-white px-3 py-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  Distribuzione dei ribassi
                </h3>
                <span className="text-[10px] text-slate-500">
                  {profile.contracts} contratti · {distribution.samples} con ribasso
                </span>
              </div>
              {distribution.bins.length === 0 ? (
                <p className="mt-2 text-[11px] text-slate-500">
                  Non ci sono abbastanza ribassi pubblicati per costruire una distribuzione.
                </p>
              ) : (
                <>
                  <div className="mt-2 flex h-24 items-end gap-1.5">
                    {distribution.bins.map((bin) => {
                      const height =
                        distribution.maxCount > 0
                          ? Math.max(3, (bin.count / distribution.maxCount) * 88)
                          : 3;
                      return (
                        <div key={bin.label} className="flex flex-1 flex-col items-center gap-1">
                          <span className="text-[9px] tabular text-slate-500">{bin.count}</span>
                          <div
                            className="w-full rounded-t bg-cyan-700/75 hover:bg-cyan-700"
                            style={{ height }}
                            title={`${bin.label}: ${bin.count} contratti`}
                          />
                          <span className="text-[8.5px] tabular text-slate-500">{bin.label}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500">
                    <span>min {pct(profile.minDiscount)}</span>
                    <span>mediana {pct(profile.medianDiscount)}</span>
                    <span>media {pct(profile.avgDiscount)}</span>
                    <span>max {pct(profile.maxDiscount)}</span>
                  </div>
                </>
              )}
            </section>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <RankList
                title="Settori CPV"
                rows={profile.topCpv}
                empty="Nessun CPV registrato."
              />
              <RankList
                title="Regioni"
                rows={profile.topRegions}
                empty="Nessuna regione registrata."
              />
              <RankList
                title={entityType === "supplier" ? "Stazioni appaltanti" : "Imprese vincitrici"}
                rows={profile.topCounterparties}
                empty="Nessun controparte registrata."
                onOpen={
                  entityType === "supplier"
                    ? (key) => onOpenEntity("buyer", key)
                    : (key) => onOpenEntity("supplier", key)
                }
              />
            </div>

            <section className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  Gare aperte collegate
                </h3>
                <span className="text-[10px] text-slate-500">
                  {profile.openNotices.length} in archivio
                </span>
              </div>
              {profile.openNotices.length === 0 ? (
                <div className="rounded border border-dashed border-slate-300 px-3 py-5 text-center text-[11px] text-slate-500">
                  Nessuna gara aperta collegata a questo ente.
                </div>
              ) : (
                <div className="overflow-hidden rounded border border-line">
                  {profile.openNotices.map((notice) => {
                    const remaining = daysLeft(notice.deadlineAt);
                    return (
                      <button
                        key={notice.id}
                        onClick={() => onOpenNotice(notice.id)}
                        className="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-cyan-50/40"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium text-heading">
                            {notice.title}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                            <Badge tone={notice.source === "anac" ? "amber" : "blue"}>
                              {notice.source === "anac" ? "ANAC" : "TED"}
                            </Badge>
                            {notice.cig && <span className="font-mono">CIG {notice.cig}</span>}
                            {notice.region && <span>{notice.region}</span>}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="tabular text-[11.5px] text-slate-700">
                            {euro(notice.estimatedValue)}
                          </div>
                          {notice.deadlineAt && (
                            <div
                              className={`text-[10px] ${
                                remaining !== null && remaining >= 0 && remaining <= 7
                                  ? "font-semibold text-rose-700"
                                  : "text-slate-500"
                              }`}
                            >
                              {remaining !== null && remaining < 0
                                ? "scaduta"
                                : `scade ${dateIt(notice.deadlineAt)}`}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  Storico contratti
                </h3>
                <span className="text-[10px] text-slate-500">ultimi {profile.history.length}</span>
              </div>
              {profile.history.length === 0 ? (
                <div className="rounded border border-dashed border-slate-300 px-3 py-5 text-center text-[11px] text-slate-500">
                  Nessun contratto registrato per questo ente.
                </div>
              ) : (
                <div className="overflow-hidden rounded border border-line">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className="th w-[82px]">Data</th>
                        <th className="th">Gara</th>
                        <th className="th w-[120px] text-right">Importo</th>
                        <th className="th w-[78px] text-right">Ribasso</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profile.history.map((row) => (
                        <tr
                          key={row.id}
                          className="cursor-pointer border-t border-line hover:bg-cyan-50/40"
                          onClick={() => onOpenNotice(row.id)}
                        >
                          <td className="td text-[11px] text-slate-500">
                            {dateIt(row.publishedAt ?? row.deadlineAt)}
                          </td>
                          <td className="td">
                            <div className="line-clamp-2 text-[11.5px] text-slate-700">
                              {row.title}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9.5px] text-slate-500">
                              <Badge tone={row.source === "anac" ? "amber" : "blue"}>
                                {row.source === "anac" ? "ANAC" : "TED"}
                              </Badge>
                              <span>{[row.buyerName, row.region].filter(Boolean).join(" · ")}</span>
                              {row.suppliers.length > 0 && (
                                <span>
                                  ·{" "}
                                  {row.suppliers.length > 1
                                    ? `${truncate(row.suppliers[0], 34)} +${row.suppliers.length - 1}`
                                    : row.suppliers[0]}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="td text-right tabular text-[11px]">
                            {euro(row.awardedValue ?? row.estimatedValue)}
                          </td>
                          <td
                            className={`td text-right tabular text-[11px] ${
                              (row.discountPct ?? 0) >= 0 ? "text-emerald-700" : "text-rose-700"
                            }`}
                          >
                            {pct(row.discountPct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <p className="mt-4 text-[10px] leading-relaxed text-slate-500">
              I dati provengono da TED e ANAC. Per le imprese, lo storico considera le aggiudicazioni
              collegate al codice fiscale o all'identificativo della fonte; eventuali fusioni o
              raggruppamenti temporanei possono comparire come soggetti distinti.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "accent";
}) {
  return (
    <div className="rounded border border-line bg-slate-50/70 px-3 py-2">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-slate-500">{label}</div>
      <div
        className={`mt-0.5 tabular text-[15px] font-semibold ${
          tone === "accent" ? "text-cyan-900" : "text-heading"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function RankList({
  title,
  rows,
  empty,
  onOpen,
}: {
  title: string;
  rows: ProfileCount[];
  empty: string;
  onOpen?: (key: string) => void;
}) {
  const max = Math.max(...rows.map((row) => row.count), 1);
  return (
    <div className="rounded border border-line bg-white px-3 py-2.5">
      <h4 className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-slate-500">{title}</h4>
      {rows.length === 0 ? (
        <p className="mt-1.5 text-[10px] text-slate-500">{empty}</p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {rows.slice(0, 6).map((row) => {
            const clickable = Boolean(onOpen) && !row.key.includes(" ");
            const content = (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[10.5px] text-slate-700" title={row.label}>
                    {row.label}
                  </span>
                  <span className="shrink-0 tabular text-[9.5px] text-slate-500">{row.count}</span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-cyan-700/60"
                    style={{ width: `${(row.count / max) * 100}%` }}
                  />
                </div>
              </>
            );
            return clickable ? (
              <button
                key={row.key}
                className="block w-full text-left hover:opacity-80"
                onClick={() => onOpen?.(row.key)}
                title={`Apri il profilo di ${row.label}`}
              >
                {content}
              </button>
            ) : (
              <div key={row.key}>{content}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function buildDistribution(profile: EntityProfile | null): {
  bins: { label: string; count: number }[];
  maxCount: number;
  samples: number;
} {
  if (!profile) return { bins: [], maxCount: 0, samples: 0 };
  const values = profile.history
    .map((row) => row.discountPct)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length === 0) return { bins: [], maxCount: 0, samples: 0 };

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 0.01) {
    return {
      bins: [{ label: pct(min, 0), count: values.length }],
      maxCount: values.length,
      samples: values.length,
    };
  }

  const bucketCount = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / bucketCount;
  const bins = Array.from({ length: bucketCount }, (_, index) => {
    const lower = min + width * index;
    const upper = index === bucketCount - 1 ? max : min + width * (index + 1);
    return {
      label: `${lower.toFixed(0)}–${upper.toFixed(0)}%`,
      count: 0,
    };
  });
  for (const value of values) {
    const index = Math.min(bucketCount - 1, Math.floor((value - min) / width));
    bins[index].count += 1;
  }
  return {
    bins,
    maxCount: Math.max(...bins.map((bin) => bin.count), 1),
    samples: values.length,
  };
}
