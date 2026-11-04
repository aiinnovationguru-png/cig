import { useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { evaluate, type Criterion } from './evaluation';

interface SavedEvaluation { id: string; title: string; report: string; criteria: Criterion[]; created_at: string }
const defaultCriteria: Criterion[] = [
  { id: 'organizzazione', label: 'Organizzazione e metodologia', weight: 30, keywords: 'organizzazione, metodologia, piano operativo' },
  { id: 'qualita', label: 'Qualità del servizio', weight: 30, keywords: 'qualità, controllo, monitoraggio' },
  { id: 'personale', label: 'Personale e formazione', weight: 20, keywords: 'personale, formazione, esperienza' },
  { id: 'sostenibilita', label: 'Sostenibilità', weight: 20, keywords: 'sostenibilità, ambiente, riduzione' },
];
const storageKey = 'cig-web-demo-evaluations-v1';
const errorText = (e: unknown) => e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' ? e.message : 'Operazione non riuscita.';
function readLocal(): SavedEvaluation[] { try { const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }

export default function Evaluation({ session }: { session: Session | null }) {
  const [saved, setSaved] = useState<SavedEvaluation[]>(() => session ? [] : readLocal());
  const [title, setTitle] = useState('');
  const [report, setReport] = useState('');
  const [criteria, setCriteria] = useState<Criterion[]>(defaultCriteria);
  const [current, setCurrent] = useState<string | null>(null);
  const [analyzed, setAnalyzed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const result = useMemo(() => evaluate(report, criteria), [report, criteria]);
  const max = result.reduce((sum, item) => sum + item.max, 0), score = result.reduce((sum, item) => sum + item.score, 0);
  const valid = !!report.trim() && report.length <= 200000 && criteria.length > 0 && criteria.length <= 30 && criteria.every(c => c.label.trim() && c.keywords.trim() && Number.isFinite(c.weight) && c.weight >= 0 && c.weight <= 1000);
  const update = (id: string, patch: Partial<Criterion>) => setCriteria(old => old.map(c => c.id === id ? { ...c, ...patch } : c));
  const load = async () => {
    if (!session || !supabase) { setSaved(readLocal()); return; }
    const { data, error } = await supabase.from('cig_web_evaluations').select('id,title,report,criteria,created_at').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    setSaved((data ?? []) as SavedEvaluation[]);
  };
  useEffect(() => {
    let alive = true;
    if (session && supabase) {
      void supabase.from('cig_web_evaluations').select('id,title,report,criteria,created_at').order('created_at', { ascending: false }).limit(200)
        .then(({ data, error }) => { if (alive) { if (error) setError(error.message); else setSaved((data ?? []) as SavedEvaluation[]); } });
    }
    return () => { alive = false; };
  }, [session]);
  const reset = () => { setCurrent(null); setTitle(''); setReport(''); setCriteria(defaultCriteria); setAnalyzed(false); setError(''); setFeedback(''); };
  const save = async () => {
    setError(''); setFeedback('');
    if (!valid) { setError('Inserisci il testo e almeno un criterio con nome, parole chiave e peso valido.'); return; }
    setBusy(true);
    try {
      const payload = { title: title.trim(), report, criteria };
      if (session && supabase) {
        const query = current ? supabase.from('cig_web_evaluations').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', current) : supabase.from('cig_web_evaluations').insert(payload);
        const { data, error } = await query.select('id').single(); if (error) throw error;
        setCurrent(data.id); await load();
      } else {
        const id = current ?? crypto.randomUUID();
        const created_at = saved.find(item => item.id === id)?.created_at ?? new Date().toISOString();
        const next = [{ id, created_at, ...payload }, ...saved.filter(item => item.id !== id)];
        sessionStorage.setItem(storageKey, JSON.stringify(next)); setSaved(next); setCurrent(id);
      }
      setFeedback(session ? 'Valutazione salvata nel tuo archivio Supabase.' : 'Valutazione salvata nella sessione dimostrativa del browser.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const remove = async (item: SavedEvaluation) => {
    if (!window.confirm(`Eliminare la valutazione “${item.title || 'Senza titolo'}”?`)) return;
    setBusy(true); setError(''); setFeedback('');
    try {
      if (session && supabase) { const { error } = await supabase.from('cig_web_evaluations').delete().eq('id', item.id).select('id').single(); if (error) throw error; await load(); }
      else { const next = saved.filter(row => row.id !== item.id); sessionStorage.setItem(storageKey, JSON.stringify(next)); setSaved(next); }
      if (current === item.id) reset();
      setFeedback('Valutazione eliminata.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const open = (item: SavedEvaluation) => { setCurrent(item.id); setTitle(item.title); setReport(item.report); setCriteria(Array.isArray(item.criteria) ? item.criteria : defaultCriteria); setAnalyzed(true); setError(''); setFeedback(''); };
  return <div className="space-y-4">
    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900"><strong>Analisi indicativa, non una valutazione di gara.</strong> Cerca parole e frasi esatte nel testo; non interpreta il contesto, non verifica i requisiti né sostituisce il giudizio della commissione. I punteggi sono proporzioni di corrispondenze, non punteggi ufficiali.</div>
    {(error || feedback) && <div role="status" className={`rounded border p-3 text-xs ${error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{error || feedback}</div>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="space-y-4 rounded-md border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold text-slate-800">Relazione tecnica</h2><button className="btn text-xs" onClick={reset} disabled={busy}>Nuova valutazione</button></div>
        <label className="block"><span className="label">Titolo</span><input className="input" maxLength={500} value={title} onChange={e => setTitle(e.target.value)} placeholder="Es. Offerta tecnica — lotto 1"/></label>
        <label className="block"><span className="label">Testo della relazione</span><textarea className="input min-h-52 resize-y" maxLength={200000} value={report} onChange={e => setReport(e.target.value)} placeholder="Incolla qui il testo della relazione…"/></label>
        <label className="block text-xs text-slate-500">Oppure carica un file di testo UTF-8 (.txt, max 200.000 caratteri)<input type="file" accept=".txt,text/plain" className="mt-2 block w-full text-xs" onChange={e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 2_000_000) { setError('Il file è troppo grande.'); e.target.value = ''; return; } void file.text().then(text => { if (text.length > 200000) setError('Il testo supera 200.000 caratteri.'); else { setReport(text); setError(''); } }).catch(() => setError('Impossibile leggere il file.')); e.target.value = ''; }}/></label>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4"><h3 className="text-sm font-semibold text-slate-700">Criteri personalizzabili</h3><button className="btn text-xs" disabled={criteria.length >= 30} onClick={() => setCriteria(old => [...old, { id: crypto.randomUUID(), label: '', weight: 0, keywords: '' }])}>+ Aggiungi criterio</button></div>
        <p className="text-[11px] leading-relaxed text-slate-400">Separa parole o frasi con una virgola. Ogni corrispondenza vale una quota uguale del peso del criterio.</p>
        {criteria.map((criterion, index) => <fieldset key={criterion.id} className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3"><legend className="px-1 text-xs font-medium text-slate-500">Criterio {index + 1}</legend><div className="flex gap-2"><label className="flex-1"><span className="label">Nome</span><input className="input" maxLength={500} value={criterion.label} onChange={e => update(criterion.id, { label: e.target.value })}/></label><label className="w-24"><span className="label">Peso</span><input className="input" type="number" min="0" max="1000" step="0.5" value={criterion.weight} onChange={e => update(criterion.id, { weight: e.target.value === '' ? 0 : Number(e.target.value) })}/></label><button className="self-end pb-2 text-xs text-rose-700 underline" onClick={() => setCriteria(old => old.filter(c => c.id !== criterion.id))} aria-label={`Elimina criterio ${index + 1}`}>Elimina</button></div><label className="block"><span className="label">Parole o frasi</span><input className="input" maxLength={2000} value={criterion.keywords} onChange={e => update(criterion.id, { keywords: e.target.value })}/></label></fieldset>)}
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4"><button className="btn btn-primary" onClick={() => { setError(''); if (!valid) setError('Inserisci il testo e almeno un criterio con nome, parole chiave e peso valido.'); else setAnalyzed(true); }}>Analizza testo</button><button className="btn" onClick={() => void save()} disabled={busy}>{busy ? 'Salvataggio…' : 'Salva valutazione'}</button></div>
        <p className="text-[11px] text-slate-400">{session ? 'Salva solo su richiesta nel tuo archivio personale Supabase.' : 'In modalità demo il salvataggio dura solo per questa sessione del browser.'}</p>
      </section>
      <div className="space-y-4"><section className="rounded-md border border-slate-200 bg-white p-5"><h2 className="text-base font-semibold text-slate-800">Risultato</h2>{!analyzed ? <p className="mt-3 text-xs text-slate-400">Inserisci testo e criteri, poi seleziona “Analizza testo”.</p> : <><div className="mt-4 rounded-md bg-cyan-50 p-4"><div className="text-[10px] font-semibold uppercase tracking-wider text-cyan-700">Corrispondenza indicativa</div><div className="mt-1 text-2xl font-semibold text-cyan-900">{score.toLocaleString('it-IT', { maximumFractionDigits: 1 })} / {max.toLocaleString('it-IT', { maximumFractionDigits: 1 })}</div><p className="mt-1 text-[11px] text-cyan-800">Non è un punteggio ufficiale e non valuta la qualità del contenuto.</p></div><div className="mt-4 space-y-3">{result.map((item, index) => <article key={item.criterion.id} className="rounded border border-slate-200 p-3"><div className="flex justify-between gap-2"><h3 className="text-sm font-semibold text-slate-700">{item.criterion.label || `Criterio ${index + 1}`}</h3><span className="shrink-0 text-xs font-semibold text-cyan-800">{item.score.toLocaleString('it-IT', {maximumFractionDigits:1})} / {item.max}</span></div><p className="mt-2 text-xs text-slate-500">Trovate: {item.matched.join(', ') || 'nessuna'}.</p><p className="mt-1 text-xs text-slate-500">Non trovate: {item.missing.join(', ') || 'nessuna'}.</p>{item.evidence.length > 0 && <ul className="mt-2 space-y-1">{item.evidence.map((sentence, i) => <li key={i} className="border-l-2 border-cyan-300 pl-2 text-xs italic text-slate-600">“{sentence}”</li>)}</ul>}</article>)}</div></>}</section>
      <section className="rounded-md border border-slate-200 bg-white p-5"><h2 className="text-base font-semibold text-slate-800">Valutazioni salvate</h2><p className="mt-1 text-[11px] text-slate-400">{session ? 'Archivio personale · fino a 200 elementi visualizzati' : 'Solo in questa sessione dimostrativa'}</p>{saved.length === 0 ? <p className="mt-3 text-xs text-slate-400">Nessuna valutazione salvata.</p> : <ul className="mt-3 divide-y divide-slate-100">{saved.map(item => <li key={item.id} className="flex items-center gap-2 py-2"><button className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-cyan-800 hover:underline" onClick={() => open(item)}>{item.title || 'Senza titolo'}</button><span className="text-[10px] text-slate-400">{new Date(item.created_at).toLocaleDateString('it-IT')}</span><button className="text-xs text-rose-700 underline" disabled={busy} onClick={() => void remove(item)} aria-label={`Elimina valutazione ${item.title || 'Senza titolo'}`}>Elimina</button></li>)}</ul>}</section></div>
    </div>
  </div>;
}
