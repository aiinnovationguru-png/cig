import { useMemo, useState } from 'react';
import type { Notice } from './types';

function key(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const weekdays = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
export default function Calendar({ rows, open }: { rows: Notice[]; open: (notice: Notice) => void }) {
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const year = month.getFullYear(), monthIndex = month.getMonth();
  const label = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(month);
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const monthRows = useMemo(() => rows.filter(r => r.deadline?.startsWith(key(year, monthIndex, 1).slice(0, 7))).sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? '') || a.title.localeCompare(b.title, 'it')), [rows, year, monthIndex]);
  const byDate = useMemo(() => {
    const result = new Map<string, Notice[]>();
    monthRows.forEach(row => { if (row.deadline) result.set(row.deadline, [...(result.get(row.deadline) ?? []), row]); });
    return result;
  }, [monthRows]);
  const move = (n: number) => setMonth(new Date(year, monthIndex + n, 1));
  return <section aria-label="Calendario scadenze" className="rounded-md border border-slate-200 bg-white p-4 sm:p-5">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold capitalize text-slate-800">{label}</h2><p className="mt-1 text-xs text-slate-400">{monthRows.length} scadenze nelle gare filtrate</p></div><div className="flex gap-2"><button className="btn" onClick={() => move(-1)} aria-label="Mese precedente">←</button><button className="btn" onClick={() => { const now = new Date(); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); }}>Oggi</button><button className="btn" onClick={() => move(1)} aria-label="Mese successivo">→</button></div></div>
    <div className="grid grid-cols-7 border-l border-t border-slate-200">{weekdays.map(day => <div key={day} className="border-b border-r border-slate-200 bg-slate-50 py-2 text-center text-[10px] font-semibold uppercase text-slate-500">{day}</div>)}{Array.from({ length: Math.ceil((offset + days) / 7) * 7 }, (_, i) => {
      const day = i - offset + 1, valid = day > 0 && day <= days;
      const events = valid ? byDate.get(key(year, monthIndex, day)) ?? [] : [];
      return <div key={i} className={`min-h-16 border-b border-r border-slate-200 p-1 sm:min-h-24 sm:p-2 ${valid ? '' : 'bg-slate-50/80'}`}>
        {valid && <><span className="text-[11px] font-medium text-slate-500">{day}</span>{events.length > 0 && <><span className="ml-1 rounded bg-cyan-50 px-1 text-[10px] text-cyan-800 sm:hidden">{events.length}</span><div className="mt-1 hidden space-y-1 sm:block">{events.slice(0, 2).map(event => <button key={event.id} onClick={() => open(event)} className="block w-full truncate rounded bg-cyan-50 px-1.5 py-1 text-left text-[10px] text-cyan-900 hover:bg-cyan-100" title={event.title}>{event.title}</button>)}{events.length > 2 && <span className="text-[10px] text-slate-400">+{events.length - 2}</span>}</div></>}</>}
      </div>;
    })}</div>
    <div className="mt-5"><h3 className="text-xs font-semibold text-slate-700">Elenco scadenze del mese</h3>{monthRows.length === 0 ? <p className="mt-2 text-xs text-slate-400">Nessuna scadenza per questo mese.</p> : <ul className="mt-2 divide-y divide-slate-100">{monthRows.map(row => <li key={row.id} className="flex gap-3 py-2 text-xs"><span className="w-24 shrink-0 text-slate-500">{row.deadline?.split('-').reverse().join('/')}</span><button className="text-left font-medium text-cyan-800 hover:underline" onClick={() => open(row)}>{row.title}</button></li>)}</ul>}</div>
  </section>;
}
