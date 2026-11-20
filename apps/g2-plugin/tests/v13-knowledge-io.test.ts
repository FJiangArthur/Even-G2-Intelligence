import { describe, expect, it, vi } from "vitest";
import { LEGACY_HISTORY_KEY, pdfSessionId, type PdfFileStatus } from "@helix/conversation-sdk";
import { G2ConversationController, OMI_AUTO_IMPORT_INTERVAL_MS, OMI_AUTO_IMPORT_RETRY_MS, OMI_AUTO_IMPORT_STORAGE_KEY } from "../src/controller";
import { ConversationPresentation } from "../src/presentation";
import type { GlassesRenderer } from "../src/glasses-renderer";
import { URL_IMPORT_BLOCKED, exportFile, fetchTextFromUrl, inEmbeddedWebView, readTextFiles, urlFileName, importUrl, type TransferEnv } from "../src/file-transfer";
import { autoImportText, markdownFileLines, pdfFileLine } from "../src/knowledge-panel";
import { extractPdfText, pageText, type PdfjsLike } from "../src/pdf-local";

/* ------------------------------------------------------------------ fixtures */

function bridgeWith(storage: Map<string, string>) {
  return {
    getLocalStorage: async (key: string) => storage.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => 0, textContainerUpgrade: async () => true,
    audioControl: async () => true, shutDownPageContainer: async () => true, onEvenHubEvent: () => () => undefined,
  };
}
async function controllerWith(storage = new Map<string, string>()) {
  const controller = new G2ConversationController(bridgeWith(storage) as never, { initialize: async () => undefined, render: () => undefined, dispose: async () => undefined } as unknown as GlassesRenderer, new ConversationPresentation());
  await controller.initialize();
  return { storage, controller };
}
const omiConversation = (id: string) => ({ id, created_at: "2026-11-18T09:00:00Z", started_at: "2026-11-18T09:00:00Z", finished_at: "2026-11-18T09:05:00Z",
  structured: { title: `Standup ${id}` }, transcript_segments: [{ text: "The calibration rig ships on Friday.", start: 1, end: 3, speaker_name: "Ada" }] });

