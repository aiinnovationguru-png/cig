import { useCallback, useEffect, useState } from 'react';
import { api, type EntityType, type SearchSeed, type Stats } from '../../api';
import { useCigStore, type View } from '../../store/cigStore';
import { num } from '../../lib/format';
import EntityDrawer from '../EntityDrawer';
import NoticeDrawer from '../NoticeDrawer';
import Nav from './Nav';
import PageRouter from './PageRouter';
import { Toast } from './Toast';

const VIEW_TITLES: Record<View, { title: string; hint: string }> = {
  ricerca: { title: 'Cerca gare', hint: 'Ricerca per significato, filtri e previsioni' },
  bacheca: { title: 'Le mie gare', hint: 'Bacheca, calendario delle scadenze' },
  intelligence: { title: 'Analisi aggiudicazioni', hint: 'Vincitori, ribassi e settori' },
  valutazione: { title: 'Valuta relazione', hint: 'Copertura dei criteri con evidenze' },
  alert: { title: 'Avvisi email', hint: 'Digest di ricerche salvate ed enti seguiti' },
  dati: { title: 'Archivio dati', hint: 'Download TED/ANAC, embedding e ingest' },
  impostazioni: { title: 'Impostazioni', hint: 'SMTP, embedding e preferenze' },
  'api-esterni': { title: 'API esterni', hint: 'Siti esterni e operazioni' },
};

export default function Layout() {
  const { view, setView, setToast } = useCigStore();
  const [stats, setStats] = useState<Stats | null>(null);
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [entity, setEntity] = useState<{ entityType: EntityType; entityId: string } | null>(null);
  const [seed, setSeed] = useState<SearchSeed | null>(null);
  const [signalVersion, setSignalVersion] = useState(0);
  const [followedVersion, setFollowedVersion] = useState(0);

  const notify = useCallback(
    (message: string, tone: 'info' | 'error' = 'info') => setToast({ message, tone }),
    [setToast],
  );

  const refreshStats = useCallback(async () => {
    try {
      setStats(await api.stats());
    } catch {
      // Il database può essere ancora in apertura: lo stato arriva al prossimo giro.
    }
  }, []);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  const onSignalChanged = useCallback(() => {
    setSignalVersion((value) => value + 1);
    void refreshStats();
  }, [refreshStats]);

  const onFollowChanged = useCallback(() => {
    setFollowedVersion((value) => value + 1);
    void refreshStats();
  }, [refreshStats]);

  const openEntity = useCallback((entityType: EntityType, entityId: string) => {
    setEntity({ entityType, entityId });
  }, []);

  const predictFromNotice = useCallback(
    (notice: { id: string; title: string }) => {
      setNoticeId(null);
      setEntity(null);
      setSeed({ kind: 'notice', noticeId: notice.id, title: notice.title });
      setView('ricerca');
    },
    [setView],
  );

  const predictFromEntity = useCallback(
    (entityType: EntityType, entityId: string, name: string) => {
      setEntity(null);
      setNoticeId(null);
      setSeed({ kind: 'entity', entityType, entityId, name });
      setView('ricerca');
    },
    [setView],
  );

  const heading = VIEW_TITLES[view];

  return (
    <div className="app-shell flex h-screen w-screen overflow-hidden bg-page text-copy">
      <Nav view={view} onNavigate={setView} stats={stats} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="app-topbar flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line bg-white px-6 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold leading-tight text-heading">{heading.title}</h1>
            <p className="truncate text-[10.5px] leading-tight text-muted">{heading.hint}</p>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-3 text-[10.5px] text-slate-600">
              <span>
                Archivio <span className="tabular font-semibold text-heading">{stats ? num(stats.notices) : '—'}</span>
              </span>
              <span className="text-slate-300">|</span>
              <span>
                Vettorizzati{' '}
                <span className="tabular font-semibold text-heading">{stats ? num(stats.embedded) : '—'}</span>
              </span>
              <span className="text-slate-300">|</span>
              <span>
                Seguiti{' '}
                <span className="tabular font-semibold text-heading">{stats ? num(stats.followed) : '—'}</span>
              </span>
            </div>
            {view !== 'dati' && (
              <button
                type="button"
                className="btn px-2.5 py-1 text-[11.5px]"
                onClick={() => setView('dati')}
                title="Apri l'archivio per scaricare nuovi bandi o calcolare la similarità"
              >
                Aggiorna archivio
              </button>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          <PageRouter
            view={view}
            stats={stats}
            seed={seed}
            signalVersion={signalVersion}
            followedVersion={followedVersion}
            notify={notify}
            onNavigate={setView}
            onOpenNotice={setNoticeId}
            onOpenEntity={openEntity}
            onStatsChanged={refreshStats}
            onSignalChanged={onSignalChanged}
            onFollowChanged={onFollowChanged}
            onSeedApplied={() => setSeed(null)}
          />
        </main>
      </div>

      {noticeId && (
        <NoticeDrawer
          id={noticeId}
          onClose={() => setNoticeId(null)}
          onOpen={setNoticeId}
          onOpenEntity={openEntity}
          onPredictNotice={predictFromNotice}
          notify={notify}
          onStatsChanged={refreshStats}
          onSignalChanged={onSignalChanged}
          onFollowChanged={onFollowChanged}
        />
      )}

      {entity && (
        <EntityDrawer
          entityType={entity.entityType}
          entityId={entity.entityId}
          onClose={() => setEntity(null)}
          onOpenNotice={(id) => {
            setEntity(null);
            setNoticeId(id);
          }}
          onOpenEntity={(entityType, entityId) => setEntity({ entityType, entityId })}
          onPredict={predictFromEntity}
          onFollowChanged={onFollowChanged}
          notify={notify}
        />
      )}

      <Toast />
    </div>
  );
}
