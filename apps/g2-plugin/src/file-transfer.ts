/**
 * v0.13 getting files in and out of the phone WebView. Pure functions with the browser pieces
 * injected (TransferEnv), so the fallback order is tested without a DOM.
 *
 * Why this exists: the plugin runs in the Even app's Flutter WebView (flutter_inappwebview). The Even
 * bridge has no file-save or file-open API, and a WebView only saves an `<a download>` blob link when
 * its host app implements a download handler. The old code clicked such a link and always reported
 * "Prepared <file>", so in the app nothing was saved and the user was told it had worked.
 *
 * Export order: (1) outside the embedded WebView, a normal browser download, which is known to work
 * there; (2) the system share sheet with the file (navigator.share: iOS WKWebView and most mobile
 * browsers; Android System WebView does not have it); (3) the text on the clipboard; (4) the text
 * shown in the page to select by hand. The outcome always says which one happened.
 */

export interface ShareNavigator {
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
  canShare?: (data: { files?: File[] }) => boolean;
}
export interface TransferEnv {
  readonly navigator?: ShareNavigator;
  /** True inside the Even app's WebView (or another embedded WebView without download support). */
  readonly embedded: boolean;
  /** Starts a browser download; returns the link so the user can tap it again. Absent: no DOM. */
  readonly download?: (name: string, blob: Blob) => unknown;
  /** Puts text on the clipboard; false when blocked. */
  readonly copy?: (text: string) => Promise<boolean>;
}
export type ExportMethod = "share" | "download" | "clipboard" | "view";
export interface ExportOutcome<Link = unknown> {
  readonly method: ExportMethod; readonly name: string;
  /** What happened, as one sentence for the user. */
  readonly message: string;
  /** The user closed the share sheet: nothing was exported, and no fallback ran. */
  readonly cancelled?: boolean;
  /** For "download": the link, to tap again if the browser ignored the automatic click. */
  readonly link?: Link;
}

/** flutter_inappwebview injects this object; the Even Hub SDK bridge talks through it. */
export function inEmbeddedWebView(scope: unknown = globalThis): boolean {
  return typeof scope === "object" && scope !== null && "flutter_inappwebview" in scope;
}

/** The real WebView: share sheet, anchor download (revoked after a minute) and the given clipboard writer. */
export function browserTransferEnv(copy: (text: string) => Promise<boolean>): TransferEnv {
  return {
    navigator: typeof navigator === "undefined" ? {} : navigator as unknown as ShareNavigator,
    embedded: inEmbeddedWebView(),
    copy,
    download: (name, blob) => {
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = name; link.rel = "noopener"; link.className = "download-link"; link.textContent = `Download ${name}`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return link;
    },
  };
}

function shareable(navigator: ShareNavigator | undefined, name: string, content: BlobPart, type: string): File | undefined {
  if (!navigator?.share || !navigator.canShare || typeof File === "undefined") return undefined;
  // Some browsers only share a fixed list of MIME types: retry a text file as text/plain.
  for (const mime of type.startsWith("text/") && type !== "text/plain" ? [type, "text/plain"] : [type]) {
    try { const file = new File([content], name, { type: mime }); if (navigator.canShare({ files: [file] })) return file; } catch { /* not shareable as this type */ }
  }
  return undefined;
}

/**
 * Exports one file, falling back automatically. `text` is the clipboard / in-page form of the same
 * content (for a zip of notes: the notes joined as one Markdown document). Call it directly from a
 * tap handler: the share sheet needs the user gesture.
 */
export async function exportFile<Link = unknown>(file: { name: string; content: string | Uint8Array; type: string; text: string }, env: TransferEnv): Promise<ExportOutcome<Link>> {
  const { name } = file;
  // An ordinary browser saves downloads reliably: do that first. (Its share sheet is a detour, and on desktop it has no "save".)
  if (!env.embedded && env.download) {
    try {
      const link = env.download(name, new Blob([file.content as BlobPart], { type: file.type })) as Link;
      return { method: "download", name, link, message: `Download started: ${name}. If nothing was saved, tap the link below, or use Copy.` };
    } catch { /* continue */ }
  }
  const shared = shareable(env.navigator, name, file.content as BlobPart, file.type);
  if (shared) {
    try {
      await env.navigator!.share!({ files: [shared], title: name });
      return { method: "share", name, message: `Share sheet opened for ${name}. Choose “Save to Files”, Obsidian or another app there.` };
    } catch (error) {
      if ((error as { name?: string } | undefined)?.name === "AbortError") return { method: "share", name, cancelled: true, message: "Share cancelled. Nothing was exported." };
      // Anything else (not allowed, unsupported after all): continue with the next fallback.
    }
  }
  const why = env.embedded ? "The Even app cannot save files from Helix" : "This browser blocked the download";
  if (file.text && env.copy && await env.copy(file.text).catch(() => false)) {
    return { method: "clipboard", name, message: `${why}, so the Markdown was copied to the clipboard instead. Paste it into a note in Obsidian or Files.` };
  }
  return { method: "view", name, message: `${why}, and the clipboard is blocked too. The Markdown is shown below: select all of it and copy.` };
}

