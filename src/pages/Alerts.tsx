import { useCallback, useEffect, useState } from "react";
import {
  api,
  type Digest,
  type EntityType,
  type FollowedEntity,
  type SavedSearch,
  type Settings,
} from "../api";
import type { View } from "../store/cigStore";
import { dateIt, dateTimeIt, pct, truncate } from "../lib/format";
import { Badge, Empty, Modal, Spinner } from "../components/ui";
import {
  IconBell,
  IconBuilding,
  IconSpark,
  IconTrash,
  IconUser,
} from "../components/icons";

export default function AlertsPage({
  notify,
  onNavigate,
  onOpenEntity,
  onFollowChanged,
}: {
  notify: (message: string, tone?: "info" | "error") => void;
  onNavigate: (view: View) => void;
  onOpenEntity: (entityType: EntityType, entityId: string) => void;
  onFollowChanged: () => void;
}) {
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const [entities, setEntities] = useState<FollowedEntity[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{ digest: Digest; searchId: number | null } | null>(null);
  const [busy, setBusy] = useState<number | "all" | "preview" | null>(null);
  const [sendingAll, setSendingAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, config, followed] = await Promise.all([
        api.savedSearches(),
        api.getSettings(),
        api.listFollowedEntities(),
      ]);
      setSearches(list);
      setSettings(config);
      setEntities(followed);
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const smtpReady =
    Boolean(settings?.smtpHost) &&
    Boolean(settings?.smtpFrom) &&
    Boolean(settings?.alertRecipient);

  const toggle = async (search: SavedSearch) => {
    try {
      await api.setSavedSearchActive(search.id, !search.active);
      setSearches((previous) =>
        previous.map((item) =>
          item.id === search.id ? { ...item, active: !item.active } : item,
        ),
      );
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const remove = async (search: SavedSearch) => {
    if (!window.confirm(`Eliminare la ricerca «${search.name}»?`)) return;
    try {
      await api.deleteSavedSearch(search.id);
      setSearches((previous) => previous.filter((item) => item.id !== search.id));
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const unfollow = async (entity: FollowedEntity) => {
    if (!window.confirm(`Smettere di seguire «${entity.name}»?`)) return;
    try {
      await api.unfollowEntity(entity.entityType, entity.entityId);
      setEntities((previous) =>
        previous.filter(
          (item) =>
            !(item.entityType === entity.entityType && item.entityId === entity.entityId),
        ),
      );
      onFollowChanged();
      notify("Ente rimosso dagli enti seguiti");
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const updateEntity = async (
    entity: FollowedEntity,
    changes: { minSimilarity?: number; active?: boolean },
  ) => {
    try {
      await api.updateFollowedEntity(
        entity.entityType,
        entity.entityId,
        changes.minSimilarity,
        changes.active,
      );
      setEntities((previous) =>
        previous.map((item) =>
          item.entityType === entity.entityType && item.entityId === entity.entityId
            ? { ...item, ...changes }
            : item,
        ),
      );
      onFollowChanged();
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const openPreview = async (search?: SavedSearch) => {
    setBusy(search ? search.id : "preview");
    try {
      const digest = await api.previewDigest(search?.id);
      if (!digest) {
        notify(
          search
            ? "Nessun nuovo avviso per questa ricerca nella finestra del digest."
            : "Nessun nuovo avviso: il digest non verrebbe inviato.",
        );
        return;
      }
      setPreview({ digest, searchId: search?.id ?? null });
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const handleReport = (report: {
    sent: boolean;
    skipped: boolean;
    notices: number;
    sections: number;
    recipient: string | null;
    error: string | null;
  }) => {
    if (report.error) notify(report.error, "error");
    else if (report.skipped) notify("Nessun nuovo avviso: il digest non è stato inviato.");
    else if (report.sent)
      notify(
        `Digest inviato a ${report.recipient}: ${report.notices} gare in ${report.sections} sezioni`,
      );
    else notify("Invio non riuscito: controlla la configurazione SMTP.", "error");
  };

  const send = async (search?: SavedSearch) => {
    setBusy(search ? search.id : "all");
    try {
      const report = await api.sendDigest(search?.id);
      handleReport(report);
      await load();
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const sendAll = async () => {
    setSendingAll(true);
    try {
      const report = await api.sendDigest();
      handleReport(report);
      await load();
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setSendingAll(false);
    }
  };

  const activeSearches = searches.filter((search) => search.active).length;
  const activeEntities = entities.filter((entity) => entity.active).length;
  const totalSections = activeSearches + activeEntities;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-white px-6 py-2.5">
        <p className="text-[11.5px] text-muted">
          Una email al giorno con le gare delle ricerche salvate e degli enti seguiti.
        </p>
        <div className="flex items-center gap-1.5">
          <button
            className="btn px-2.5 py-1.5 text-[11.5px]"
            onClick={() => void openPreview()}
            disabled={busy === "preview" || totalSections === 0}
          >
            <IconBell size={12} /> {busy === "preview" ? "Preparo…" : "Anteprima digest"}
          </button>
          <button
            className="btn btn-primary px-3 py-1.5 text-[11.5px]"
            onClick={sendAll}
            disabled={sendingAll || totalSections === 0}
          >
            {sendingAll ? "Invio…" : "Invia digest ora"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-page px-6 py-4">
        {!smtpReady && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded border border-amber-300 bg-amber-50 px-3.5 py-2.5">
            <div className="text-[12px] text-amber-900">
              SMTP non configurato: le email non possono partire. Puoi comunque vedere l'anteprima.
            </div>
            <button className="btn px-2.5 py-1 text-[11px]" onClick={() => onNavigate("impostazioni")}>
              Configura SMTP
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="card px-4 py-3">
            <div className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-slate-500">
              Ricerche attive
            </div>
            <div className="mt-1 tabular text-[20px] font-bold text-heading">{activeSearches}</div>
            <div className="text-[10.5px] text-slate-500">{searches.length} salvate in totale</div>
          </div>
          <div className="card px-4 py-3">
            <div className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-slate-500">
              Enti seguiti
            </div>
            <div className="mt-1 tabular text-[20px] font-bold text-heading">{entities.length}</div>
            <div className="text-[10.5px] text-slate-500">
              {activeEntities} attivi · imprese e stazioni appaltanti
            </div>
          </div>
          <div className="card px-4 py-3">
            <div className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-slate-500">
              Prossimo digest
            </div>
            <div className="mt-1 text-[20px] font-bold text-heading">
              {String(settings?.alertHour ?? 7).padStart(2, "0")}:00
            </div>
            <div className="text-[10.5px] text-slate-500">
              ultimi {settings?.digestDays ?? 1} giorni · max {settings?.digestMaxNotices ?? 12} gare
            </div>
          </div>
        </div>

        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
              Ricerche salvate
            </h2>
            <button
              className="text-[10.5px] text-cyan-800 hover:underline"
              onClick={() => onNavigate("ricerca")}
            >
              Crea una ricerca
            </button>
          </div>

          {loading ? (
            <div className="card p-5">
              <Spinner label="Carico ricerche ed enti…" />
            </div>
          ) : searches.length === 0 ? (
            <Empty
              title="Nessuna ricerca salvata"
              hint="Dalla pagina di ricerca, premi «Salva ricerca»: qui decidi quando e come riceverla via email."
              action={
                <button className="btn" onClick={() => onNavigate("ricerca")}>
                  Vai alla ricerca
                </button>
              }
            />
          ) : (
            <div className="overflow-hidden rounded border border-line bg-white">
              {searches.map((search) => (
                <div key={search.id} className="border-b border-line px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-heading">{search.name}</span>
                        <Badge tone={search.active ? "green" : "neutral"}>
                          {search.active ? "attiva" : "sospesa"}
                        </Badge>
                        {!search.hasEmbedding && search.query && (
                          <Badge tone="amber">senza vettore</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11.5px] text-slate-600">
                        «{truncate(search.query || "solo filtri", 110)}»
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                        <span>soglia {pct(search.minSimilarity * 100, 0)}</span>
                        <span>
                          {search.filters.source
                            ? `fonte ${search.filters.source.toUpperCase()}`
                            : "tutte le fonti"}
                          {search.filters.region ? ` · ${search.filters.region}` : ""}
                          {search.filters.cpvPrefix ? ` · CPV ${search.filters.cpvPrefix}` : ""}
                          {search.filters.kind ? ` · ${search.filters.kind}` : ""}
                        </span>
                        <span>
                          ultimo invio: {search.lastRunAt ? dateTimeIt(search.lastRunAt) : "mai"}
                        </span>
                        <span>creata {dateIt(search.createdAt)}</span>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      <button
                        className="btn btn-ghost px-2 py-1 text-[10.5px]"
                        onClick={() => void openPreview(search)}
                        disabled={busy === search.id}
                      >
                        <IconBell size={11} /> Anteprima
                      </button>
                      <button
                        className="btn px-2 py-1 text-[10.5px]"
                        onClick={() => void send(search)}
                        disabled={busy === search.id || !smtpReady}
                        title="Invia solo questa ricerca"
                      >
                        {busy === search.id ? "…" : "Invia solo questa"}
                      </button>
                      <button
                        className="btn btn-ghost px-2 py-1 text-[10.5px]"
                        onClick={() => void toggle(search)}
                        aria-pressed={search.active}
                      >
                        {search.active ? "Sospendi" : "Attiva"}
                      </button>
                      <button
                        className="btn btn-ghost px-1.5 py-1 text-slate-500 hover:text-rose-700"
                        onClick={() => void remove(search)}
                        aria-label={`Elimina ${search.name}`}
                      >
                        <IconTrash size={11} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
              Enti seguiti
            </h2>
            <span className="text-[10px] text-slate-500">
              le gare compatibili entrano nel digest
            </span>
          </div>

          {entities.length === 0 ? (
            <div className="rounded border border-dashed border-slate-300 bg-white px-4 py-5 text-center">
              <div className="text-[12px] font-medium text-slate-700">Nessun ente seguito</div>
              <p className="mx-auto mt-1 max-w-xl text-[11px] leading-relaxed text-slate-500">
                Apri il profilo di un'impresa o di una stazione appaltante da una scheda gara e premi
                «Segui». Le nuove gare compatibili con il suo storico compariranno nel digest.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded border border-line bg-white">
              {entities.map((entity) => (
                <div
                  key={`${entity.entityType}-${entity.entityId}`}
                  className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 bg-slate-50 text-slate-600">
                    {entity.entityType === "supplier" ? <IconUser size={14} /> : <IconBuilding size={14} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <button
                      className="truncate text-[12.5px] font-semibold text-heading hover:text-cyan-800 hover:underline"
                      onClick={() => onOpenEntity(entity.entityType, entity.entityId)}
                    >
                      {entity.name}
                    </button>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                      <Badge tone={entity.entityType === "supplier" ? "blue" : "amber"}>
                        {entity.entityType === "supplier" ? "impresa" : "stazione appaltante"}
                      </Badge>
                      <Badge tone={entity.active ? "green" : "neutral"}>
                        {entity.active ? "attivo" : "sospeso"}
                      </Badge>
                      <span>{entity.openNotices} gare aperte compatibili</span>
                      <span>· seguito dal {dateIt(entity.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <label className="flex items-center gap-1 text-[10px] text-slate-500">
                      soglia
                      <select
                        className="rounded border border-line bg-white px-1 py-0.5 text-[10px] text-slate-700"
                        value={Math.round(entity.minSimilarity * 100)}
                        onChange={(event) =>
                          void updateEntity(entity, {
                            minSimilarity: Number(event.target.value) / 100,
                          })
                        }
                        aria-label={`Soglia di affinità per ${entity.name}`}
                      >
                        {[40, 50, 60, 70, 75, 80, 85, 90].map((value) => (
                          <option key={value} value={value}>
                            {value}%
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="btn btn-ghost px-2 py-1 text-[10.5px]"
                      onClick={() => void updateEntity(entity, { active: !entity.active })}
                      aria-pressed={entity.active}
                    >
                      {entity.active ? "Sospendi" : "Attiva"}
                    </button>
                    <button
                      className="btn btn-ghost px-2 py-1 text-[10.5px]"
                      onClick={() => onOpenEntity(entity.entityType, entity.entityId)}
                    >
                      Profilo
                    </button>
                    <button
                      className="btn btn-ghost px-2 py-1 text-[10.5px] text-slate-500 hover:text-rose-700"
                      onClick={() => void unfollow(entity)}
                      aria-label={`Non seguire più ${entity.name}`}
                    >
                      Non seguire
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="mt-4 rounded border border-line bg-white px-4 py-3 text-[11px] leading-relaxed text-slate-600">
          <div className="flex items-start gap-2">
            <IconSpark size={13} className="mt-0.5 shrink-0 text-cyan-800" />
            <p>
              Il digest parte ogni giorno alle ore {String(settings?.alertHour ?? 7).padStart(2, "0")}
              :00, considera gli avvisi pubblicati negli ultimi {settings?.digestDays ?? 1} giorni e
              unisce ricerche ed enti in un solo messaggio. Le gare già presenti in una sezione non
              vengono ripetute nelle altre; il totale è limitato a{" "}
              {settings?.digestMaxNotices ?? 12} gare. Se non c'è nulla di nuovo, non parte alcuna
              email.
            </p>
          </div>
        </div>
      </div>

      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview ? `Anteprima · ${preview.digest.subject}` : "Anteprima"}
        width="max-w-3xl"
      >
        {preview && (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span>
                {preview.digest.total} gare · {preview.digest.sections.length} sezioni
              </span>
              <span className="text-slate-400">·</span>
              <span>
                {preview.searchId
                  ? "solo questa ricerca"
                  : "tutte le ricerche attive e gli enti seguiti"}
              </span>
            </div>

            <div className="mb-2 max-h-32 space-y-1 overflow-y-auto rounded border border-line bg-slate-50 px-3 py-2">
              {preview.digest.sections.map((section) => (
                <div key={`${section.kind}-${section.id}`} className="flex items-baseline justify-between gap-2 text-[10.5px]">
                  <span className="min-w-0 truncate text-slate-700">
                    <span className="font-semibold">{section.name}</span>
                    {section.detail ? ` · ${section.detail}` : ""}
                  </span>
                  <span className="shrink-0 text-slate-500">{section.notices.length}</span>
                </div>
              ))}
            </div>

            <iframe
              title="Anteprima email"
              srcDoc={preview.digest.html}
              className="h-[430px] w-full rounded border border-line bg-white"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn" onClick={() => setPreview(null)}>
                Chiudi
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const searchId = preview.searchId;
                  setPreview(null);
                  if (searchId) {
                    const search = searches.find((item) => item.id === searchId);
                    if (search) void send(search);
                  } else {
                    void sendAll();
                  }
                }}
                disabled={!smtpReady}
              >
                {preview.searchId ? "Invia questa ricerca" : "Invia questo digest"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
