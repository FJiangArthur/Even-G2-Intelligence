/**
 * v0.13 on-phone PDF text extraction with pdfjs-dist. Nothing is uploaded.
 *
 * pdfjs (about 0.4 MB) and its worker (about 1.4 MB) are separate lazy chunks: they are fetched
 * from the installed package only when the first PDF is parsed, never at app start. The legacy
 * build is used because the Even app's WebView version is not under our control.
 *
 * Limits: text layer only. A scanned or image-only PDF has no text to extract (no OCR here);
 * password-protected PDFs are rejected; reading order follows the PDF's own text order, so
 * multi-column pages and tables can come out interleaved.
 */
import type { PdfDocumentText, PdfPage } from "@helix/conversation-sdk";

interface PdfTextItem { readonly str?: string; readonly hasEOL?: boolean; readonly transform?: readonly number[] }
interface PdfPageProxy { getTextContent(): Promise<{ items: readonly unknown[] }>; cleanup?(): unknown }
interface PdfDocumentProxy { readonly numPages: number; getPage(index: number): Promise<PdfPageProxy>; destroy?(): Promise<unknown> | unknown }
/** The part of pdfjs-dist this module uses (so tests can pass the Node build or a fake). */
export interface PdfjsLike {
  getDocument(source: { data: Uint8Array; isEvalSupported?: boolean; useSystemFonts?: boolean; disableFontFace?: boolean }): { promise: Promise<PdfDocumentProxy> };
}

let loading: Promise<PdfjsLike> | undefined;
/** Lazy-loads pdfjs and points it at the bundled worker. A failed load is retried on the next call. */
export function loadPdfjs(): Promise<PdfjsLike> {
  loading ??= (async () => {
    const [lib, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]);
    // If the WebView refuses to start a module worker from the app origin, pdfjs imports the same
    // file on the main thread instead ("fake worker"): slower, but it still parses.
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib as unknown as PdfjsLike;
  })().catch(error => { loading = undefined; throw error; });
  return loading;
}

/** Text items of one page -> lines (pdfjs marks line ends; a large vertical jump starts a paragraph). */
export function pageText(items: readonly unknown[]): string {
  let text = "", lastY: number | undefined;
  for (const raw of items) {
    const item = raw as PdfTextItem, value = typeof item.str === "string" ? item.str : "", y = item.transform?.[5];
    if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 18 && text && !text.endsWith("\n\n")) text = `${text.replace(/\s+$/u, "")}\n\n`;
    text += value;
    if (item.hasEOL) text += "\n"; else if (value && !/\s$/u.test(value)) text += " ";
    if (y !== undefined && value.trim()) lastY = y;
  }
  return text.replace(/ +\n/gu, "\n").replace(/ {2,}/gu, " ").trim();
}

/** Extracts the text layer of a PDF, page by page. Throws on an unreadable or protected file. */
export async function extractPdfText(data: Uint8Array, options: { signal?: AbortSignal; maxPages?: number; pdfjs?: PdfjsLike } = {}): Promise<PdfDocumentText> {
  const pdfjs = options.pdfjs ?? await loadPdfjs();
  let document: PdfDocumentProxy;
  try {
    // pdfjs transfers the buffer to its worker: hand it a copy so the caller's bytes stay usable.
    document = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, useSystemFonts: false, disableFontFace: true }).promise;
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name ?? "";
    throw new Error(name === "PasswordException" ? "This PDF is password-protected. Remove the password and try again."
      : name === "InvalidPDFException" ? "This file is not a readable PDF (damaged or not a PDF)." : "The PDF could not be opened on this phone.");
  }
  try {
    const limit = Math.max(1, options.maxPages ?? 500), count = Math.min(document.numPages, limit), pages: PdfPage[] = [];
    for (let index = 1; index <= count; index++) {
      if (options.signal?.aborted) throw new DOMException("Cancelled.", "AbortError");
      const page = await document.getPage(index);
      const text = pageText((await page.getTextContent()).items);
      if (text) pages.push({ page: index, text });
      page.cleanup?.();
    }
    return { pages, pageCount: document.numPages, ...(document.numPages > count ? { truncated: true } : {}) };
  } finally { try { await document.destroy?.(); } catch { /* already gone */ } }
}