/** A real, minimal PDF: one page per string, Helvetica, uncompressed. Empty string = a page without text (like a scan). */
function makePdf(pages: readonly string[]): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const lines = text ? text.split("\n").map((line, n) => `BT /F1 12 Tf 72 ${720 - n * 16} Td (${line.replace(/[()\\]/gu, "\\$&")}) Tj ET`).join("\n") : "";
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`;
  });
  let out = "%PDF-1.4\n"; const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) { offsets[n] = out.length; out += `${n} 0 obj\n${objects[n]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
/** pdfjs in Node (the legacy build runs its worker code in-process). */
const nodePdfjs = async () => await import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as PdfjsLike;
const pdfFile = (name: string, pages: readonly string[]) => { const bytes = makePdf(pages); return { name, size: bytes.length, data: new Blob([bytes as BlobPart], { type: "application/pdf" }) }; };

/* ------------------------------------------------------------------ export */

describe("v0.13 export fallbacks", () => {
  const file = { name: "2026-11-19 Vendor call.md", content: "# Vendor call\n", type: "text/markdown", text: "# Vendor call\n" };
  const env = (patch: Partial<TransferEnv>): TransferEnv => ({ embedded: false, ...patch });

  it("root cause: in the Even app WebView a blob download cannot be confirmed, so it is no longer attempted or reported as done", async () => {
    const download = vi.fn(), copy = vi.fn(async () => true);
    const result = await exportFile(file, env({ embedded: true, download, copy, navigator: {} }));
    expect(download).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith("# Vendor call\n");
    expect(result).toMatchObject({ method: "clipboard", message: expect.stringMatching(/Even app cannot save files.*copied to the clipboard/u) });
    expect(inEmbeddedWebView({ flutter_inappwebview: {} })).toBe(true);
    expect(inEmbeddedWebView({})).toBe(false);
  });

  it("prefers the share sheet with the file when the WebView offers it, retrying a Markdown file as text/plain", async () => {
    const shared: File[] = [];
    const navigator = { canShare: ({ files }: { files?: File[] }) => files![0]!.type === "text/plain", share: async ({ files }: { files?: File[] }) => { shared.push(...files!); } };
    const download = vi.fn();
    const result = await exportFile(file, env({ embedded: true, navigator, download, copy: async () => true }));
    expect(result.method).toBe("share");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ name: file.name, type: "text/plain" });
    expect(await shared[0]!.text()).toBe("# Vendor call\n");
    expect(download).not.toHaveBeenCalled();
  });

  it("a cancelled share is reported as cancelled and runs no fallback; a failed share falls through", async () => {
    const copy = vi.fn(async () => true);
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const cancelled = await exportFile(file, env({ embedded: true, copy, navigator: { canShare: () => true, share: async () => { throw abort; } } }));
    expect(cancelled).toMatchObject({ method: "share", cancelled: true, message: "Share cancelled. Nothing was exported." });
    expect(copy).not.toHaveBeenCalled();
    const denied = Object.assign(new Error("no gesture"), { name: "NotAllowedError" });
    const fell = await exportFile(file, env({ embedded: true, copy, navigator: { canShare: () => true, share: async () => { throw denied; } } }));
    expect(fell.method).toBe("clipboard");
  });

  it("an ordinary browser downloads and returns the link; with everything blocked the text is shown in the page", async () => {
    const link = { href: "blob:x" };
    const download = vi.fn((_name: string, _blob: Blob) => link);
    const zip = { name: "helix-vault.zip", content: new Uint8Array([80, 75, 5, 6]), type: "application/zip", text: "<!-- a.md -->\n# A" };
    const share = vi.fn(async () => undefined);
    const result = await exportFile(zip, env({ download, navigator: { canShare: () => true, share } }));
    expect(result).toMatchObject({ method: "download", link });
    expect(share).not.toHaveBeenCalled(); // a browser that can download does not detour through the share sheet
    expect(download.mock.calls[0]![0]).toBe("helix-vault.zip");
    expect(download.mock.calls[0]![1]).toMatchObject({ size: 4, type: "application/zip" });
    const view = await exportFile(zip, env({ embedded: true, copy: async () => false }));
    expect(view).toMatchObject({ method: "view", message: expect.stringMatching(/clipboard is blocked too.*shown below/u) });
    const broken = await exportFile(zip, env({ download: () => { throw new Error("blocked"); }, copy: async () => { throw new Error("denied"); } }));
    expect(broken).toMatchObject({ method: "view", message: expect.stringMatching(/browser blocked the download/u) });
  });
});

/* ------------------------------------------------------------------ import */

