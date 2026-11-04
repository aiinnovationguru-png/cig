import { type Stats } from '../../api';
import { type View } from '../../store/cigStore';
import {
  IconBell,
  IconBoard,
  IconChart,
  IconDatabase,
  IconDoc,
  IconGear,
  IconSearch,
} from '../icons';

type Item = { id: View; label: string; icon: typeof IconSearch; hint: string };

const WORK: Item[] = [
  { id: 'ricerca', label: 'Cerca gare', icon: IconSearch, hint: 'Ricerca e previsioni' },
  { id: 'bacheca', label: 'Le mie gare', icon: IconBoard, hint: 'Bacheca e scadenze' },
  { id: 'intelligence', label: 'Aggiudicazioni', icon: IconChart, hint: 'Chi vince e a quanto' },
  { id: 'valutazione', label: 'Valuta relazione', icon: IconDoc, hint: 'Copertura dei criteri' },
  { id: 'alert', label: 'Avvisi email', icon: IconBell, hint: 'Ricerche ed enti seguiti' },
];

const TOOLS: Item[] = [
  { id: 'dati', label: 'Archivio dati', icon: IconDatabase, hint: 'Download e similarità' },
  { id: 'impostazioni', label: 'Impostazioni', icon: IconGear, hint: 'Email e preferenze' },
  { id: 'api-esterni', label: 'API esterni', icon: IconSearch, hint: 'Siti esterni e operazioni' },
];

export default function Nav({
  view,
  onNavigate,
  stats,
}: {
  view: View;
  onNavigate: (view: View) => void;
  stats: Stats | null;
}) {
  const counts: Partial<Record<View, number>> = {
    bacheca: stats?.boardItems ?? 0,
    alert: stats?.followed ?? 0,
  };

  const renderItem = (item: Item) => {
    const Icon = item.icon;
    const active = view === item.id;
    const count = counts[item.id] ?? 0;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => onNavigate(item.id)}
        aria-current={active ? 'page' : undefined}
        title={item.hint}
        className={`nav-item flex w-full items-center gap-2.5 border-l-2 border-transparent px-2.5 py-2 text-left text-[12.5px] transition-colors ${
          active
            ? 'nav-item-active font-semibold'
            : 'text-slate-600 hover:bg-slate-100 hover:text-heading'
        }`}
      >
        <Icon size={15} className={active ? 'shrink-0 text-cyan-800' : 'shrink-0 text-slate-500'} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {count > 0 && (
          <span className="tabular shrink-0 rounded-sm border border-line bg-white px-1 text-[9.5px] font-semibold text-slate-600">
            {count}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className="app-sidebar flex h-full w-[228px] shrink-0 flex-col" aria-label="Navigazione principale">
      <div className="border-b border-line px-4 py-4">
        <div className="flex items-center gap-2.5">
          <div className="brand-mark flex h-9 w-9 shrink-0 items-center justify-center text-[14px] font-bold text-white">
            CIG
          </div>
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-semibold leading-tight text-heading">
              Intelligence appalti
            </div>
            <div className="truncate text-[10.5px] leading-tight text-muted">Gare pubbliche italiane</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Sezioni">
        <div className="px-2 pb-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500">
          Lavoro
        </div>
        {WORK.map(renderItem)}
        <div className="px-2 pb-1.5 pt-4 text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500">
          Strumenti
        </div>
        {TOOLS.map(renderItem)}
      </nav>

      <div className="border-t border-line px-4 py-3">
        <div className="text-[10px] leading-relaxed text-muted">
          Dati e modello restano su questo computer. Nessun account richiesto.
        </div>
      </div>
    </aside>
  );
}
