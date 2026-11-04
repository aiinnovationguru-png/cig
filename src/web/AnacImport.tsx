import { useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { normalizeAnac, type AnacNotice } from './anac';
import { IconPlus } from '../components/icons';

type ParseState = { notices: AnacNotice[]; rows: number; truncated: boolean; name: string };
export default function AnacImport({ session, onLogin, onSave, savedIds }: { session: Session | null; onLogin: () => void; onSave: (row: AnacNotice) => Promise<void>; savedIds: Set<string> }) {
  const [parsed, setParsed] = useState<ParseState | null>(null);
  const [encoding, setEncoding] = useState('UTF-8');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const read = async (file: File) => {
    setError(''); setFeedback(''); setParsed(null); setLoading(true);
    try {
      if (!/\.csv$/i.test(file.name)) throw new Error('Seleziona un file CSV estratto dallo ZIP ANAC.');
      const { default: Papa } = await import('papaparse');
      Papa.parse<Record<string, string>>(file, {
        header: true, delimiter: ';', encoding, skipEmptyLines: 'greedy', preview: 5001,
        transformHeader: h => h.replace(/^\uFEFF/, '').trim().toLowerCase(),
        complete: result => {
          try {
            const headers = result.meta.fields ?? [];
            if (!headers.includes('cig') || (!headers.includes('oggetto_lotto') && !headers.includes('oggetto_gara'))) throw new Error('Intestazioni ANAC non riconosciute: servono cig e oggetto_lotto o oggetto_gara.');
            if (result.errors.length) throw new Error(`CSV non valido (riga ${(result.errors[0].row ?? 0) + 2}): ${result.errors[0].message}`);
            const data = result.data.slice(0, 5000);
            setParsed({ notices: normalizeAnac(data), rows: data.length, truncated: result.meta.truncated || result.data.length > 5000, name: file.name });
          } catch (e) { setError(e instanceof Error ? e.message : 'CSV non valido.'); }
          finally { setLoading(false); }
        },
        error: e => { setError(e.message || 'Impossibile leggere il file.'); setLoading(false); },
      });
    } catch (e) { setError(e instanceof Error ? e.message : 'Impossibile leggere il file.'); setLoading(false); }
  };
  const save = async (row: AnacNotice) => { setSaving(row.cig); setError(''); setFeedback(''); try { await onSave(row); setFeedback('Gara ANAC aggiunta al tuo archivio personale.'); } catch (e) { setError(e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' ? e.message : 'Salvataggio non riuscito.'); } finally { setSaving(null); } };
  if (!session) return <div className="rounded-md border border-slate-200 bg-white p-6"><h2 className="text-base font-semibold text-slate-800">Importazione ANAC da CSV</h2><p className="mt-2 text-sm text-slate-500">Accedi per aggiungere al tuo archivio gare da un file ANAC. I dati demo non vengono importati.</p><button className="btn btn-primary mt-4" onClick={onLogin}>Accedi</button></div>;
  return <div className="space-y-4"><div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900"><strong>Importazione manuale limitata.</strong> Scarica un dataset CIG da ANAC, estrai lo ZIP e seleziona il CSV. Il file è letto nel browser; le gare sono salvate solo quando le aggiungi. Vengono esaminate le prime 5.000 righe e mostrati al massimo 100 CIG: non è un import completo né un aggiornamento automatico.</div>
    <div className="space-y-3 rounded-md border border-slate-200 bg-white p-4"><a className="text-xs font-semibold text-cyan-800 underline" href="https://dati.anticorruzione.it/opendata/dataset/cig" target="_blank" rel="noopener noreferrer">Apri i dataset ANAC ↗</a><div className="flex flex-wrap items-end gap-4"><label><span className="label">Codifica del file</span><select className="input h-10" value={encoding} onChange={e => setEncoding(e.target.value)}><option value="UTF-8">UTF-8</option><option value="windows-1252">Windows-1252</option></select></label><label className="text-xs text-slate-600">CSV ANAC (separatore punto e virgola)<input type="file" accept=".csv,text/csv" disabled={loading || !!saving} className="mt-2 block text-xs" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }}/></label>{loading && <span className="text-xs text-slate-500">Lettura in corso…</span>}</div></div>
    {(error || feedback) && <div role="status" className={`rounded border px-4 py-3 text-xs ${error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{error || feedback}</div>}
    {parsed && <section className="rounded-md border border-slate-200 bg-white"><div className="border-b border-slate-100 p-4"><h2 className="text-sm font-semibold text-slate-800">{parsed.name}</h2><p className="mt-1 text-xs text-slate-500">{parsed.rows} righe esaminate · {parsed.notices.length} CIG validi{parsed.truncated ? ' · file troncato alle prime 5.000 righe' : ''}{parsed.notices.length > 100 ? ' · visualizzati i primi 100' : ''}</p><p className="mt-1 text-xs text-slate-400">Il CIG è un identificativo, non una verifica che la gara sia ancora aperta. Controlla sempre l’avviso ufficiale.</p></div>{parsed.notices.length === 0 ? <p className="p-8 text-center text-sm text-slate-400">Nessuna riga con CIG e titolo validi nelle righe esaminate.</p> : <div className="divide-y divide-slate-100">{parsed.notices.slice(0, 100).map(row => <article key={row.cig} className="flex flex-wrap items-start justify-between gap-3 p-4"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-slate-800">{row.title}</h3><p className="mt-1 text-xs text-slate-500">{row.buyer || 'Ente non indicato'} · CIG {row.cig}{row.cpv && ` · CPV ${row.cpv}`}</p><p className="mt-1 text-xs text-slate-500">Scadenza: {row.deadline ?? 'Non indicata'} · Importo: {row.estimated_value == null ? 'Non indicato' : `${row.estimated_value.toLocaleString('it-IT')} €`}</p></div><button className="btn h-9 text-xs" disabled={!!saving || savedIds.has(row.cig)} onClick={() => void save(row)}><IconPlus size={14}/>{savedIds.has(row.cig) ? 'Già in archivio' : saving === row.cig ? 'Salvataggio…' : 'Aggiungi all’archivio'}</button></article>)}</div>}</section>}
  </div>;
}