describe("v0.13 note import without losing files", () => {
  it("root cause: one unreadable file used to reject the whole batch silently; now each file has its own result", async () => {
    const results = await readTextFiles([
      { name: "a.md", size: 10, text: async () => "# A\n\nAlpha" },
      { name: "locked.md", size: 10, text: async () => { throw new Error("The file could not be read."); } },
      { name: "huge.md", size: 3_000_000, text: async () => "x" },
      { name: "empty.md", size: 0, text: async () => "  \n" },
      { name: "image.md", size: 4, text: async () => "\u0000PNG" },
    ]);
    expect(results.map(item => item.ok)).toEqual([true, false, false, false, false]);
    expect(results.slice(1).map(item => item.ok ? "" : item.error)).toEqual(["The file could not be read.", "Too large (2.9 MB; the limit is 1.9 MB).", "The file is empty.", "Not a text file."]);
    expect(markdownFileLines(["a.md", "b.md", "locked.md"], [{ name: "locked.md", error: "The file could not be read." }], [{ name: "b.md", error: "b.md: Markdown note is too large to import (2 MB limit)." }])).toEqual([
      { name: "a.md", state: "done", detail: "Imported" },
      { name: "b.md", state: "failed", detail: "Failed: Markdown note is too large to import (2 MB limit)." },
      { name: "locked.md", state: "failed", detail: "Failed: The file could not be read." },
    ]);
  });

  it("the controller reports notes beyond the batch limit instead of dropping them", async () => {
    const { controller } = await controllerWith();
    const files = Array.from({ length: 201 }, (_, i) => ({ name: `note-${i}.md`, text: `# Note ${i}\n\nBody ${i}` }));
    const result = await controller.importMarkdownFiles(files);
    expect(result.imported).toBe(200);
    expect(result.failed).toEqual([{ name: "note-200.md", error: expect.stringMatching(/Only 200 notes/u) }]);
    await controller.dispose();
  });

  it("imports from a link when the host allows it and explains the WebView/CORS block when it does not", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("# Linked note\n\nBody", { headers: { "content-type": "text/markdown; charset=utf-8" } }));
    await expect(fetchTextFromUrl(" https://example.org/notes/Plan%20Q4.md ", { fetch })).resolves.toEqual({ name: "Plan Q4.md", text: "# Linked note\n\nBody" });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: "omit", method: "GET" });
    await expect(fetchTextFromUrl("https://example.org/x.md", { fetch: async () => { throw new TypeError("Failed to fetch"); } })).rejects.toThrow(URL_IMPORT_BLOCKED);
    await expect(fetchTextFromUrl("https://example.org/page", { fetch: async () => new Response("<html>", { headers: { "content-type": "text/html" } }) })).rejects.toThrow(/web page or a binary file/u);
    await expect(fetchTextFromUrl("https://example.org/a.pdf", { fetch: async () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }) })).rejects.toThrow(/PDF documents/u);
    await expect(fetchTextFromUrl("https://example.org/x.md", { fetch: async () => new Response("nope", { status: 404 }) })).rejects.toThrow("The link returned HTTP 404.");
    await expect(fetchTextFromUrl("https://example.org/x.md", { maxBytes: 5, fetch: async () => new Response("too long for this") })).rejects.toThrow(/Too large/u);
    for (const bad of ["notes.md", "http://example.org/x.md", "file:///etc/passwd", "https://user:pw@example.org/x.md"]) expect(() => importUrl(bad)).toThrow(/https/u);
    expect(urlFileName(new URL("https://example.org/"), "pdf")).toBe("example.org.pdf");
    expect(urlFileName(new URL("https://example.org/a/Paper.PDF?download=1"), "pdf")).toBe("Paper.PDF");
  });
});

/* ------------------------------------------------------------------ auto-import */

