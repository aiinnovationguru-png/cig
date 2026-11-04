/** Extract selectable text in the browser. The file is not uploaded by this function. */
export async function extractPdfText(file: File): Promise<string> {
  if (file.size > 15_000_000) throw new Error('Il PDF supera il limite di 15 MB.');
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true });
  try {
    const doc = await task.promise;
    if (doc.numPages > 100) throw new Error('Il PDF supera il limite di 100 pagine.');
    const pages: string[] = [];
    let length = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
      page.cleanup();
      if (text) { const formatted = `Pagina ${i}: ${text}`; length += formatted.length + 1; if (length > 200_000) throw new Error('Il testo estratto supera 200.000 caratteri.'); pages.push(formatted); }
    }
    if (!pages.length) throw new Error('Nessun testo selezionabile: i PDF scansionati richiedono OCR, non disponibile qui.');
    return pages.join('\n');
  } finally { await task.destroy(); }
}
