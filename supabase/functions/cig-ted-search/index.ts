// Authenticated, bounded proxy for the official TED Search API.
// This endpoint is read-only: saving a result is a separate RLS-protected action.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
function first(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) { for (const v of value) { const s = first(v); if (s) return s; } }
  else if (value && typeof value === 'object') { const o = value as Record<string, unknown>; for (const v of [o.ita, o.eng, ...Object.values(o)]) { const s = first(v); if (s) return s; } }
  return '';
}
function date(value: unknown): string | null {
  const str = first(value); const d = /^\d{4}-\d{2}-\d{2}/.exec(str)?.[0] ?? (/^\d{8}$/.test(str) ? `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}` : '');
  if (!d) return null;
  const t = new Date(`${d}T00:00:00Z`);
  return Number.isFinite(t.valueOf()) && t.toISOString().slice(0, 10) === d ? d : null;
}
function normalize(n: Record<string, unknown>) {
  const external_id = first(n['publication-number']);
  const title = first(n['notice-title']);
  if (!/^\d{1,7}-\d{4}$/.test(external_id) || !title) return null;
  const description = first(n['description-proc']) || first(n['description-lot']);
  const amount = Number(first(n['estimated-value-proc']));
  const value = first(n['estimated-value-cur-proc']).toUpperCase() === 'EUR' && Number.isFinite(amount) && amount >= 0 && first(n['estimated-value-proc']) ? amount : null;
  const cig = /\bCIG\s*[:#-]?\s*([A-Z0-9]{10})\b/i.exec(`${title} ${description}`)?.[1]?.toUpperCase() ?? '';
  return {
    external_id, title: title.slice(0, 500), buyer: first(n['buyer-name']).slice(0, 500), region: '', cig,
    deadline: date(n['deadline-receipt-tender-date-lot']), estimated_value: value,
    source: 'ted', description: description.slice(0, 10000), cpv: first(n['classification-cpv']).slice(0, 1000),
    published_on: date(n['publication-date']), official_url: `https://ted.europa.eu/it/notice/-/detail/${external_id}`,
  };
}
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Metodo non consentito.' });
  try {
    const raw = await req.text(); if (raw.length > 2048) return json(413, { error: 'Richiesta troppo grande.' });
    const input = JSON.parse(raw || '{}');
    const page = input.page ?? 1, days = input.days ?? 30, cpv = input.cpv ?? '';
    if (!Number.isInteger(page) || page < 1 || page > 20 || !Number.isInteger(days) || days < 1 || days > 90 || typeof cpv !== 'string' || !/^\d{0,8}$/.test(cpv)) return json(400, { error: 'Parametri di ricerca non validi.' });
    const from = new Date(); from.setUTCDate(from.getUTCDate() - days);
    const fromText = from.toISOString().slice(0, 10).replaceAll('-', '');
    const query = `buyer-country = ITA AND form-type = competition AND publication-date >= ${fromText}${cpv ? ` AND classification-cpv = ${cpv}*` : ''} SORT BY publication-date DESC`;
    const fields = ['publication-number', 'notice-title', 'buyer-name', 'description-proc', 'description-lot', 'classification-cpv', 'publication-date', 'deadline-receipt-tender-date-lot', 'estimated-value-proc', 'estimated-value-cur-proc'];
    const response = await fetch('https://api.ted.europa.eu/v3/notices/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ query, fields, limit: 25, page, scope: 'ALL', paginationMode: 'PAGE_NUMBER' }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) return json(502, { error: `TED non è disponibile (HTTP ${response.status}). Riprova più tardi.` });
    const data = await response.json();
    if (data.timedOut) return json(502, { error: 'TED ha interrotto la ricerca per timeout. Riprova.' });
    if (!Array.isArray(data.notices)) return json(502, { error: 'Risposta TED non riconosciuta.' });
    const notices = data.notices.map(normalize).filter(Boolean);
    return json(200, { notices, total: typeof data.totalNoticeCount === 'number' ? data.totalNoticeCount : null, page, days, source: 'TED' });
  } catch (e) {
    if (e instanceof SyntaxError) return json(400, { error: 'Richiesta JSON non valida.' });
    return json(502, { error: 'Impossibile contattare TED. Riprova più tardi.' });
  }
});