describe("v0.13 Omi auto-import", () => {
  const T0 = Date.parse("2026-11-19T10:00:00.000Z");

  it("root cause: nothing ever imported automatically. Off by default; on, it imports, records the outcome and persists without the key", async () => {
    const { storage, controller } = await controllerWith();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json([omiConversation("a")]));
    controller.omiImportFetch = fetch;
    controller.configureAutoImport(() => "omi_dev_secret", 3_600_000);
    expect(controller.historySnapshot().autoImport).toEqual({ enabled: false, running: false });
    expect(await controller.maybeAutoImport("interval", T0)).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();

    const views: boolean[] = [];
    controller.subscribeHistory(state => views.push(state.autoImport.running));
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    try { expect(await controller.setAutoImportEnabled(true)).toBe("imported"); } finally { vi.useRealTimers(); }
    expect(views).toContain(true); expect(views.at(-1)).toBe(false);
    expect(controller.listHistorySessions().map(session => session.id)).toEqual(["omi:a"]);
    expect(controller.autoImportView()).toMatchObject({ enabled: true, running: false, lastImported: 1, lastSuccessAt: "2026-11-19T10:00:00.000Z" });
    expect(controller.autoImportView().lastError).toBeUndefined();
    // The first run reads 14 days back, with transcripts, straight from api.omi.me with the Omi key.
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe("https://api.omi.me/v1/dev/user/conversations");
    expect(url.searchParams.get("start_date")).toBe("2026-11-05T10:00:00.000Z");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: "Bearer omi_dev_secret" } });
    const saved = storage.get(OMI_AUTO_IMPORT_STORAGE_KEY)!;
    expect(JSON.parse(saved)).toEqual({ enabled: true, lastAttemptAt: "2026-11-19T10:00:00.000Z", lastSuccessAt: "2026-11-19T10:00:00.000Z", lastImported: 1 });
    expect(saved).not.toContain("omi_dev_secret");
    expect([...storage.values()].join("\n")).not.toContain("omi_dev_secret");
    await controller.dispose();
  });

  it("runs on its own after a restart, only when due, incrementally from the last success", async () => {
    const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
    const storage = new Map([[OMI_AUTO_IMPORT_STORAGE_KEY, JSON.stringify({ enabled: true, lastAttemptAt: iso(now), lastSuccessAt: iso(now), lastImported: 1 })]]);
    const { controller } = await controllerWith(storage);
    const fetch = vi.fn(async (_url: string) => Response.json([omiConversation("b"), omiConversation("c")]));
    controller.omiImportFetch = fetch;
    controller.configureAutoImport(() => "omi_dev_secret", 3_600_000);
    expect(controller.autoImportView().enabled).toBe(true); // the switch survived the restart
    expect(await controller.maybeAutoImport("interval", now + OMI_AUTO_IMPORT_INTERVAL_MS - 1)).toBe("not-due");
    expect(await controller.maybeAutoImport("resume", now + 60_000)).toBe("not-due");
    expect(fetch).not.toHaveBeenCalled();
    expect(await controller.maybeAutoImport("interval", now + OMI_AUTO_IMPORT_INTERVAL_MS)).toBe("imported");
    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("start_date")).toBe(iso(now - 24 * 60 * 60_000)); // a day of overlap
    expect(controller.autoImportView()).toMatchObject({ lastImported: 2, lastSuccessAt: iso(now + OMI_AUTO_IMPORT_INTERVAL_MS) });
    expect(controller.listHistorySessions()).toHaveLength(2);
    await controller.dispose();
  });

  it("the schedule started by configureAutoImport imports without any tap once the app is ready", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const storage = new Map([[OMI_AUTO_IMPORT_STORAGE_KEY, JSON.stringify({ enabled: true })]]);
      const controller = new G2ConversationController(bridgeWith(storage) as never, { initialize: async () => undefined, render: () => undefined, dispose: async () => undefined } as unknown as GlassesRenderer, new ConversationPresentation());
      const fetch = vi.fn(async (_url: string) => Response.json([omiConversation("startup")]));
      controller.omiImportFetch = fetch;
      // Same order as the app: the Knowledge panel registers the key before the controller is initialized.
      controller.configureAutoImport(() => "omi_dev_secret", 60_000);
      expect(fetch).not.toHaveBeenCalled();
      await controller.initialize(); // -> maybeAutoImport("startup")
      await vi.waitFor(() => expect(controller.autoImportView().lastImported).toBe(1));
      expect(controller.listHistorySessions().map(session => session.id)).toEqual(["omi:startup"]);
      // Later ticks do nothing until the interval has passed, and nothing after dispose.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      await controller.dispose();
      await vi.advanceTimersByTimeAsync(2 * OMI_AUTO_IMPORT_INTERVAL_MS);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("says why it did not import: no key (retries as soon as one is there), or the Omi error (retries after a few minutes)", async () => {
    const { storage, controller } = await controllerWith();
    let key = "";
    let respond = async (): Promise<Response> => new Response("private", { status: 401 });
    const fetch = vi.fn(async (_url: string) => respond());
    controller.omiImportFetch = fetch;
    controller.configureAutoImport(() => key, 3_600_000);
    expect(await controller.setAutoImportEnabled(true)).toBe("no-key");
    expect(controller.autoImportView().lastError).toMatch(/no Omi key.*Save API keys on this phone/u);
    expect(controller.autoImportView().lastAttemptAt).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();

    key = "omi_dev_secret";
    expect(await controller.maybeAutoImport("interval", T0)).toBe("failed");
    expect(controller.autoImportView()).toMatchObject({ enabled: true, lastAttemptAt: "2026-11-19T10:00:00.000Z", lastError: expect.stringMatching(/Omi import request failed/u) });
    expect(controller.autoImportView().lastError).not.toMatch(/private|omi_dev_secret/u);
    expect(JSON.parse(storage.get(OMI_AUTO_IMPORT_STORAGE_KEY)!).lastError).toMatch(/Omi import request failed/u);
    expect(autoImportText(controller.autoImportView())).toMatch(/^Not imported: Omi import request failed.*retries in a few minutes/u);

    expect(await controller.maybeAutoImport("interval", T0 + OMI_AUTO_IMPORT_RETRY_MS - 1)).toBe("not-due");
    respond = async () => Response.json([omiConversation("later")]);
    expect(await controller.maybeAutoImport("interval", T0 + OMI_AUTO_IMPORT_RETRY_MS)).toBe("imported");
    expect(controller.autoImportView().lastError).toBeUndefined();

    // A manual import in progress is not doubled.
    let release!: (response: Response) => void;
    respond = () => new Promise<Response>(resolve => { release = resolve; });
    const manual = controller.importOmi({ key, fetch: () => respond() });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await controller.maybeAutoImport("manual", T0 + 10 * OMI_AUTO_IMPORT_INTERVAL_MS)).toBe("busy");
    release(Response.json([])); await manual;

    expect(await controller.setAutoImportEnabled(false)).toBe("disabled");
    expect(JSON.parse(storage.get(OMI_AUTO_IMPORT_STORAGE_KEY)!).enabled).toBe(false);
    expect(await controller.maybeAutoImport("manual", T0 + 20 * OMI_AUTO_IMPORT_INTERVAL_MS)).toBe("disabled");
    await controller.dispose();
  });

  it("status text covers off, first run, success and failure", () => {
    const format = (iso: string) => iso.slice(11, 16);
    expect(autoImportText({ enabled: false, running: false })).toMatch(/^Off\./u);
    expect(autoImportText({ enabled: true, running: false })).toMatch(/first import starts now.*14 days/u);
    expect(autoImportText({ enabled: true, running: true })).toBe("Importing new Omi conversations…");
    expect(autoImportText({ enabled: true, running: false, lastSuccessAt: "2026-11-19T10:00:00.000Z", lastImported: 1 }, format)).toBe("Last import 10:00: 1 conversation checked. Checks again about every 30 minutes while Helix is open.");
  });
});

