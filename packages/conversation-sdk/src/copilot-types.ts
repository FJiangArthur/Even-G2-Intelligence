/**
 * v0.7 copilot contract. Shared by the SDK lanes (copilot.ts, model-catalog.ts,
 * direct-transport.ts) and the G2 plugin (controller, presentation, UI).
 * Copilot output travels through host callbacks, never through the strict
 * protocol GatewayEvent union, so legacy protocol validation stays unchanged.
 */
import type { Speaker } from "./types.js";
import type { AnswerLength } from "./answer-length.js";
import type { SessionNotebook } from "./session-notebook.js";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface AnswerModelInfo {
  readonly id: string;
  readonly label: string;
  /** "current" = listed on OpenAI's pricing/model pages Nov 2026; "legacy" = still callable, older. */
  readonly tier: "current" | "legacy";
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  /** Lowest-latency effort the model accepts; used for live answers. */
  readonly liveEffort?: ReasoningEffort;
  /** USD per 1M tokens. undefined = provider no longer publishes a price. */
  readonly price?: { readonly input: number; readonly cachedInput: number; readonly output: number };
  /** Responses API only (no Chat Completions support documented). */
  readonly responsesOnly: boolean;
  readonly webSearch: boolean;
}

export interface TranscriptionModelInfo {
  readonly profileId: string;
  readonly model: string;
  readonly label: string;
  /** USD per audio minute; undefined when not published. */
  readonly pricePerMinute?: number;
  readonly deprecated?: string;
}

export type UsageKind = "answer" | "copilot" | "lookup" | "verify" | "insight" | "transcription" | "fact-check";

export interface UsageRecord {
  readonly id: string;
  readonly kind: UsageKind;
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly webSearchCalls: number;
  readonly audioSeconds: number;
  /** undefined when the model has no published price. Never a guess. */
  readonly costUsd?: number;
  /** true when tokens came from provider `usage`; false = local byte estimate. */
  readonly measured: boolean;
  readonly at: string;
  readonly relatedId?: string;
}

/** Wall-clock timing for one answer, all relative to its trigger. */
export interface AnswerTiming {
  /** Speech audio duration that produced the trigger (0 for typed). */
  readonly speechMs: number;
  /** Upload + transcription round trip. */
  readonly transcriptionMs?: number;
  /** Waiting for earlier queued work before the answer request started. */
  readonly queueMs: number;
  /** Request dispatched -> first streamed text. */
  readonly firstTokenMs?: number;
  /** Request dispatched -> completed. */
  readonly generationMs: number;
  /** End of speech (or typed submit) -> completed. What the wearer feels. */
  readonly endToEndMs: number;
}

export interface Citation {
  readonly url: string; readonly title: string;
  /** Publication date "YYYY-MM-DD" when known. */
  readonly publishedAt?: string;
  /** search = date from the provider's search results; model = date the model reported for a page it cited. */
  readonly dateSource?: "search" | "model";
  /** Site / publisher name when the search engine returned one. */
  readonly site?: string;
}

export interface AnswerMeta {
  readonly answerId: string;
  readonly questionId?: string;
  readonly timing: AnswerTiming;
  readonly usage?: UsageRecord;
  /** Web citations when the answer used web search. */
  readonly sources: readonly Citation[];
  readonly grounded: "web" | "memory" | "conversation";
  /** Retrieval diagnostics so the UI can say *why* no source was used. */
  readonly retrieval: { readonly searchedEntries: number; readonly matched: number; readonly webUsed: boolean; /** Set when the passages came from the OpenAI knowledge base. */ readonly knowledge?: "openai" };
}

export interface CopilotSummary {
  readonly bullets: readonly string[];
  /** Decisions, numbers, owners spoken so far. */
  readonly keyFacts: readonly string[];
  readonly updatedAt: string;
  readonly transcriptChars: number;
}

