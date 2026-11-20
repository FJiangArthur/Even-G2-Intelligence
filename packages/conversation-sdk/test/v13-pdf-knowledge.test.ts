import { describe, expect, it, vi } from "vitest";
import {
  LocalHistoryStore, PDF_LIMITS, extractPdfWithOpenAI, importOmiConversations, ingestPdfs, pdfPassages, pdfSessionId, pdfToSession, splitPdfPages,
  type PdfDocumentText, type PdfFileStatus, type PdfSessionResult,
} from "../src/index.js";

const key = "test-only-placeholder";
const pdfBlob = (text = "%PDF-1.4 fake") => new Blob([text], { type: "application/pdf" });
async function store() { const s = new LocalHistoryStore({ getLocalStorage: async () => "", setLocalStorage: async () => true }); await s.load(); return s; }
const saver = (s: LocalHistoryStore) => async ({ session, entries }: PdfSessionResult) => { await s.upsertSession(session); await s.upsertEntries(entries); };

/** Files + Responses endpoints of api.openai.com. `reply(fileRef)` is the model output for one PDF. */
function fakeOpenAI(reply: (file: Record<string, string>) => Response | Promise<Response>) {
  const calls: { method: string; path: string; body?: unknown; headers: Record<string, string> }[] = [];
  let seq = 0;
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.openai.com/v1", ""), method = init.method ?? "GET";
    const headers = init.headers as Record<string, string>;
    if (method === "POST" && path === "/files") { calls.push({ method, path, headers, body: { purpose: (init.body as FormData).get("purpose"), name: ((init.body as FormData).get("file") as File).name } }); return Response.json({ id: `file-${++seq}` }); }
    if (method === "POST" && path === "/responses") { const body = JSON.parse(init.body as string); calls.push({ method, path, headers, body }); return reply(body.input[0].content[0]); }
    calls.push({ method, path, headers });
    return Response.json({ deleted: true });
  });
  return { fetch, calls };
}
const modelText = (text: string, status = "completed") => Response.json({ status, output: [{ type: "message", content: [{ type: "output_text", text }] }] });

describe("v0.13 PDF text -> knowledge session", () => {
  it("splits text into passages at paragraph, sentence and word boundaries and joins hyphenated line breaks", () => {
    expect(pdfPassages("Lead time is twelve weeks.\n\nThe Orin mod-\nule ships in March.")).toEqual(["Lead time is twelve weeks. The Orin module ships in March."]);
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about the sensor fusion roadmap.`).join(" ");
    const parts = pdfPassages(long, 300);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every(part => part.length <= 300)).toBe(true);
    expect(parts.join(" ")).toBe(long);
    expect(pdfPassages("x".repeat(700), 300).map(part => part.length)).toEqual([300, 300, 100]);
  });

  it("stores passages as retrievable transcript entries with page provenance, under a stable id", async () => {
    const s = await store();
    const doc: PdfDocumentText = { pageCount: 2, pages: [{ page: 1, text: "Quarterly vendor review.\n\nOrin lead time is twelve weeks." }, { page: 2, text: "预算给了六万元。" }] };
    const result = pdfToSession({ name: "Vendor Review Q3.pdf", size: 1234 }, doc, { parser: "local", now: "2026-11-19T10:00:00.000Z" });
    expect(result).toMatchObject({ pages: 2, truncated: false });
    expect(result.session).toMatchObject({ id: pdfSessionId({ name: "Vendor Review Q3.pdf", size: 1234 }), source: "obsidian", title: "Vendor Review Q3", tags: ["pdf"] });
    expect(result.session.id).toMatch(/^pdf:Vendor-Review-Q3-[0-9a-f]+$/u);
    expect(result.entries.map(entry => entry.metadata)).toEqual([{ origin: "pdf-local", section: "Page 1" }, { origin: "pdf-local", section: "Page 2" }]);
    await saver(s)(result);
    // The existing on-phone keyword retrieval finds PDF text, in English and Chinese.
    expect(s.retrieve("Orin lead time")[0]).toMatchObject({ session: { title: "Vendor Review Q3" }, entry: { kind: "transcript", metadata: { section: "Page 1" } } });
    expect(s.retrieve("预算")[0]?.entry.text).toContain("六万元");
    expect(pdfSessionId({ name: "Vendor Review Q3.pdf", size: 1235 })).not.toBe(result.session.id);
  });

  it("caps the text per PDF and says so; a PDF without text explains the scanned-PDF limit", () => {
    const page = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ${"lorem ipsum ".repeat(90)}`).join("\n\n");
    const result = pdfToSession({ name: "big.pdf" }, { pages: [{ page: 1, text: page }] }, { parser: "openai" });
    expect(result.truncated).toBe(true);
    expect(result.chars).toBeLessThanOrEqual(PDF_LIMITS.maxChars);
    expect(result.session.keyFacts?.[0]).toMatch(/parsed by OpenAI \(text truncated\)/u);
    expect(() => pdfToSession({ name: "scan.pdf" }, { pages: [], pageCount: 3 }, { parser: "local" })).toThrow(/scanned or image-only.*no OCR.*OpenAI parser/u);
  });

  it("reads page markers from model output", () => {
    expect(splitPdfPages("=== Page 1 ===\nAlpha\n\n=== Page 2 ===\nBeta\n=== Page 3 ===\n")).toEqual([{ page: 1, text: "Alpha" }, { page: 2, text: "Beta" }]);
    expect(splitPdfPages("No markers at all")).toEqual([{ page: 0, text: "No markers at all" }]);
  });
});