/* ------------------------------------------------------------------ PDFs */

describe("v0.13 on-phone PDF parsing (pdfjs, real PDF bytes)", () => {
  it("extracts the text layer page by page; a page without text yields nothing; damaged files are explained", async () => {
    const pdfjs = await nodePdfjs();
    const doc = await extractPdfText(makePdf(["Orin lead time is twelve weeks.\nSecond line of page one.", "", "Calibration drift fixed in firmware nine."]), { pdfjs });
    expect(doc.pageCount).toBe(3);
    expect(doc.pages.map(page => page.page)).toEqual([1, 3]);
    expect(doc.pages[0]!.text).toMatch(/Orin lead time is twelve weeks\.\s+Second line of page one\./u);
    expect(doc.pages[1]!.text).toBe("Calibration drift fixed in firmware nine.");
    expect(await extractPdfText(makePdf(["a", "b", "c"]), { pdfjs, maxPages: 2 })).toMatchObject({ pageCount: 3, truncated: true, pages: [{ page: 1 }, { page: 2 }] });
    await expect(extractPdfText(new TextEncoder().encode("%PDF-1.4\nthis is not really a pdf"), { pdfjs })).rejects.toThrow(/not a readable PDF|could not be opened/u);
    const abort = new AbortController(); abort.abort();
    await expect(extractPdfText(makePdf(["a"]), { pdfjs, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("joins text items into lines and paragraphs", () => {
    expect(pageText([{ str: "Lead", transform: [1, 0, 0, 1, 72, 700] }, { str: "time", hasEOL: true, transform: [1, 0, 0, 1, 100, 700] }, { str: "next line", hasEOL: true, transform: [1, 0, 0, 1, 72, 686] },
      { str: "New paragraph", transform: [1, 0, 0, 1, 72, 640] }, { noText: true }])).toBe("Lead time\nnext line\n\nNew paragraph");
  });
});

describe("v0.13 PDFs in the controller", () => {
  it("local parser: several PDFs become searchable knowledge; a scanned and a broken one fail alone; re-adding replaces", async () => {
    const { controller } = await controllerWith(), pdfjs = await nodePdfjs();
    const extractLocal = (data: Uint8Array, options: { signal?: AbortSignal; maxPages: number }) => extractPdfText(data, { ...options, pdfjs });
    const vendor = pdfFile("Vendor review.pdf", ["Orin lead time is twelve weeks.", "The budget is sixty thousand."]);
    const seen: PdfFileStatus["state"][][] = [];
    controller.subscribeHistory(state => { if (state.pdfImport.running) seen.push(state.pdfImport.files.map(file => file.state)); });
    const files = await controller.importPdfs([
      vendor, pdfFile("Scan.pdf", ["", ""]), { name: "Broken.pdf", size: 20, data: new Blob(["%PDF-1.4 garbage garbage"]) }, pdfFile("Firmware.pdf", ["Calibration drift was fixed in firmware nine."]),
    ], { parser: "local", extractLocal });
    expect(files.map(file => file.state)).toEqual(["done", "failed", "failed", "done"]);
    expect(files[0]).toMatchObject({ pages: 2, passages: 2, sessionId: pdfSessionId(vendor) });
    expect(files[1]!.detail).toMatch(/scanned or image-only.*no OCR/u);
    expect(files[2]!.detail).toMatch(/not a readable PDF|could not be opened/u);
    expect(seen.some(states => states[0] === "parsing" && states[3] === "queued")).toBe(true);
    expect(controller.historySnapshot().pdfImport).toMatchObject({ running: false, files: [{ state: "done" }, { state: "failed" }, { state: "failed" }, { state: "done" }] });
    expect(controller.historySnapshot().status).toBe("Added 2 of 4 PDFs to the knowledge base · 2 failed.");
    // Stored as imported documents with the pdf tag, found by the existing keyword search.
    const session = controller.listHistorySessions().find(item => item.id === files[0]!.sessionId)!;
    expect(session).toMatchObject({ source: "obsidian", title: "Vendor review", tags: ["pdf"] });
    expect(controller.searchHistory("budget sixty thousand")[0]).toMatchObject({ session: { id: session.id }, entry: { metadata: { origin: "pdf-local", section: "Page 2" } } });
    expect(controller.searchHistory("firmware nine")[0]?.session.title).toBe("Firmware");
    // Same file again: replaced, not duplicated.
    await controller.importPdfs([vendor], { parser: "local", extractLocal });
    expect(controller.listHistorySessions().filter(item => item.title === "Vendor review")).toHaveLength(1);
    expect(controller.historyEntryCount(session.id)).toBe(2);
    await controller.dispose();
  });

  it("OpenAI parser: uses the key for api.openai.com only, saves the text locally, and syncs it to the OpenAI knowledge base when that is in use", async () => {
    const storage = new Map<string, string>(), at = "2026-11-10T10:00:00.000Z";
    storage.set(LEGACY_HISTORY_KEY, JSON.stringify({ version: 1, sessions: [{ id: "s1", source: "helix", title: "Vendor call", startedAt: at, updatedAt: at }],
      entries: [{ id: "s1:e1", sessionId: "s1", kind: "transcript", text: "Hello there.", occurredAt: at, speaker: "Them" }] }));
    const { controller } = await controllerWith(storage);
    let seq = 0; const urls: string[] = [], stored: string[] = [], purposes: string[] = [];
    controller.keyTestFetch = async (url: string, init: RequestInit = {}) => {
      urls.push(url); expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
      const path = url.replace("https://api.openai.com/v1", ""), method = init.method ?? "GET";
      if (method === "POST" && path === "/vector_stores") return Response.json({ id: `vs_${++seq}` });
      if (method === "POST" && path === "/files") {
        const form = init.body as FormData; purposes.push(String(form.get("purpose")));
        if (form.get("purpose") === "assistants") stored.push(await (form.get("file") as File).text());
        return Response.json({ id: `file-${++seq}` });
      }
      if (method === "POST" && path === "/responses") return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "=== Page 1 ===\nThe scanned contract renews on 1 March." }] }] });
      return Response.json({ id: "ok", deleted: true });
    };
    await expect(controller.importPdfs([pdfFile("Contract.pdf", [""])], { parser: "openai", openaiKey: "  " })).rejects.toThrow(/needs your OpenAI API key/u);
    await controller.setKnowledgeSource("openai");
    await controller.syncOpenAIKnowledge("sk-test");
    expect(stored).toHaveLength(1);

    const files = await controller.importPdfs([pdfFile("Contract.pdf", [""]), { name: "paper.pdf", url: "https://example.org/paper.pdf" }], { parser: "openai", openaiKey: "sk-test" });
    expect(files.map(file => file.state)).toEqual(["done", "done"]);
    expect(urls.every(url => url.startsWith("https://api.openai.com/v1/"))).toBe(true);
    expect(purposes.filter(purpose => purpose === "user_data")).toHaveLength(1); // the link was not uploaded by the phone
    expect(controller.searchHistory("contract renews").find(hit => hit.session.title === "Contract")).toMatchObject({ session: { tags: ["pdf"] }, entry: { metadata: { origin: "pdf-openai", section: "Page 1" } } });
    // Both PDFs went on to the vector store as ordinary knowledge documents.
    expect(stored).toHaveLength(3);
    expect(stored.slice(1).join("\n")).toContain("The scanned contract renews on 1 March.");
    expect(controller.knowledgeBase()).toMatchObject({ source: "openai", synced: 3, pending: 0 });
    await controller.dispose();
  });

  it("only one batch at a time; cancel keeps what was already added; rows read well", async () => {
    const { controller } = await controllerWith();
    let release!: () => void;
    const slow = async (data: Uint8Array) => { await new Promise<void>(resolve => { release = resolve; }); return { pageCount: 1, pages: [{ page: 1, text: `Text of ${data.length} bytes` }] }; };
    const batch = controller.importPdfs([pdfFile("a.pdf", ["a"]), pdfFile("b.pdf", ["b"])], { parser: "local", extractLocal: slow });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(controller.importPdfs([pdfFile("c.pdf", ["c"])], { parser: "local", extractLocal: slow })).rejects.toThrow(/already being added/u);
    release();
    await vi.waitFor(() => expect(controller.pdfImportView().files[0]!.state).toBe("done"));
    controller.cancelPdfImport(); release();
    expect((await batch).map(file => file.state)).toEqual(["done", "cancelled"]);
    expect(controller.listHistorySessions().map(session => session.title)).toEqual(["a"]);
    expect(pdfFileLine({ name: "a.pdf", state: "done", pages: 1, passages: 3 })).toEqual({ name: "a.pdf", state: "done", detail: "Added: 1 page, 3 searchable passages" });
    expect(pdfFileLine({ name: "a.pdf", state: "parsing" }, "openai").detail).toMatch(/OpenAI is reading/u);
    expect(pdfFileLine({ name: "a.pdf", state: "failed", detail: "Not a PDF file." })).toEqual({ name: "a.pdf", state: "failed", detail: "Failed: Not a PDF file." });
    await controller.dispose();
  });
});
