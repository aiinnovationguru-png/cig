import { type EntityType, type SearchSeed, type Stats } from '../../api';
import { type View } from '../../store/cigStore';
import AlertsPage from '../../pages/Alerts';
import ApiSitesPage from '../../pages/ApiSites';
import BoardPage from '../../pages/Board';
import DataPage from '../../pages/Data';
import EvaluationPage from '../../pages/Evaluation';
import IntelPage from '../../pages/Intel';
import SearchPage from '../../pages/Search';
import SettingsPage from '../../pages/Settings';

export interface PageProps {
  view: View;
  stats: Stats | null;
  seed: SearchSeed | null;
  signalVersion: number;
  followedVersion: number;
  notify: (message: string, tone?: 'info' | 'error') => void;
  onNavigate: (view: View) => void;
  onOpenNotice: (id: string) => void;
  onOpenEntity: (entityType: EntityType, entityId: string) => void;
  onStatsChanged: () => void;
  onSignalChanged: () => void;
  onFollowChanged: () => void;
  onSeedApplied: () => void;
}

export default function PageRouter(props: PageProps) {
  const {
    view,
    stats,
    seed,
    signalVersion,
    followedVersion,
    notify,
    onNavigate,
    onOpenNotice,
    onOpenEntity,
    onStatsChanged,
    onSignalChanged,
    onFollowChanged,
    onSeedApplied,
  } = props;

  switch (view) {
    case 'ricerca':
      return (
        <SearchPage
          onOpen={onOpenNotice}
          onOpenEntity={onOpenEntity}
          notify={notify}
          onStatsChanged={onStatsChanged}
          onSignalChanged={onSignalChanged}
          signalVersion={signalVersion}
          followedVersion={followedVersion}
          seed={seed}
          onSeedApplied={onSeedApplied}
        />
      );
    case 'bacheca':
      return <BoardPage onOpen={onOpenNotice} notify={notify} onStatsChanged={onStatsChanged} />;
    case 'intelligence':
      return <IntelPage onOpen={onOpenNotice} onOpenEntity={onOpenEntity} />;
    case 'valutazione':
      return <EvaluationPage notify={notify} />;
    case 'alert':
      return (
        <AlertsPage
          notify={notify}
          onNavigate={onNavigate}
          onOpenEntity={onOpenEntity}
          onFollowChanged={onFollowChanged}
        />
      );
    case 'dati':
      return <DataPage notify={notify} onStatsChanged={onStatsChanged} stats={stats} />;
    case 'impostazioni':
      return <SettingsPage notify={notify} />;
    case 'api-esterni':
      return <ApiSitesPage notify={notify} />;
    default:
      return null;
  }
}
