import type { Notice } from './types';
import { stages } from './types';

/** Build spreadsheet rows. User-provided content is always a string, never a formula. */
export function makeSheet(rows: Notice[]) {
  const headings = ['Titolo', 'CIG', 'Stazione appaltante', 'Regione', 'Fonte', 'Importo stimato (€)', 'Scadenza (AAAA-MM-GG)', 'Stato bacheca', 'Note'];
  return [
    headings.map(value => ({ value, fontWeight: 'bold' as const, backgroundColor: '#165A70', textColor: '#FFFFFF' })),
    ...rows.map(row => [
      row.title, row.cig, row.buyer, row.region, row.source,
      row.estimated_value, row.deadline ?? '',
      stages.find(stage => stage.key === row.stage)?.label ?? '', row.notes,
    ]),
  ];
}
export async function downloadWorkbook(rows: Notice[], scope: string) {
  // Loaded on demand to avoid making the spreadsheet writer part of initial page load.
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const columns = [48, 20, 32, 20, 14, 23, 24, 22, 60].map(width => ({ width }));
  await writeExcelFile(makeSheet(rows), { sheet: 'Gare', columns, stickyRowsCount: 1 })
    .toFile(`cig-${scope}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
