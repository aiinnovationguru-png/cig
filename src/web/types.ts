export type Stage = 'valutare' | 'preparare' | 'presentato' | 'vinto' | 'perso';
export type Notice = {
  id: string; title: string; buyer: string; region: string; cig: string;
  deadline: string | null; estimated_value: number | null; source: string;
  stage: Stage | null; notes: string; created_at: string; updated_at: string;
  external_id?: string | null; official_url?: string | null; description?: string; cpv?: string; published_on?: string | null;
};
export const stages: { key: Stage; label: string; color: string }[] = [
  { key: 'valutare', label: 'Da valutare', color: 'bg-amber-400' },
  { key: 'preparare', label: 'In preparazione', color: 'bg-blue-400' },
  { key: 'presentato', label: 'Presentate', color: 'bg-violet-400' },
  { key: 'vinto', label: 'Vinte', color: 'bg-emerald-500' },
  { key: 'perso', label: 'Perse', color: 'bg-slate-400' },
];