export interface CopilotConcept {
  readonly id: string;
  readonly term: string;
  readonly explanation: string;
  readonly transcriptId?: string;
  readonly createdAt: string;
  readonly origin: "copilot" | "insight" | "user";
}

export interface CopilotConflict {
  readonly id: string;
  readonly earlier: string;
  readonly later: string;
  readonly explanation: string;
  readonly createdAt: string;
}

export interface CopilotSuggestion {
  readonly id: string;
  readonly question: string;
  readonly why: string;
  readonly createdAt: string;
  /** Set once the wearer (or, in Candidate mode, the other side) has said this question aloud. */
  readonly askedAt?: string;
  /**
   * Candidate mode only. "they-ask" = a question the interviewer is likely to ask next (panel heading
   * "They may ask"); "ask-them" = a question the wearer could ask ("Ask them"). Absent = ask-them.
   */
  readonly kind?: "they-ask" | "ask-them";
}

/**
 * Implicit information needs found in non-question speech.
 *  lookup  = time-sensitive/public fact: lead time, price, availability -> web search.
 *  propose = design/opinion prompt: "16 GB RAM with 1 TB SSD architecture" -> proposed answer.
 */
export interface CopilotAsk {
  readonly id: string;
  readonly kind: "lookup" | "propose" | "question";
  readonly topic: string;
  readonly trigger: string;
  readonly status: "pending" | "done" | "failed";
  readonly answer?: string;
  readonly sources?: readonly Citation[];
  readonly createdAt: string;
  readonly transcriptId?: string;
}

export interface VerificationResult {
  readonly id: string;
  readonly target: string;
  readonly status: "supported" | "contradicted" | "uncertain" | "unavailable";
  readonly summary: string;
  readonly sources: readonly Citation[];
  readonly checkedAt: string;
  readonly requestedBy: "user" | "auto";
  /** "news" when the check was biased to recent reporting (time-sensitive claim). */
  readonly recency?: "news" | "general";
  /** Provider whose search produced the sources, e.g. "OpenAI", "DeepSeek". */
  readonly via?: string;
}

/**
 * v0.8 question taxonomy (three kinds):
 *  answer  = a question someone ELSE asked the wearer -> show a direct answer (glasses ANSWER view).
 *  ask     = a question the WEARER could ask the other party -> show as a prompt to say (CopilotSuggestion).
 *  implicit= a statement that implies an information need (CopilotAsk lookup/propose).
 * Questions spoken by the wearer themself (speaker role "self") are not auto-answered.
 */
export type QuestionKind = "answer" | "ask" | "implicit";

/** A checkable statement (fact, number, date, commitment) worth a Verify action on glasses/phone. */
export interface CopilotClaim {
  readonly id: string;
  readonly text: string;
  readonly speaker?: string;
  readonly transcriptId?: string;
  /** public = web-checkable; conversation = check against what was said earlier. */
  readonly scope: "public" | "conversation";
  readonly createdAt: string;
}