/* ------------------------------------------------------------------ reading picked files */

export interface ReadFile { readonly name: string; readonly size: number; text?: () => Promise<string> }
export type TextFileResult = { readonly name: string; readonly ok: true; readonly text: string } | { readonly name: string; readonly ok: false; readonly error: string };
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function legacyText(file: ReadFile): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") { reject(new Error("This WebView cannot read files.")); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsText(file as unknown as Blob);
  });
}
/** Reads every picked text file. One unreadable or oversized file is reported; the others still load. */
export async function readTextFiles(files: readonly ReadFile[], maxBytes = 2_000_000): Promise<TextFileResult[]> {
  return Promise.all(files.map(async (file): Promise<TextFileResult> => {
    try {
      if (file.size > maxBytes) throw new Error(`Too large (${mb(file.size)}; the limit is ${mb(maxBytes)}).`);
      const text = typeof file.text === "function" ? await file.text() : await legacyText(file);
      if (!text.trim()) throw new Error("The file is empty.");
      if (text.slice(0, 2048).includes("\u0000")) throw new Error("Not a text file.");
      return { name: file.name, ok: true, text };
    } catch (error) { return { name: file.name, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }));
}

/* ------------------------------------------------------------------ import from a link */

export const URL_IMPORT_BLOCKED = "The link could not be loaded from inside the app. The Even app only lets Helix reach its listed providers, and most sites do not allow cross-site reads. Open the link in a browser, copy the text and paste it here instead.";
/** https only, no embedded sign-in details. Returns the normalized URL or throws a user-facing error. */
export function importUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a full https:// link."); }
  if (url.protocol !== "https:" || url.username || url.password || value.length > 2000) throw new Error("Only plain https:// links without sign-in details can be imported.");
  return url;
}
export function urlFileName(url: URL, extension: string): string {
  let base = url.pathname.split("/").filter(Boolean).pop() ?? "";
  try { base = decodeURIComponent(base); } catch { /* keep raw */ }
  base = base.replace(/[\u0000-\u001f\\/:*?"<>|]+/gu, " ").trim().slice(0, 80) || url.hostname;
  return new RegExp(`\\.${extension}$`, "iu").test(base) ? base : `${base}.${extension}`;
}
/**
 * Fetches a Markdown or text file from a link (no cookies, no redirects to other schemes).
 * In the Even app this works only for hosts in the plugin's network whitelist; elsewhere the site
 * must allow cross-origin reads. Both failures surface as URL_IMPORT_BLOCKED.
 */
export async function fetchTextFromUrl(value: string, options: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; signal?: AbortSignal; maxBytes?: number } = {}): Promise<{ name: string; text: string }> {
  const url = importUrl(value), maxBytes = options.maxBytes ?? 2_000_000;
  const fetcher = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  let response: Response;
  try { response = await fetcher(url.toString(), { method: "GET", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", ...(options.signal ? { signal: options.signal } : {}) }); }
  catch (error) { if (options.signal?.aborted) throw error; throw new Error(URL_IMPORT_BLOCKED); }
  if (!response.ok) throw new Error(`The link returned HTTP ${response.status}.`);
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (/^text\/html|^application\/(?:pdf|zip)|^image\/|^audio\/|^video\//u.test(type)) {
    throw new Error(type.startsWith("application/pdf") ? "That link is a PDF. Add it under “PDF documents” instead." : "That link is a web page or a binary file, not a Markdown or text file. Copy the text and paste it instead.");
  }
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error(`Too large (the limit is ${mb(maxBytes)}).`);
  const text = await response.text();
  if (text.length > maxBytes) throw new Error(`Too large (the limit is ${mb(maxBytes)}).`);
  if (!text.trim()) throw new Error("The link returned no text.");
  return { name: urlFileName(url, "md"), text };
}
