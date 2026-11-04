import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { IconBoard, IconCalendar, IconDatabase, IconPlus, IconSearch, IconTrash, IconClose, IconUser, IconDoc, IconDownload } from './components/icons';
import type { Notice, Stage } from './web/types';
import { stages } from './web/types';
import { downloadWorkbook } from './web/export';
import Calendar from './web/Calendar';
import Evaluation from './web/Evaluation';
import TedSearch, { type TedNotice } from './web/TedSearch';

type Draft = { title: string; buyer: string; region: string; cig: string; deadline: string; estimated_value: string; notes: string };
const blank: Draft = { title: '', buyer: '', region: '', cig: '', deadline: '', estimated_value: '', notes: '' };
const sample: Notice[] = [
  { id: 'esempio-1', title: 'Esempio · Servizi di manutenzione degli edifici', buyer: 'Ente dimostrativo', region: 'Campania', cig: '', deadline: null, estimated_value: 180000, source: 'esempio', stage: 'valutare', notes: 'Dato fittizio, solo per provare l’interfaccia.', created_at: '2026-01-01', updated_at: '2026-01-01' },
  { id: 'esempio-2', title: 'Esempio · Fornitura di attrezzature informatiche', buyer: 'Ente dimostrativo', region: 'Lazio', cig: '', deadline: null, estimated_value: 75000, source: 'esempio', stage: 'preparare', notes: 'Dato fittizio, solo per provare l’interfaccia.', created_at: '2026-01-02', updated_at: '2026-01-02' },
  { id: 'esempio-3', title: 'Esempio · Interventi di riqualificazione urbana', buyer: 'Ente dimostrativo', region: 'Lombardia', cig: '', deadline: null, estimated_value: 420000, source: 'esempio', stage: null, notes: 'Dato fittizio, solo per provare l’interfaccia.', created_at: '2026-01-03', updated_at: '2026-01-03' },
];
const money = (value: number | null) => value == null ? 'Non indicato' : new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
const date = (value: string | null) => value ? new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`)) : 'Non indicata';
const demoKey = 'cig-web-demo-v1';
function initialDemo(): Notice[] {
  try { const value = sessionStorage.getItem(demoKey); return value ? JSON.parse(value) as Notice[] : sample; } catch { return sample; }
}
function message(error: unknown) { return error instanceof Error ? error.message : typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Operazione non riuscita. Riprova.'; }

export default function WebApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  const [demo, setDemo] = useState<Notice[]>(initialDemo);
  const [remote, setRemote] = useState<Notice[]>([]);
  const [view, setView] = useState<'archivio' | 'bacheca' | 'calendario' | 'valutazione' | 'ted'>('archivio');
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Notice | 'new' | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'recover' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [draft, setDraft] = useState<Draft>(blank);
  const rows = session ? remote : demo;

  useEffect(() => { try { sessionStorage.setItem(demoKey, JSON.stringify(demo)); } catch { /* modalità privata */ } }, [demo]);
  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    let alive = true;
    supabase.auth.getSession().then(({ data, error }) => { if (alive) { if (error) setError(message(error)); sessionRef.current = data.session; setSession(data.session); setAuthReady(true); } });
    const { data } = supabase.auth.onAuthStateChange((event, next) => { sessionRef.current = next; setSession(next); if (event === 'PASSWORD_RECOVERY') { setAuthMode('reset'); setError(''); setAuthOpen(true); } });
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);
  const load = useCallback(async () => {
    if (!session || !supabase) return;
    setLoading(true); setError('');
    const all: Notice[] = [];
    const pageSize = 500;
    for (let start = 0; ;) {
      const { data, error, count } = await supabase.from('cig_web_notices').select('*', { count: 'exact' }).order('created_at', { ascending: false }).order('id').range(start, start + pageSize - 1);
      if (sessionRef.current?.user.id !== session.user.id) return;
      if (error) { setError(`Impossibile leggere l’archivio Supabase: ${error.message}`); setLoading(false); return; }
      const page = (data ?? []) as Notice[];
      all.push(...page);
      if (page.length === 0 || (count !== null ? all.length >= count : page.length < pageSize)) break;
      start += page.length;
    }
    setRemote(all); setLoading(false);
  }, [session]);
  useEffect(() => { setRemote([]); if (session) void load(); else setLoading(false); }, [session, load]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('it');
    return rows.filter(row => (!term || [row.title, row.buyer, row.cig, row.notes].some(value => value.toLocaleLowerCase('it').includes(term))) && (!region || row.region.toLocaleLowerCase('it').includes(region.toLocaleLowerCase('it'))));
  }, [rows, query, region]);
  const openEditor = (item: Notice | 'new') => {
    setError(''); setNotice(''); setEditing(item);
    setDraft(item === 'new' ? blank : { title: item.title, buyer: item.buyer, region: item.region, cig: item.cig, deadline: item.deadline ?? '', estimated_value: item.estimated_value == null ? '' : String(item.estimated_value), notes: item.notes });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim(); const value = draft.estimated_value.trim() ? Number(draft.estimated_value.replace(',', '.')) : null;
    if (!title || title.length > 500 || (value !== null && (!Number.isFinite(value) || value < 0))) { setError('Controlla titolo e importo: il titolo è obbligatorio e l’importo non può essere negativo.'); return; }
    setBusy(true); setError('');
    const payload = { title, buyer: draft.buyer.trim(), region: draft.region.trim(), cig: draft.cig.trim().toUpperCase(), deadline: draft.deadline || null, estimated_value: value, notes: draft.notes.trim(), updated_at: new Date().toISOString() };
    try {
      if (session && supabase) {
        const request = editing === 'new' ? supabase.from('cig_web_notices').insert({ ...payload, source: 'manuale' }) : supabase.from('cig_web_notices').update(payload).eq('id', (editing as Notice).id);
        const { error } = await request.select('id').single(); if (error) throw error; await load();
      } else if (editing === 'new') {
        setDemo(old => [{ ...payload, id: crypto.randomUUID(), source: 'manuale', stage: null, created_at: new Date().toISOString() }, ...old]);
      } else if (editing) setDemo(old => old.map(row => row.id === editing.id ? { ...row, ...payload } : row));
      setEditing(null); setNotice(session ? 'Gara salvata su Supabase.' : 'Gara salvata nella sessione di anteprima.');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const patch = async (id: string, values: Partial<Pick<Notice, 'stage'>>) => {
    setError(''); setBusy(true);
    try {
      if (session && supabase) { const { error } = await supabase.from('cig_web_notices').update({ ...values, updated_at: new Date().toISOString() }).eq('id', id).select('id').single(); if (error) throw error; await load(); }
      else setDemo(old => old.map(row => row.id === id ? { ...row, ...values } : row));
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const remove = async (row: Notice) => {
    if (!window.confirm(`Eliminare “${row.title}”?`)) return;
    setError(''); setBusy(true);
    try {
      if (session && supabase) { const { error } = await supabase.from('cig_web_notices').delete().eq('id', row.id).select('id').single(); if (error) throw error; await load(); }
      else setDemo(old => old.filter(item => item.id !== row.id));
      setNotice('Gara eliminata.');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const authenticate = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase) { setError('Supabase non è configurato.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const redirectTo = new URL(import.meta.env.BASE_URL, window.location.origin).toString();
      if (authMode === 'recover') {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
        if (error) throw error;
        setNotice('Se l’account esiste, controlla la tua email per ripristinare la password.');
      } else if (authMode === 'reset') {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setNotice('Password aggiornata.');
      } else {
        const result = authMode === 'login' ? await supabase.auth.signInWithPassword({ email: email.trim(), password }) : await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirectTo } });
        if (result.error) throw result.error;
        if (authMode === 'signup' && !result.data.session) setNotice('Controlla la tua email per confermare l’account. Il reindirizzamento dipende dalla configurazione del progetto Supabase.');
        else setNotice('Accesso effettuato.');
      }
      setPassword(''); setAuthOpen(false); setAuthMode('login');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const logout = async () => { if (!supabase) return; const { error } = await supabase.auth.signOut(); if (error) setError(error.message); else { setSession(null); setNotice('Sessione chiusa. Sei tornato all’anteprima con dati fittizi.'); } };
  const saveTed = async (row: TedNotice) => {
    if (!session || !supabase) throw new Error('Accedi per salvare una gara.');
    const { error } = await supabase.from('cig_web_notices').insert(row).select('id').single();
    if (error?.code === '23505') throw new Error('Questa gara TED è già nel tuo archivio.');
    if (error) throw error;
    await load();
  };
  const boardCount = rows.filter(row => row.stage !== null).length;
  const exportRows = view === 'bacheca' ? filtered.filter(row => row.stage !== null) : filtered;
  const exportExcel = async () => {
    setError(''); setNotice(''); setBusy(true);
    try { await downloadWorkbook(exportRows, view === 'bacheca' ? 'bacheca' : 'gare'); setNotice(`Esportate ${exportRows.length} gare in Excel.`); }
    catch (e) { setError(`Esportazione non riuscita: ${message(e)}`); }
    finally { setBusy(false); }
  };
  const titles = { archivio: 'Archivio gare', bacheca: 'Le mie gare', calendario: 'Calendario scadenze', valutazione: 'Valuta relazione', ted: 'Cerca gare TED' };
  const hints = { archivio: 'Tieni sotto controllo le opportunità che contano per te.', bacheca: 'Segui le opportunità, dalla valutazione all’esito.', calendario: 'Visualizza le scadenze delle gare nel tuo archivio.', valutazione: 'Verifica le parole chiave nella relazione con evidenze testuali.', ted: 'Cerca gli avvisi italiani pubblicati dalla fonte ufficiale europea.' };

  return (
    <div className="flex min-h-screen bg-[#f3f6f8] text-slate-700">
      <aside className="hidden w-[230px] shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-5"><div className="flex h-10 w-10 items-center justify-center rounded bg-cyan-900 text-sm font-bold tracking-tighter text-white">CIG</div><div><div className="font-semibold text-slate-800">Intelligence appalti</div><div className="mt-0.5 text-[11px] text-slate-500">Gare pubbliche italiane</div></div></div>
        <div className="px-4 pt-7 text-[10px] font-bold uppercase tracking-[.18em] text-slate-400">Spazio di lavoro</div>
        <nav className="mt-3 flex-1 space-y-1 px-3" aria-label="Navigazione web">
          {([{ id: 'archivio', label: 'Archivio gare', icon: IconSearch }, { id: 'bacheca', label: 'Le mie gare', icon: IconBoard }, { id: 'calendario', label: 'Scadenze', icon: IconCalendar }, { id: 'valutazione', label: 'Valuta relazione', icon: IconDoc }, { id: 'ted', label: 'Gare TED', icon: IconDatabase }] as const).map(item => <button key={item.id} onClick={() => setView(item.id)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-[13px] ${view === item.id ? 'bg-cyan-50 font-semibold text-cyan-900' : 'text-slate-500 hover:bg-slate-50'}`}><item.icon size={16}/>{item.label}{item.id === 'bacheca' && <span className="ml-auto text-xs text-slate-400">{boardCount}</span>}</button>)}
          <div className="px-3 pb-1 pt-8 text-[10px] font-bold uppercase tracking-[.18em] text-slate-400">In sviluppo</div>
          <div className="flex items-center gap-3 px-3 py-2.5 text-[13px] text-slate-400"><IconDatabase size={16}/> Importazioni ANAC</div>
        </nav>
        <div className="m-4 rounded-md border border-slate-200 bg-slate-50 p-3"><div className="text-[11px] font-semibold text-slate-600">CIG · Anteprima web</div><p className="mt-1 text-[11px] leading-relaxed text-slate-500">Una versione di prova, distinta dall’app desktop.</p></div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-4 md:px-8"><div className="flex items-center gap-2 text-[12px] text-slate-400"><span className="font-semibold text-cyan-900 md:hidden">CIG</span><span className="hidden md:inline">Spazio di lavoro</span><span>/</span><span className="font-medium text-slate-700">{titles[view]}</span></div><div className="flex items-center gap-2"><span className={`hidden rounded-full px-2.5 py-1 text-[10px] font-semibold sm:inline ${session ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{session ? '●  Supabase' : '●  Modalità dimostrativa'}</span>{session ? <><span className="hidden max-w-40 truncate text-xs text-slate-500 sm:block">{session.user.email}</span><button className="btn text-xs" onClick={() => void logout()}>Esci</button></> : <button className="btn text-xs" onClick={() => { setAuthOpen(true); setError(''); }}><IconUser size={14}/> Accedi</button>}</div></header>
        <main className="mx-auto max-w-[1500px] px-4 pb-12 pt-6 md:px-8 md:pt-9">
          <div className={`mb-6 flex flex-wrap items-start justify-between gap-2 rounded-md border px-4 py-3 text-[12px] leading-relaxed ${session ? 'border-emerald-200 bg-emerald-50/60 text-emerald-900' : 'border-amber-200 bg-amber-50/70 text-amber-900'}`}><div><strong>{session ? 'Archivio personale su Supabase.' : 'Stai esplorando l’anteprima.'}</strong> {session ? 'Sono visibili solo le gare del tuo account. I dati desktop non sono stati importati.' : 'Le gare “Esempio” sono fittizie; le modifiche restano in questa sessione del browser e non vengono inviate a Supabase.'}</div>{!session && <button onClick={() => setAuthOpen(true)} className="font-semibold underline underline-offset-2">Accedi per salvare online →</button>}</div>
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><div className="mb-2 text-[10px] font-bold uppercase tracking-[.2em] text-cyan-700">CIG / INTELLIGENCE APPALTI</div><h1 className="text-[26px] font-semibold tracking-tight text-slate-800 md:text-[30px]">{titles[view]}</h1><p className="mt-1.5 text-[13px] text-slate-500">{hints[view]}</p></div>{view !== 'valutazione' && view !== 'ted' && <div className="flex flex-wrap gap-2"><button className="btn h-10 px-4" disabled={busy || loading || exportRows.length === 0} onClick={() => void exportExcel()}><IconDownload size={15}/> Esporta Excel</button><button className="btn btn-primary h-10 px-4" onClick={() => openEditor('new')}><IconPlus size={15}/> Aggiungi gara</button></div>}</div>
          {(view === 'archivio' || view === 'bacheca') && <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">{[{ label:'GARE IN ARCHIVIO', value:rows.length, sub:'Inserite manualmente' },{ label:'IN BACHECA', value:boardCount, sub:'Opportunità da seguire' },{ label:'IN PREPARAZIONE', value:rows.filter(r => r.stage === 'preparare').length, sub:'Attività in corso' },{ label:'AGGIUDICATE', value:rows.filter(r => r.stage === 'vinto').length, sub:'Esiti segnati come vinti' }].map((stat, i) => <div key={stat.label} className="rounded-md border border-slate-200 bg-white px-4 py-4"><div className="text-[10px] font-bold tracking-[.11em] text-slate-400">{stat.label}</div><div className={`mt-3 text-[26px] font-semibold leading-none ${i === 0 ? 'text-cyan-800' : 'text-slate-700'}`}>{stat.value.toLocaleString('it-IT')}</div><div className="mt-2 text-[11px] text-slate-400">{stat.sub}</div></div>)}</div>}
          <div className="mb-4 flex flex-wrap items-center gap-2 md:hidden"><button className={`btn ${view === 'archivio' ? 'btn-primary' : ''}`} onClick={() => setView('archivio')}>Archivio</button><button className={`btn ${view === 'bacheca' ? 'btn-primary' : ''}`} onClick={() => setView('bacheca')}>Bacheca</button><button className={`btn ${view === 'calendario' ? 'btn-primary' : ''}`} onClick={() => setView('calendario')}>Scadenze</button><button className={`btn ${view === 'valutazione' ? 'btn-primary' : ''}`} onClick={() => setView('valutazione')}>Valutazione</button><button className={`btn ${view === 'ted' ? 'btn-primary' : ''}`} onClick={() => setView('ted')}>Gare TED</button></div>
          {(error || notice) && <div role="status" className={`mb-4 rounded border px-4 py-3 text-[12px] ${error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{error || notice}<button className="float-right underline" onClick={() => {setError(''); setNotice('');}}>Chiudi</button></div>}
          {view !== 'valutazione' && view !== 'ted' && <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[15px] font-semibold text-slate-800">{view === 'archivio' ? 'Le tue opportunità' : view === 'bacheca' ? 'Stato delle gare' : 'Scadenze delle gare'}</h2><p className="mt-1 text-[11px] text-slate-400">{loading ? 'Caricamento…' : `${view === 'bacheca' ? filtered.filter(row => row.stage !== null).length : filtered.length} gare · ${session ? 'archivio online' : 'anteprima locale'}`}</p></div><div className="flex w-full gap-2 sm:w-auto"><div className="relative flex-1 sm:w-64"><IconSearch size={15} className="absolute left-3 top-2.5 text-slate-400"/><input aria-label="Cerca nell’archivio" className="input h-9 pl-9" value={query} onChange={e => setQuery(e.target.value)} placeholder="Cerca titolo, ente o CIG" /></div><input aria-label="Filtra per regione" className="input h-9 w-36" value={region} onChange={e => setRegion(e.target.value)} placeholder="Regione"/></div></div>}
          {view === 'ted' ? <TedSearch key={session?.user.id ?? 'demo'} session={session} onLogin={() => { setError(''); setAuthOpen(true); }} onSave={saveTed} savedIds={new Set(rows.filter(r => r.source === 'ted' && r.external_id).map(r => r.external_id!))}/> : view === 'valutazione' ? <Evaluation key={session?.user.id ?? 'demo'} session={session}/> : view === 'calendario' ? <Calendar rows={filtered} open={openEditor}/> : view === 'archivio' ? <div className="overflow-hidden rounded-md border border-slate-200 bg-white"><div className="hidden grid-cols-[minmax(0,1fr)_150px_140px_140px_110px] gap-4 border-b border-slate-100 bg-slate-50/80 px-5 py-3 text-[10px] font-bold tracking-[.08em] text-slate-400 lg:grid"><span>GARA / STAZIONE APPALTANTE</span><span>REGIONE</span><span>IMPORTO</span><span>SCADENZA</span><span>AZIONI</span></div>
            {filtered.length === 0 ? <div className="px-6 py-16 text-center"><IconSearch size={24} className="mx-auto text-slate-300"/><p className="mt-3 font-medium text-slate-600">Nessuna gara trovata</p><p className="mt-1 text-xs text-slate-400">Modifica i filtri oppure aggiungi una gara manualmente.</p></div> : filtered.map(row => <div key={row.id} className="grid gap-3 border-b border-slate-100 px-5 py-4 last:border-0 lg:grid-cols-[minmax(0,1fr)_150px_140px_140px_110px] lg:items-center lg:gap-4"><div className="min-w-0"><button onClick={() => openEditor(row)} className="text-left text-[13px] font-semibold text-slate-700 hover:text-cyan-700">{row.title}</button><div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400"><span>{row.buyer || 'Ente non indicato'}</span><span>·</span><span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${row.source === 'esempio' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{row.source}</span>{row.cig && <span>· CIG {row.cig}</span>}</div></div><div className="text-[12px] text-slate-500">{row.region || '—'}</div><div className="text-[12px] font-medium text-slate-600">{money(row.estimated_value)}</div><div className="flex items-center gap-1.5 text-[12px] text-slate-500"><IconCalendar size={13}/>{date(row.deadline)}</div><div className="flex items-center gap-1"><button disabled={busy} className="btn btn-ghost px-2 py-1 text-[11px]" onClick={() => void patch(row.id, { stage: row.stage ? null : 'valutare' })} title={row.stage ? 'Rimuovi dalla bacheca' : 'Aggiungi alla bacheca'}><IconBoard size={14}/>{row.stage ? 'In bacheca' : 'Segui'}</button><button disabled={busy} className="btn btn-ghost px-1.5 py-1 text-slate-400" title="Elimina" aria-label={`Elimina ${row.title}`} onClick={() => void remove(row)}><IconTrash size={14}/></button></div></div>)}
          </div> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{stages.map(stage => { const items = filtered.filter(r => r.stage === stage.key); return <section key={stage.key} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); const row = rows.find(item => item.id === id); if (row?.stage && row.stage !== stage.key && !busy) void patch(id, { stage: stage.key }); }} className="min-h-44 rounded-md border border-slate-200 bg-slate-100/70 p-3"><div className="mb-3 flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${stage.color}`}/><h3 className="text-[12px] font-semibold text-slate-600">{stage.label}</h3><span className="ml-auto rounded bg-white px-1.5 py-0.5 text-[10px] text-slate-400">{items.length}</span></div>{items.length === 0 ? <div className="rounded border border-dashed border-slate-200 p-4 text-center text-[11px] text-slate-400">Nessuna gara</div> : <div className="space-y-2">{items.map(row => <article key={row.id} draggable={!busy} onDragStart={e => { e.dataTransfer.setData('text/plain', row.id); e.dataTransfer.effectAllowed = 'move'; }} className="cursor-grab rounded border border-slate-200 bg-white p-3 shadow-sm"><button className="text-left text-[12px] font-semibold leading-snug text-slate-700 hover:text-cyan-700" onClick={() => openEditor(row)}>{row.title}</button><p className="mt-2 text-[11px] text-slate-400">{row.buyer || 'Ente non indicato'}</p><p className="mt-2 text-[11px] font-medium text-slate-600">{money(row.estimated_value)}</p><label className="mt-3 block text-[10px] text-slate-400">Sposta in<select className="input mt-1 h-8 text-[11px]" value={row.stage ?? ''} disabled={busy} onChange={e => void patch(row.id, {stage: e.target.value as Stage})}>{stages.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label><button disabled={busy} className="mt-2 text-[10px] text-slate-400 underline" onClick={() => void patch(row.id, {stage:null})}>Rimuovi dalla bacheca</button></article>)}</div>}</section>; })}</div>}
          <div className="mt-5 flex items-start gap-3 rounded-md border border-slate-200 bg-white px-4 py-3"><IconDatabase size={16} className="mt-0.5 shrink-0 text-slate-400"/><p className="text-[11px] leading-relaxed text-slate-500"><strong className="text-slate-600">Funzioni web disponibili:</strong> inserimento e modifica manuale, ricerca testuale, filtri, bacheca, calendario, export Excel e valutazione testuale. Ricerca TED autenticata con salvataggio manuale. ANAC, ricerca semantica, email e analisi automatica dei disciplinari non sono ancora collegati nella versione web.</p></div>
        </main>
      </div>
      {editing && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setEditing(null); }}><div role="dialog" aria-modal="true" aria-labelledby="edit-title" className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white shadow-xl"><div className="flex items-start justify-between border-b border-slate-100 px-6 py-5"><div><h2 id="edit-title" className="text-lg font-semibold text-slate-800">{editing === 'new' ? 'Aggiungi una gara' : 'Dettaglio gara'}</h2><p className="mt-1 text-xs text-slate-400">{session ? 'I dati saranno salvati nel tuo archivio Supabase.' : 'I dati resteranno nella sessione di anteprima.'}</p></div><button className="btn btn-ghost p-1" disabled={busy} onClick={() => setEditing(null)} aria-label="Chiudi"><IconClose/></button></div><form onSubmit={event => void save(event)} className="space-y-4 px-6 py-5">{error && <div role="alert" className="rounded bg-rose-50 p-3 text-xs text-rose-800">{error}</div>}{editing !== 'new' && editing.source === 'ted' && editing.external_id && /^\d{1,7}-\d{4}$/.test(editing.external_id) && <a href={`https://ted.europa.eu/it/notice/-/detail/${editing.external_id}`} target="_blank" rel="noopener noreferrer" className="block text-xs font-semibold text-cyan-800 underline">Apri l’avviso ufficiale TED ↗</a>}<label className="block"><span className="label">Titolo della gara *</span><input autoFocus required maxLength={500} className="input" value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="Oggetto della procedura"/></label><div className="grid gap-4 sm:grid-cols-2"><label><span className="label">Stazione appaltante</span><input className="input" value={draft.buyer} onChange={e => setDraft({ ...draft, buyer: e.target.value })} placeholder="Nome dell’ente"/></label><label><span className="label">Regione</span><input className="input" value={draft.region} onChange={e => setDraft({ ...draft, region: e.target.value })} placeholder="Es. Campania"/></label><label><span className="label">CIG</span><input className="input" maxLength={30} value={draft.cig} onChange={e => setDraft({ ...draft, cig: e.target.value })} placeholder="Se disponibile"/></label><label><span className="label">Scadenza</span><input type="date" className="input" value={draft.deadline} onChange={e => setDraft({ ...draft, deadline: e.target.value })}/></label><label><span className="label">Importo stimato (€)</span><input type="number" min="0" step="0.01" className="input" value={draft.estimated_value} onChange={e => setDraft({ ...draft, estimated_value: e.target.value })} placeholder="0,00"/></label></div><label className="block"><span className="label">Note</span><textarea className="input min-h-24" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} placeholder="Appunti e prossime attività"/></label><div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>Annulla</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Salvataggio…' : 'Salva gara'}</button></div></form></div></div>}
      {authOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setAuthOpen(false); }}><div role="dialog" aria-modal="true" aria-labelledby="auth-title" className="w-full max-w-md rounded-lg bg-white shadow-xl"><div className="flex items-start justify-between border-b border-slate-100 px-6 py-5"><div><h2 id="auth-title" className="text-lg font-semibold text-slate-800">{authMode === 'login' ? 'Accedi al tuo archivio' : authMode === 'signup' ? 'Crea un account' : authMode === 'recover' ? 'Recupera la password' : 'Imposta una nuova password'}</h2><p className="mt-1 text-xs leading-relaxed text-slate-400">Usa l’account del progetto Supabase collegato.</p></div><button className="btn btn-ghost p-1" onClick={() => setAuthOpen(false)} aria-label="Chiudi"><IconClose/></button></div><form onSubmit={event => void authenticate(event)} className="space-y-4 px-6 py-5">{error && <div role="alert" className="rounded bg-rose-50 p-3 text-xs text-rose-800">{error}</div>}{!supabase && <p className="rounded bg-amber-50 p-3 text-xs text-amber-800">Configura URL e chiave pubblicabile Supabase per abilitare l’accesso.</p>}{authMode !== 'reset' && <label className="block"><span className="label">Email</span><input autoFocus type="email" required autoComplete="email" className="input" value={email} onChange={e => setEmail(e.target.value)}/></label>}{authMode !== 'recover' && <label className="block"><span className="label">{authMode === 'reset' ? 'Nuova password' : 'Password'}</span><input type="password" required minLength={6} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} className="input" value={password} onChange={e => setPassword(e.target.value)}/></label>}{authMode === 'signup' && <p className="text-[11px] leading-relaxed text-slate-500">La registrazione richiede la conferma via email. Il servizio email del progetto può limitare i destinatari; il reindirizzamento dipende dalla configurazione Supabase.</p>}<button type="submit" className="btn btn-primary w-full" disabled={busy || !authReady || !supabase}>{busy ? 'Attendi…' : authMode === 'login' ? 'Accedi' : authMode === 'signup' ? 'Crea account' : authMode === 'recover' ? 'Invia link di recupero' : 'Aggiorna password'}</button>{authMode !== 'reset' && <><button type="button" className="w-full text-center text-xs text-cyan-800 underline underline-offset-2" onClick={() => { setAuthMode(authMode === 'login' ? 'signup' : 'login'); setError(''); }}>{authMode === 'login' ? 'Non hai un account? Registrati' : 'Torna all’accesso'}</button>{authMode === 'login' && <button type="button" className="w-full text-center text-xs text-cyan-800 underline underline-offset-2" onClick={() => { setAuthMode('recover'); setError(''); }}>Password dimenticata?</button>}</>}</form></div></div>}
    </div>
  );
}
