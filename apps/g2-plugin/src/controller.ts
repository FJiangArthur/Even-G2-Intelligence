import {
  AudioInputSource,
  AudioSpeakerRole,
  type AudioEvent,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { countDiagnostic, mainThreadPressure, recordDiagnostic } from "./diagnostics";
import { micHandlerBegin, micHandlerEnd, noteMicDropped, noteMicSend } from "./mic-probe";
import {
  HelixConversationClient,
  InMemoryNoteSink,
  DirectConversationTransport,
  type ConversationTransport,
  type ConversationClientState,
  type Speaker,
  type ContextScope,
  LocalHistoryStore,
  importOmiConversations,
  type HistorySession,
  type HistoryEntry,
  type RetrievedMemory,
  type RetrievalStats,
  type RetrievalTiming,
  type OmiImportOptions,
  type FactCheckResult,
  type ContextInsight,
  type DirectConversationOptions,
  type GatewayEvent,
  type CopilotTransport,
  type CopilotCallbacks,
  type KeyTestResult,
  testOpenAIKey,
  type CopilotPerson,
  type KnowledgeStats,
  type PersonAggregate,
  type SessionKnowledge,
  type OmiExportResult,
  exportToOmi,
} from "@helix/conversation-sdk";
import { markdownSession, omiExportSummary, sessionMarkdown as toSessionMarkdown, vaultFiles as toVaultFiles, type MarkdownFile } from "./knowledge-panel"; // phone agent
import { joinConcept } from "./history-panel";
import { firstAccessibleModel } from "@helix/conversation-sdk";
import { DEFAULT_COPILOT_MODEL, answerProviderInfo, directEndpoint, providerModel, testProviderKey, type ProviderKeyTestResult } from "@helix/conversation-sdk";
import { RehearsalPlayer, rehearsalScript, type RehearsalResult } from "./rehearsal";
import {
  pcmS16LeBytesToSamples,
  routeEvenHubEvent,
} from "./even-event-router";
import type { GlassesRenderBridge } from "./glasses-renderer";
import type { GlassesSurface, HudCommand, HudGesture, HudView } from "./glasses-hud";
import type { ConversationPresentation } from "./presentation";
import {
  providerCredentialsForSession,
  persistedConfigFromForm,
  savePersistedConfig,
  type LocalConfigStore,
  type SessionFormState,
  loadPersistedConfig,
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  type PluginConfig,
  copilotSettingsFromConfig,
  applyModePreset,
  CONVERSATION_MODES,
  type ConversationMode,
} from "./config";
import { modeProfile, summarizeSession } from "@helix/conversation-sdk";
import { SessionNotebook, applyTodoOp, type SessionNotebookData, type TodoOp } from "@helix/conversation-sdk";
import { EMPTY_OPENAI_KNOWLEDGE, cleanOpenAIKnowledgeState, deleteOpenAIKnowledge, syncOpenAIKnowledge, type KnowledgeDocument, type KnowledgeSyncProgress, type OpenAIKnowledgeState } from "@helix/conversation-sdk";
import { MIN_RECAP_TRANSCRIPT_CHARS, SESSION_DIGEST_ENDPOINT, SESSION_DIGEST_PROMPT_VERSION, fallbackSessionRecap, isAutoSessionTitle, removeOpenAIKnowledgeDocument, sessionHasContent, sessionRecap, spokenChars, type SessionDigest, type UsageRecord } from "@helix/conversation-sdk";
import type { ShortcutActionId } from "./shortcut-actions";
import { ingestPdfs, type PdfDocumentText, type PdfFileStatus, type PdfInput, type PdfParser } from "@helix/conversation-sdk"; // v0.13 knowledge I/O

/** Where answers look up saved knowledge: on this phone (BM25) or in the user's OpenAI vector store. */
export type KnowledgeSource = "local" | "openai";
/** v0.12 knowledge base status for the Knowledge tab. */
export interface KnowledgeBaseView {
  readonly source: KnowledgeSource;
  /** Sessions currently in the OpenAI store / sessions saved on this phone that are not in it or changed since. */
  readonly synced: number; readonly pending: number;
  /** v0.13: sessions removed on this phone whose file is still in the OpenAI store (removed there by the next sync). */
  readonly removals: number;
  readonly hasStore: boolean; readonly syncedAt?: string;
  readonly syncing?: KnowledgeSyncProgress;
  readonly notice?: string;
}
export const OPENAI_KNOWLEDGE_STORAGE_KEY = "helix.openai.knowledge.v1";
// ---- v0.13 knowledge I/O: Omi auto-import and PDF ingestion ----
/** Holds the switch and the last outcome only. Never a key and never conversation text. */
export const OMI_AUTO_IMPORT_STORAGE_KEY = "helix.omi.auto-import.v1";
/** Gap between automatic Omi imports while the app is open, and before a retry after a failure. */
export const OMI_AUTO_IMPORT_INTERVAL_MS = 30 * 60_000;
export const OMI_AUTO_IMPORT_RETRY_MS = 5 * 60_000;
/** The first automatic import reads this many days back; later ones start a day before the last success. */
export const OMI_AUTO_IMPORT_FIRST_DAYS = 14;
export type AutoImportReason = "startup" | "interval" | "resume" | "enabled" | "manual";
export type AutoImportOutcome = "disabled" | "not-ready" | "no-key" | "busy" | "not-due" | "imported" | "failed";
export interface AutoImportView {
  readonly enabled: boolean; readonly running: boolean;
  readonly lastAttemptAt?: string; readonly lastSuccessAt?: string; readonly lastImported?: number;
  /** Why the last attempt did not import (missing key, Omi error, storage full). */
  readonly lastError?: string;
}
export interface PdfImportView { readonly running: boolean; readonly parser?: PdfParser; readonly files: readonly PdfFileStatus[] }
export interface PdfImportRequest {
  readonly parser: PdfParser;
  /** OpenAI key from Setup (in memory). Needed for the OpenAI parser; also used to sync the result to the OpenAI knowledge base when that is selected. */
  readonly openaiKey?: string;
  /** On-phone text extractor (pdf-local.ts, lazy-loaded by the panel). Needed for the local parser. */
  readonly extractLocal?: (data: Uint8Array, options: { signal?: AbortSignal; maxPages: number }) => Promise<PdfDocumentText>;
}
// ---- end v0.13 knowledge I/O ----
export interface HistoryState {
  readonly knowledge: KnowledgeBaseView;
  readonly autoImport: AutoImportView;
  readonly pdfImport: PdfImportView;
  readonly sessions: HistorySession[];
  readonly status: string;
  readonly importing: boolean;
  readonly useLocalMemory: boolean;
  readonly liveWebFactCheck: boolean;
  readonly autoExplainTerms: boolean;
  readonly settingsError?: string;
}
export type ImportOmiRequest = Omit<OmiImportOptions, "store" | "signal" | "onProgress">;

export interface G2BridgePort extends GlassesRenderBridge, LocalConfigStore {
  audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>;
  shutDownPageContainer(exitMode?: number): Promise<boolean>;
  onEvenHubEvent(callback: (event: EvenHubEvent) => void): () => void;
}

/** v0.8 lifecycle: survives a WebView reclaim (Even docs: localStorage survives). Never holds keys. */
export const LIFECYCLE_STORAGE_KEY = "helix.lifecycle.v1";
export interface LifecycleFlag {
  readonly connected: boolean; readonly listening: boolean; readonly at: number;
  /** v0.13: history record of the interrupted session, so tap-to-resume continues it instead of starting another. */
  readonly sessionId?: string;
}
/** v0.13: a resume within this long of the interrupted session's last saved line continues that session in History. */
export const RESUME_SAME_SESSION_MS = 30 * 60 * 1000;
/** What History removal reports back to the panel. */
export interface HistoryRemoval { readonly removed: number; readonly failed: number; readonly pendingInOpenAI: number; readonly message: string }
/** One model call over a saved transcript (the transport's own fetch, or the Setup key path). */
type DigestRunner = (session: { title: string; lines: readonly { speaker: string; text: string }[] }) => Promise<SessionDigest>;
export const RESUME_PROMPT = "Session paused while Helix was in the background · tap to resume";
export const CONNECT_PROMPT = "Helix is not connected · tap to connect";
/** A flag older than this is not offered for resume. */
const LIFECYCLE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export class G2ConversationController {
  private client?: HelixConversationClient;
  private unsubscribeClientEvent?: () => void;
  private unsubscribeClientState?: () => void;
  private unsubscribeHub?: () => void;
  private unsubscribePresentation?: () => void;
  private audioSendChain: Promise<void> = Promise.resolve();
  private lastFrameSpeaker: Speaker = { label: "Speaker", role: "unknown" };
  private micOn = false;
  private initialized = false;
  private disposed = false;
  private controlChain: Promise<void> = Promise.resolve();
  private holding = false;
  private holdOpenedMic = false;
  private exiting = false;
  private clickTimer?: ReturnType<typeof setTimeout>;
  private readonly history: LocalHistoryStore;
  private historyStatus = "Loading local history…";
  private settingsError?: string;
  private readonly historyListeners = new Set<(state: HistoryState) => void>();
  private importAbort?: AbortController;
  private importCompletion?: Promise<void>;
  private archiveQueue: Promise<void> = Promise.resolve();
  private readonly historyDeletions = new Map<string, Promise<void>>();
  // ---- history write coalescing (v0.9) ----
  /** Explicit bulk history writes (imports) in progress: they write through instead of coalescing. */
  private bulkHistoryWrites = 0;
  /**
   * Coalescing window for live-session history writes (LocalHistoryStore.writeDelayMs). 0 (default, tests)
   * writes through; app bootstrap sets LIVE_HISTORY_WRITE_DELAY_MS. Pending writes are saved by
   * flushHistory() (page hidden/frozen), disconnect(), dispose(), deletions and imports.
   */
  public liveHistoryWriteDelayMs = 0;
  // ---- end history write coalescing ----
  private settingsQueue: Promise<void> = Promise.resolve();
  private config: PluginConfig = DEFAULT_CONFIG;
  private localMemoryEnabled = true;
  private knowledgeSource: KnowledgeSource = "local";
  private openaiKnowledge: OpenAIKnowledgeState = EMPTY_OPENAI_KNOWLEDGE;
  private knowledgeSync?: { abort: AbortController; progress: KnowledgeSyncProgress };
  private knowledgeNotice?: string;
  private knowledgeWrite: Promise<void> = Promise.resolve();
  private webCheckEnabled = false;
  private autoExplainEnabled = true;
  private transport?: ConversationTransport;
  private session?: HistorySession;
  // Live callbacks retain session identity after its archive is deleted.
  private archiveSessionId?: string;
  private manualRevision = 0;
  private readonly transcriptRevisions = new Map<string, number>();
  private readonly memoryByQuestion = new Map<string, RetrievedMemory[]>();
  // ---- v0.13 post-conversation summary ----
  /** OpenAI key of the live session (memory only), for the summary written when it ends. */
  private sessionKey?: string;
  /** The live session once its history record has been issued (it is saved with its first content). */
  private recordedSessionId?: string;
  /** Sessions whose summary call is in flight. */
  private readonly recapJobs = new Map<string, Promise<void>>();
  /** Sessions merged into another this run (interrupted + resumed): old id -> the record that now holds it. */
  private readonly mergedInto = new Map<string, string>();
  /** False: sessions end with the on-phone fallback title only (no model call). */
  public summarizeOnEnd = true;
  // ---- end post-conversation summary ----
  private rehearsal?: RehearsalPlayer;
  private modelAccess?: { key: string; ids: Promise<string[] | undefined> };
  private readonly modelAccessListeners = new Set<(access: { accessible: string[]; model: string; copilotModel: string }) => void>();
  // ---- lifecycle state (glasses agent) ----
  private resumeHandler?: (flag: LifecycleFlag) => Promise<void> | void;
  private resumeFlag?: LifecycleFlag;
  private lastResumeAt = 0;
  private overlayAt = 0;
  private lifecycleWrite: Promise<void> = Promise.resolve();
  private lastLifecycle?: string;

  public constructor(
    private readonly bridge: G2BridgePort,
    /** GlassesHud (default) or GlassesRenderer (answers-only layout). */
    private readonly renderer: GlassesSurface,
    private readonly presentation: ConversationPresentation,
    private readonly transportFactory: (options?: DirectConversationOptions) => ConversationTransport = options => new DirectConversationTransport(options),
  ) { this.history = new LocalHistoryStore(bridge); }

  public historySnapshot(): HistoryState {
    return { knowledge: this.knowledgeBase(), autoImport: this.autoImportView(), pdfImport: this.pdfImportView(), sessions: this.history.listSessions(), status: this.settingsError ?? this.historyStatus, settingsError: this.settingsError, importing: !!this.importAbort,
      useLocalMemory: this.localMemoryEnabled, liveWebFactCheck: this.webCheckEnabled, autoExplainTerms: this.autoExplainEnabled };
  }
  public subscribeHistory(listener: (state: HistoryState) => void): () => void {
    this.historyListeners.add(listener); listener(this.historySnapshot());
    return () => this.historyListeners.delete(listener);
  }
  public listHistorySessions(): HistorySession[] { return this.history.listSessions(); }
  public searchHistory(query: string): RetrievedMemory[] { return this.history.search(query); }
  public openHistorySession(id: string): { session: HistorySession; entries: HistoryEntry[] } | undefined {
    const session = this.history.getSession(id); // v0.11.1: not listSessions(), which clones the whole archive per call
    return session ? { session, entries: this.history.getEntries(id) } : undefined;
  }
  /** Cheap change stamp for list rows: saved entry count of a session. */
  public historyEntryCount(id: string): number { return this.history.entryCount(id); }
  /** The session an entry was saved in (memory provenance), or undefined. */
  public historySessionOfEntry(entryId: string): HistorySession | undefined {
    const id = this.history.sessionIdOfEntry(entryId);
    return id ? this.history.getSession(id) : undefined;
  }
  // ---- v0.13 history: content, recap and removal ----
  /** False for a Helix record with nothing in it (kept out of the list; pruned on load). */
  public historySessionHasContent(session: HistorySession): boolean {
    return session.source !== "helix" || sessionHasContent(session, this.history.entryCount(session.id));
  }
  /** True while the post-conversation summary of this session is being written. */
  public sessionSummaryPending(id: string): boolean { return this.recapJobs.has(id); }
  /** Resolves when no post-conversation summary is running (tests, and before the page goes away). */
  public async recapSettled(): Promise<void> { while (this.recapJobs.size) await Promise.all([...this.recapJobs.values()]); }
  /**
   * Removes sessions everywhere they are kept: the history index and every shard chunk (so local
   * retrieval, People and the knowledge map no longer see them) and, when a session was synced, its
   * file in the OpenAI knowledge base. `key` is the OpenAI key from Setup; without it, or when OpenAI
   * cannot be reached, the file stays listed as pending removal and the next Sync removes it.
   * Caller confirms the user-triggered removal before calling this API.
   */
  public async removeHistorySessions(ids: readonly string[], key = ""): Promise<HistoryRemoval> {
    let removed = 0, failed = 0;
    const gone: string[] = [];
    for (const id of new Set(ids)) {
      try { await this.deleteHistorySession(id); removed++; gone.push(id); } catch { failed++; }
    }
    const pendingInOpenAI = await this.forgetOpenAIKnowledge(gone, key);
    const message = `${removed === 1 ? "Session" : `${removed} sessions`} removed from this phone and local retrieval.`
      + (failed ? ` ${failed} could not be removed.` : "")
      + (pendingInOpenAI ? ` ${pendingInOpenAI === 1 ? "It is" : `${pendingInOpenAI} are`} still in your OpenAI knowledge base until the next Sync (Knowledge tab).` : "");
    if (removed || failed) this.setHistoryStatus(message);
    return { removed, failed, pendingInOpenAI, message };
  }
  /** Removes the uploaded files of deleted sessions now when a key is at hand; returns how many are left for the next sync. */
  private async forgetOpenAIKnowledge(ids: readonly string[], key: string): Promise<number> {
    const synced = ids.filter(id => this.openaiKnowledge.files[id]);
    if (!synced.length) return 0;
    let left = synced.length;
    if (key.trim() && !this.knowledgeSync) {
      const fetcher = this.keyTestFetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
      for (const id of synced) {
        try { this.openaiKnowledge = await removeOpenAIKnowledgeDocument(fetcher, key, this.openaiKnowledge, id); left--; } catch { /* stays pending: the next sync removes it */ }
      }
      await this.saveKnowledge();
    }
    this.emitHistory();
    return left;
  }
  // ---- end v0.13 history ----
  /** Caller confirms user-triggered deletion before calling this API. */
  public async deleteHistorySession(id: string): Promise<void> {
    const pending = this.historyDeletions.get(id);
    if (pending) return pending;
    // An import accepted before deletion may still upsert this Omi record.
    // Finish it first; later explicit imports wait for this deletion instead.
    const importing = id.startsWith("omi:") ? this.importCompletion : undefined;
    const deletion = this.archiveQueue.then(async () => {
      await importing;
      const deleted = this.history.deleteSession(id);
      void this.history.flush().catch(() => undefined); // Saved now, not after the live write window.
      await deleted;
      if (this.archiveSessionId === id) this.archiveSessionId = undefined;
      this.setHistoryStatus("Session deleted from this phone and local retrieval.");
    }).catch(error => {
      this.setHistoryStatus(errorMessage(error)); throw error;
    }).finally(() => { this.historyDeletions.delete(id); });
    // Suspend new target writes synchronously, before draining accepted writes.
    // On failure the store retains its snapshot and future live writes resume;
    // events received while deletion is pending are not archived or replayed.
    this.historyDeletions.set(id, deletion);
    this.archiveQueue = deletion.catch(() => undefined);
    return deletion;
  }
  public async importOmi(request: ImportOmiRequest): Promise<void> {
    if (this.disposed || this.exiting) throw new Error("Helix has exited.");
    if (this.importAbort) throw new Error("An Omi import is already running.");
    const abort = new AbortController(); this.importAbort = abort;
    this.bulkHistoryWrites++; this.syncHistoryWriteDelay(); // Sequential awaited writes: no coalescing window.
    this.setHistoryStatus("Importing Omi conversations…");
    const archives = this.archiveQueue;
    const completion = (async () => {
      try {
        await archives;
        // v0.13 skipInvalid: one conversation Helix cannot read is counted and skipped instead of failing every import.
        const result = await importOmiConversations({ skipInvalid: true, ...request, store: this.history, signal: abort.signal,
          onProgress: progress => this.setHistoryStatus(`Imported ${progress.imported} conversations · ${progress.pages} pages`) });
        this.lastOmiImport = { ok: true, imported: result.imported, skipped: result.skipped ?? 0 };
        this.setHistoryStatus(`Import complete: ${result.imported} conversations processed${result.skipped ? ` · ${result.skipped} skipped (Omi returned them in a form Helix cannot read)` : ""}. Repeated imports update existing records.`);
      } catch (error) { this.lastOmiImport = { ok: false, message: errorMessage(error) }; this.setHistoryStatus(errorMessage(error)); }
      finally { this.importAbort = undefined; this.importCompletion = undefined; this.bulkHistoryWrites--; this.syncHistoryWriteDelay(); this.emitHistory(); }
    })();
    this.importCompletion = completion;
    await completion;
  }
  public cancelImport(): void { this.importAbort?.abort(); }

  // ---- v0.13 Omi auto-import ----
  /** Outcome of the most recent importOmi() run (it reports through the status line and never throws). */
  private lastOmiImport?: { ok: true; imported: number; skipped: number } | { ok: false; message: string };
  private autoImport: { enabled: boolean; lastAttemptAt?: string; lastSuccessAt?: string; lastImported?: number; lastError?: string } = { enabled: false };
  private autoImportRunning = false;
  private autoImportKey?: () => string;
  private autoImportTimer?: ReturnType<typeof setInterval>;
  private autoImportWrite: Promise<void> = Promise.resolve();
  /** Test hook: the fetch used by automatic Omi imports. */
  public omiImportFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  public autoImportView(): AutoImportView { return { ...this.autoImport, running: this.autoImportRunning }; }
  private saveAutoImport(): Promise<void> {
    const value = JSON.stringify(this.autoImport);
    this.autoImportWrite = this.autoImportWrite.then(async () => { try { await this.bridge.setLocalStorage(OMI_AUTO_IMPORT_STORAGE_KEY, value); } catch { /* best effort: the switch still applies until the app closes */ } });
    return this.autoImportWrite;
  }
  /**
   * Gives the controller the Omi key source (the Setup field) and starts the schedule: one check now,
   * then one a minute, each of which imports only when the switch is on and an import is due.
   * Called by the Knowledge panel; without it nothing runs automatically.
   */
  public configureAutoImport(key: () => string, checkEveryMs = 60_000): void {
    this.autoImportKey = key;
    if (this.autoImportTimer !== undefined) clearInterval(this.autoImportTimer);
    this.autoImportTimer = setInterval(() => { void this.maybeAutoImport("interval"); }, checkEveryMs);
    void this.maybeAutoImport("startup");
  }
  public async setAutoImportEnabled(enabled: boolean): Promise<AutoImportOutcome> {
    const { lastError: _cleared, ...kept } = this.autoImport;
    this.autoImport = { ...kept, enabled };
    this.emitHistory();
    await this.saveAutoImport();
    return enabled ? this.maybeAutoImport("enabled") : "disabled";
  }
  /**
   * Runs an Omi import when the switch is on, the app is ready, a key is present, no import is
   * running and one is due ("enabled" and "manual" skip the due check). Incremental: from a day
   * before the last success, or OMI_AUTO_IMPORT_FIRST_DAYS back the first time. Never throws; the
   * outcome is stored (without the key) and shown in the Knowledge tab.
   */
  public async maybeAutoImport(reason: AutoImportReason, now = Date.now()): Promise<AutoImportOutcome> {
    if (!this.autoImport.enabled) return "disabled";
    if (!this.initialized || !this.autoImportKey || this.disposed || this.exiting) return "not-ready";
    if (this.autoImportRunning || this.importAbort) return "busy";
    const last = Date.parse(this.autoImport.lastAttemptAt ?? ""), failed = !!this.autoImport.lastError;
    if (reason !== "enabled" && reason !== "manual" && Number.isFinite(last) && now - last < (failed ? OMI_AUTO_IMPORT_RETRY_MS : OMI_AUTO_IMPORT_INTERVAL_MS)) return "not-due";
    const key = (this.autoImportKey?.() ?? "").trim();
    if (!key) {
      // Not counted as an attempt: the next check imports as soon as a key is there.
      const message = "Auto-import is on, but there is no Omi key. Enter your Omi developer key in Setup → API keys, and turn on “Save API keys on this phone” so it is still there after a restart.";
      if (this.autoImport.lastError !== message) { this.autoImport = { ...this.autoImport, lastError: message }; this.emitHistory(); await this.saveAutoImport(); }
      return "no-key";
    }
    this.autoImportRunning = true;
    const since = Date.parse(this.autoImport.lastSuccessAt ?? "");
    const startDate = new Date(Number.isFinite(since) ? since - 24 * 60 * 60_000 : now - OMI_AUTO_IMPORT_FIRST_DAYS * 24 * 60 * 60_000).toISOString();
    this.lastOmiImport = undefined;
    try {
      await this.importOmi({ key, startDate, ...(this.omiImportFetch ? { fetch: this.omiImportFetch } : {}) });
    } catch (error) { this.lastOmiImport = { ok: false, message: errorMessage(error) }; }
    const result = this.lastOmiImport as { ok: true; imported: number; skipped: number } | { ok: false; message: string } | undefined;
    const at = new Date(now).toISOString();
    const { lastError: _cleared, ...kept } = this.autoImport;
    this.autoImport = result?.ok ? { ...kept, lastAttemptAt: at, lastSuccessAt: at, lastImported: result.imported }
      : { ...kept, lastAttemptAt: at, lastError: result?.message ?? "The Omi import did not finish." };
    this.autoImportRunning = false;
    this.emitHistory();
    await this.saveAutoImport();
    return result?.ok ? "imported" : "failed";
  }
  // ---- end v0.13 Omi auto-import ----

  // ---- v0.13 PDF ingestion ----
  private pdfImport: { abort: AbortController; parser: PdfParser } | undefined;
  private pdfFiles: readonly PdfFileStatus[] = [];
  public pdfImportView(): PdfImportView { return { running: !!this.pdfImport, ...(this.pdfImport ? { parser: this.pdfImport.parser } : {}), files: this.pdfFiles }; }
  public cancelPdfImport(): void { this.pdfImport?.abort.abort(); }
  /**
   * Parses PDFs (on this phone, or in the user's OpenAI project) and saves each as a knowledge
   * session that on-phone retrieval searches. One failing file never loses the others. When the
   * OpenAI knowledge base is selected and already created, the new documents are synced to it too.
   */
  public async importPdfs(inputs: readonly PdfInput[], request: PdfImportRequest): Promise<PdfFileStatus[]> {
    if (this.disposed || this.exiting) throw new Error("Helix has exited.");
    if (this.pdfImport) throw new Error("PDFs are already being added. Wait for them to finish or cancel first.");
    if (!inputs.length) return [];
    const key = (request.openaiKey ?? "").trim();
    if (request.parser === "openai" && !key) throw new Error("The OpenAI parser needs your OpenAI API key. Enter it in Setup → API keys, or choose “On this phone”.");
    const run = { abort: new AbortController(), parser: request.parser };
    this.pdfImport = run; this.pdfFiles = inputs.map(input => ({ name: input.name, state: "queued" as const })); this.emitHistory();
    const fetcher = this.keyTestFetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    this.bulkHistoryWrites++; this.syncHistoryWriteDelay();
    let files: PdfFileStatus[] = [];
    try {
      files = await ingestPdfs(inputs, {
        parser: request.parser, signal: run.abort.signal,
        ...(request.extractLocal ? { extractLocal: request.extractLocal } : {}),
        ...(request.parser === "openai" ? { openai: { fetch: fetcher, key, model: answerProviderInfo(this.config.answerProvider)?.api === "chat" ? DEFAULT_COPILOT_MODEL : this.config.copilotModel } } : {}),
        onStatus: status => { this.pdfFiles = status; this.emitHistory(); },
        save: async ({ session, entries }) => {
          await this.archiveQueue;
          // One all-or-nothing save. Re-adding the same PDF replaces it (passages of an old, longer version
          // must not stay); when the save fails (archive full) no empty document is left and the old copy stays.
          await this.history.replaceSession(session, entries);
        },
      });
    } finally {
      this.bulkHistoryWrites--; this.syncHistoryWriteDelay();
      this.pdfImport = undefined;
      if (files.length) this.pdfFiles = files;
      const done = files.filter(file => file.state === "done").length, failed = files.filter(file => file.state === "failed").length, cancelled = files.filter(file => file.state === "cancelled").length;
      this.setHistoryStatus(`Added ${done} of ${inputs.length} PDF${inputs.length === 1 ? "" : "s"} to the knowledge base${failed ? ` · ${failed} failed` : ""}${cancelled ? ` · ${cancelled} cancelled` : ""}.`);
    }
    // The OpenAI knowledge base, when in use, gets the new documents too (same Files API the user already opted into).
    if (files.some(file => file.state === "done") && key && this.knowledgeSource === "openai" && this.openaiKnowledge.vectorStoreId && !this.knowledgeSync) {
      await this.syncOpenAIKnowledge(key).catch(() => undefined); // the outcome is in the knowledge base status line
    }
    return files;
  }
  // ---- end v0.13 PDF ingestion ----
  public setLocalMemoryEnabled(enabled: boolean): Promise<void> {
    this.localMemoryEnabled = enabled; return this.saveMemorySettings();
  }
  public setLiveWebFactCheckEnabled(enabled: boolean): Promise<void> {
    this.webCheckEnabled = enabled;
    if (!enabled) this.cancelFactChecks();
    return this.saveMemorySettings();
  }
  public setAutoExplainTermsEnabled(enabled: boolean): Promise<void> {
    this.autoExplainEnabled = enabled;
    if (!enabled) this.cancelInsights();
    return this.saveMemorySettings();
  }
  // ---- v0.12 knowledge base: local (on this phone) or OpenAI (vector store in the user's project) ----
  /** Saved sessions as knowledge documents (the live session is still changing and is left out). */
  private knowledgeDocuments(): KnowledgeDocument[] {
    const live = this.session?.id;
    return this.history.listSessions().filter(session => session.id !== live).map(session => this.titled(session)).map(session => ({
      id: session.id, stamp: this.knowledgeStamp(session), title: session.title, date: session.startedAt,
      markdown: knowledgeText(toSessionMarkdown(session, this.history.getEntries(session.id)), session),
    }));
  }
  /**
   * Change stamp of a session's uploaded file. To-dos and notes are edited after a session ended
   * without touching its lines or updatedAt, so they are part of the stamp: an edit in History marks
   * the session as changed for the next Sync. Sessions without a notebook keep the v0.12 stamp.
   */
  private knowledgeStamp(session: HistorySession): string {
    const base = `${this.history.entryCount(session.id)}|${session.updatedAt}`;
    if (!session.todos?.length && !session.notes?.length) return base;
    let hash = 0x811c9dc5;
    for (const char of JSON.stringify([session.todos ?? [], session.notes ?? []])) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
    return `${base}|n${hash.toString(36)}`;
  }
  public knowledgeBase(): KnowledgeBaseView {
    const files = this.openaiKnowledge.files, live = this.session?.id;
    let pending = 0, removals = 0;
    // Only worth an archive pass when the OpenAI store is in use.
    if (this.knowledgeSource === "openai" || this.openaiKnowledge.vectorStoreId) {
      const saved = new Set<string>();
      for (const session of this.history.listSessions()) {
        saved.add(session.id);
        if (session.id === live) continue;
        if (files[session.id]?.stamp !== this.knowledgeStamp(session)) pending++;
      }
      for (const id of Object.keys(files)) if (!saved.has(id)) removals++;
    }
    return { source: this.knowledgeSource, synced: Object.keys(files).length, pending, removals, hasStore: !!this.openaiKnowledge.vectorStoreId,
      ...(this.openaiKnowledge.syncedAt ? { syncedAt: this.openaiKnowledge.syncedAt } : {}),
      ...(this.knowledgeSync ? { syncing: this.knowledgeSync.progress } : {}), ...(this.knowledgeNotice ? { notice: this.knowledgeNotice } : {}) };
  }
  /** The store answers should search, when OpenAI is selected, memory is on and something is uploaded. */
  private openaiKnowledgeSource(): { vectorStoreId: string; resolveSession: (id: string) => HistorySession | undefined } | undefined {
    const id = this.openaiKnowledge.vectorStoreId;
    if (this.knowledgeSource !== "openai" || !this.localMemoryEnabled || !id || !Object.keys(this.openaiKnowledge.files).length) return undefined;
    return { vectorStoreId: id, resolveSession: sessionId => this.history.getSession(sessionId) };
  }
  private saveKnowledge(): Promise<void> {
    const value = JSON.stringify({ source: this.knowledgeSource, state: this.openaiKnowledge });
    this.knowledgeWrite = this.knowledgeWrite.then(async () => { try { await this.bridge.setLocalStorage(OPENAI_KNOWLEDGE_STORAGE_KEY, value); } catch { /* best effort */ } });
    return this.knowledgeWrite;
  }
  public async setKnowledgeSource(source: KnowledgeSource): Promise<void> {
    this.knowledgeSource = source === "openai" ? "openai" : "local";
    this.knowledgeNotice = undefined;
    this.emitHistory();
    await this.saveKnowledge();
  }
  /** Uploads new and changed sessions to the OpenAI vector store and removes deleted ones. User-triggered only. */
  public async syncOpenAIKnowledge(key: string): Promise<KnowledgeSyncProgress> {
    if (this.knowledgeSync) throw new Error("A knowledge sync is already running.");
    // v0.13: with the History switch off, saved sessions are not read for answers and not uploaded either.
    if (!this.localMemoryEnabled) {
      this.knowledgeNotice = "The knowledge base may not read history. Turn on “Let the knowledge base read history” in History, then sync.";
      this.emitHistory();
      throw new Error(this.knowledgeNotice);
    }
    const fetcher = this.keyTestFetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    const sync = { abort: new AbortController(), progress: { done: 0, total: 0, uploaded: 0, removed: 0, failed: 0 } };
    this.knowledgeSync = sync; this.knowledgeNotice = undefined; this.emitHistory();
    let lastSave = 0;
    try {
      const result = await syncOpenAIKnowledge(fetcher, key, this.knowledgeDocuments(), this.openaiKnowledge, {
        signal: sync.abort.signal,
        onProgress: progress => { sync.progress = progress; this.emitHistory(); },
        // Persist as it goes: an interrupted sync resumes instead of uploading everything again.
        onState: state => { this.openaiKnowledge = state; if (Date.now() - lastSave > 2000) { lastSave = Date.now(); void this.saveKnowledge(); } },
      });
      this.openaiKnowledge = result.state;
      const { uploaded, removed, failed } = result.progress;
      this.knowledgeNotice = sync.abort.signal.aborted ? "Sync stopped. Tap Sync to continue."
        : `Synced: ${uploaded} uploaded, ${removed} removed${failed ? `, ${failed} failed (tap Sync to retry)` : ""}.`;
      return result.progress;
    } catch (error) {
      this.knowledgeNotice = errorMessage(error);
      throw error;
    } finally {
      this.knowledgeSync = undefined;
      await this.saveKnowledge();
      this.emitHistory();
    }
  }
  public cancelKnowledgeSync(): void { this.knowledgeSync?.abort.abort(); }
  /** Deletes the OpenAI vector store and the uploaded files, and returns answers to the local lookup. */
  public async deleteOpenAIKnowledge(key: string): Promise<void> {
    this.cancelKnowledgeSync();
    const fetcher = this.keyTestFetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    try {
      await deleteOpenAIKnowledge(fetcher, key, this.openaiKnowledge);
      this.openaiKnowledge = EMPTY_OPENAI_KNOWLEDGE; this.knowledgeSource = "local";
      this.knowledgeNotice = "Removed from OpenAI. Answers use the knowledge on this phone.";
    } catch (error) { this.knowledgeNotice = errorMessage(error); throw error; }
    finally { await this.saveKnowledge(); this.emitHistory(); }
  }
  // ---- end knowledge base ----

  public dismissCue(): void { this.presentation.dismissCue(); }
  public dismissInsight(id: string): void { this.presentation.dismissInsight(id); }
  public async explainTerm(): Promise<void> {
    await this.ask("Using the whole captured conversation, directly explain one recent technical term in the speech language. Preserve ambiguity. If there is no clear technical term, say so briefly.");
  }
  public async runShortcut(id: ShortcutActionId): Promise<void> {
    this.cancelClick();
    switch (id) {
      case 1: return this.explainTerm();
      case 2: return this.askContext("local");
      case 3: return this.askContext("global");
      case 4: this.dismissCue(); return;
      case 5: return this.togglePause();
    }
  }
  /**
   * Saved-knowledge search for an answer. It runs in slices of a few ms (a whole-archive search in one
   * task froze the page behind queued microphone events). Diagnostics: "memory-search Nx max S s" is how
   * long answers waited for it; "memory-block" counts a slice that held the page for 50 ms or more.
   */
  private searchKnowledge(query: string, sessionId: string): Promise<RetrievalStats> {
    if (!this.localMemoryEnabled) return Promise.resolve({ items: [], searchedEntries: 0, matched: 0 });
    return this.history.retrieveAsync(query, { excludeSessionId: sessionId, onTiming: timing => this.countKnowledgeWork("memory-search", timing) });
  }
  /** Builds the search index ahead of the first answer (after load and at session start), also in slices. */
  private warmKnowledge(): void {
    if (this.localMemoryEnabled) void this.history.warmRetrieval(timing => { if (timing.slices > 1) this.countKnowledgeWork("memory-index", timing); });
  }
  private countKnowledgeWork(name: string, timing: RetrievalTiming): void {
    countDiagnostic(name, timing.totalMs);
    if (timing.maxSliceMs >= 50) countDiagnostic("memory-block", timing.maxSliceMs);
  }
  private cancelInsights(): void {
    (this.transport as (ConversationTransport & { cancelInsights?: () => void }) | undefined)?.cancelInsights?.();
    this.presentation.dismissCue();
  }
  private saveMemorySettings(): Promise<void> {
    this.config = { ...this.config, useLocalMemory: this.localMemoryEnabled, liveWebFactCheck: this.webCheckEnabled, autoExplainTerms: this.autoExplainEnabled };
    const config = this.config; this.emitHistory();
    const save = this.settingsQueue.then(async () => {
      try {
        if (!await this.bridge.setLocalStorage(CONFIG_STORAGE_KEY, JSON.stringify(config))) throw new Error("settings save failed");
        this.settingsError = undefined; this.emitHistory();
      } catch { this.settingsError = "Memory settings could not be saved. Current toggles still apply."; this.emitHistory(); }
    });
    this.settingsQueue = save; return save;
  }
  private cancelFactChecks(): void {
    const transport = this.transport as (ConversationTransport & { cancelFactChecks?: () => void }) | undefined;
    transport?.cancelFactChecks?.();
  }
  private setHistoryStatus(status: string): void { this.historyStatus = status; this.emitHistory(); }
  private emitHistory(): void {
    if (!this.historyListeners.size) return;
    const snapshot = this.historySnapshot(); // one archive pass per change, shared by all panels
    for (const listener of this.historyListeners) listener({ ...snapshot, sessions: snapshot.sessions.slice() });
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.config = await loadPersistedConfig(this.bridge);
    this.localMemoryEnabled = this.config.useLocalMemory;
    this.webCheckEnabled = this.config.liveWebFactCheck;
    this.autoExplainEnabled = this.config.autoExplainTerms;
    this.presentation.setMode(this.config.conversationMode);
    try {
      const saved = JSON.parse(await this.bridge.getLocalStorage(OPENAI_KNOWLEDGE_STORAGE_KEY) || "{}") as { source?: unknown; state?: unknown };
      this.openaiKnowledge = cleanOpenAIKnowledgeState(saved.state);
      this.knowledgeSource = saved.source === "openai" ? "openai" : "local";
    } catch { /* no knowledge base yet */ }
    try { // v0.13 Omi auto-import switch and last outcome
      const saved = JSON.parse(await this.bridge.getLocalStorage(OMI_AUTO_IMPORT_STORAGE_KEY) || "{}") as Record<string, unknown>;
      const text = (value: unknown) => typeof value === "string" && value.length <= 600 ? value : undefined;
      const lastAttemptAt = text(saved.lastAttemptAt), lastSuccessAt = text(saved.lastSuccessAt), lastError = text(saved.lastError);
      this.autoImport = { enabled: saved.enabled === true, ...(lastAttemptAt ? { lastAttemptAt } : {}), ...(lastSuccessAt ? { lastSuccessAt } : {}), ...(lastError ? { lastError } : {}),
        ...(typeof saved.lastImported === "number" && Number.isSafeInteger(saved.lastImported) ? { lastImported: saved.lastImported } : {}) };
    } catch { /* auto-import stays off */ }
    try { await this.history.load(); await this.tidyHistory(); this.setHistoryStatus("History is saved only on this phone."); }
    catch (error) { this.setHistoryStatus(errorMessage(error)); }
    this.warmKnowledge();
    this.presentation.setStatus("starting");
    this.unsubscribePresentation = this.presentation.subscribe((snapshot) => {
      this.renderer.render(snapshot.glasses, snapshot);
    });

    // v0.8 glasses -> phone mirror (asynchronous, deduped by the HUD and the presentation).
    this.renderer.setMirrorListener?.(mirror => { if (!this.disposed) this.presentation.setHud(mirror); });
    // Official G2 ordering: the 576x288 startup page must exist before the
    // glasses microphone can be opened. A warm/cold WebView restart finds the page already
    // there; the HUD then takes it over with rebuildPageContainer instead of failing.
    await this.renderer.initialize();
    this.unsubscribeHub = this.bridge.onEvenHubEvent(this.handleEvenHubEvent);
    this.initialized = true;
    this.presentation.setStatus("ready");
    void this.maybeAutoImport("startup"); // v0.13: no-op unless the Omi auto-import switch is on
    await this.offerResume();
  }

  public async connect(form: SessionFormState): Promise<void> {
    this.requireInitialized();
    await this.disconnect();
    this.presentation.reset();

    let config: PluginConfig = { ...persistedConfigFromForm(form), ...(this.config.modePrompts ? { modePrompts: this.config.modePrompts } : {}) };
    this.config = config;
    this.localMemoryEnabled = config.useLocalMemory;
    this.webCheckEnabled = config.liveWebFactCheck;
    this.autoExplainEnabled = config.autoExplainTerms;
    const providerCredentials = providerCredentialsForSession(form);
    await savePersistedConfig(this.bridge, form);
    this.presentation.setStatus("connecting");

    const now = new Date().toISOString();
    // v0.13: tap-to-resume shortly after an interruption continues the interrupted session in History
    // (the two records are merged when this one ends); anything else starts a new one.
    const continues = this.resumeTarget(this.resumeFlag?.sessionId, Date.parse(now));
    const session: HistorySession = { id: createId("session"), source: "helix", title: `Helix · ${now}`, startedAt: now, updatedAt: now, ...(continues ? { continues } : {}) };
    this.session = session;
    this.archiveSessionId = session.id;
    this.startNotebook(session.id, continues ? this.resumeFlag?.sessionId : undefined, continues);
    this.sessionKey = providerCredentials?.openai;
    this.recordedSessionId = undefined;
    this.transcriptRevisions.clear();
    this.memoryByQuestion.clear();
    this.manualRevision = 0;
    this.warmKnowledge(); // the first answer must not wait for (or be stalled by) the search index
    // v0.13: no history record until something is said or answered (archiveEvent / flushSessionKnowledge
    // save it with the first line). Connecting, resuming and reconnecting used to leave an empty
    // "<1 min · 0 · 0" session behind each time.
    const transport = this.transportFactory({
      retrieveMemory: (query, sessionId) => this.localMemoryEnabled ? this.history.retrieve(query, { excludeSessionId: sessionId }) : [],
      retrieveMemoryWithStats: (query, sessionId) => this.localMemoryEnabled
        ? this.history.retrieveWithStats(query, { excludeSessionId: sessionId })
        : { items: [], searchedEntries: 0, matched: 0 },
      retrieveMemoryAsync: (query, sessionId) => this.searchKnowledge(query, sessionId),
      openaiKnowledge: () => this.openaiKnowledgeSource(),
      onUplink: state => countDiagnostic(state === "paused" ? "uplink-pause" : "uplink-resume"),
      copilot: this.copilotCallbacks(session.id),
      onUsage: usage => { if (this.session?.id === session.id) this.presentation.applyUsage(usage); },
      onAnswerMeta: meta => { if (this.session?.id === session.id) this.presentation.applyAnswerMeta(meta); },
      onMemoryRetrieved: (items, questionId) => {
        if (this.session?.id !== session.id) return;
        this.memoryByQuestion.set(questionId ?? "", items);
        this.presentation.setMemorySources(items, questionId);
      },
      factCheck: { enabled: () => this.webCheckEnabled, onResult: result => this.handleFactCheck(result), news: () => this.config.newsSearch !== false },
      answerLength: () => this.config.answerLength,
      insights: { enabled: () => this.autoExplainEnabled, onResult: result => this.handleInsight(result) },
      // v0.10: modes switch live (phone chips or the glasses menu) without reconnecting.
      mode: () => this.config.conversationMode,
      automation: () => ({ answerQuestions: this.config.autoAnswer, detectQuestions: this.config.autoQuestion }),
      responseStrategy: () => this.config.responseStrategy,
      modeInstructions: mode => this.config.modePrompts?.[mode],
    });
    this.transport = transport;
    // Respect the selection when the project can call it; otherwise switch visibly
    // (never silently) to the best accessible model and save that choice.
    // The OpenAI model-list check only applies when OpenAI answers; a direct provider (DeepSeek, Qwen, GLM, Kimi)
    // must never be "switched" to an OpenAI model. A model id from another provider's catalog is replaced visibly.
    const directProvider = answerProviderInfo(config.answerProvider);
    const direct = directProvider !== undefined && directProvider.api !== "openai";
    if (direct) {
      const model = providerModel(directProvider, config.model, "answer"), copilotModel = providerModel(directProvider, config.copilotModel, "copilot");
      if (model !== config.model || copilotModel !== config.copilotModel) {
        const changes = [model !== config.model ? `answers ${config.model} → ${model}` : "", copilotModel !== config.copilotModel ? `copilot ${config.copilotModel} → ${copilotModel}` : ""].filter(Boolean).join(", ");
        this.presentation.notice(`model-provider-${session.id}`, "Model switched", `${directProvider.label} can't run the selected model. Using ${changes}. Change it in Setup.`);
        config = { ...config, model, copilotModel };
        this.config = config;
        void this.saveSettings({ ...form, model, copilotModel }).catch(() => undefined);
      }
    }
    const accessible = !direct && providerCredentials?.openai ? await this.accessibleModels(providerCredentials.openai, transport, 1500) : undefined;
    if (accessible) {
      const has = new Set(accessible);
      const model = has.has(config.model) ? config.model : firstAccessibleModel("answer", accessible) ?? config.model;
      const copilotModel = has.has(config.copilotModel) ? config.copilotModel : firstAccessibleModel("copilot", accessible) ?? config.copilotModel;
      if (model !== config.model || copilotModel !== config.copilotModel) {
        const changes = [model !== config.model ? `answers ${config.model} → ${model}` : "", copilotModel !== config.copilotModel ? `copilot ${config.copilotModel} → ${copilotModel}` : ""].filter(Boolean).join(", ");
        this.presentation.notice(`model-access-${session.id}`, "Model switched", `Your OpenAI project can't use the selected model. Using ${changes}. Change it in Setup.`);
        config = { ...config, model, copilotModel };
        this.config = config;
        void this.saveSettings({ ...form, model, copilotModel }).catch(() => undefined);
      }
      for (const listener of this.modelAccessListeners) listener({ accessible, model, copilotModel });
    }
    const noteSink = new InMemoryNoteSink();
    const providerPreferences = {
      ...(config.transcriptionProvider === "gateway-default"
        ? {}
        : { transcriptionProvider: config.transcriptionProvider }),
      ...(config.answerProvider === "gateway-default"
        ? {}
        : { answerProvider: config.answerProvider }),
    };
    const client = new HelixConversationClient(transport, {
      noteSink,
      autoSaveSuggestedNotes: config.autoNotes,
      onNoteSaved: (event, result) => {
        if (result.status === "saved" || result.status === "duplicate") {
          this.presentation.markNoteSaved(event.note.id);
        }
      },
      onNoteError: (_event, error) => this.handleError(error),
      onListenerError: (error) => this.handleError(error),
    });
    this.client = client;
    this.unsubscribeClientEvent = client.subscribe((event) => { this.presentation.apply(event); this.archiveEvent(event); this.notebookTranscript(event); });
    this.unsubscribeClientState = client.subscribeState(this.handleClientState);

    try {
      await client.start({
        sessionId: session.id,
        // Provenance of the selected provider (OpenAI: id "openai-direct", .../v1/responses, provider "openai").
        // Never substitute a different model: the selected id is sent as-is.
        endpoint: directEndpoint(config.answerProvider, config.model),
        prompt: {
          id: config.promptId,
          version: config.promptVersion,
          system: config.instructions,
          mode: config.conversationMode,
          maxResponseSentences: config.maxResponseSentences,
        },
        mode: config.conversationMode,
        responseStrategy: config.responseStrategy,
        ...(Object.keys(providerPreferences).length === 0
          ? {}
          : { providers: providerPreferences }),
        memory: {
          readOmiContext: false,
          syncNotes: false,
        },
        audio: {
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
          channels: 1,
        },
        locale: config.locale,
        speaker: { label: "G2 conversation", role: "unknown" },
        automation: {
          detectQuestions: config.autoQuestion,
          answerQuestions: config.autoAnswer,
          saveNotes: config.autoNotes,
        },
        client: {
          name: "@helix/g2-plugin",
          version: "0.7.0",
          device: "Even Realities G2",
        },
      }, providerCredentials);
    } catch (error) {
      this.presentation.setStatus("failed", errorMessage(error));
      await this.releaseClient();
      throw error;
    }
    this.resumeFlag = undefined;
    this.presentation.setResumePrompt(undefined);
    this.persistLifecycle();
  }

  public async startListening(): Promise<void> {
    return this.control(() => this.openMic());
  }

  private async openMic(): Promise<void> {
    this.requireInitialized();
    const client = this.requireActiveClient();
    if (this.micOn) {
      // Listening, but the overload guard has the microphone closed: an explicit start wins.
      if (this.audioGuardClosed) await this.reopenAudioNow("start");
      return;
    }
    const source = this.micSource;
    const opened = await this.bridge.audioControl(true, source);
    if (!opened) throw new Error(`G2 refused to start the ${source === AudioInputSource.Phone ? "phone" : "glasses"} microphone`);
    if (client !== this.client || this.disposed || this.exiting) {
      await this.bridge.audioControl(false, source);
      return;
    }
    this.micOn = true; this.audioLastAt = 0; this.micWrongSource = 0; this.micRightSource = 0;
    this.presentation.setStatus("listening");
    this.persistLifecycle();
  }

  public async togglePause(): Promise<void> {
    return this.control(async () => {
      if (this.holding) return;
      if (!this.micOn) {
        await this.openMic();
        this.presentation.setInteraction("MIC ON / PAUSE ON PHONE");
        return;
      }
      await this.closeMic();
      await this.audioDrained();
      await this.commitIfAudioAvailable();
      this.presentation.setStatus("paused");
      this.presentation.setInteraction("PAUSED / RESUME ON PHONE");
    });
  }

  private control(action: () => Promise<void>): Promise<void> {
    const next = this.controlChain.catch(() => undefined).then(async () => {
      if (this.disposed || this.exiting) return;
      await action();
    });
    this.controlChain = next;
    return next;
  }

  private async closeMic(): Promise<void> {
    if (!this.micOn) return;
    this.micOn = false; this.clearAudioPause();
    try {
      // The SDK sends "glasses" when no source is given, which would leave the phone microphone running.
      if (!await this.bridge.audioControl(false, this.micSource)) throw new Error("G2 refused to stop the microphone");
    } catch (error) { this.micOn = true; throw error; }
    this.persistLifecycle();
  }

  public async beginHold(): Promise<void> {
    return this.control(async () => {
      this.requireActiveClient();
      if (this.holding) return;
      this.holdOpenedMic = !this.micOn;
      if (!this.micOn) await this.openMic();
      else if (this.audioGuardClosed) await this.reopenAudioNow("hold"); // the wearer's hold beats the overload guard
      this.holding = true;
      this.presentation.setInteraction("[ HOLDING ] RELEASE TO SUBMIT");
    });
  }

  public async releaseHold(): Promise<void> {
    return this.control(async () => {
      if (!this.holding) return; // Duplicate/orphan release must not send twice.
      this.holding = false;
      const pauseAfter = this.holdOpenedMic;
      this.holdOpenedMic = false;
      if (pauseAfter) await this.closeMic();
      await this.audioDrained();
      const committed = await this.commitIfAudioAvailable();
      if (pauseAfter) this.presentation.setStatus("paused");
      this.presentation.setInteraction(committed ? "SENT / WAITING FOR RESPONSE" : "NO NEW AUDIO / HOLD AND SPEAK");
    });
  }

  public async requestExit(): Promise<void> {
    if (this.exiting || this.disposed) return;
    this.exiting = true; // Reject new gestures immediately, including queued ones.
    this.cancelInsights();
    this.cancelImport();
    this.cancelFactChecks();
    this.cancelClick();
    this.holding = false;
    this.presentation.setInteraction("STOPPING / EXIT");
    this.clearLifecycle();
    try {
      await this.controlChain.catch(() => undefined);
      await this.disconnect();
      this.presentation.setInteraction("STOPPED / EXIT");
      await this.renderer.flush();
      if (!await this.bridge.shutDownPageContainer(1)) throw new Error("G2 declined the exit request");
      this.presentation.setStatus("exited");
      await this.dispose();
    } catch (error) {
      this.exiting = false;
      this.handleError(error);
    }
  }

  public async ask(question: string): Promise<void> {
    const text = question.trim();
    if (!text) throw new Error("Type a question first");
    const client = this.requireActiveClient();
    this.manualRevision++;
    this.cancelInsights();
    this.cancelFactChecks();
    this.cancelClick();
    this.presentation.beginRequest();
    await client.ask(text, {
      label: "You",
      role: "self",
    });
  }

  public async askContext(scope: ContextScope): Promise<void> {
    if (this.disposed || this.exiting) return;
    const client = this.requireActiveClient();
    this.manualRevision++;
    this.cancelInsights();
    this.cancelFactChecks();
    this.cancelClick();
    this.presentation.beginRequest();
    await client.askContext(scope, {
      label: scope === "local" ? "Local context" : "Whole conversation", role: "self",
    });
  }

  private cancelClick(): void {
    if (this.clickTimer !== undefined) clearTimeout(this.clickTimer);
    this.clickTimer = undefined;
  }

  private queueLocalClick(): void {
    if (this.disposed || this.exiting) return;
    this.cancelClick();
    this.clickTimer = setTimeout(() => {
      this.clickTimer = undefined;
      if (this.routeHudGesture("click")) return; // HUD: context-sensitive tap
      void this.askContext("local").catch(error => this.handleError(error));
    }, 250);
  }

  /** Persist setup immediately (not only on Connect). Keys never travel this path. */
  public async saveSettings(form: SessionFormState): Promise<void> {
    const config = persistedConfigFromForm(form);
    this.config = { ...config, useLocalMemory: this.localMemoryEnabled, liveWebFactCheck: this.webCheckEnabled, autoExplainTerms: this.autoExplainEnabled,
      ...(this.config.modePrompts ? { modePrompts: this.config.modePrompts } : {}) };
    const save = this.settingsQueue.then(async () => {
      try {
        if (!await this.bridge.setLocalStorage(CONFIG_STORAGE_KEY, JSON.stringify(this.config))) throw new Error("settings save failed");
        this.settingsError = undefined;
      } catch { this.settingsError = "Settings could not be saved on this phone. Current values still apply."; }
      this.emitHistory();
    });
    this.settingsQueue = save; return save;
  }

  /** Pre-check (e.g. when a key is entered) so Connect never waits on the network. Memory-only cache. */
  public async checkModelAccess(key: string): Promise<string[] | undefined> {
    const trimmed = key.trim();
    if (!trimmed) return undefined;
    const ids = await this.accessibleModels(trimmed, this.transportFactory(), 5000);
    if (ids) for (const listener of this.modelAccessListeners) listener({ accessible: ids, model: this.config.model, copilotModel: this.config.copilotModel });
    return ids;
  }

  private accessibleModels(key: string, transport: ConversationTransport, timeoutMs: number): Promise<string[] | undefined> {
    if (this.modelAccess?.key === key) return this.modelAccess.ids;
    const lister = (transport as ConversationTransport & { listModels?: (key: string, timeoutMs?: number) => Promise<string[] | undefined> }).listModels;
    if (!lister) return Promise.resolve(undefined);
    const ids = lister.call(transport, key, timeoutMs).then(result => {
      if (!result && this.modelAccess?.ids === ids) this.modelAccess = undefined; // retry later
      return result;
    });
    this.modelAccess = { key, ids };
    return ids;
  }

  public subscribeModelAccess(listener: (access: { accessible: string[]; model: string; copilotModel: string }) => void): () => void {
    this.modelAccessListeners.add(listener); return () => this.modelAccessListeners.delete(listener);
  }

  /** Interactive verification of any point (answer sentence, summary bullet, claim). */
  public verify(target: string, id?: string): void {
    const text = target.trim();
    if (!text) throw new Error("Nothing to verify");
    this.requireActiveClient();
    const transport = this.copilotTransport();
    if (!transport) throw new Error("Verification needs the phone conversation transport.");
    // v0.8: the glasses/phone show "Verifying…" until a VerificationResult with this id arrives.
    if (id) this.presentation.beginVerification(id);
    transport.verify(text.slice(0, 2000), id);
  }

  /** v0.8: verify one claim by id. The result is a VerificationResult whose id is the claim id. */
  public verifyClaim(claimId: string): void {
    this.requireActiveClient();
    // SDK v0.8: verifies with the claim's own transcript context; the result id is the claim id.
    // Returns false for claims the copilot does not know (e.g. added by the host).
    const transport = this.copilotTransport();
    if (transport?.verifyClaim?.(claimId)) { this.presentation.beginVerification(claimId); return; }
    const claim = this.presentation.snapshot().claims.find(item => item.id === claimId);
    if (!claim) throw new Error("That claim is no longer available");
    this.verify(claim.text, claim.id);
  }

  public runCopilot(): void {
    this.requireActiveClient();
    this.copilotTransport()?.runCopilotNow();
  }

  /** Plays a scripted conversation through the live pipeline (no microphone, no STT). */
  public async rehearse(scriptId: string, speed = 1): Promise<RehearsalResult> {
    const script = rehearsalScript(scriptId);
    if (!script) throw new Error(`Unknown rehearsal script: ${scriptId}`);
    this.requireActiveClient();
    const transport = this.copilotTransport();
    if (!transport) throw new Error("Rehearsal needs the phone conversation transport.");
    this.rehearsal?.stop();
    const sessionId = this.session?.id;
    const player = new RehearsalPlayer({
      inject: (text, speaker) => {
        if (this.session?.id !== sessionId || this.disposed || this.exiting) { player.stop(); return Promise.resolve(); }
        this.lastFrameSpeaker = speaker;
        return transport.injectTranscript(text, speaker);
      },
      onProgress: (index, total) => this.presentation.setInteraction(`REHEARSAL ${index + 1}/${total}`),
    });
    this.rehearsal = player;
    try {
      const result = await player.play(script, speed);
      // Flush trailing speech through the copilot instead of waiting out its cooldown.
      if (this.session?.id === sessionId) this.copilotTransport()?.runCopilotNow();
      if (this.rehearsal === player) this.presentation.setInteraction(result.completed ? undefined : "REHEARSAL STOPPED");
      return result;
    } finally { if (this.rehearsal === player) this.rehearsal = undefined; }
  }

  public stopRehearsal(): void { this.rehearsal?.stop(); }
  public get rehearsing(): boolean { return this.rehearsal?.state === "playing"; }
  /** True while a provider session is active (Connect succeeded and not stopped). */
  public get connected(): boolean { return this.client?.state === "active"; }

  /** Setup → Test key: auth, accessible models, a tiny paid probe (credits) and realtime access.
   * Also refreshes the per-key model-access cache and marks inaccessible models in Setup. */
  public async testKey(key: string, model: string): Promise<KeyTestResult> {
    const fetcher = this.keyTestFetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    const result = await testOpenAIKey(fetcher, key, model);
    if (result.models.length) {
      this.modelAccess = { key: key.trim(), ids: Promise.resolve([...result.models]) };
      for (const listener of this.modelAccessListeners) listener({ accessible: [...result.models], model: result.model ?? this.config.model, copilotModel: this.config.copilotModel });
    }
    return result;
  }
  /**
   * v0.11 History → Generate summary: one model call over a saved session's transcript; the result
   * is stored as that session's summary, key facts and concepts.
   */
  public async generateSessionKnowledge(sessionId: string, key: string): Promise<void> {
    if (!this.history.getSession(sessionId)) throw new Error("This session is no longer on this phone.");
    const fetcher = this.keyTestFetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    const model = this.digestModel();
    await this.writeRecap(sessionId, model, session => summarizeSession(fetcher, key, model, session, { onUsage: usage => this.presentation.applyUsage(usage) }));
  }

  // ---- v0.13 post-conversation summary (title + overview + summary, with provenance) ----
  /**
   * One model call over a saved session's transcript; stores the title, the one-to-two sentence
   * overview, the summary bullets, key facts and concepts, and who wrote them (model, prompt version,
   * endpoint, latency, time). Rejects when the call fails: the stored fallback then stays.
   */
  private async writeRecap(sessionId: string, model: string, run: DigestRunner): Promise<void> {
    const record = this.openHistorySession(sessionId);
    if (!record) throw new Error("This session is no longer on this phone.");
    const lines = record.entries.filter(entry => entry.kind === "transcript" && entry.text.trim()).map(entry => ({ speaker: entry.speaker?.trim() || "Speaker", text: entry.text }));
    const started = Date.now();
    // Only a real title is a hint: not the live placeholder, a first utterance, or the on-phone fallback.
    const hint = record.session.recap?.origin === "fallback" || isAutoSessionTitle(record.session, record.entries) ? "" : record.session.title;
    const digest = await run({ title: hint, lines });
    const latencyMs = Date.now() - started, generatedAt = new Date().toISOString();
    if (this.historyDeletions.has(sessionId) || !this.history.getSession(sessionId)) return;
    const concepts = new Map((record.session.concepts ?? []).map(item => [item.split(/\s*(?::|—|–| - )\s+/u)[0]!.trim().toLowerCase(), item]));
    for (const concept of digest.concepts) if (!concepts.has(concept.term.toLowerCase())) concepts.set(concept.term.toLowerCase(), joinConcept(concept.term, concept.explanation));
    await this.history.updateSessionKnowledge(sessionId, { summary: digest.summary, keyFacts: digest.keyFacts,
      ...(concepts.size ? { concepts: [...concepts.values()].slice(-20) } : {}) });
    const latest = this.openHistorySession(sessionId);
    if (!latest) return;
    await this.history.updateSessionRecap(sessionId, {
      // Only a Helix conversation is titled by the summary; an imported note, Omi conversation or PDF keeps the title it came with.
      ...(latest.session.source === "helix" ? { title: digest.title || fallbackSessionRecap(latest.session, latest.entries).title } : {}),
      overview: digest.overview || digest.summary.slice(0, 2).join(" "),
      recap: { origin: "model", generatedAt, model, provider: "openai", endpoint: SESSION_DIGEST_ENDPOINT, promptVersion: SESSION_DIGEST_PROMPT_VERSION, latencyMs },
    });
    this.titles.delete(sessionId);
    this.emitHistory();
  }
  /**
   * A session ended (Stop, disconnect, reconnect, exit). Local part, awaited: fold a resumed session
   * into the one it continues, record the end time and a title derived on the phone. Then, not
   * awaited: one summary call with the session's own key and the selected copilot model, which
   * replaces that fallback; without a key, with too little speech, or when the call fails, the
   * fallback stays (History → open the session → Generate summary retries).
   */
  private async finalizeSession(ended: HistorySession, run?: { model: string; digest: DigestRunner }): Promise<void> {
    let id = ended.id;
    try {
      const saved = this.history.getSession(id);
      if (!saved) return; // nothing was said or answered: no record and no summary call
      if (saved.continues) id = await this.mergeContinuation(saved) ?? id;
      const record = this.openHistorySession(id);
      if (!record) return;
      const endedAt = new Date().toISOString();
      await this.history.updateSessionRecap(id, { endedAt, ...(record.session.recap ? {} : {
        title: fallbackSessionRecap(record.session, record.entries).title, recap: { origin: "fallback" as const, generatedAt: endedAt } }) });
      this.titles.delete(id);
      this.emitHistory();
      if (!run || !this.summarizeOnEnd || spokenChars(record.entries) < MIN_RECAP_TRANSCRIPT_CHARS) return;
    } catch (error) { this.setHistoryStatus(errorMessage(error)); return; }
    const job = this.writeRecap(id, run.model, run.digest).catch(() => undefined) // the fallback recap stays
      .finally(() => { if (this.recapJobs.get(id) === job) this.recapJobs.delete(id); if (!this.disposed) this.emitHistory(); });
    this.recapJobs.set(id, job);
    this.emitHistory();
  }
  /** The session digest is an OpenAI Responses call with the OpenAI key; a direct provider's copilot model cannot run it. */
  private digestModel(): string {
    return answerProviderInfo(this.config.answerProvider)?.api === "chat" ? DEFAULT_COPILOT_MODEL : this.config.copilotModel;
  }
  /** The summary call for a session that is ending, bound to its transport (its fetch) and its key. */
  private sessionDigestRunner(): { model: string; digest: DigestRunner } | undefined {
    const key = this.sessionKey?.trim(), model = this.digestModel();
    const transport = this.transport as (ConversationTransport & { summarizeSession?: (key: string, model: string, session: Parameters<DigestRunner>[0], options?: { onUsage?: (usage: UsageRecord) => void }) => Promise<SessionDigest> }) | undefined;
    if (!key || !model || typeof transport?.summarizeSession !== "function") return undefined;
    return { model, digest: session => transport.summarizeSession!(key, model, session, { onUsage: usage => { if (!this.disposed) this.presentation.applyUsage(usage); } }) };
  }
  /** The record a resume should continue: the interrupted session (or what it was merged into), if recent. */
  private resumeTarget(sessionId: string | undefined, now: number): string | undefined {
    if (!sessionId) return undefined;
    const id = this.mergedInto.get(sessionId) ?? sessionId, session = this.history.getSession(id);
    if (!session || session.source !== "helix") return undefined;
    return now - Date.parse(session.updatedAt) <= RESUME_SAME_SESSION_MS ? session.continues ?? id : undefined;
  }
  /** Moves a resumed session's lines into the session it continues. Returns the surviving id. */
  private async mergeContinuation(session: HistorySession): Promise<string | undefined> {
    const target = session.continues ? this.mergedInto.get(session.continues) ?? session.continues : undefined;
    if (!target || target === session.id || this.history.getSession(target)?.source !== "helix") return undefined;
    // Oldest part first: an earlier part that was itself interrupted (and so never merged) goes in
    // before this one, so the later notebook state and line order win.
    const earlier = this.history.listSessions().filter(other => other.id !== session.id && other.id !== target && other.continues
      && (this.mergedInto.get(other.continues) ?? other.continues) === target && Date.parse(other.startedAt) < Date.parse(session.startedAt))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    for (const part of earlier) {
      try { await this.history.mergeSession(part.id, target); this.mergedInto.set(part.id, target); this.titles.delete(part.id); } catch { /* stays a separate record */ }
    }
    try { await this.history.mergeSession(session.id, target); } catch { return undefined; }
    this.mergedInto.set(session.id, target); this.titles.delete(target); this.titles.delete(session.id);
    return target;
  }
  /**
   * Startup clean-up of what earlier versions left behind: Helix records with nothing in them (one was
   * saved at every Connect / resume) are pruned, and a resumed session that was itself interrupted is
   * folded into the session it continues. Imported title-only records and unreadable shards are kept.
   */
  private async tidyHistory(): Promise<void> {
    try {
      const empty = this.history.emptySessionIds("helix");
      if (empty.length) await this.history.deleteSessions(empty);
      const resumed = this.history.listSessions().filter(session => session.continues).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
      for (const session of resumed) await this.mergeContinuation(session);
    } catch { /* history stays as stored */ }
  }
  private readonly titles = new Map<string, { stamp: string; title: string }>();
  /** Title to show for a session anywhere on the phone (generated, imported, or the on-phone fallback). Cached per change. */
  public historyTitle(session: HistorySession): string {
    const stamp = `${this.history.entryCount(session.id)}|${session.title}|${session.recap?.generatedAt ?? ""}|${session.summary?.[0] ?? ""}`, cached = this.titles.get(session.id);
    if (cached?.stamp === stamp) return cached.title;
    const title = sessionRecap(session, session.recap ? [] : this.history.getEntries(session.id)).title;
    this.titles.set(session.id, { stamp, title });
    return title;
  }
  // ---- end post-conversation summary ----
  /** v0.11: edit (or reset with "") the system prompt of one mode; applies to the next answer. */
  public setModePrompt(mode: ConversationMode, prompt: string): Promise<void> {
    const prompts = { ...this.config.modePrompts };
    const text = prompt.trim().slice(0, 4000);
    if (text && text !== modeProfile(mode).answer) prompts[mode] = text; else delete prompts[mode];
    const { modePrompts: _old, ...rest } = this.config;
    this.config = { ...rest, ...(Object.keys(prompts).length ? { modePrompts: prompts } : {}) };
    return this.saveMemorySettings();
  }
  public modePrompt(mode: ConversationMode): { text: string; custom: boolean } {
    const custom = this.config.modePrompts?.[mode];
    return { text: custom ?? modeProfile(mode).answer, custom: !!custom };
  }
  /** v0.11 glasses menu "Connect": the same path as tap-to-resume (keys already on this phone). */
  public async connectFromGlasses(): Promise<void> {
    if (this.client || !this.resumeHandler) return;
    this.presentation.setInteraction("CONNECTING");
    await this.resumeHandler({ connected: true, listening: true, at: Date.now() });
  }
  /** Setup → Test provider key: one tiny completion against the selected direct provider (DeepSeek, Qwen, GLM, Kimi). */
  public async testProviderKey(providerId: string, key: string, model: string): Promise<ProviderKeyTestResult> {
    const provider = answerProviderInfo(providerId);
    if (!provider || provider.api === "openai") return { status: "error", message: "Select DeepSeek, Qwen, Zhipu GLM or Moonshot Kimi as the answer provider first.", model };
    const fetcher = this.keyTestFetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
    return testProviderKey(fetcher, provider, key, providerModel(provider, model, "answer"));
  }
  /** Test seam for testKey; production uses the global fetch. */
  public keyTestFetch?: (url: string, init?: RequestInit) => Promise<Response>;

  private copilotTransport(): (ConversationTransport & Partial<CopilotTransport>) & CopilotTransport | undefined {
    const transport = this.transport as (ConversationTransport & Partial<CopilotTransport>) | undefined;
    return transport && typeof transport.injectTranscript === "function" ? transport as ConversationTransport & CopilotTransport : undefined;
  }

  private copilotCallbacks(sessionId: string): CopilotCallbacks {
    const live = () => this.session?.id === sessionId && !this.disposed && !this.exiting;
    return {
      enabled: () => live(),
      settings: () => copilotSettingsFromConfig(this.config),
      onSummary: summary => { if (live()) { this.presentation.applySummary(summary); this.noteSessionSummary(sessionId, summary.bullets, summary.keyFacts); } },
      onConcept: concept => { if (live()) { this.presentation.applyConcept(concept); this.noteSessionConcept(sessionId, concept.term, concept.explanation); } },
      onConflict: conflict => { if (live()) this.presentation.applyConflict(conflict, !this.holding); },
      onSuggestions: items => { if (live()) this.presentation.setSuggestions(items); },
      onAsk: ask => { if (live()) this.presentation.applyAsk(ask); },
      onVerification: result => { if (live()) this.presentation.applyVerification(result); },
      onClaim: claim => { if (live()) this.presentation.applyClaim(claim); },
      // v0.8 People (phone agent): live People tab + persisted session people.
      onPerson: person => { if (live()) { this.presentation.applyPerson(person); this.noteSessionPerson(sessionId, person); } },
      // Notes mode: the copilot edits the session notebook (to-do operations, running notes).
      notebook: () => live() ? this.notebook : undefined,
    };
  }

  // ---- History / knowledge / people (phone agent) ----
  private readonly knowledgeDrafts = new Map<string, { summary?: string[]; keyFacts?: string[]; concepts: Map<string, string>; people: Map<string, { name: string; role?: string; mentions?: number }> }>();
  private knowledgeTimer?: ReturnType<typeof setTimeout>;
  /** Debounce for persisting copilot knowledge into the live session's history record. */
  public knowledgeFlushMs = 1500;

  private knowledgeDraft(sessionId: string) {
    let draft = this.knowledgeDrafts.get(sessionId);
    if (!draft) { draft = { concepts: new Map(), people: new Map() }; this.knowledgeDrafts.set(sessionId, draft); }
    return draft;
  }
  private noteSessionSummary(sessionId: string, bullets: readonly string[], keyFacts: readonly string[]): void {
    const draft = this.knowledgeDraft(sessionId);
    draft.summary = [...bullets]; draft.keyFacts = [...keyFacts];
    this.scheduleKnowledgeFlush();
  }
  private noteSessionConcept(sessionId: string, term: string, explanation: string): void {
    if (!term?.trim()) return;
    this.knowledgeDraft(sessionId).concepts.set(term.trim().toLowerCase(), joinConcept(term, explanation ?? ""));
    this.scheduleKnowledgeFlush();
  }
  private noteSessionPerson(sessionId: string, person: CopilotPerson): void {
    const name = person.name?.trim().replace(/\s+/gu, " ");
    if (!name) return;
    const people = this.knowledgeDraft(sessionId).people;
    const key = personKey(name);
    const previous = people.get(key);
    const role = person.role?.trim() || previous?.role;
    people.set(key, { name: previous && previous.name.length >= name.length ? previous.name : name, ...(role ? { role } : {}),
      mentions: Math.max(previous?.mentions ?? 0, Number.isFinite(person.mentions) ? person.mentions : 1, 1) });
    this.scheduleKnowledgeFlush();
  }
  private scheduleKnowledgeFlush(): void {
    if (this.knowledgeTimer !== undefined) return;
    this.knowledgeTimer = setTimeout(() => { this.knowledgeTimer = undefined; this.flushSessionKnowledge(); }, this.knowledgeFlushMs);
  }
  /** Queues summary/keyFacts/people/concepts into the session's history record (after its upsert). */
  public flushSessionKnowledge(): void {
    if (this.knowledgeTimer !== undefined) { clearTimeout(this.knowledgeTimer); this.knowledgeTimer = undefined; }
    this.flushNotebook();
    for (const [sessionId, draft] of this.knowledgeDrafts) {
      if (this.historyDeletions.has(sessionId)) { this.knowledgeDrafts.delete(sessionId); continue; }
      const patch: SessionKnowledge = {
        ...(draft.summary ? { summary: draft.summary.slice(0, 20) } : {}),
        ...(draft.keyFacts ? { keyFacts: draft.keyFacts.slice(0, 20) } : {}),
        ...(draft.concepts.size ? { concepts: [...draft.concepts.values()].slice(-20) } : {}),
        ...(draft.people.size ? { people: [...draft.people.values()].sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0)).slice(0, 20) } : {}),
      };
      // Live sessions keep accumulating; ended sessions are written once and dropped.
      if (this.session?.id !== sessionId) this.knowledgeDrafts.delete(sessionId);
      if (!Object.keys(patch).length) continue;
      // The live record may still be in the store's pending (coalesced) write, where the update is validated.
      const live = this.archiveSessionId === sessionId;
      // v0.13: the record is saved with its first content. Knowledge can be that first content (a
      // rehearsal, or speech the copilot summarised before a line was archived), so save it here too.
      const record = live && this.session?.id === sessionId && Object.values(patch).some(value => Array.isArray(value) && value.length) ? this.session : undefined;
      if (record) this.recordedSessionId = sessionId;
      const recorded = this.recordedSessionId === sessionId;
      this.enqueueArchive(async () => {
        if (this.historyDeletions.has(sessionId)) return;
        if (!record && !(live ? recorded : this.history.getSession(sessionId))) return;
        // Issued together: both land in the same (coalesced) write, the record first.
        await Promise.all([record ? this.history.upsertSession(record) : undefined, this.history.updateSessionKnowledge(sessionId, patch)]);
      });
    }
  }
  /** Saves pending history writes now (call when the page is hidden or frozen). Rejects if they could not be saved. */
  public async flushHistory(): Promise<void> {
    this.flushSessionKnowledge();
    await this.archiveQueue;
    await this.history.flush();
  }
  /** Id of the live session's history record, when connected. */
  public liveSessionId(): string | undefined { return this.session?.id; }
  public knowledgeStats(): KnowledgeStats { return this.history.stats(); }
  public listPeople(): PersonAggregate[] { return this.history.listPeople(); }
  /** Sessions (newest first) that list a person, by normalized name. */
  public sessionsForPerson(name: string): HistorySession[] {
    const key = personKey(name);
    const ids = new Set(this.history.listPeople().find(person => personKey(person.name) === key)?.sessionIds ?? []);
    return this.history.listSessions().filter(session => ids.has(session.id));
  }
  public sessionMarkdown(id: string): string | undefined {
    const record = this.openHistorySession(id);
    return record ? toSessionMarkdown(this.titled(record.session), record.entries) : undefined;
  }
  /** The session with the title History shows (exports and the knowledge base never carry a placeholder title). */
  private titled(session: HistorySession): HistorySession {
    const title = this.historyTitle(session);
    return title === session.title ? session : { ...session, title };
  }
  /** Obsidian vault bundle: one note per session (all sessions, or `ids`). */
  public vaultFiles(ids?: readonly string[]): MarkdownFile[] {
    const wanted = ids ? new Set(ids) : undefined;
    const sessions = this.history.listSessions().filter(session => !wanted || wanted.has(session.id));
    return sessions.length ? toVaultFiles(sessions.map(session => ({ session: this.titled(session), entries: this.history.getEntries(session.id) }))) : [];
  }
  /** Obsidian -> Helix: parse .md notes and store them as source "obsidian" sessions. */
  public async importMarkdownFiles(files: readonly { name: string; text: string }[]): Promise<{ imported: number; sessionIds: string[]; failed: { name: string; error: string }[] }> {
    if (this.disposed || this.exiting) throw new Error("Helix has exited.");
    const parsed: { session: HistorySession; entries: HistoryEntry[] }[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const file of files.slice(0, 200)) {
      try { parsed.push(markdownSession(file.name, file.text)); } catch (error) { failed.push({ name: file.name, error: errorMessage(error) }); }
    }
    // v0.13: files past the batch limit are reported, not silently dropped.
    for (const file of files.slice(200)) failed.push({ name: file.name, error: "Only 200 notes can be imported at once. Import this one in the next batch." });
    const sessionIds: string[] = [];
    await this.archiveQueue;
    this.bulkHistoryWrites++; this.syncHistoryWriteDelay();
    try {
      for (const { session, entries } of parsed) {
        try {
          await this.history.upsertSession({ ...session, source: "obsidian" });
          if (entries.length) await this.history.upsertEntries(entries.map(entry => ({ ...entry, sessionId: session.id })));
          sessionIds.push(session.id);
        } catch (error) { failed.push({ name: session.title, error: errorMessage(error) }); }
      }
    } finally { this.bulkHistoryWrites--; this.syncHistoryWriteDelay(); }
    this.setHistoryStatus(`Imported ${sessionIds.length} Obsidian note${sessionIds.length === 1 ? "" : "s"}${failed.length ? ` · ${failed.length} failed` : ""}.`);
    return { imported: sessionIds.length, sessionIds, failed };
  }
  public omiExportSupport(): { supported: boolean; reason: string } {
    return { supported: true, reason: "" };
  }
  /**
   * Helix/Obsidian -> Omi through the SDK's exportToOmi (explicit, user-triggered only), one
   * conversation per session, sequentially. Omi limits writes to ~25 conversations per hour.
   */
  public async exportSessionsToOmi(ids: readonly string[], key?: string, signal?: AbortSignal): Promise<{ exported: number; message: string }> {
    if (this.disposed || this.exiting) throw new Error("Helix has exited.");
    const sessions = ids.map(id => this.openHistorySession(id)).filter((item): item is { session: HistorySession; entries: HistoryEntry[] } => Boolean(item));
    if (!sessions.length) throw new Error("Choose a saved session to send.");
    const omiKey = (key ?? "").trim();
    if (!omiKey) throw new Error("Enter your Omi developer API key in Setup → API keys first.");
    const batch = sessions.slice(0, 20);
    const results: OmiExportResult[] = [];
    for (const [index, { session, entries }] of batch.entries()) {
      this.setHistoryStatus(`Sending to Omi… ${index + 1}/${batch.length}`);
      const result = await exportToOmi({ key: omiKey, session, entries, ...(signal ? { signal } : {}), ...(this.config.locale ? { language: this.config.locale } : {}) });
      results.push(result);
      if (result.status === "failed" && ["invalid-key", "auth", "rate-limited"].includes(result.code)) break;
    }
    const summary = omiExportSummary(results);
    const message = sessions.length > batch.length ? `${summary.message} Sent the first ${batch.length}; send the rest later (Omi write limit).` : summary.message;
    this.setHistoryStatus(message);
    return { exported: summary.exported, message };
  }
  // ---- end history / knowledge / people ----

  public async disconnect(): Promise<void> {
    const hadClient = !!this.client;
    this.flushSessionKnowledge(); // phone agent: save copilot knowledge before the session ends
    this.rehearsal?.stop();
    this.cancelInsights();
    this.cancelFactChecks();
    // v0.13: what ended, and the summary call bound to its transport and key (both are released below).
    const ended = this.session, digest = ended ? this.sessionDigestRunner() : undefined;
    this.session = undefined;
    this.archiveSessionId = undefined;
    this.sessionKey = undefined;
    this.cancelClick();
    this.presentation.setStatus("stopped");
    this.holding = false;
    await this.closeMic();
    this.resetAudioLoad(); // the next session learns its own delivery rate and starts with no flush history
    await this.audioDrained();
    await this.releaseClient();
    if (hadClient) this.clearLifecycle(); // a user disconnect is not an interrupted session
    await this.archiveQueue;
    this.syncHistoryWriteDelay(); await this.history.flush().catch(() => undefined); // failures are reported in history status
    if (ended) await this.finalizeSession(ended, digest);
    if (this.initialized && !this.disposed) this.presentation.setStatus("ready");
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.flushSessionKnowledge(); // phone agent: save copilot knowledge before teardown
    this.disposed = true;
    this.cancelInsights();
    this.cancelImport();
    this.cancelPdfImport(); if (this.autoImportTimer !== undefined) { clearInterval(this.autoImportTimer); this.autoImportTimer = undefined; } // v0.13
    this.cancelFactChecks();
    const ended = this.session, digest = ended ? this.sessionDigestRunner() : undefined;
    this.session = undefined;
    this.archiveSessionId = undefined;
    this.sessionKey = undefined;
    this.cancelClick();
    this.presentation.setStatus("exited");
    this.unsubscribeHub?.();
    this.unsubscribeHub = undefined;
    this.unsubscribePresentation?.();
    this.unsubscribePresentation = undefined;
    this.renderer.dispose(); // Stop display traffic before asynchronous teardown.
    try {
      if (this.micOn) await this.bridge.audioControl(false, this.micSource);
      this.micOn = false; this.clearAudioPause();
      await this.audioDrained();
      await this.releaseClient("shutdown");
      await this.archiveQueue;
      this.syncHistoryWriteDelay(); await this.history.flush().catch(() => undefined);
      // The page may be going away: the on-phone title is saved first; the summary call may not finish.
      if (ended) await this.finalizeSession(ended, digest);
      this.historyListeners.clear();
    } finally {
      this.holding = false;
    }
  }

  private readonly handleEvenHubEvent = (event: EvenHubEvent): void => {
    routeEvenHubEvent(event, {
      onAudio: (audio) => this.receiveAudio(audio),
      onClick: () => this.queueLocalClick(),
      // v0.8: double press opens/closes the glasses MENU; answers-only layout keeps "whole conversation".
      onDoubleClick: () => {
        this.cancelClick();
        if (!this.routeHudGesture("double")) void this.askContext("global").catch((error: unknown) => this.handleError(error));
      },
      onListSelect: (index, name) => this.queueListSelect(index, name),
      onScrollUp: () => { this.routeHudGesture("up"); },
      onScrollDown: () => { this.routeHudGesture("down"); },
      onHold: () => { this.cancelClick(); void this.beginHold().catch((error: unknown) => this.handleError(error)); },
      onCommit: () => void this.releaseHold().catch((error: unknown) => this.handleError(error)),
      onExit: kind => {
        // The wearer closed Helix: no resume prompt next time. Abnormal exits keep the flag.
        if (kind !== "abnormal") this.clearLifecycle();
        void this.dispose().catch((error: unknown) => this.handleError(error));
      },
      onMenu: id => void this.runShortcut(id).catch((error: unknown) => this.handleError(error)),
      onForeground: kind => { this.cancelClick(); this.handleForeground(kind); },
    });
  };

  // ---- Glasses HUD gesture routing (glasses-hud.ts) ----
  /** True when the glasses surface consumed the gesture; false = use the default action. */
  private routeHudGesture(gesture: HudGesture): boolean {
    if (this.disposed || this.exiting) return true;
    let command: HudCommand | undefined;
    try { command = this.renderer.handleGesture?.(gesture); } catch { return false; }
    if (!command) return false;
    this.runHudCommand(command);
    return true;
  }

  private runHudCommand(command: HudCommand): void {
    const fail = (error: unknown) => this.handleError(error);
    switch (command.type) {
      case "ask": void this.ask(command.text).catch(fail); break;
      case "askLocal": void this.askContext("local").catch(fail); break;
      case "askGlobal": void this.askContext("global").catch(fail); break;
      case "verify":
        try { if (command.kind === "claim") this.verifyClaim(command.id); else this.verify(command.target, command.id); } catch (error) { fail(error); }
        break;
      case "togglePause": void this.togglePause().catch(fail); break;
      case "resume": void this.requestResume().catch(fail); break;
      case "mode": void this.setMode(command.mode as ConversationMode).catch(fail); break;
      case "stop": void this.disconnect().catch(fail); break;
      case "connect": void this.connectFromGlasses().catch(fail); break;
      case "handled": break;
    }
  }

  /** MENU list click; waits out the double-press window like a tap (double closes the menu). */
  private queueListSelect(index: number, name?: string): void {
    if (this.disposed || this.exiting) return;
    this.cancelClick();
    this.clickTimer = setTimeout(() => {
      this.clickTimer = undefined;
      if (this.disposed || this.exiting) return;
      let command: HudCommand | undefined;
      try { command = this.renderer.selectListItem?.(index, name); } catch { command = undefined; }
      if (command) this.runHudCommand(command);
      else if (!this.routeHudGesture("click")) void this.askContext("local").catch((error: unknown) => this.handleError(error));
    }, 250);
  }

  // ---- v0.10 conversation modes ----
  private readonly modeListeners = new Set<(config: PluginConfig) => void>();
  public get mode(): ConversationMode { return this.config.conversationMode; }
  /** Called with the new config after a mode switch (the phone form re-reads its toggles). */
  public subscribeMode(listener: (config: PluginConfig) => void): () => void {
    this.modeListeners.add(listener); return () => this.modeListeners.delete(listener);
  }
  /**
   * Switch modes live: applies the mode's presets (copilot features, auto-answer, strategy), keeps
   * models/keys/memory, saves, and updates the phone and the glasses. A running session continues.
   */
  public setMode(mode: ConversationMode): Promise<void> {
    if (!(CONVERSATION_MODES as readonly string[]).includes(mode)) return Promise.resolve();
    const presets = modeProfile(mode).presets;
    // The older insight lane explains terms only when copilot concepts are off: keep it off with them.
    this.autoExplainEnabled = presets.concepts && this.autoExplainEnabled;
    if (!presets.claims && this.webCheckEnabled) { this.webCheckEnabled = false; this.cancelFactChecks(); }
    if (!this.autoExplainEnabled) this.cancelInsights();
    this.config = applyModePreset({ ...this.config, liveWebFactCheck: this.webCheckEnabled, autoExplainTerms: this.autoExplainEnabled }, mode);
    this.presentation.setMode(mode);
    this.presentation.setInteraction(`MODE · ${modeProfile(mode).label.toUpperCase()}`);
    if (!presets.suggestions) this.presentation.setSuggestions([]);
    for (const listener of this.modeListeners) { try { listener(this.config); } catch { /* isolate UI */ } }
    return this.saveMemorySettings();
  }
  // ---- end v0.10 modes ----

  // ---- Notes mode: session notebook (to-do list + running notes) ----
  private notebook?: SessionNotebook;
  private readonly notebookDrafts = new Map<string, SessionNotebookData>();
  /** One notebook per live session; every change reaches the phone, the glasses (confirmation) and the session's history record. */
  private startNotebook(sessionId: string, interruptedId?: string, continuesId?: string): void {
    this.notebookDrafts.delete(sessionId);
    // A resumed session continues the notebook of the conversation it belongs to: the interrupted part's
    // lists when it had any (it started from the earlier ones), else those of the session it continues.
    const interrupted = interruptedId ? this.history.getSession(interruptedId) : undefined, root = continuesId ? this.history.getSession(continuesId) : undefined;
    const todos = interrupted?.todos ?? root?.todos ?? [], notes = interrupted?.notes ?? root?.notes ?? [];
    if (todos.length || notes.length) this.presentation.applyNotebook(todos, notes);
    this.notebook = new SessionNotebook({ todos, notes, onChange: event => {
      if (this.session?.id !== sessionId || this.disposed) return;
      this.presentation.applyNotebook(event.todos, event.notes, this.exiting ? undefined : event.confirmation);
      this.notebookDrafts.set(sessionId, { todos: [...event.todos], notes: [...event.notes] });
      this.scheduleKnowledgeFlush();
    } });
  }
  /** Spoken to-do commands ("add a to-do ...", "mark the vendor call done") while Notes mode is on. */
  private notebookTranscript(event: GatewayEvent): void {
    if (event.type !== "transcript.final" || !this.notebook || event.sessionId !== this.session?.id) return;
    if (modeProfile(this.config.conversationMode).presets.noteTaking !== true) return;
    try { this.notebook.handleTranscript(event.transcriptId, event.text, event.context.speaker); } catch (error) { console.warn("Helix to-do command failed", error); }
  }
  /** Queues the notebook into the session's history record (same queue and debounce as session knowledge). */
  private flushNotebook(): void {
    for (const [sessionId, patch] of this.notebookDrafts) {
      this.notebookDrafts.delete(sessionId);
      if (this.historyDeletions.has(sessionId)) continue;
      const live = this.archiveSessionId === sessionId;
      // v0.13: the record is saved with its first content, and a to-do or note can be that first content
      // (added on the phone, or captured before any line was archived): save the record here too. A
      // resumed session that emptied the lists it started from is saved as well, so the merge sees it.
      const record = live && this.session?.id === sessionId && (patch.todos?.length || patch.notes?.length || this.session.continues) ? this.session : undefined;
      if (record) this.recordedSessionId = sessionId;
      const recorded = this.recordedSessionId === sessionId;
      this.enqueueArchive(async () => {
        if (this.historyDeletions.has(sessionId)) return;
        if (!record && !(live ? recorded : this.history.getSession(sessionId))) return;
        // Issued together: both land in the same (coalesced) write, the record first.
        await Promise.all([record ? this.history.upsertSession(record) : undefined, this.history.updateSessionNotebook(sessionId, patch)]);
      });
    }
  }
  /**
   * Phone edit of a to-do list (add / update / complete / remove / move): the live session's notebook,
   * or a saved session in History. Resolves false when nothing changed.
   */
  public async editTodo(op: TodoOp, sessionId?: string): Promise<boolean> {
    const id = sessionId ?? this.session?.id;
    if (!id) return false;
    if (this.session?.id === id && this.notebook) return this.notebook.apply(op, { origin: "user" }) !== undefined;
    const saved = this.history.getSession(id);
    if (!saved) return false;
    const result = applyTodoOp(saved.todos ?? [], op, { origin: "user" });
    if (!result.change) return false;
    await this.history.updateSessionNotebook(id, { todos: result.list });
    this.emitHistory();
    return true;
  }
  // ---- end Notes mode ----

  /** Phone -> glasses: move the HUD to `view` (e.g. when a phone tab is tapped). */
  public setHudView(view: HudView): void {
    if (this.disposed || this.exiting) return;
    this.renderer.setView?.(view);
  }
  // ---- end glasses HUD gesture routing ----

  // ---- lifecycle (glasses agent): WebView suspension / reclaim, foreground return ----
  /**
   * Re-push the glasses page and re-open the microphone after Android suspended the WebView
   * or the OS foreground layer closed. Idempotent and debounced (one per 1.5 s).
   * Main wires document visibilitychange -> visible and pageshow here.
   */
  public async resumeFromBackground(reason = "visible"): Promise<void> {
    if (!this.initialized || this.disposed || this.exiting) return;
    const now = Date.now();
    if (now - this.lastResumeAt < 1500) return;
    this.lastResumeAt = now;
    recordDiagnostic("glasses-repush", reason);
    try { await this.renderer.repush?.(); } catch (error) { console.warn("Helix glasses re-push failed", reason, error); }
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    if (this.audioSuspended) {
      // Paused for load while hidden: only a visible page (or the retry timer) turns the microphone back on.
      // A pause that began on screen waits for its own timer, or a glasses event would undo it at once.
      if (!hidden && this.audioSuspendedHidden) await this.resumeAudioAfterLoad("visible");
    } else if (this.micOn && !this.audioFlushing && this.client?.state === "active") {
      // Android stops the mic while suspended; re-enable with the same source. Not in the middle of an overload flush.
      try { await this.bridge.audioControl(true, this.micSource); } catch (error) { console.warn("Helix mic re-enable failed", error); }
    }
    // A socket that looks open after suspension may be dead: the transport replaces it when
    // no server event arrived for 10 s (optional SDK method; reconnect-on-close still applies).
    const transport = this.transport as (ConversationTransport & { resumeAfterSuspend?: (idleMs: number) => void }) | undefined;
    try { transport?.resumeAfterSuspend?.(10_000); } catch { /* optional */ }
  }

  /** Main wires the "tap to resume" prompt to the existing connect path (in-memory/saved keys only). */
  public setResumeHandler(handler: ((flag: LifecycleFlag) => Promise<void> | void) | undefined): void { this.resumeHandler = handler; }
  /** The interrupted session found at startup, if any (cleared once resumed or dismissed). */
  public get pendingResume(): LifecycleFlag | undefined { return this.resumeFlag; }

  public async requestResume(): Promise<void> {
    const flag = this.resumeFlag;
    if (!flag || !this.resumeHandler) return;
    this.presentation.setInteraction("RESUMING");
    await this.resumeHandler(flag);
  }

  public dismissResume(): void {
    this.resumeFlag = undefined;
    this.presentation.setResumePrompt(undefined);
    this.clearLifecycle();
  }

  private handleForeground(kind?: "enter" | "exit"): void {
    // Simulator 0.9.5: the OS context menu sends ENTER when it opens and EXIT when it closes, and
    // a rebuild under the overlay is harmless. Ignore the echo of our own page rebuilds.
    const now = Date.now();
    if (kind === "enter") {
      this.overlayAt = now;
      if (now - (this.renderer.lastRebuildAt ?? 0) < 1500) return;
      void this.resumeFromBackground("foreground-enter");
    } else if (kind === "exit") {
      // Back from a long absence (another glasses app, system UI): redraw as well.
      if (this.overlayAt && now - this.overlayAt > 20_000) void this.resumeFromBackground("foreground-exit");
      this.overlayAt = 0;
    }
  }

  private async offerResume(): Promise<void> {
    let flag: LifecycleFlag | undefined;
    try {
      const raw = await this.bridge.getLocalStorage(LIFECYCLE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) as Partial<LifecycleFlag> : undefined;
      if (parsed?.connected && typeof parsed.at === "number" && Date.now() - parsed.at < LIFECYCLE_MAX_AGE_MS) {
        flag = { connected: true, listening: !!parsed.listening, at: parsed.at, ...(typeof parsed.sessionId === "string" && parsed.sessionId ? { sessionId: parsed.sessionId } : {}) };
      }
    } catch { /* unreadable flag: no prompt */ }
    if (!flag || this.client) return;
    this.resumeFlag = flag;
    this.presentation.setResumePrompt(RESUME_PROMPT);
  }

  private persistLifecycle(): void {
    const connected = this.client?.state === "active";
    if (!connected) return;
    this.writeLifecycle(JSON.stringify({ connected: true, listening: this.micOn, at: Date.now(), ...(this.session ? { sessionId: this.session.continues ?? this.session.id } : {}) }));
  }

  private clearLifecycle(): void { this.writeLifecycle(""); }

  private writeLifecycle(value: string): void {
    const state = value ? value.replace(/"at":\d+/u, "") : "";
    if (state === this.lastLifecycle) return;
    this.lastLifecycle = state;
    this.lifecycleWrite = this.lifecycleWrite.then(async () => {
      try { await this.bridge.setLocalStorage(LIFECYCLE_STORAGE_KEY, value); } catch { /* best effort */ }
    });
  }
  // ---- end lifecycle ----

  private readonly handleClientState = (state: ConversationClientState): void => {
    if (state === "connecting") this.presentation.setStatus("connecting");
    if (state === "starting") this.presentation.setStatus("authorizing");
    if (state === "active" && !this.micOn) this.presentation.setStatus("connected");
    if (state === "failed") {
      this.presentation.setStatus("failed", "Direct provider connection failed");
      this.micOn = false; this.clearAudioPause(); this.resetAudioLoad();
      this.holding = false;
      void this.bridge.audioControl(false, this.micSource).catch(() => undefined);
    }
  };

  // ---- v0.12.2 audio intake: batched, bounded, and never replaying a backlog ----
  // The Even app delivers the microphone as 20 ms events (50 a second). When the WebView was suspended
  // (phone locked, app in the background) the events queued up natively and all arrive at once on resume:
  // measured in qa/perf.html, 5 minutes of backlog meant 21 MB of stale audio uploaded in a burst and a
  // main thread blocked for seconds, on a phone that was already hot. Only audio that can be live is kept.
  /** App bootstrap turns this on. Off, every frame is accepted at any rate (tests, offline replays). */
  public audioRealtimeGuard = false;
  private audioBudget = AUDIO_BURST_SAMPLES;
  private audioBudgetAt = 0;
  private audioDropped = 0;
  private audioBatch: Int16Array[] = [];
  private audioBatchSamples = 0;
  private audioBatchMeta?: { source: AudioEvent["source"]; direction: AudioEvent["direction"]; speakerRole: ReturnType<typeof normalizeSpeakerRole> };
  private audioBatchTimer?: ReturnType<typeof setTimeout>;
  private audioPending = 0;

  // ---- v0.13.2 microphone source ----
  /** Which microphone feeds the session: the glasses (default) or this phone. Phone is untested on hardware; Setup says so. */
  public micSource: AudioInputSource = AudioInputSource.Glasses;
  private micWrongSource = 0;
  private micRightSource = 0;
  /** Switches the microphone, re-opening it on the new source when it was on. Serialized with pause / hold. */
  public setMicSource(source: AudioInputSource): Promise<void> {
    return this.control(async () => {
      if (source === this.micSource) return;
      const wasOn = this.micOn;
      if (wasOn) { await this.closeMic(); await this.audioDrained(); await this.commitIfAudioAvailable(); }
      this.micSource = source;
      this.resetAudioLoad(); // the other microphone has its own delivery rate
      recordDiagnostic("mic-source", source);
      if (wasOn && this.client?.state === "active") await this.openMic();
    });
  }

  /**
   * Every microphone event enters here. While the overload guard has the microphone closed, events that
   * still arrive are the host's backlog: they return at once (two field writes, no conversion, no
   * allocation, no diagnostics) so the queue drains as fast as the page can take it.
   */
  private receiveAudio(audio: AudioEvent): void {
    if (this.audioFlushing || this.audioSuspended) { this.audioFlushSeen++; this.audioFlushLastAt = Date.now(); return; }
    const began = micHandlerBegin(audio.audioPcm.byteLength);
    countDiagnostic("audio");
    this.enqueueAudio(audio);
    micHandlerEnd(began);
  }

  private enqueueAudio(audio: AudioEvent): void {
    if (!this.micOn || this.disposed || this.exiting || this.client?.state !== "active") return;
    const sampleCount = ((audio.audioPcm as ArrayLike<number> | undefined)?.length ?? 0) >> 1;
    if (sampleCount === 0) return;
    // Only the selected microphone: after a switch the other one may still deliver for a moment. The SDK
    // tags an untagged frame as "glasses", so a host that does not tag phone audio shows up here, not as wrong audio.
    if ((audio.source ?? AudioInputSource.Glasses) !== this.micSource) {
      noteMicDropped("source");
      if (++this.micWrongSource === 150 && !this.micRightSource) {
        recordDiagnostic("mic-source-mismatch", `selected ${this.micSource}, but 150 audio events tagged ${String(audio.source)} and none tagged ${this.micSource}`);
        this.presentation.notice("mic-source", "Microphone", `No audio from the ${this.micSource} microphone has arrived; the Even app is sending ${String(audio.source)} audio, which is ignored. Check Setup → Diagnostics → Microphone.`);
      }
      return;
    }
    this.micRightSource++;
    if (this.audioRealtimeGuard) {
      this.trackAudioLoad(sampleCount);
      if (this.audioFlushing || this.audioSuspended) return; // this event tripped the guard: it is part of the backlog
      // Token bucket at the microphone's own rate (16 kHz, 25 % tolerance, 2 s burst for BLE jitter).
      const now = Date.now();
      this.audioBudget = Math.min(AUDIO_BURST_SAMPLES, this.audioBudget + Math.max(0, now - this.audioBudgetAt) * 20);
      this.audioBudgetAt = now;
      // Checked before the PCM is even converted: dropping a queued frame costs almost nothing.
      if (sampleCount > this.audioBudget || this.audioPending >= AUDIO_MAX_PENDING) { this.audioDropped += sampleCount; noteMicDropped("rate"); return; }
      this.audioBudget -= sampleCount;
      if (this.audioDropped) {
        const seconds = this.audioDropped / 16000; this.audioDropped = 0;
        if (seconds >= 1) recordDiagnostic("audio-backlog", `dropped ${seconds.toFixed(0)} s of queued microphone audio after a pause`);
      }
    }
    const samples = pcmS16LeBytesToSamples(audio.audioPcm);
    if (samples.length === 0) return;
    const speakerRole = normalizeSpeakerRole(audio.speakerRole); // the phone microphone has no direction tag: "unknown"
    this.lastFrameSpeaker = speakerForRole(speakerRole);
    const meta = this.audioBatchMeta;
    if (meta && (meta.speakerRole !== speakerRole || meta.source !== audio.source || meta.direction !== audio.direction)) this.flushAudioBatch();
    this.audioBatchMeta ??= { source: audio.source, direction: audio.direction, speakerRole };
    this.audioBatch.push(samples); this.audioBatchSamples += samples.length;
    // One hand-off per ~100 ms instead of one promise chain per 20 ms frame.
    if (this.audioBatchSamples >= AUDIO_BATCH_SAMPLES) this.flushAudioBatch();
    else this.audioBatchTimer ??= setTimeout(() => this.flushAudioBatch(), 120);
  }

  // ---- v0.12.3 overload while locked ----
  // Measured on an iPhone over USB (system log, 2026-11-21): 17 s after the screen locked, every microphone
  // event took ~42 ms to run in the backgrounded WebView (0.6 ms in the foreground), back to back at 100 %,
  // while events kept arriving faster than that. The queue grew without bound, captions stopped, and after
  // unlock the page stayed frozen and blank for 35 s because the "app is in the foreground" message sat behind
  // the queue. When audio arrives clearly slower than it is recorded while the page is hidden, stop the
  // microphone so the queue can drain, and try again later or when the page is visible.
  //
  // ---- v0.13.2 overload on screen ----
  // Same device, screen ON: ~42 events a second at 0.5-1 ms each for the first ~20 s, then one call of
  // 0.27-0.47 s, then 36-47 ms for every call (15 -> 20 -> 36 ms in steps): 25 served a second against 42
  // arriving. The host queue never drains and our own bridge replies wait behind it (6 -> 11 -> 18 -> 31 ->
  // 53 s), so captions stop, the page stops answering taps and is eventually killed. Why a call stays at
  // 40 ms is not known (mic-probe.ts measures it), so this does not depend on the cause: when delivery is
  // slow AND continuous, close the microphone, wait until audio events have really stopped (the queue is
  // empty and replies get through), then open it again. A weak glasses link also delivers slowly, but its
  // bridge replies are prompt, so a storage read is used as a ping to tell the two apart.
  private audioWindowAt = 0;
  private audioWindowSamples = 0;
  private audioWindowGap = 0;
  private audioLastAt = 0;
  private audioBaseline = 1;
  private audioBaselineWindows = 0;
  private audioSlowWindows = 0;
  private audioSteadySlow = 0;
  private audioStreamWindows = 0;
  private audioSuspended = false;
  private audioSuspendedHidden = false;
  private audioRetryTimer?: ReturnType<typeof setTimeout>;
  private audioRetryMs = AUDIO_RETRY_MS;
  private audioFlushing = false;
  private audioFlushTimer?: ReturnType<typeof setTimeout>;
  private audioFlushGeneration = 0;
  private audioFlushAt = 0;
  private audioFlushLastAt = 0;
  private audioFlushSeen = 0;
  private audioFlushResent = false;
  private audioFlushTimes: number[] = [];
  private audioUnconfirmedAt = 0;
  private audioResumedAt = 0;
  private audioReopenFails = 0;
  private audioPingAt = 0;
  private audioPingMs = 0;
  private audioPingDoneAt = 0;
  /** Second signal for the on-screen guard (test seam): oldest pending Even bridge call, recent timer lateness. */
  public audioPressure: (now: number) => { bridgePendingMs: number; timerLateMs: number } = mainThreadPressure;
  /** True while the microphone is stopped for a long pause because the phone could not keep up. */
  public get audioPausedForLoad(): boolean { return this.audioSuspended; }
  /** True during a short flush: microphone closed until the host's queued audio events have stopped arriving. */
  public get audioFlushingForLoad(): boolean { return this.audioFlushing; }
  private get audioGuardClosed(): boolean { return this.audioFlushing || this.audioSuspended; }

  private trackAudioLoad(sampleCount: number): void {
    const now = Date.now(), gap = now - this.audioLastAt;
    if (gap > 5000) { this.audioWindowAt = now; this.audioWindowSamples = 0; this.audioWindowGap = 0; this.audioSlowWindows = 0; this.audioSteadySlow = 0; this.audioStreamWindows = 0; } // new stream or a gap
    else if (gap > this.audioWindowGap) this.audioWindowGap = gap;
    this.audioLastAt = now;
    this.audioWindowSamples += sampleCount;
    const elapsed = now - this.audioWindowAt;
    if (elapsed < AUDIO_LOAD_WINDOW_MS) return;
    const ratio = this.audioWindowSamples / 16 / elapsed; // seconds of audio received per second of wall time
    const steady = this.audioWindowGap < AUDIO_STEADY_GAP_MS;
    this.audioWindowAt = now; this.audioWindowSamples = 0; this.audioWindowGap = 0;
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    // This device's normal delivery rate (42 events a second was measured, not 50). Learned on screen or
    // off, but never from a slow window: at 60 % a baseline that followed the rate would hide the overload.
    if (ratio < 1.5 && (this.audioBaselineWindows ? ratio >= this.audioBaseline * 0.85 : ratio > 0.7)) {
      this.audioBaselineWindows++;
      this.audioBaseline = this.audioBaselineWindows === 1 ? ratio : this.audioBaseline * 0.8 + ratio * 0.2;
    }
    // The first window of a stream is never judged: a microphone that was just opened starts unevenly.
    const below = ratio > 0.1 && ratio < this.audioBaseline * AUDIO_SLOW_SHARE, slow = this.audioStreamWindows++ > 0 && below;
    this.audioSlowWindows = slow ? this.audioSlowWindows + 1 : 0;
    this.audioSteadySlow = slow && steady ? this.audioSteadySlow + 1 : 0;
    if (this.audioSuspended || this.audioFlushing) return;
    if (hidden) {
      if (this.audioSlowWindows >= AUDIO_SLOW_WINDOWS) this.suspendAudioForLoad(true, `audio arriving at ${(ratio / this.audioBaseline * 100).toFixed(0)} % of real time while hidden`);
      return;
    }
    if (below && steady) this.pingBridge(now); // asked already in a stream's first window, so the answer is in by the next
    if (!this.audioSteadySlow) return;
    const pressure = this.audioPressure(now);
    const pingMs = this.audioPingAt ? now - this.audioPingAt : now - this.audioPingDoneAt <= 2 * AUDIO_LOAD_WINDOW_MS ? this.audioPingMs : 0;
    const confirmed = pingMs >= AUDIO_PING_SLOW_MS || pressure.bridgePendingMs >= AUDIO_BRIDGE_PENDING_MS || pressure.timerLateMs >= AUDIO_TIMER_LATE_MS;
    // A hold-to-talk turn is the wearer's; the guard waits for the release. No flush right after a re-open either.
    if (this.holding || now - this.audioResumedAt < AUDIO_FLUSH_SPACING_MS) return;
    // After a confirmed flush in the last minute one slow window is enough: waiting for two lets the queue grow
    // back to 4 s (seen in qa/mic-guard.html: 170 events, 8.8 s to drain).
    const repeat = this.audioFlushTimes.some(at => now - at < AUDIO_FLUSH_ESCALATE_MS);
    if (confirmed ? this.audioSteadySlow < (repeat ? 1 : AUDIO_FLUSH_WINDOWS)
      : this.audioSteadySlow < AUDIO_FLUSH_UNCONFIRMED_WINDOWS || now - this.audioUnconfirmedAt < AUDIO_FLUSH_UNCONFIRMED_EVERY_MS) return;
    const numbers = `audio at ${(ratio / this.audioBaseline * 100).toFixed(0)} % of this phone's normal rate (${ratio.toFixed(2)} of ${this.audioBaseline.toFixed(2)}) for ${this.audioSteadySlow} windows · ping ${Math.round(pingMs)} ms · bridge pending ${Math.round(pressure.bridgePendingMs)} ms · timer late ${Math.round(pressure.timerLateMs)} ms`;
    this.beginAudioFlush(now, confirmed, numbers);
  }

  /** A storage read that never touches the glasses: answered in milliseconds unless replies are queued behind audio events. */
  private pingBridge(now: number): void {
    if (this.audioPingAt || now - this.audioPingDoneAt < AUDIO_PING_EVERY_MS) return;
    this.audioPingAt = now;
    const done = (): void => { if (this.audioPingAt !== now) return; const at = Date.now(); this.audioPingAt = 0; this.audioPingMs = at - now; this.audioPingDoneAt = at; };
    try { void this.bridge.getLocalStorage(AUDIO_PING_KEY).then(done, done); } catch { done(); }
  }

  /**
   * Hands over what was captured before the gap and ends the turn: the transport commits a turn that has
   * speech and drops one that has none, so no half turn waits for audio that is not coming.
   */
  private settleAudioTurn(): void {
    this.flushAudioBatch();
    this.audioSendChain = this.audioSendChain
      .then(async () => { if (!this.disposed && !this.holding && this.client?.state === "active") await this.commitIfAudioAvailable(); })
      .catch((error: unknown) => this.handleError(error));
  }

  private beginAudioFlush(now: number, confirmed: boolean, numbers: string): void {
    this.audioSteadySlow = 0; this.audioSlowWindows = 0;
    if (confirmed) { this.audioFlushTimes = this.audioFlushTimes.filter(at => now - at < AUDIO_FLUSH_ESCALATE_MS); this.audioFlushTimes.push(now); }
    else this.audioUnconfirmedAt = now;
    if (confirmed && this.audioFlushTimes.length >= AUDIO_FLUSH_ESCALATE) {
      // Flushing did not help: stop for longer and tell the wearer, instead of opening and closing in a loop.
      this.audioFlushTimes = [];
      this.suspendAudioForLoad(false, `${numbers} · on screen · flush ${AUDIO_FLUSH_ESCALATE} within ${AUDIO_FLUSH_ESCALATE_MS / 1000} s`);
      return;
    }
    recordDiagnostic("audio-overload", `${numbers} · on screen · ${confirmed ? "backlog confirmed" : "no second signal"} · flushing`);
    this.settleAudioTurn();
    this.audioFlushing = true; this.audioFlushAt = now; this.audioFlushLastAt = now; this.audioFlushSeen = 0; this.audioFlushResent = false;
    const generation = ++this.audioFlushGeneration;
    // The reply to this call waits behind the queue; progress is judged by audio events stopping, not by the reply.
    void this.bridge.audioControl(false, this.micSource).catch(() => undefined);
    clearTimeout(this.audioFlushTimer);
    this.audioFlushTimer = setTimeout(() => this.pollAudioFlush(generation), AUDIO_FLUSH_POLL_MS);
  }

  private pollAudioFlush(generation: number): void {
    if (generation !== this.audioFlushGeneration || !this.audioFlushing) return;
    this.audioFlushTimer = undefined;
    const now = Date.now(), closed = now - this.audioFlushAt, quiet = now - this.audioFlushLastAt;
    if (closed >= AUDIO_FLUSH_MIN_MS && quiet >= AUDIO_FLUSH_QUIET_MS) {
      const seen = this.audioFlushSeen;
      this.audioFlushSeen = 0; this.audioFlushing = false;
      if (seen) noteMicDropped("flush", seen);
      recordDiagnostic("audio-flush", `microphone closed ${(closed / 1000).toFixed(1)} s · ${seen} queued audio events discarded · quiet for ${Math.round(quiet)} ms`);
      void this.reopenAfterGuard("flush", generation);
      return;
    }
    if (closed >= AUDIO_FLUSH_HARD_MS) {
      // Audio events never stopped: the close did not take, or the queue is longer than this. Re-opening would change nothing.
      recordDiagnostic("audio-flush", `not quiet after ${(closed / 1000).toFixed(0)} s · ${this.audioFlushSeen} audio events still arrived, the last ${Math.round(quiet)} ms ago`);
      this.audioFlushing = false;
      this.suspendAudioForLoad(false, "audio events kept arriving after the microphone was closed · on screen");
      return;
    }
    if (closed >= AUDIO_FLUSH_SOFT_MS && !this.audioFlushResent) { this.audioFlushResent = true; void this.bridge.audioControl(false, this.micSource).catch(() => undefined); }
    this.audioFlushTimer = setTimeout(() => this.pollAudioFlush(generation), AUDIO_FLUSH_POLL_MS);
  }

  /** Long pause: hidden page (as in 0.12.3), repeated flushes on screen, or a queue that would not drain. */
  private suspendAudioForLoad(hidden: boolean, detail: string): void {
    this.audioSuspended = true; this.audioSuspendedHidden = hidden; this.audioSlowWindows = 0; this.audioSteadySlow = 0;
    const retry = this.audioRetryMs, seconds = Math.round(retry / 1000);
    recordDiagnostic("audio-overload", `${detail} · microphone paused · retry in ${seconds} s`);
    this.settleAudioTurn();
    if (hidden) this.presentation.setInteraction("MIC PAUSED · PHONE BUSY · UNLOCK TO RESUME");
    else {
      this.presentation.setInteraction(`PHONE CAN'T KEEP UP · MIC PAUSED ${seconds} S`);
      this.presentation.notice("audio-overload", "Microphone paused", `This phone is not keeping up with the microphone audio, so listening is paused for ${seconds} s and then tried again. Pause and resume to try now. If it keeps happening, switch Setup → Diagnostics → Microphone, and send the diagnostics log.`);
    }
    void this.bridge.audioControl(false, this.micSource).catch(() => undefined);
    clearTimeout(this.audioRetryTimer);
    this.audioRetryTimer = setTimeout(() => { this.audioRetryMs = Math.min(retry * 2, AUDIO_RETRY_MAX_MS); void this.resumeAudioAfterLoad("retry"); }, retry);
  }

  /** Stops everything the guard has running (explicit pause / stop / failure / dispose). Flush history survives a pause. */
  private clearAudioPause(): void {
    clearTimeout(this.audioRetryTimer); this.audioRetryTimer = undefined;
    clearTimeout(this.audioFlushTimer); this.audioFlushTimer = undefined;
    this.audioFlushGeneration++;
    if (this.audioFlushSeen) { noteMicDropped("flush", this.audioFlushSeen); this.audioFlushSeen = 0; }
    this.audioFlushing = false; this.audioSuspended = false; this.audioSuspendedHidden = false;
    this.audioSlowWindows = 0; this.audioSteadySlow = 0; this.audioRetryMs = AUDIO_RETRY_MS; this.audioReopenFails = 0; this.audioLastAt = 0;
  }
  /** New session, other microphone or failure: forget the learned delivery rate and the flush history. */
  private resetAudioLoad(): void {
    this.audioBaseline = 1; this.audioBaselineWindows = 0; this.audioFlushTimes = []; this.audioUnconfirmedAt = 0; this.audioResumedAt = 0;
    this.audioPingAt = 0; this.audioPingMs = 0; this.audioPingDoneAt = 0; this.micWrongSource = 0; this.micRightSource = 0;
  }

  /** Re-opens the microphone after an overload pause (page visible again, or the retry timer). */
  private async resumeAudioAfterLoad(reason: "visible" | "retry"): Promise<void> {
    if (!this.audioSuspended) return;
    clearTimeout(this.audioRetryTimer); this.audioRetryTimer = undefined;
    const seen = this.audioFlushSeen; this.audioFlushSeen = 0;
    if (seen) noteMicDropped("flush", seen);
    this.audioSuspended = false; this.audioSlowWindows = 0; this.audioSteadySlow = 0;
    if (reason === "visible") this.audioRetryMs = AUDIO_RETRY_MS;
    if (!this.micOn || this.disposed || this.exiting || this.client?.state !== "active") return;
    this.presentation.setInteraction("LISTENING");
    await this.reopenAfterGuard(seen ? `${reason} · ${seen} late audio events discarded` : reason, ++this.audioFlushGeneration);
  }

  /** The wearer started listening or began a hold while the guard had the microphone closed: open it now. */
  private async reopenAudioNow(reason: "hold" | "start"): Promise<void> {
    clearTimeout(this.audioRetryTimer); this.audioRetryTimer = undefined;
    clearTimeout(this.audioFlushTimer); this.audioFlushTimer = undefined;
    if (this.audioFlushSeen) { noteMicDropped("flush", this.audioFlushSeen); this.audioFlushSeen = 0; }
    this.audioFlushing = false; this.audioSuspended = false; this.audioSuspendedHidden = false; this.audioRetryMs = AUDIO_RETRY_MS;
    await this.reopenAfterGuard(reason, ++this.audioFlushGeneration);
  }

  private async reopenAfterGuard(reason: string, generation: number): Promise<void> {
    // A fresh window and a small budget: anything that still trickles in from before the gap is not accepted as live.
    const now = Date.now();
    this.audioLastAt = 0; this.audioBudget = AUDIO_BATCH_SAMPLES * 2; this.audioBudgetAt = now; this.audioResumedAt = now;
    if (!this.micOn || this.disposed || this.exiting || this.client?.state !== "active") return;
    let opened = false;
    try { opened = await this.bridge.audioControl(true, this.micSource); } catch { /* retried below */ }
    if (generation !== this.audioFlushGeneration || !this.micOn || this.disposed) return; // paused, stopped or held meanwhile
    if (opened) { this.audioReopenFails = 0; recordDiagnostic("audio-resume", `${reason} · microphone re-opened`); return; }
    // Refused: stay closed and try again (5 s once, then the long-pause back-off), never in a tight loop.
    const retry = this.audioReopenFails++ ? this.audioRetryMs : AUDIO_REOPEN_RETRY_MS;
    recordDiagnostic("audio-resume", `${reason} · re-open refused · retry in ${Math.round(retry / 1000)} s`);
    this.audioSuspended = true;
    clearTimeout(this.audioRetryTimer);
    this.audioRetryTimer = setTimeout(() => { if (this.audioReopenFails > 1) this.audioRetryMs = Math.min(this.audioRetryMs * 2, AUDIO_RETRY_MAX_MS); void this.resumeAudioAfterLoad("retry"); }, retry);
  }

  private flushAudioBatch(): void {
    clearTimeout(this.audioBatchTimer); this.audioBatchTimer = undefined;
    const meta = this.audioBatchMeta, parts = this.audioBatch, total = this.audioBatchSamples;
    this.audioBatch = []; this.audioBatchSamples = 0; this.audioBatchMeta = undefined;
    const client = this.client;
    if (!meta || !total || !client || this.disposed || client.state !== "active") return;
    let samples: Int16Array;
    if (parts.length === 1) samples = parts[0]!;
    else { samples = new Int16Array(total); let offset = 0; for (const part of parts) { samples.set(part, offset); offset += part.length; } }
    this.audioPending++;
    this.audioSendChain = this.audioSendChain
      .then(async () => {
        if (this.disposed || client !== this.client || client.state !== "active") return;
        const began = performance.now();
        await client.sendAudio(samples, { source: meta.source, direction: meta.direction, speakerRole: meta.speakerRole, capturedAt: new Date().toISOString() });
        noteMicSend(performance.now() - began);
      })
      .catch((error: unknown) => this.handleError(error))
      .finally(() => { this.audioPending--; });
  }
  /** Everything received so far has been handed to the session. */
  private async audioDrained(): Promise<void> { this.flushAudioBatch(); await this.audioSendChain; }

  private async commitIfAudioAvailable(): Promise<boolean> {
    const client = this.client;
    if (!client || client.state !== "active") return false;
    try {
      // A speech submission is not an explicit answer request. Keep active
      // checks, pending speech, cooldown and context in the transport scheduler.
      await client.commitAudio("manual", this.lastFrameSpeaker);
      return true;
    } catch (error) {
      if (!errorMessage(error).includes("No uncommitted audio")) throw error;
      return false;
    }
  }

  private async releaseClient(reason: "user" | "shutdown" = "user"): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.unsubscribeClientEvent?.();
    this.unsubscribeClientEvent = undefined;
    this.unsubscribeClientState?.();
    this.unsubscribeClientState = undefined;
    if (!client) return;

    let stopError: unknown;
    try {
      await client.stop(reason);
    } catch (error) {
      stopError = error;
    }

    try {
      await client.dispose();
    } catch (error) {
      if (stopError === undefined) throw error;
    }

    if (stopError !== undefined) throw stopError;
  }

  /**
   * Issues archive writes in order without awaiting their save, so the store can coalesce a live
   * session's writes; it commits each only after it is saved. flushHistory()/disconnect()/dispose() wait.
   */
  private enqueueArchive(save: () => Promise<unknown>): void {
    this.archiveQueue = this.archiveQueue.then(() => {
      this.syncHistoryWriteDelay();
      this.setHistoryStatus("Saving local history…");
      let saved: Promise<unknown>;
      try { saved = save(); } catch (error) { saved = Promise.reject(error); }
      void saved.then(() => this.setHistoryStatus("Saved on this phone."), error => this.setHistoryStatus(errorMessage(error)));
    });
  }
  /** Live sessions coalesce history writes; imports, deletions and idle time write through. */
  private syncHistoryWriteDelay(): void {
    this.history.writeDelayMs = this.archiveSessionId && !this.bulkHistoryWrites && !this.disposed ? this.liveHistoryWriteDelayMs : 0;
  }
  private archiveEvent(event: GatewayEvent): void {
    const session = this.session;
    if (!session || event.sessionId !== session.id) return;
    if (event.type !== "transcript.final" && event.type !== "question.detected" && event.type !== "answer.completed") return;
    if (event.type === "transcript.final") this.transcriptRevisions.set(event.transcriptId, this.manualRevision);
    // A manual request waits for queued transcription. Advance again when that
    // barrier resolves so pre-request speech finishing late remains older.
    if (event.type === "question.detected" && event.context.trigger === "manual") this.manualRevision++;
    // Deletion suspends persistence, not live transcript/answer priority tracking.
    if (this.archiveSessionId !== session.id || this.historyDeletions.has(session.id)) return;
    if (!event.text.trim()) return;
    const kind = event.type === "transcript.final" ? "transcript" : event.type === "question.detected" ? "question" : "answer";
    const id = event.type === "transcript.final" ? event.transcriptId : event.type === "question.detected" ? event.questionId : event.answerId;
    const memory = event.type === "answer.completed" ? this.memoryByQuestion.get(event.questionId ?? "") : undefined;
    const entry: HistoryEntry = { id: `${session.id}:${id}`, sessionId: session.id, kind, text: event.text, occurredAt: this.uniqueEntryTime(event.occurredAt),
      speaker: kind === "answer" ? "Helix" : event.context.speaker.label,
      metadata: { model: event.context.endpoint.model, provider: event.context.endpoint.provider, endpoint: event.context.endpoint.url,
        promptVersion: event.context.prompt.version, latencyMs: String(event.context.latencyMs.totalMs),
        ...(memory?.length ? { memoryEntryIds: JSON.stringify(memory.map(item => item.entry.id)) } : {}) } };
    // v0.13: the title stays the placeholder while live (History shows a derived one); the real title is
    // written from the summary when the session ends, never from the first thing that was said.
    const updated = { ...session, updatedAt: event.occurredAt };
    this.session = updated; this.recordedSessionId = session.id;
    this.enqueueArchive(() => Promise.all([this.history.upsertSession(updated), this.history.upsertEntries([entry])]));
  }
  private handleFactCheck(result: FactCheckResult): void {
    const session = this.session;
    if (!this.webCheckEnabled || this.disposed || this.exiting || !session || result.sessionId !== session.id) return;
    const claimRevision = this.transcriptRevisions.get(result.transcriptId);
    this.presentation.applyFactCheck(result, !this.holding && claimRevision !== undefined && claimRevision >= this.manualRevision);
    if (this.archiveSessionId !== session.id || this.historyDeletions.has(session.id)) return;
    const updated = { ...session, updatedAt: result.checkedAt };
    this.session = updated; this.recordedSessionId = session.id;
    this.enqueueArchive(() => Promise.all([this.history.upsertSession(updated),
      this.history.upsertEntries([{ id: `${session.id}:${result.id}`, sessionId: session.id, kind: "fact-check",
        text: `${result.claim}\n${result.summary}`, occurredAt: this.uniqueEntryTime(result.checkedAt), sources: result.sources,
        metadata: { status: result.status, checkedAt: result.checkedAt } }])]));
  }

  /**
   * History orders entries by time, then by (random) id. Two lines saved in the same millisecond would
   * swap at random, so a later arrival with an already used timestamp moves forward by 1 ms.
   */
  private readonly entryTimes = new Set<number>();
  private uniqueEntryTime(occurredAt: string): string {
    let at = Date.parse(occurredAt);
    if (!Number.isFinite(at)) return occurredAt;
    const original = at;
    while (this.entryTimes.has(at)) at += 1;
    this.entryTimes.add(at);
    if (this.entryTimes.size > 4000) this.entryTimes.delete(this.entryTimes.values().next().value!);
    return at === original ? occurredAt : new Date(at).toISOString();
  }

  private handleInsight(insight: ContextInsight): void {
    if (!this.autoExplainEnabled || this.disposed || this.exiting || !this.session || insight.sessionId !== this.session.id) return;
    const revision = this.transcriptRevisions.get(insight.transcriptId);
    this.presentation.applyInsight(insight, !this.holding && revision !== undefined && revision >= this.manualRevision);
  }

  private requireActiveClient(): HelixConversationClient {
    if (!this.client || this.client.state !== "active") {
      // v0.11.1: after a reload the page is alive but not connected, and every action only failed.
      // Offer the one-tap connect (phone banner + glasses) instead of leaving a dead-looking screen.
      if (!this.client && !this.resumeFlag && this.resumeHandler && !this.disposed && !this.exiting) {
        this.resumeFlag = { connected: true, listening: false, at: Date.now() };
        this.presentation.setResumePrompt(CONNECT_PROMPT);
      }
      throw new Error("Connect Helix with your provider API key first");
    }
    return this.client;
  }

  private requireInitialized(): void {
    if (!this.initialized || this.disposed) throw new Error("The G2 plugin is not ready");
  }

  private handleError(error: unknown): void {
    if (this.disposed) return;
    this.presentation.setStatus("failed", errorMessage(error));
  }
}