/** A person mentioned in (or speaking in) the conversation. */
export interface CopilotPerson {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  /** Short context: what they said/own/were mentioned for, in this conversation. */
  readonly context: string;
  readonly mentions: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface CopilotSettings {
  readonly summarize: boolean;
  readonly concepts: boolean;
  readonly conflicts: boolean;
  readonly suggestions: boolean;
  /** Auto-answer implicit asks (lookup via web search, propose via model). */
  readonly implicitAsks: boolean;
  /** Allow web search for lookups and grounded answers (incurs provider charges). */
  readonly webGrounding: boolean;
  /** Cheap model for the background copilot lane. */
  readonly copilotModel: string;
  /** v0.8, optional for old configs (treated as true when absent). */
  readonly claims?: boolean;
  readonly people?: boolean;
  /** v0.10 conversation mode (modeProfile id): steers suggestions, summary focus and tone. */
  readonly mode?: string;
  /** Answer length for lookups, proposals, verdicts and concept explanations (absent = standard). */
  readonly answerLength?: AnswerLength;
  /** Bias web checks to recent news and ask for dated sources (absent = off, the pre-setting behaviour). */
  readonly newsSearch?: boolean;
}

export const DEFAULT_COPILOT_SETTINGS: CopilotSettings = Object.freeze({
  summarize: true, concepts: true, conflicts: true, suggestions: true,
  implicitAsks: true, webGrounding: true, copilotModel: "gpt-6-luna",
});

export interface CopilotCallbacks {
  readonly enabled: () => boolean;
  readonly settings: () => CopilotSettings;
  readonly onSummary?: (summary: CopilotSummary) => void;
  readonly onConcept?: (concept: CopilotConcept) => void;
  readonly onConflict?: (conflict: CopilotConflict) => void;
  /** Replaces the whole suggestion list (bounded to 5, open ones first, then those just asked). May be empty: suggestions expire and are cleared on a mode change. */
  readonly onSuggestions?: (items: readonly CopilotSuggestion[]) => void;
  /** Called with pending first, then done/failed for the same id. */
  readonly onAsk?: (ask: CopilotAsk) => void;
  readonly onVerification?: (result: VerificationResult) => void;
  /** v0.8: checkable claims (deduped per session). */
  readonly onClaim?: (claim: CopilotClaim) => void;
  /** v0.8: people, upserted by normalized name (mentions/lastSeen/context update). */
  readonly onPerson?: (person: CopilotPerson) => void;
  /**
   * Notes mode: the session notebook the copilot keeps current (to-do operations and running notes).
   * Used only while the mode preset `noteTaking` is on; changes are reported by the notebook itself.
   */
  readonly notebook?: () => SessionNotebook | undefined;
}

/** Extra transport capabilities exposed by DirectConversationTransport in v0.7. */
export interface CopilotTransport {
  /** Rehearsal/simulation: treat text as a final transcript from `speaker`. No STT call. */
  injectTranscript(text: string, speaker: Speaker): Promise<void>;
  /** User-requested verification of any point (answer sentence, summary bullet, claim). */
  verify(target: string, id?: string): void;
  /** Run the copilot lane immediately (bypasses debounce, keeps one-active rule). */
  runCopilotNow(): void;
  /**
   * v0.8 (optional): verify a stored CopilotClaim by id. The VerificationResult arrives via
   * onVerification with id === claimId. Returns false when the claim id is unknown.
   */
  verifyClaim?(claimId: string): boolean;
}

/** v0.8 knowledge base: where a session/note came from and can be transferred to. */
export type KnowledgeSource = "helix" | "omi" | "obsidian";

/**
 * v0.8 glasses -> phone mirror. The HUD publishes what is on the glasses so the phone can show
 * it and follow ring/temple operations (view changes, menu, selection).
 */
export interface HudMirror {
  readonly view: string;
  readonly header: string;
  readonly body: string;
  readonly caption: string;
  readonly menuOpen: boolean;
  /** Highlighted item index in the current view/menu, when any. */
  readonly selection?: number;
  /** Last gesture that changed the HUD, e.g. "down", "click", "double", "menu:verify". */
  readonly lastGesture?: string;
  readonly updatedAt: number;
  /** v0.10: the two header containers (title left, status right) as the glasses show them. */
  readonly title?: string;
  readonly status?: string;
  /** v0.10: pixel-art images on the glasses by slot, e.g. { mascot: "mascot:listening", badge: "badge:technical" }. */
  readonly images?: Readonly<Record<string, string>>;
  /** v0.11: right side of the BODY box (mode, view list with unseen counts) and the BODY text itself (also while the menu is open). */
  readonly railMode?: string;
  readonly railViews?: string;
  readonly content?: string;
  /** Ambient display: the glasses are blank except for an answer / cue pop-up (no frame, no images). */
  readonly ambient?: boolean;
}
