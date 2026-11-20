/**
 * v0.12 OpenAI knowledge base: the saved sessions as Markdown files in an OpenAI vector store in the
 * user's own OpenAI project, searched with the Retrieval API at answer time (semantic + keyword
 * search on OpenAI's side) as the alternative to the on-phone BM25 search.
 *
 * Privacy: this uploads saved session text to the user's OpenAI project. It runs only when the user
 * selects it and taps Sync; `deleteOpenAIKnowledge` removes the store and its files again.
 * Only fixed api.openai.com URLs are called (directFetch: no redirects, no credential forwarding).
 */
import { DirectProviderError, OPENAI_BASE, directFetch, type DirectFetch } from "./direct-providers.js";

/** One document to keep in the store (one saved session). `stamp` changes when the content changes. */
export interface KnowledgeDocument { readonly id: string; readonly stamp: string; readonly title: string; readonly date?: string; readonly markdown: string }
/** What is in the store. Holds ids only: no keys and no text. */
export interface OpenAIKnowledgeState {
  readonly vectorStoreId?: string;
  /** document id -> uploaded file and the stamp it was uploaded with. */
  readonly files: Readonly<Record<string, { readonly fileId: string; readonly stamp: string }>>;
  readonly syncedAt?: string;
}
export const EMPTY_OPENAI_KNOWLEDGE: OpenAIKnowledgeState = Object.freeze({ files: Object.freeze({}) });
export interface KnowledgeHit { readonly fileId: string; readonly documentId?: string; readonly title?: string; readonly date?: string; readonly score: number; readonly text: string }
export interface KnowledgeSyncProgress { readonly done: number; readonly total: number; readonly uploaded: number; readonly removed: number; readonly failed: number }

const PROVIDER = "OpenAI knowledge";
/** Small chunks: an answer prompt quotes at most ~600 characters per passage. */
const CHUNKING = { type: "static", static: { max_chunk_size_tokens: 300, chunk_overlap_tokens: 60 } } as const;
const MAX_DOCUMENT_CHARS = 400_000;