function normalizeSpeakerRole(role: AudioSpeakerRole): Speaker["role"] {
  if (role === AudioSpeakerRole.Self) return "self";
  if (role === AudioSpeakerRole.Other) return "other";
  return "unknown";
}

function speakerForRole(role: Speaker["role"]): Speaker {
  if (role === "self") return { label: "You", role };
  if (role === "other") return { label: "Other speaker", role };
  return { label: "Speaker", role };
}

/** Normalized person key (matches the SDK's LocalHistoryStore people merge). */
function personKey(name: string): string { return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}_${uuid ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Audio intake: frames are handed on in ~100 ms batches; at most 2 s may arrive at once; at most 3 s may wait. */
const AUDIO_BATCH_SAMPLES = 1600, AUDIO_BURST_SAMPLES = 32_000, AUDIO_MAX_PENDING = 30;
/** Overload check: 2 s windows; 3 slow windows in a row while hidden pause the microphone; retry after 30 s, doubling to 4 min. */
const AUDIO_LOAD_WINDOW_MS = 2000, AUDIO_SLOW_WINDOWS = 3, AUDIO_RETRY_MS = 30_000, AUDIO_RETRY_MAX_MS = 240_000;
// v0.13.2 on-screen overload (measurements: "overload on screen" in the audio intake section).
/** A window is slow below this share of the device's own delivery rate (measured failure: ~60 %). */
const AUDIO_SLOW_SHARE = 0.72;
/** Slow and still continuous: no gap this long inside the window. A weak link or a pause shows longer gaps; the measured stall calls were 0.27-0.47 s. */
const AUDIO_STEADY_GAP_MS = 600;
/** Slow windows needed with evidence of a backlog (4 s; 2 s when it already happened in the last minute), and without any (16 s, at most once a minute). */
const AUDIO_FLUSH_WINDOWS = 2, AUDIO_FLUSH_UNCONFIRMED_WINDOWS = 8, AUDIO_FLUSH_UNCONFIRMED_EVERY_MS = 60_000;
/** Evidence: our bridge ping unanswered this long, any bridge call pending this long, or a 1 s timer this late. */
const AUDIO_PING_SLOW_MS = 1500, AUDIO_BRIDGE_PENDING_MS = 3000, AUDIO_TIMER_LATE_MS = 400, AUDIO_PING_EVERY_MS = 2000;
export const AUDIO_PING_KEY = "helix.mic.ping";
/** Flush: microphone closed at least 1 s, re-opened after 0.5 s without an audio event; close repeated at 3 s; given up at 10 s. */
const AUDIO_FLUSH_MIN_MS = 1000, AUDIO_FLUSH_QUIET_MS = 500, AUDIO_FLUSH_SOFT_MS = 3000, AUDIO_FLUSH_HARD_MS = 10_000, AUDIO_FLUSH_POLL_MS = 100;
/** No new flush this soon after re-opening; the third confirmed flush within a minute becomes a long pause. */
const AUDIO_FLUSH_SPACING_MS = 4000, AUDIO_FLUSH_ESCALATE = 3, AUDIO_FLUSH_ESCALATE_MS = 60_000, AUDIO_REOPEN_RETRY_MS = 5000;
/** Live-session history write coalescing window for the phone app (set on G2ConversationController.liveHistoryWriteDelayMs). */
export const LIVE_HISTORY_WRITE_DELAY_MS = 10_000;

/** Session note for retrieval: the Obsidian export without the YAML front matter and the Mermaid map (search noise). */
export function knowledgeText(markdown: string, session: HistorySession): string {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n+/u, "").replace(/^## Diagram\n+```mermaid\n[\s\S]*?\n```\n*/mu, "");
  const date = session.startedAt.slice(0, 10);
  return body.replace(/^# .*$/mu, heading => `${heading}\n\nSession date: ${date} · source: ${session.source}`).trim();
}
