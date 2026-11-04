import { useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { IconSearch, IconPlus } from '../components/icons';

export type TedNotice = {
  external_id: string; title: string; buyer: string; region: string; cig: string;
  deadline: string | null; estimated_value: number | null; source: 'ted';
  description: string; cpv: string; published_on: string | null; official_url: string;
};
type SearchResult = { notices: TedNotice[]; total: number | null; page: number; days: number };
const displayDate = (date: string | null) => date ? date.split('-').reverse().join('/') : 'Non indicata';
const displayMoney = (value: number | null) => value == null ? 'Non indicato in EUR' : new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
async function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'context' in error && error.context instanceof Response) {
    try { const body = await error.context.clone().json(); if (typeof body.error === 'string') return body.error; } catch { /* fallback */ }
  }
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Ricerca non disponibile.';
}
export default function TedSearch({ session, onLogin, onSave, savedIds }: { session: Session | null; onLogin: () => void; onSave: (row: TedNotice) => Promise<void>; savedIds: Set<string> }) {
  const [days, setDays] = useState(30);
  const [cpv, setCpv] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [requested, setRequested] = useState<{ days: number; cpv: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const search = async (page = 1, params = { days, cpv }) => {
    if (!supabase || !session) return;
    if (!/^\d{0,8}$/.test(params.cpv)) { setError('Il CPV deve contenere fino a 8 cifre.'); return; }
    setLoading(true); setError(''); setFeedback('');
    try {
      const { data, error } = await supabase.functions.invoke('cig-ted-search', { body: { ...params, page } });
      if (error) throw error;
      if (!data || !Array.isArray(data.notices)) throw new Error('Risposta TED non riconosciuta.');
      setResult(data as SearchResult); setRequested(params);
    } catch (e) { setError(await errorMessage(e)); }
    finally { setLoading(false); }
  };
  const save = async (row: TedNotice) => {
    setSaving(row.external_id); setError(''); setFeedback('');
    try { await onSave(row); setFeedback('Gara aggiunta al tuo archivio personale.'); }
    catch (e) { setError(await errorMessage(e)); }
    finally { setSaving(null); }
  };
  if (!session) return <div className="rounded-md border border-slate-200 bg-white p-6"><h2 className="text-base font-semibold text-slate-800">Ricerca sugli avvisi TED</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">Accedi per interrogare la fonte ufficiale europea e salvare le gare nel tuo archivio personale. I risultati sono separati dai dati fittizi della demo.</p><button className="btn btn-primary mt-4" onClick={onLogin}>Accedi</button></div>;
  return <div className="space-y-4">
    <div className="rounded-md border border-cyan-200 bg-cyan-50 px-4 py-3 text-xs leading-relaxed text-cyan-900"><strong>Fonte ufficiale TED.</strong> Cerca avvisi di gara italiani pubblicati negli ultimi 90 giorni. La ricerca è limitata a 25 risultati per pagina e alle prime 20 pagine; non include ANAC né sostituisce la verifica dell’avviso ufficiale.</div>
    <form className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-4" onSubmit={e => { e.preventDefault(); void search(); }}>
      <label><span className="label">Pubblicate negli ultimi</span><select className="input h-10 min-w-40" value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>7 giorni</option><option value={30}>30 giorni</option><option value={60}>60 giorni</option><option value={90}>90 giorni</option></select></label>
      <label><span className="label">Prefisso CPV (facoltativo)</span><input className="input h-10" inputMode="numeric" pattern="[0-9]{0,8}" maxLength={8} value={cpv} onChange={e => setCpv(e.target.value)} placeholder="Es. 45"/></label>
      <button className="btn btn-primary h-10" type="submit" disabled={loading}><IconSearch size={15}/>{loading ? 'Ricerca in corso…' : 'Cerca su TED'}</button>
    </form>
    {(error || feedback) && <div role="status" className={`rounded border px-4 py-3 text-xs ${error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{error || feedback}</div>}
    {!result ? <div className="rounded-md border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">Avvia una ricerca per vedere gli avvisi TED.</div> : <section className="rounded-md border border-slate-200 bg-white"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-4"><div><h2 className="text-sm font-semibold text-slate-800">Avvisi TED · pagina {result.page}</h2><p className="mt-1 text-xs text-slate-400">{result.total == null ? 'Totale non fornito' : `${result.total.toLocaleString('it-IT')} risultati dichiarati da TED`} · ultimi {result.days} giorni</p></div><div className="flex gap-2"><button className="btn text-xs" disabled={loading || result.page <= 1} onClick={() => requested && void search(result.page - 1, requested)}>← Precedente</button><button className="btn text-xs" disabled={loading || result.page >= 20 || result.notices.length === 0 || (result.total !== null && result.page * 25 >= result.total)} onClick={() => requested && void search(result.page + 1, requested)}>Successiva →</button></div></div>
      {result.notices.length === 0 ? <p className="p-8 text-center text-sm text-slate-400">Nessun avviso valido in questa pagina.</p> : <div className="divide-y divide-slate-100">{result.notices.map(row => <article key={row.external_id} className="space-y-2 p-4"><div className="flex flex-wrap justify-between gap-3"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-slate-800">{row.title}</h3><p className="mt-1 text-xs text-slate-500">{row.buyer || 'Ente non indicato'} · TED {row.external_id}{row.cig && ` · CIG ${row.cig}`}</p></div><button className="btn h-9 text-xs" disabled={!!saving || savedIds.has(row.external_id)} onClick={() => void save(row)}><IconPlus size={14}/>{savedIds.has(row.external_id) ? 'Già in archivio' : saving === row.external_id ? 'Salvataggio…' : 'Aggiungi all’archivio'}</button></div><div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500"><span>Pubblicazione: {displayDate(row.published_on)}</span><span>Scadenza: {displayDate(row.deadline)}</span><span>Importo: {displayMoney(row.estimated_value)}</span>{row.cpv && <span>CPV: {row.cpv}</span>}</div><a href={row.official_url} target="_blank" rel="noopener noreferrer" className="inline-block text-xs font-semibold text-cyan-800 underline">Apri l’avviso ufficiale TED ↗</a></article>)}</div>}
    </section>}
  </div>;
}