describe("v0.13 OpenAI PDF parser", () => {
  it("uploads with purpose user_data, asks the Responses API with input_file, and deletes the upload", async () => {
    const api = fakeOpenAI(() => modelText("=== Page 1 ===\nOrin lead time is twelve weeks."));
    const stages: string[] = [];
    const result = await extractPdfWithOpenAI(api.fetch, ` ${key} `, { name: "Vendor.pdf", data: pdfBlob() }, { model: "gpt-4.1-mini", onStage: stage => stages.push(stage) });
    expect(result).toMatchObject({ pages: [{ page: 1, text: "Orin lead time is twelve weeks." }], pageCount: 1, model: "gpt-4.1-mini" });
    expect(stages).toEqual(["uploading", "parsing"]);
    expect(api.calls.map(call => `${call.method} ${call.path}`)).toEqual(["POST /files", "POST /responses", "DELETE /files/file-1"]);
    expect(api.calls[0]!.body).toEqual({ purpose: "user_data", name: "Vendor.pdf" });
    const request = api.calls[1]!.body as { model: string; store: boolean; max_output_tokens: number; input: { content: Record<string, string>[] }[] };
    expect(request).toMatchObject({ model: "gpt-4.1-mini", store: false, max_output_tokens: 32_768 });
    expect(request.input[0]!.content[0]).toEqual({ type: "input_file", file_id: "file-1" });
    expect(request.input[0]!.content[1]).toMatchObject({ type: "input_text" });
    for (const [url, init] of api.fetch.mock.calls) {
      expect(url.startsWith("https://api.openai.com/v1/")).toBe(true); // the key goes to OpenAI only
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", headers: { Authorization: `Bearer ${key}` } });
    }
  });

  it("passes a link as file_url without downloading or uploading it, and rejects non-https links", async () => {
    const api = fakeOpenAI(() => modelText("Plain text without page markers"));
    const result = await extractPdfWithOpenAI(api.fetch, key, { name: "paper.pdf", url: "https://example.org/paper.pdf" });
    expect(result.pages).toEqual([{ page: 0, text: "Plain text without page markers" }]);
    expect(api.calls.map(call => call.path)).toEqual(["/responses"]);
    expect((api.calls[0]!.body as { input: { content: unknown[] }[] }).input[0]!.content[0]).toEqual({ type: "input_file", file_url: "https://example.org/paper.pdf" });
    await expect(extractPdfWithOpenAI(api.fetch, key, { name: "x.pdf", url: "http://example.org/x.pdf" })).rejects.toThrow(/https/u);
    await expect(extractPdfWithOpenAI(api.fetch, key, { name: "x.pdf", url: "https://user:pw@example.org/x.pdf" })).rejects.toThrow(/sign-in/u);
    await expect(extractPdfWithOpenAI(api.fetch, "  ", { name: "x.pdf", data: pdfBlob() })).rejects.toThrow(/OpenAI API key/u);
    expect(api.calls).toHaveLength(1);
  });

  it("deletes the upload when parsing fails, marks output cut by the token limit, and never echoes the key", async () => {
    const failing = fakeOpenAI(() => new Response(`private ${key}`, { status: 500 }));
    const error = await extractPdfWithOpenAI(failing.fetch, key, { name: "a.pdf", data: pdfBlob() }).catch(e => e as Error);
    expect(String(error)).toMatch(/OpenAI PDF: request failed \(HTTP 500\)/u);
    expect(String(error)).not.toContain(key);
    expect(failing.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/files/file-1" });
    const cut = fakeOpenAI(() => modelText("=== Page 1 ===\nAlpha", "incomplete"));
    expect(await extractPdfWithOpenAI(cut.fetch, key, { name: "a.pdf", data: pdfBlob() })).toMatchObject({ truncated: true });
  });
});

describe("v0.13 multi-PDF ingestion", () => {
  const extractLocal = async (data: Uint8Array): Promise<PdfDocumentText> => {
    const text = new TextDecoder().decode(data);
    if (text.includes("BROKEN")) throw new Error("This file is not a readable PDF (damaged or not a PDF).");
    if (text.includes("SCAN")) return { pages: [], pageCount: 4 };
    return { pageCount: 1, pages: [{ page: 1, text: text.replace("%PDF-1.4 ", "") }] };
  };

  it("local parser: one bad file, one scanned file and one oversized file do not lose the good ones; progress is per file", async () => {
    const s = await store(), seen: PdfFileStatus[][] = [];
    const inputs = [
      { name: "good-1.pdf", data: pdfBlob("%PDF-1.4 The Orin lead time is twelve weeks.") },
      { name: "broken.pdf", data: pdfBlob("%PDF-1.4 BROKEN") },
      { name: "scan.pdf", data: pdfBlob("%PDF-1.4 SCAN") },
      { name: "huge.pdf", size: PDF_LIMITS.maxBytes + 1, url: "https://example.org/huge.pdf" },
      { name: "notes.txt", data: new Blob(["just text"]) },
      { name: "empty.pdf", data: new Blob([]) },
      { name: "good-2.pdf", data: pdfBlob("%PDF-1.4 Calibration drift was fixed in firmware nine.") },
    ];
    const files = await ingestPdfs(inputs, { parser: "local", extractLocal, save: saver(s), onStatus: status => seen.push([...status]) });
    expect(files.map(file => file.state)).toEqual(["done", "failed", "failed", "failed", "failed", "failed", "done"]);
    expect(files[0]).toMatchObject({ pages: 1, passages: 1, truncated: false, sessionId: pdfSessionId({ name: "good-1.pdf", size: inputs[0]!.data!.size }) });
    expect(files[1]!.detail).toMatch(/not a readable PDF/u);
    expect(files[2]!.detail).toMatch(/scanned or image-only/u);
    expect(files[3]!.detail).toMatch(/Larger than the 30 MB limit/u);
    expect(files[4]!.detail).toBe("Not a PDF file.");
    expect(files[5]!.detail).toBe("The file is empty.");
    expect(s.listSessions().map(session => session.title).sort()).toEqual(["good-1", "good-2"]);
    expect(s.retrieve("calibration drift")[0]?.session.title).toBe("good-2");
    // Every state of the first file was reported while the others were still queued.
    expect(seen.map(status => status[0]!.state).filter((state, i, all) => state !== all[i - 1])).toEqual(["queued", "reading", "parsing", "saving", "done"]);
    expect(seen.find(status => status[0]!.state === "parsing")![6]!.state).toBe("queued");
  });

  it("a storage failure for one PDF is reported for that PDF only", async () => {
    const s = await store(); let n = 0;
    const files = await ingestPdfs([{ name: "a.pdf", data: pdfBlob("%PDF-1.4 alpha text") }, { name: "b.pdf", data: pdfBlob("%PDF-1.4 beta text") }], {
      parser: "local", extractLocal, save: async result => { if (++n === 1) throw new Error("Local history is too large to save."); await saver(s)(result); } });
    expect(files).toMatchObject([{ state: "failed", detail: "Local history is too large to save." }, { state: "done" }]);
    expect(s.listSessions().map(session => session.title)).toEqual(["b"]);
  });

  it("replaceSession stores a document in one save: a re-import replaces every passage, a failed save changes nothing", async () => {
    let fail = false; const writes: string[] = [];
    const s = new LocalHistoryStore({ getLocalStorage: async () => "", setLocalStorage: async key => { if (fail) throw new Error("storage refused"); writes.push(key); return true; } });
    await s.load();
    const first = pdfToSession({ name: "Vendor.pdf", size: 10 }, { pages: [{ page: 1, text: "Lead time is twelve weeks." }, { page: 2, text: "Budget is sixty thousand." }] }, { parser: "local" });
    await s.replaceSession(first.session, first.entries);
    expect(s.getEntries(first.session.id).map(entry => entry.text)).toEqual(["Lead time is twelve weeks.", "Budget is sixty thousand."]);
    // A shorter version of the same file: the stale second passage goes.
    const shorter = pdfToSession({ name: "Vendor.pdf", size: 10 }, { pages: [{ page: 1, text: "Lead time is ten weeks." }] }, { parser: "local" });
    await s.replaceSession(shorter.session, shorter.entries);
    expect(s.getEntries(first.session.id).map(entry => entry.text)).toEqual(["Lead time is ten weeks."]);
    expect(s.search("budget sixty")).toEqual([]);
    // Failed save: the stored copy is untouched and a new document leaves nothing behind.
    fail = true;
    await expect(s.replaceSession(first.session, first.entries)).rejects.toThrow(/Could not save local history/u);
    const other = pdfToSession({ name: "Other.pdf", size: 11 }, { pages: [{ page: 1, text: "Calibration drift." }] }, { parser: "local" });
    await expect(s.replaceSession(other.session, other.entries)).rejects.toThrow(/Could not save local history/u);
    expect(s.listSessions().map(session => session.id)).toEqual([first.session.id]);
    expect(s.getEntries(first.session.id).map(entry => entry.text)).toEqual(["Lead time is ten weeks."]);
    await expect(s.replaceSession(other.session, [{ ...other.entries[0]!, sessionId: "elsewhere" }])).rejects.toThrow(/without their session/u);
  });

  it("OpenAI parser: a rejected PDF fails alone; a key or billing error stops the rest with the reason and keeps what was saved", async () => {
    const s = await store(); let n = 0;
    const api = fakeOpenAI(() => ++n === 2 ? new Response("{}", { status: 400 }) : modelText(`=== Page 1 ===\nDocument ${n} mentions the Orin lead time.`));
    const pdfs = ["a.pdf", "b.pdf", "c.pdf"].map(name => ({ name, data: pdfBlob() }));
    const files = await ingestPdfs(pdfs, { parser: "openai", openai: { fetch: api.fetch, key }, save: saver(s) });
    expect(files.map(file => file.state)).toEqual(["done", "failed", "done"]);
    expect(files[1]!.detail).toBe("OpenAI PDF: request failed (HTTP 400).");
    expect(api.calls.filter(call => call.method === "DELETE")).toHaveLength(3); // no upload is left behind, including the failed one
    expect(s.getEntries(files[0]!.sessionId!)[0]).toMatchObject({ metadata: { origin: "pdf-openai", section: "Page 1" } });

    let m = 0;
    const broke = fakeOpenAI(() => ++m === 1 ? modelText("=== Page 1 ===\nFirst") : Response.json({ error: { code: "insufficient_quota" } }, { status: 429 }));
    const stopped = await ingestPdfs(pdfs, { parser: "openai", openai: { fetch: broke.fetch, key }, save: saver(s) });
    expect(stopped.map(file => file.state)).toEqual(["done", "failed", "failed"]);
    expect(stopped[1]!.detail).toMatch(/no credits remaining/u);
    expect(stopped[2]!.detail).toMatch(/^Not sent: .*no credits remaining/u);
    expect(broke.calls.filter(call => call.path === "/files" && call.method === "POST")).toHaveLength(2); // the third PDF was never uploaded
  });

  it("cancel stops after the current file; more than the batch limit is refused per file; missing parser pieces are explained", async () => {
    const s = await store(), abort = new AbortController();
    const files = await ingestPdfs(["a.pdf", "b.pdf", "c.pdf"].map(name => ({ name, data: pdfBlob(`%PDF-1.4 ${name} text`) })), { parser: "local", save: saver(s), signal: abort.signal,
      extractLocal: async data => { const doc = await extractLocal(data); if (new TextDecoder().decode(data).includes("b.pdf")) abort.abort(); return doc; } });
    expect(files.map(file => file.state)).toEqual(["done", "cancelled", "cancelled"]);
    expect(s.listSessions()).toHaveLength(1);

    const many = Array.from({ length: PDF_LIMITS.maxFiles + 2 }, (_, i) => ({ name: `f${i}.pdf`, data: pdfBlob(`%PDF-1.4 file ${i}`) }));
    const capped = await ingestPdfs(many, { parser: "local", extractLocal, save: async () => undefined });
    expect(capped.filter(file => file.state === "done")).toHaveLength(PDF_LIMITS.maxFiles);
    expect(capped.at(-1)).toMatchObject({ state: "failed", detail: expect.stringMatching(/Only 20 PDFs/u) });

    expect((await ingestPdfs([{ name: "a.pdf", data: pdfBlob() }], { parser: "local", save: async () => undefined }))[0]!.detail).toMatch(/not available in this build/u);
    expect((await ingestPdfs([{ name: "a.pdf", url: "https://example.org/a.pdf" }], { parser: "local", extractLocal, save: async () => undefined }))[0]!.detail).toMatch(/needs the file itself/u);
    expect((await ingestPdfs([{ name: "a.pdf", data: pdfBlob() }], { parser: "openai", save: async () => undefined }))[0]!.detail).toMatch(/needs an OpenAI API key/u);
  });
});

describe("v0.13 Omi import tolerance", () => {
  const conversation = (id: string, extra: object = {}) => ({ id, created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:01:00Z",
    structured: { title: `Launch ${id}` }, transcript_segments: [{ text: "October launch.", start: 1, end: 2 }], ...extra });

  it("skipInvalid skips and counts an unreadable conversation instead of failing the import; the default stays strict", async () => {
    const body = [conversation("ok-1"), { id: "bad" }, conversation("bad-segment", { transcript_segments: [{ text: 42 }] }), conversation("ok-2")];
    const strict = await store();
    await expect(importOmiConversations({ key, store: strict, fetch: async () => Response.json(body) })).rejects.toThrow(/invalid conversation response/u);
    expect(strict.listSessions()).toEqual([]);
    const tolerant = await store(), progress = vi.fn();
    await expect(importOmiConversations({ key, store: tolerant, skipInvalid: true, onProgress: progress, fetch: async () => Response.json(body) })).resolves.toEqual({ imported: 2, pages: 1, skipped: 2 });
    expect(tolerant.listSessions().map(session => session.id).sort()).toEqual(["omi:ok-1", "omi:ok-2"]);
    expect(progress).toHaveBeenLastCalledWith({ imported: 2, pages: 1, skipped: 2 });
    // The envelope is still checked: a non-array response is an error, not "0 imported".
    await expect(importOmiConversations({ key, store: tolerant, skipInvalid: true, fetch: async () => Response.json({ detail: "nope" }) })).rejects.toThrow(/invalid conversation response/u);
  });

  it("reads timestamps without a UTC offset as UTC (was: the whole import failed)", async () => {
    const s = await store();
    await importOmiConversations({ key, store: s, fetch: async () => Response.json([conversation("naive", { created_at: "2026-09-01T08:30:00.123456", started_at: "2026-09-01T08:30:00.123456", finished_at: "2026-09-01T08:45:00" })]) });
    expect(s.listSessions()[0]).toMatchObject({ id: "omi:naive", startedAt: "2026-09-01T08:30:00.123Z", updatedAt: "2026-09-01T08:45:00.000Z" });
  });
});
