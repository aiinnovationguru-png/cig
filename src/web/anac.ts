export type AnacNotice = {
  external_id: string; title: string; buyer: string; region: string; cig: string;
  deadline: string | null; estimated_value: number | null; source: 'anac';
  description: string; cpv: string; published_on: string | null; official_url: null;
};
const text = (s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
function date(raw: string): string | null {
  const value = raw.trim(); let s = '';
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) s = value.slice(0, 10);
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) s = value.split('/').reverse().join('-');
  if (!s) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === s ? s : null;
}
function amount(raw: string): number | null {
  const v = raw.replace(/\s/g, '');
  // Refuse ambiguous values such as 1.234 instead of guessing the decimal separator.
  const normalized = /^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(v) ? v.replace(/\./g, '').replace(',', '.') : /^\d+,\d{1,2}$/.test(v) ? v.replace(',', '.') : /^\d+(\.\d{1,2})?$/.test(v) ? v : '';
  if (!normalized) return null;
  const n = Number(normalized); return Number.isFinite(n) && n >= 0 && n < 1e16 ? n : null;
}
/** Converts supported ANAC CSV fields only, grouping rows by CIG; unknown values remain empty. */
export function normalizeAnac(rows: Record<string, string>[]): AnacNotice[] {
  const byCig = new Map<string, AnacNotice>();
  for (const original of rows) {
    const row = Object.fromEntries(Object.entries(original).map(([k, v]) => [k.replace(/^\uFEFF/, '').trim().toLowerCase(), text(v)]));
    const cig = (row.cig || '').toUpperCase();
    const title = row.oggetto_lotto || row.oggetto_gara;
    if (!/^[A-Z0-9]{10}$/.test(cig) || !title) continue;
    const code = /^\d{8}(?:-\d)?$/.test(row.cod_cpv ?? '') ? row.cod_cpv : '';
    const existing = byCig.get(cig);
    if (existing) {
      const cpvs = new Set(existing.cpv ? existing.cpv.split(', ') : []);
      if (code) cpvs.add(code);
      existing.cpv = [...cpvs].join(', ').slice(0, 1000);
      continue;
    }
    byCig.set(cig, { external_id: cig, title: title.slice(0, 500), buyer: (row.denominazione_amministrazione_appaltante || '').slice(0, 500), region: '', cig,
      deadline: date(row.data_scadenza_offerta || ''), estimated_value: amount(row.importo_lotto || row.importo_complessivo_gara || ''), source: 'anac',
      description: (row.oggetto_gara || '').slice(0, 10000), cpv: code, published_on: date(row.data_pubblicazione || ''), official_url: null });
  }
  return [...byCig.values()];
}