function headers(key: string, json = true): Record<string, string> {
  return { Authorization: `Bearer ${key}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}
function requireKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new DirectProviderError("provider-authentication", "Add your OpenAI API key first.");
  return trimmed;
}
async function json<T>(response: Response): Promise<T> { return await response.json() as T; }

export function cleanOpenAIKnowledgeState(value: unknown): OpenAIKnowledgeState {
  if (!value || typeof value !== "object") return EMPTY_OPENAI_KNOWLEDGE;
  const raw = value as { vectorStoreId?: unknown; files?: unknown; syncedAt?: unknown };
  const files: Record<string, { fileId: string; stamp: string }> = {};
  if (raw.files && typeof raw.files === "object") {
    for (const [id, item] of Object.entries(raw.files as Record<string, { fileId?: unknown; stamp?: unknown }>)) {
      if (item && typeof item.fileId === "string" && /^file[-_][A-Za-z0-9_-]+$/u.test(item.fileId) && typeof item.stamp === "string") files[id] = { fileId: item.fileId, stamp: item.stamp };
    }
  }
  const vectorStoreId = typeof raw.vectorStoreId === "string" && /^vs_[A-Za-z0-9_-]+$/u.test(raw.vectorStoreId) ? raw.vectorStoreId : undefined;
  return { ...(vectorStoreId ? { vectorStoreId } : {}), files, ...(typeof raw.syncedAt === "string" ? { syncedAt: raw.syncedAt } : {}) };
}

async function createStore(fetcher: DirectFetch, key: string, name: string, signal?: AbortSignal): Promise<string> {
  const response = await directFetch(fetcher, `${OPENAI_BASE}/vector_stores`, { method: "POST", headers: headers(key), body: JSON.stringify({ name }), ...(signal ? { signal } : {}) }, PROVIDER);
  const id = (await json<{ id?: unknown }>(response)).id;
  if (typeof id !== "string" || !id.startsWith("vs_")) throw new DirectProviderError("provider-response", "OpenAI did not return a vector store.");
  return id;
}
/** False only when OpenAI says the store is gone (404); any other failure throws, so a network blip never abandons the uploaded files. */
async function storeExists(fetcher: DirectFetch, key: string, id: string, signal?: AbortSignal): Promise<boolean> {
  const response = await fetcher(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(id)}`, { method: "GET", headers: headers(key, false), redirect: "error", credentials: "omit", cache: "no-store", ...(signal ? { signal } : {}) });
  if (response.status === 404) return false;
  if (response.ok) return true;
  if (response.status === 401) throw new DirectProviderError("provider-authentication", "OpenAI knowledge: the API key was rejected.");
  throw new DirectProviderError("provider-response", `OpenAI knowledge: could not check the knowledge base (HTTP ${response.status}).`, response.status >= 500);
}
async function uploadDocument(fetcher: DirectFetch, key: string, storeId: string, doc: KnowledgeDocument, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("purpose", "assistants");
  const name = `${doc.id.replace(/[^A-Za-z0-9_-]+/gu, "_").slice(0, 80) || "session"}.md`;
  form.append("file", new Blob([doc.markdown.slice(0, MAX_DOCUMENT_CHARS)], { type: "text/markdown" }), name);
  // No Content-Type header: the runtime sets the multipart boundary.
  const uploaded = await directFetch(fetcher, `${OPENAI_BASE}/files`, { method: "POST", headers: headers(key, false), body: form, ...(signal ? { signal } : {}) }, PROVIDER);
  const fileId = (await json<{ id?: unknown }>(uploaded)).id;
  if (typeof fileId !== "string") throw new DirectProviderError("provider-response", "OpenAI did not return a file id.");
  const attributes = { document_id: doc.id.slice(0, 512), title: doc.title.slice(0, 512), ...(doc.date ? { date: doc.date.slice(0, 64) } : {}) };
  try {
    await directFetch(fetcher, `${OPENAI_BASE}/vector_stores/${encodeURIComponent(storeId)}/files`, { method: "POST", headers: headers(key),
      body: JSON.stringify({ file_id: fileId, attributes, chunking_strategy: CHUNKING }), ...(signal ? { signal } : {}) }, PROVIDER);
  } catch (error) {
    await removeFile(fetcher, key, undefined, fileId).catch(() => undefined); // do not leave an orphan upload behind
    throw error;
  }
  return fileId;
}
async function removeFile(fetcher: DirectFetch, key: string, storeId: string | undefined, fileId: string, signal?: AbortSignal): Promise<void> {
  // Deleting the file object also removes it from every vector store.
  void storeId;
  try { await directFetch(fetcher, `${OPENAI_BASE}/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: headers(key, false), ...(signal ? { signal } : {}) }, PROVIDER); }
  catch (error) { if (signal?.aborted) throw error; /* already gone */ }
}

/**
 * Makes the store match `documents`: uploads new and changed ones, deletes those no longer present.
 * Resumable: returns the state reached so far when aborted or when single uploads fail; call again.
 */
export async function syncOpenAIKnowledge(fetcher: DirectFetch, key: string, documents: readonly KnowledgeDocument[], previous: OpenAIKnowledgeState,
  options: { signal?: AbortSignal; onProgress?: (progress: KnowledgeSyncProgress) => void; onState?: (state: OpenAIKnowledgeState) => void; storeName?: string } = {}): Promise<{ state: OpenAIKnowledgeState; progress: KnowledgeSyncProgress }> {
  const apiKey = requireKey(key), signal = options.signal;
  let storeId = previous.vectorStoreId;
  let files: Record<string, { fileId: string; stamp: string }> = { ...previous.files };
  if (storeId && !await storeExists(fetcher, apiKey, storeId, signal)) { storeId = undefined; files = {}; } // deleted on the OpenAI side
  storeId ??= await createStore(fetcher, apiKey, options.storeName ?? "Helix G2 knowledge", signal);
  const wanted = new Map(documents.filter(doc => doc.markdown.trim()).map(doc => [doc.id, doc]));
  const stale = Object.keys(files).filter(id => !wanted.has(id));
  const changed = [...wanted.values()].filter(doc => files[doc.id]?.stamp !== doc.stamp);
  const progress = { done: 0, total: stale.length + changed.length, uploaded: 0, removed: 0, failed: 0 };
  const snapshot = (): OpenAIKnowledgeState => ({ vectorStoreId: storeId!, files: { ...files }, syncedAt: new Date().toISOString() });
  const report = () => { try { options.onProgress?.({ ...progress }); options.onState?.(snapshot()); } catch { /* UI failures must not stop a sync */ } };
  report();
  for (const id of stale) {
    if (signal?.aborted) break;
    await removeFile(fetcher, apiKey, storeId, files[id]!.fileId, signal);
    delete files[id]; progress.removed++; progress.done++; report();
  }
  for (const doc of changed) {
    if (signal?.aborted) break;
    try {
      const old = files[doc.id];
      const fileId = await uploadDocument(fetcher, apiKey, storeId, doc, signal);
      files[doc.id] = { fileId, stamp: doc.stamp };
      if (old) await removeFile(fetcher, apiKey, storeId, old.fileId, signal);
      progress.uploaded++;
    } catch (error) {
      if (signal?.aborted) break;
      // Auth and billing failures will repeat for every file: stop with the reason.
      if (error instanceof DirectProviderError && /auth|billing|permission/u.test(error.code)) throw error;
      progress.failed++;
    }
    progress.done++; report();
  }
  return { state: snapshot(), progress };
}

/** Removes the vector store and every file this app uploaded to it. */
export async function deleteOpenAIKnowledge(fetcher: DirectFetch, key: string, state: OpenAIKnowledgeState, signal?: AbortSignal): Promise<void> {
  const apiKey = requireKey(key);
  for (const item of Object.values(state.files)) await removeFile(fetcher, apiKey, state.vectorStoreId, item.fileId, signal);
  if (state.vectorStoreId) {
    try { await directFetch(fetcher, `${OPENAI_BASE}/vector_stores/${encodeURIComponent(state.vectorStoreId)}`, { method: "DELETE", headers: headers(apiKey, false), ...(signal ? { signal } : {}) }, PROVIDER); }
    catch (error) { if (signal?.aborted) throw error; }
  }
}

/** Semantic + keyword search over the store. Throws on provider errors and aborts. */
export async function searchOpenAIKnowledge(fetcher: DirectFetch, key: string, vectorStoreId: string, query: string,
  options: { limit?: number; signal?: AbortSignal } = {}): Promise<KnowledgeHit[]> {
  const text = query.trim().slice(0, 2000);
  if (!text) return [];
  const response = await directFetch(fetcher, `${OPENAI_BASE}/vector_stores/${encodeURIComponent(vectorStoreId)}/search`, { method: "POST", headers: headers(requireKey(key)),
    body: JSON.stringify({ query: text, max_num_results: Math.max(1, Math.min(20, options.limit ?? 6)), rewrite_query: false }), ...(options.signal ? { signal: options.signal } : {}) }, PROVIDER);
  const data = (await json<{ data?: unknown }>(response)).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item: { file_id?: unknown; score?: unknown; attributes?: Record<string, unknown> | null; content?: unknown }) => {
    const parts = Array.isArray(item.content) ? item.content : [];
    const body = parts.map((part: { type?: unknown; text?: unknown }) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("\n").trim();
    if (!body || typeof item.file_id !== "string") return [];
    const attr = item.attributes ?? {};
    const pick = (name: string) => typeof attr[name] === "string" ? attr[name] as string : undefined;
    const documentId = pick("document_id"), title = pick("title"), date = pick("date");
    return [{ fileId: item.file_id, ...(documentId ? { documentId } : {}), ...(title ? { title } : {}), ...(date ? { date } : {}), score: typeof item.score === "number" ? item.score : 0, text: body }];
  });
}
