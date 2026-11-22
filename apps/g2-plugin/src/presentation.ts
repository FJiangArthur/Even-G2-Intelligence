import type {
  GatewayEvent, FactCheckResult, RetrievedMemory, ContextInsight,
  AnswerMeta, CopilotAsk, CopilotConcept, CopilotConflict, CopilotSuggestion, CopilotSummary,
  CopilotPerson, UsageKind, UsageRecord, VerificationResult,
  CopilotClaim, HudMirror, SessionNote, TodoItem,
} from "@helix/conversation-sdk";
import type { GlassesConversationState, NoteDeliveryState } from "./glasses-renderer";

export const FEED_LIMIT = 400;
export type FeedKind = "transcript" | "question" | "answer" | "note" | "error" | "fact-check" | "insight";
export type SpeakerRole = "self" | "other" | "unknown";
/** v0.8 question kinds on the phone: others asked the wearer / the wearer asked / explicit request to Helix. */
export type FeedQuestionKind = "they" | "you" | "request";

export interface FeedItem {
  readonly id: string;
  readonly kind: FeedKind;
  readonly label: string;
  readonly body: string;
  readonly meta?: string;
  readonly streaming?: boolean;
  readonly noteTitle?: string;
  readonly noteDelivery?: NoteDeliveryState;
  readonly sources?: { url: string; title: string }[];
  readonly memorySources?: RetrievedMemory[];
  readonly sourceTranscriptId?: string;
  readonly sourceSessionId?: string;
  /** v0.8 continuous transcript: display speaker ("You" / "Them" / "Speaker" / a name) and diarized role. */
  readonly speaker?: string;
  readonly speakerRole?: SpeakerRole;
  readonly questionKind?: FeedQuestionKind;
  readonly occurredAt?: string;
  /** Answers: the provider cut it short; the body is what arrived. */
  readonly partial?: boolean;
}

/** Phone tabs. Only the phone shows copilot output; glasses stay answer-first. */
export const COMPANION_TABS = ["answers", "concepts", "summary", "qa", "checks", "people", "history", "knowledge", "setup"] as const;
export type CompanionTab = typeof COMPANION_TABS[number];

const GENERIC_SPEAKERS = new Set(["", "speaker", "unknown", "other", "other speaker", "g2 conversation", "conversation", "user", "them"]);
/** Phone speaker label: role self -> "You", other -> "Them", unknown -> a real name if one was given, else "Speaker". */
export function speakerName(label: string | undefined, role: SpeakerRole | undefined): string {
  if (role === "self") return "You";
  if (role === "other") return "Them";
  const clean = (label ?? "").split(" · ")[0]!.trim();
  if (/^(you|me|self)$/iu.test(clean)) return "You";
  return GENERIC_SPEAKERS.has(clean.toLowerCase()) ? "Speaker" : clean.slice(0, 40);
}

/**
 * One rendered block of the Answers feed. Consecutive transcript finals from the same speaker
 * merge into one paragraph; the live partial joins the open paragraph when the speaker matches.
 * Only a speaker change or a question/answer card closes a paragraph. Side cards (insight, note,
 * fact check, error) that arrive mid-paragraph are placed right after it so speech keeps flowing.
 */
export type FeedBlock =
  | { readonly type: "paragraph"; readonly id: string; readonly speaker: string; readonly role: SpeakerRole;
    readonly segments: readonly FeedItem[]; readonly partial?: FeedItem }
  | { readonly type: "card"; readonly id: string; readonly item: FeedItem };
type ParagraphBlock = Extract<FeedBlock, { type: "paragraph" }>;

export const PARTIAL_TRANSCRIPT_ID = "transcript-partial";
const INTERRUPTING_KINDS: ReadonlySet<FeedKind> = new Set<FeedKind>(["question", "answer"]);

export function feedBlocks(feed: readonly FeedItem[]): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  let open: ParagraphBlock | undefined;
  let deferred: FeedBlock[] = [];
  const close = () => {
    if (open) blocks.push(open);
    blocks.push(...deferred);
    open = undefined; deferred = [];
  };
  const partial = feed.find(item => item.id === PARTIAL_TRANSCRIPT_ID && item.kind === "transcript");
  for (const item of feed) {
    if (item === partial) continue;
    if (item.kind !== "transcript") {
      const card: FeedBlock = { type: "card", id: item.id, item };
      if (open && !INTERRUPTING_KINDS.has(item.kind)) { deferred.push(card); continue; }
      close(); blocks.push(card); continue;
    }
    if (!item.body.trim()) continue;
    const speaker = item.speaker ?? speakerName(item.label, item.speakerRole);
    if (open && open.speaker === speaker) { open = { ...open, segments: [...open.segments, item] }; continue; }
    close();
    open = { type: "paragraph", id: `para:${item.id}`, speaker, role: item.speakerRole ?? "unknown", segments: [item] };
  }
  if (partial?.body.trim()) {
    const speaker = partial.speaker ?? speakerName(partial.label, partial.speakerRole);
    if (open && open.speaker === speaker) open = { ...open, partial };
    else {
      close();
      open = { type: "paragraph", id: `para:${PARTIAL_TRANSCRIPT_ID}`, speaker, role: partial.speakerRole ?? "unknown", segments: [], partial };
    }
  }
  close();
  return blocks;
}

/** Text of a paragraph block: finals joined with single spaces (no break between sentences). */
export function paragraphText(block: Extract<FeedBlock, { type: "paragraph" }>): string {
  return block.segments.map(item => item.body.trim()).filter(Boolean).join(" ");
}

const normalizedName = (name: string) => name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

export interface UsageBucket {
  /** Sum of records with a published price. */
  readonly costUsd: number;
  /** Records whose model has no published price (never guessed). */
  readonly unknownCostCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
}
export interface UsageTotals extends UsageBucket {
  readonly byKind: Partial<Record<UsageKind, UsageBucket>>;
}

/** Newest copilot item, for the cross-tab peek strip. `seq` increases per peek. */
export interface PresentationPeek {
  readonly seq: number;
  readonly id: string;
  readonly tab: CompanionTab;
  readonly kind: "concept" | "conflict" | "ask" | "verification" | "suggestion";
  readonly title: string;
  readonly text: string;
}

/** Notes mode: the live session's to-do list and running notes, plus the latest glasses confirmations. */
export interface NotebookView {
  readonly todos: readonly TodoItem[];
  readonly notes: readonly SessionNote[];
  /** Newest last, bounded to 5; each is one short line such as "TODO + Send quote - Mei, Fri". */
  readonly cues: readonly { readonly id: string; readonly text: string }[];
}

export interface PresentationSnapshot {
  readonly status: string;
  /** Exact asynchronous failure detail, when the current status needs attention. */
  readonly error?: string;
  readonly feed: readonly FeedItem[];
  readonly glasses: GlassesConversationState;
  readonly summary?: CopilotSummary;
  /** Oldest first, bounded to 100, unique by case-insensitive term. */
  readonly concepts: readonly CopilotConcept[];
  readonly conflicts: readonly CopilotConflict[];
  readonly suggestions: readonly CopilotSuggestion[];
  readonly asks: readonly CopilotAsk[];
  readonly verifications: readonly VerificationResult[];
  readonly factChecks: readonly FactCheckResult[];
  readonly answerMeta: Readonly<Record<string, AnswerMeta>>;
  readonly usage: UsageTotals;
  /** End-to-end latency of the most recent answer with timing meta. */
  readonly lastLatencyMs?: number;
  readonly unseen: Readonly<Record<CompanionTab, number>>;
  readonly peek?: PresentationPeek;
  /** v0.8 people in the live session, upserted by normalized name (oldest first, bounded to 100). */
  readonly people: readonly CopilotPerson[];
  /** v0.8 glasses -> phone mirror: what the HUD shows right now (published by the glasses HUD). */
  readonly hud?: HudMirror;
  /** v0.8 checkable claims (oldest first, bounded to 50, unique by id and normalized text). */
  readonly claims: readonly CopilotClaim[];
  /** v0.8 verification ids requested and not yet answered (verify(target, id) with an id). */
  readonly verifying: readonly string[];
  /** Notes mode notebook of the live session (absent until something was captured). */
  readonly notebook?: NotebookView;
}

const LIMITS = { concepts: 100, conflicts: 50, asks: 50, verifications: 50, factChecks: 50, answerMeta: 100, people: 100 } as const;
const emptyBucket = (): UsageBucket => ({ costUsd: 0, unknownCostCount: 0, inputTokens: 0, outputTokens: 0, requests: 0 });
const emptyUnseen = (): Record<CompanionTab, number> => ({ answers: 0, concepts: 0, summary: 0, qa: 0, checks: 0, people: 0, history: 0, knowledge: 0, setup: 0 });
function addUsage(bucket: UsageBucket, record: UsageRecord): UsageBucket {
  return {
    costUsd: bucket.costUsd + (record.costUsd ?? 0),
    unknownCostCount: bucket.unknownCostCount + (record.costUsd === undefined ? 1 : 0),
    inputTokens: bucket.inputTokens + record.inputTokens,
    outputTokens: bucket.outputTokens + record.outputTokens,
    requests: bucket.requests + 1,
  };
}
function upsertById<T extends { readonly id: string }>(list: T[], item: T, limit: number): { list: T[]; added: boolean; previous?: T } {
  const index = list.findIndex(candidate => candidate.id === item.id);
  if (index >= 0) { const previous = list[index]; const next = [...list]; next[index] = item; return { list: next, added: false, previous }; }
  const next = [...list, item];
  return { list: next.length > limit ? next.slice(-limit) : next, added: true };
}
const ACTIVE_STATUSES = ["connected", "listening", "paused"];
/** Statuses that end the session (or the attempt): only these clear the glasses answer. */
const ENDING_STATUSES = ["failed", "stopped", "exited", "ready"];

export type PresentationListener = (snapshot: PresentationSnapshot) => void;

export class ConversationPresentation {
  private status = "ready";
  private error?: string;
  private feed: FeedItem[] = [];
  private glasses: GlassesConversationState = { status: "ready" };
  private readonly questions = new Map<
    string,
    NonNullable<GlassesConversationState["question"]>
  >();
  private readonly questionOrder: string[] = [];
  private readonly listeners = new Set<PresentationListener>();
  private readonly retiredAnswers = new Set<string>();
  private readonly retiredQuestions = new Set<string>();
  private waitingForManual = false;
  private manualQuestionId?: string;
  private readonly memorySources = new Map<string, RetrievedMemory[]>();
  private summary?: CopilotSummary;
  private concepts: CopilotConcept[] = [];
  private conflicts: CopilotConflict[] = [];
  private suggestions: CopilotSuggestion[] = [];
  private asks: CopilotAsk[] = [];
  private verifications: VerificationResult[] = [];
  private factChecks: FactCheckResult[] = [];
  private answerMeta = new Map<string, AnswerMeta>();
  private usage: UsageTotals = { ...emptyBucket(), byKind: {} };
  private readonly usageIds = new Set<string>();
  private lastLatencyMs?: number;
  private unseen = emptyUnseen();
  private peek?: PresentationPeek;
  private peekSeq = 0;
  private people: CopilotPerson[] = [];
  // ---- v0.8 glasses: HUD mirror, claims, pending verifications (glasses agent) ----
  private hud?: HudMirror;
  private claims: CopilotClaim[] = [];
  private readonly verifying = new Map<string, number>();
  // ---- Notes mode: to-do list + running notes ----
  private notebook?: NotebookView;
  private notebookSeq = 0;
  private noticeSeq = 0;

  /**
   * Notes mode: the notebook changed. `confirmation` is the one-line glasses confirmation of a to-do
   * change; it travels the cue path (LIVE item on the HUD, cue on the answers-only layout).
   */
  public applyNotebook(todos: readonly TodoItem[], notes: readonly SessionNote[], confirmation?: string): void {
    const text = confirmation?.replace(/\s+/gu, " ").trim();
    const cue = text ? { id: `todo-cue-${++this.notebookSeq}`, text } : undefined;
    this.notebook = { todos: structuredClone([...todos]), notes: structuredClone([...notes]), cues: cue ? [...(this.notebook?.cues ?? []), cue].slice(-5) : this.notebook?.cues ?? [] };
    this.unseen.summary = 1;
    if (cue && ACTIVE_STATUSES.includes(this.status) && this.cueEligible()) this.glasses = { ...this.glasses, cue };
    this.emit();
  }

  /** Glasses -> phone mirror. Emits only when the visible content or menu/selection changed. */
  public setHud(mirror: HudMirror): void {
    const previous = this.hud;
    if (previous && previous.view === mirror.view && previous.header === mirror.header && previous.body === mirror.body
      && previous.caption === mirror.caption && previous.menuOpen === mirror.menuOpen && previous.selection === mirror.selection
      && previous.lastGesture === mirror.lastGesture) return;
    this.hud = { ...mirror };
    this.emit();
  }

  /** Checkable claims (deduped by id and by normalized text; newest wording wins, position kept). */
  public applyClaim(claim: CopilotClaim): void {
    const text = claim.text?.trim();
    if (!text) return;
    const key = text.replace(/\s+/gu, " ").toLowerCase();
    const index = this.claims.findIndex(item => item.id === claim.id || item.text.replace(/\s+/gu, " ").trim().toLowerCase() === key);
    if (index >= 0) {
      const next = [...this.claims]; next[index] = { ...structuredClone(claim), id: this.claims[index]!.id, text }; this.claims = next;
    } else {
      this.claims = [...this.claims, { ...structuredClone(claim), text }].slice(-50);
    }
    this.emit();
  }

  /** Marks a user-requested verification as pending until applyVerification delivers the same id. */
  public beginVerification(id: string): void {
    if (!id) return;
    this.verifying.delete(id);
    this.verifying.set(id, Date.now());
    while (this.verifying.size > 20) this.verifying.delete(this.verifying.keys().next().value!);
    this.emit();
  }

  /** v0.10 conversation mode, shown on the phone and the glasses (switchable live). */
  public setMode(mode: string): void {
    if (this.glasses.mode === mode) return;
    this.glasses = { ...this.glasses, mode };
    this.emit();
  }

  /** Lifecycle: "session paused while Helix was in the background" prompt (phone + glasses). */
  public setResumePrompt(text?: string): void {
    if ((this.glasses.resumePrompt ?? "") === (text ?? "")) return;
    this.glasses = { ...this.glasses, resumePrompt: text || undefined };
    this.emit();
  }
  // ---- end v0.8 glasses ----

  /**
   * v0.8 People: upsert by normalized name. Mentions take the larger count (the copilot reports
   * running totals), lastSeen/context/role follow the newest report, firstSeen and id are kept.
   */
  public applyPerson(person: CopilotPerson): void {
    const name = person.name?.trim().replace(/\s+/gu, " ");
    if (!name) return;
    const key = normalizedName(name);
    const index = this.people.findIndex(item => normalizedName(item.name) === key || item.id === person.id);
    if (index >= 0) {
      const previous = this.people[index]!;
      const merged: CopilotPerson = {
        ...previous,
        name: previous.name.length >= name.length ? previous.name : name,
        ...(person.role?.trim() ? { role: person.role.trim() } : {}),
        context: person.context?.trim() || previous.context,
        mentions: Math.max(previous.mentions, Number.isFinite(person.mentions) ? person.mentions : 0, 1),
        firstSeen: [previous.firstSeen, person.firstSeen].filter(Boolean).sort()[0] ?? previous.firstSeen,
        lastSeen: [previous.lastSeen, person.lastSeen].filter(Boolean).sort().at(-1) ?? previous.lastSeen,
      };
      if (JSON.stringify(merged) === JSON.stringify(previous)) return;
      const next = [...this.people]; next[index] = merged; this.people = next;
    } else {
      this.people = [...this.people, { ...structuredClone(person), name, mentions: Math.max(1, person.mentions || 0) }].slice(-LIMITS.people);
      this.unseen.people++;
    }
    this.emit();
  }

  public applyInsight(insight: ContextInsight, eligibleForGlasses = false): void {
    if (!ACTIVE_STATUSES.includes(this.status)) return;
    this.upsert({ id: insight.id, kind: "insight", label: insight.term, body: insight.explanation,
      meta: "AI-generated · Not web-verified", sourceTranscriptId: insight.transcriptId, sourceSessionId: insight.sessionId });
    this.addConcept({ id: insight.id, term: insight.term, explanation: insight.explanation, createdAt: insight.createdAt,
      origin: "insight", ...(insight.transcriptId ? { transcriptId: insight.transcriptId } : {}) });
    if (eligibleForGlasses && this.cueEligible()) {
      this.glasses = { ...this.glasses, cue: { id: insight.id, text: `${insight.term}: ${insight.explanation}` } };
    }
    this.emit();
  }

  /** Copilot concept channel. Phone-only; dedupes by term (latest explanation wins, position kept). */
  public applyConcept(concept: CopilotConcept): void {
    this.addConcept(concept);
    this.emit();
  }

  /** Conflicts may cue the glasses under the same idle-only rules as insight cues. */
  public applyConflict(conflict: CopilotConflict, eligibleForGlasses = false): void {
    const result = upsertById(this.conflicts, structuredClone(conflict), LIMITS.conflicts);
    this.conflicts = result.list;
    if (result.added) {
      this.unseen.checks++;
      this.setPeek({ id: conflict.id, tab: "checks", kind: "conflict", title: "Conflict", text: conflict.explanation || conflict.later });
    }
    if (eligibleForGlasses && ACTIVE_STATUSES.includes(this.status) && this.cueEligible()) {
      this.glasses = { ...this.glasses, cue: { id: conflict.id, text: `Conflict: ${conflict.explanation || conflict.later}` } };
    }
    this.emit();
  }

  public applySummary(summary: CopilotSummary): void {
    const changed = JSON.stringify(summary.bullets) !== JSON.stringify(this.summary?.bullets ?? [])
      || JSON.stringify(summary.keyFacts) !== JSON.stringify(this.summary?.keyFacts ?? []);
    this.summary = structuredClone(summary);
    if (changed) this.unseen.summary = 1;
    this.emit();
  }

  /** Replaces the suggestion list; only ids not shown before count as new. */
  public setSuggestions(items: readonly CopilotSuggestion[]): void {
    const known = new Set(this.suggestions.map(item => item.id));
    // A suggestion that was already said aloud is not news.
    const fresh = items.filter(item => !known.has(item.id) && !item.askedAt);
    this.suggestions = structuredClone([...items]);
    this.unseen.qa += fresh.length;
    const first = fresh[0];
    if (first) this.setPeek({ id: first.id, tab: "qa", kind: "suggestion", title: "Suggested question", text: first.question });
    this.emit();
  }

  /** Upsert by id: pending first, then done/failed. */
  public applyAsk(ask: CopilotAsk): void {
    const result = upsertById(this.asks, structuredClone(ask), LIMITS.asks);
    this.asks = result.list;
    const settled = ask.status !== "pending" && result.previous?.status === "pending";
    if (result.added || settled) {
      this.unseen.qa++;
      const title = ask.kind === "lookup" ? "Looking up" : ask.kind === "propose" ? "Proposal" : "Question";
      this.setPeek({ id: ask.id, tab: "qa", kind: "ask", title: ask.status === "pending" ? `${title}…` : `${title} · ${ask.status}`,
        text: ask.status === "done" && ask.answer ? `${ask.topic}: ${ask.answer}` : ask.topic });
    }
    this.emit();
  }

  public applyVerification(result: VerificationResult): void {
    this.verifying.delete(result.id);
    const next = upsertById(this.verifications, structuredClone(result), LIMITS.verifications);
    const changedStatus = next.previous?.status !== result.status;
    this.verifications = next.list;
    if (next.added || changedStatus) {
      this.unseen.checks++;
      this.setPeek({ id: result.id, tab: "checks", kind: "verification", title: `Verify · ${result.status}`, text: result.summary || result.target });
    }
    this.emit();
  }

  /** Timing/usage/sources for one answer. Usage is deduped by record id, so the
   * controller may also pass the same record to applyUsage. */
  public applyAnswerMeta(meta: AnswerMeta): void {
    this.answerMeta.delete(meta.answerId);
    this.answerMeta.set(meta.answerId, structuredClone(meta));
    while (this.answerMeta.size > LIMITS.answerMeta) {
      const oldest = this.answerMeta.keys().next().value;
      if (oldest === undefined) break;
      this.answerMeta.delete(oldest);
    }
    if (Number.isFinite(meta.timing.endToEndMs)) this.lastLatencyMs = meta.timing.endToEndMs;
    if (meta.usage) this.addUsageRecord(meta.usage);
    this.emit();
  }

  public applyUsage(record: UsageRecord): void {
    if (this.addUsageRecord(record)) this.emit();
  }

  public markSeen(tab: CompanionTab): void {
    if (this.unseen[tab] === 0) return;
    this.unseen = { ...this.unseen, [tab]: 0 };
    this.emit();
  }

  private addUsageRecord(record: UsageRecord): boolean {
    if (this.usageIds.has(record.id)) return false;
    this.usageIds.add(record.id);
    const byKind = { ...this.usage.byKind, [record.kind]: addUsage(this.usage.byKind[record.kind] ?? emptyBucket(), record) };
    this.usage = { ...addUsage(this.usage, record), byKind };
    return true;
  }

  private addConcept(concept: CopilotConcept): void {
    const key = concept.term.trim().toLowerCase();
    const index = this.concepts.findIndex(item => item.term.trim().toLowerCase() === key || item.id === concept.id);
    if (index >= 0) {
      const next = [...this.concepts]; next[index] = structuredClone(concept); this.concepts = next;
      return;
    }
    this.concepts = [...this.concepts, structuredClone(concept)].slice(-LIMITS.concepts);
    this.unseen.concepts++;
    this.setPeek({ id: concept.id, tab: "concepts", kind: "concept", title: concept.term, text: concept.explanation });
  }

  private setPeek(peek: Omit<PresentationPeek, "seq">): void {
    this.peek = { ...peek, seq: ++this.peekSeq };
  }

  private cueEligible(): boolean {
    return !this.waitingForManual && !this.manualQuestionId && !this.glasses.answer?.streaming;
  }
  public dismissCue(): void { this.glasses = { ...this.glasses, cue: undefined }; this.emit(); }
  public dismissInsight(id: string): void {
    if (!this.feed.some(item => item.id === id && item.kind === "insight")) return;
    this.remove(id);
    if (this.glasses.cue?.id === id) this.glasses = { ...this.glasses, cue: undefined };
    this.emit();
  }

  public setMemorySources(items: RetrievedMemory[], questionId?: string): void {
    this.memorySources.set(questionId ?? "", structuredClone(items));
  }
  public applyFactCheck(result: FactCheckResult, eligibleForGlasses = false): void {
    if (!ACTIVE_STATUSES.includes(this.status)) return;
    const sources = result.sources.filter(source => {
      try { const url = new URL(source.url); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !/[\u0000-\u0020\u007f]/u.test(source.url); } catch { return false; }
    });
    this.upsert({ id: result.id, kind: "fact-check", label: `Web check · ${result.status}`, body: `${result.claim}\n${result.summary}`,
      meta: `Checked ${result.checkedAt}`, sources });
    const stored = upsertById(this.factChecks, { ...structuredClone(result), sources }, LIMITS.factChecks);
    this.factChecks = stored.list;
    if (stored.added) this.unseen.checks++;
    if (eligibleForGlasses && result.status === "contradicted" && sources.length && !this.waitingForManual && !this.manualQuestionId && !this.glasses.answer?.streaming) {
      this.retireAnswer();
      this.glasses = { ...this.glasses, answer: { id: result.id, text: `Correction: ${result.summary}`, speaker: "Web check", streaming: false } };
    }
    this.emit();
  }

  /** The phone feed is history; only glasses output is retired on a new ask. */
  public beginRequest(): void {
    this.glasses = { ...this.glasses, cue: undefined, manualPending: true };
    this.retireAnswer();
    for (const id of this.questions.keys()) this.retiredQuestions.add(id);
    this.waitingForManual = true;
    this.manualQuestionId = undefined;
    this.emit();
  }

  private retireAnswer(retireQuestion = true): void {
    const answer = this.glasses.answer;
    const partial = answer?.id ? this.feed.find(item => item.id === answer.id && item.streaming) : undefined;
    if (partial) this.upsert({ ...partial, streaming: false, label: "Helix · interrupted" });
    if (answer?.id) this.retiredAnswers.add(answer.id);
    if (retireQuestion && answer?.questionId) this.retiredQuestions.add(answer.questionId);
    this.glasses = { ...this.glasses, answer: undefined,
      answerResetRevision: (this.glasses.answerResetRevision ?? 0) + 1 };
  }

  private acceptsAnswer(answerId: string, questionId?: string): boolean {
    if (this.retiredAnswers.has(answerId) || (questionId !== undefined && this.retiredQuestions.has(questionId))) return false;
    if (this.waitingForManual) return false;
    if (this.glasses.answer?.id && this.glasses.answer.id !== answerId) this.retireAnswer(false);
    return true;
  }

  public snapshot(): PresentationSnapshot {
    return {
      status: this.status,
      ...(this.error === undefined ? {} : { error: this.error }),
      feed: this.feed.map((item) => ({ ...item })),
      glasses: { ...this.glasses },
      ...(this.summary ? { summary: this.summary } : {}),
      concepts: [...this.concepts],
      conflicts: [...this.conflicts],
      suggestions: [...this.suggestions],
      asks: [...this.asks],
      verifications: [...this.verifications],
      factChecks: [...this.factChecks],
      answerMeta: Object.fromEntries(this.answerMeta),
      usage: { ...this.usage, byKind: { ...this.usage.byKind } },
      ...(this.lastLatencyMs === undefined ? {} : { lastLatencyMs: this.lastLatencyMs }),
      unseen: { ...this.unseen },
      ...(this.peek ? { peek: this.peek } : {}),
      people: [...this.people],
      ...(this.hud ? { hud: { ...this.hud } } : {}),
      claims: [...this.claims],
      verifying: [...this.verifying.keys()],
      ...(this.notebook ? { notebook: this.notebook } : {}),
    };
  }

  public subscribe(listener: PresentationListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /**
   * Only a session-ending status clears the glasses answer. An error with any other status is
   * transient (busy, a failed retry, a copilot failure): the request that was waiting is over, the
   * answer on screen stays, and the glasses show the message as a brief notice.
   */
  public setStatus(status: string, error?: string): void {
    const ending = ENDING_STATUSES.includes(status);
    if (ending) {
      this.glasses = { ...this.glasses, cue: undefined, manualPending: false };
      this.retireAnswer();
    } else if (error) {
      this.glasses = { ...this.glasses, manualPending: false };
    }
    if (ending || error) {
      this.manualQuestionId = undefined;
      this.waitingForManual = false;
    }
    this.status = status;
    this.error = error;
    this.glasses = { ...this.glasses, status, error: ending ? error : undefined,
      notice: !ending && error ? { id: ++this.noticeSeq, text: error } : undefined };
    this.emit();
  }

  /** Phone-only informational card (e.g. model fallback). */
  public notice(id: string, label: string, body: string): void {
    this.upsert({ id, kind: "note", label, body });
    this.emit();
  }

  public setInteraction(message?: string): void {
    this.glasses = { ...this.glasses, interaction: message };
    this.emit();
  }

  public reset(): void {
    this.status = "ready";
    this.error = undefined;
    this.feed = [];
    this.glasses = { status: "ready", ...(this.glasses.mode ? { mode: this.glasses.mode } : {}) };
    this.questions.clear();
    this.memorySources.clear();
    this.retiredAnswers.clear();
    this.retiredQuestions.clear();
    this.waitingForManual = false;
    this.manualQuestionId = undefined;
    this.questionOrder.length = 0;
    this.summary = undefined;
    this.concepts = []; this.conflicts = []; this.suggestions = []; this.asks = [];
    this.verifications = []; this.factChecks = [];
    this.answerMeta.clear(); this.usageIds.clear();
    this.usage = { ...emptyBucket(), byKind: {} };
    this.lastLatencyMs = undefined;
    this.unseen = emptyUnseen();
    this.peek = undefined;
    this.people = [];
    this.claims = []; this.verifying.clear();
    this.notebook = undefined;
    this.emit();
  }

  public apply(event: GatewayEvent): void {
    if (event.type !== "error") this.error = undefined;
    const feedback = this.glasses.interaction;
    if (event.type === "answer.delta" && feedback === "SENT / WAITING FOR RESPONSE") {
      this.glasses = { ...this.glasses, interaction: "ANSWER / RECEIVING" };
    }
    if (event.type === "answer.completed" && (feedback === "SENT / WAITING FOR RESPONSE" || feedback === "ANSWER / RECEIVING")) {
      this.glasses = { ...this.glasses, interaction: undefined };
    }
    switch (event.type) {
      case "session.started":
        this.setStatus("connected");
        return;
      case "session.ended":
        this.setStatus("stopped");
        return;
      case "transcript.partial": {
        const label = `${event.context.speaker.label} · hearing`;
        this.upsert({
          id: "transcript-partial",
          kind: "transcript",
          label,
          body: event.text,
          streaming: true,
          speaker: speakerName(event.context.speaker.label, event.context.speaker.role),
          speakerRole: event.context.speaker.role,
          occurredAt: event.occurredAt,
        });
        this.glasses = {
          ...this.glasses,
          error: undefined, notice: undefined,
        };
        break;
      }
      case "transcript.final": {
        this.remove("transcript-partial");
        this.upsert({
          id: event.transcriptId,
          kind: "transcript",
          label: `${event.context.speaker.label} · transcript`,
          body: event.text,
          speaker: speakerName(event.context.speaker.label, event.context.speaker.role),
          speakerRole: event.context.speaker.role,
          occurredAt: event.occurredAt,
        });
        this.glasses = {
          ...this.glasses,
          error: undefined, notice: undefined,
        };
        break;
      }
      case "question.detected": {
        if (this.retiredQuestions.has(event.questionId)) return;
        if (this.questions.has(event.questionId)) return;
        const manual = event.context.trigger === "manual";
        const contextLabel = ["Local context", "Whole conversation"].includes(event.context.speaker.label);
        const question = {
          text: event.text,
          speaker: event.context.speaker.label,
          confidence: event.confidence,
          // v0.8 glasses: "THEY ASKED" vs manual vs self-asked (never auto-shown on glasses).
          role: event.context.speaker.role,
          trigger: event.context.trigger ?? (manual ? "manual" : "question"),
        };
        this.rememberQuestion(event.questionId, question);
        // v0.8: a question the wearer spoke is "You asked" (never auto-answered); others' are "They asked".
        const questionKind: FeedQuestionKind = manual ? "request" : event.context.speaker.role === "self" ? "you" : "they";
        this.upsert({
          id: event.questionId,
          kind: "question",
          questionKind,
          speaker: speakerName(event.context.speaker.label, event.context.speaker.role),
          speakerRole: event.context.speaker.role,
          occurredAt: event.occurredAt,
          ...(event.sourceTranscriptId ? { sourceTranscriptId: event.sourceTranscriptId } : {}),
          label: manual
            ? `${event.context.speaker.label} · ${contextLabel ? "request" : "manual question"}`
            : questionKind === "you" ? "You asked" : "They asked",
          body: manual && contextLabel
            ? (event.context.speaker.label === "Local context" ? "Help with the recent conversation." : "Help using the whole conversation.")
            : event.text,
          meta: manual ? undefined : `${Math.round(event.confidence * 100)}% confidence`,
        });
        // Detection is phone-only, including after answer completion while the
        // reader is still paging. Only an actual new answer may replace it.
        if (!manual) break;
        this.retireAnswer();
        if (manual) {
          this.waitingForManual = false;
          this.manualQuestionId = event.questionId;
        }
        this.glasses = {
          ...this.glasses,
          question,
          answer: undefined,
          error: undefined, notice: undefined,
        };
        break;
      }
      case "answer.delta": {
        if (!this.acceptsAnswer(event.answerId, event.questionId)) return;
        this.glasses = { ...this.glasses, cue: undefined };
        const id = event.answerId;
        const previous = this.feed.find((item) => item.id === id)?.body ?? "";
        const text = `${previous}${event.delta}`;
        this.upsert({ id, kind: "answer", label: "Helix · answering", body: text, streaming: true,
          memorySources: this.memorySources.get(event.questionId ?? "") });
        this.glasses = {
          ...this.glasses,
          question: this.questionFor(event.questionId),
          answer: { id: event.answerId, questionId: event.questionId, text, speaker: "Helix", streaming: true },
          error: undefined, notice: undefined,
        };
        break;
      }
      case "answer.completed": {
        if (!this.acceptsAnswer(event.answerId, event.questionId)) return;
        this.glasses = { ...this.glasses, cue: undefined, manualPending: false };
        if (event.questionId === this.manualQuestionId) this.manualQuestionId = undefined;
        if (this.feed.find(item => item.id === event.answerId)?.kind !== "answer" || this.feed.find(item => item.id === event.answerId)?.streaming) this.unseen.answers++;
        this.upsert({
          id: event.answerId,
          kind: "answer",
          label: event.partial ? "Helix · answer cut off" : "Helix · answer",
          ...(event.partial ? { partial: true } : {}),
          body: event.text,
          meta: `${Math.round(event.context.latencyMs.totalMs)} ms`,
          memorySources: this.memorySources.get(event.questionId ?? ""),
        });
        this.glasses = {
          ...this.glasses,
          question: this.questionFor(event.questionId),
          answer: { id: event.answerId, questionId: event.questionId, text: event.text, speaker: "Helix", streaming: false, ...(event.partial ? { partial: true } : {}) },
          error: undefined, notice: undefined,
        };
        break;
      }
      case "note.suggested": {
        const noteDelivery = noteDeliveryState(event.note.persistence);
        this.upsert({
          id: event.note.id,
          kind: "note",
          label: noteLabel(noteDelivery, event.note.title),
          body: event.note.text,
          meta: noteMeta(event.note.tags, event.note.persistence?.failureCode),
          noteTitle: event.note.title,
          noteDelivery,
        });
        this.glasses = {
          ...this.glasses,
          note: {
            id: event.note.id,
            text: event.note.text,
            speaker: "Helix",
            delivery: noteDelivery,
          },
          error: undefined, notice: undefined,
        };
        break;
      }
      case "error":
        this.glasses = { ...this.glasses, interaction: undefined };
        this.upsert({
          id: event.eventId,
          kind: "error",
          label: event.retryable ? "Temporary problem" : "Problem",
          body: event.message,
          meta: event.code,
        });
        this.setStatus(event.fatal ? "failed" : this.status, event.message);
        return;
    }
    this.emit();
  }

  public markNoteSaved(noteId: string): void {
    const item = this.feed.find((candidate) => candidate.id === noteId);
    if (item && item.noteDelivery === "suggested") {
      this.upsert({
        ...item,
        label: noteLabel("session", item.noteTitle),
        noteDelivery: "session",
      });
    }
    if (
      this.glasses.note?.id === noteId
      && this.glasses.note.delivery === "suggested"
    ) {
      this.glasses = {
        ...this.glasses,
        note: { ...this.glasses.note, delivery: "session" },
      };
    }
    this.emit();
  }

  private upsert(item: FeedItem): void {
    const index = this.feed.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) this.feed[index] = item;
    else this.feed.push(item);
    // Long meetings: keep a continuous transcript (was 50 items, which silently dropped earlier speech).
    if (this.feed.length > FEED_LIMIT) this.feed = this.feed.slice(-FEED_LIMIT);
  }

  private remove(id: string): void {
    this.feed = this.feed.filter((item) => item.id !== id);
  }

  private rememberQuestion(
    id: string,
    question: NonNullable<GlassesConversationState["question"]>,
  ): void {
    if (!this.questions.has(id)) this.questionOrder.push(id);
    this.questions.set(id, question);
    while (this.questionOrder.length > 50) {
      const removed = this.questionOrder.shift();
      if (removed !== undefined) this.questions.delete(removed);
    }
  }

  private questionFor(
    questionId: string | undefined,
  ): NonNullable<GlassesConversationState["question"]> | undefined {
    return questionId === undefined ? undefined : this.questions.get(questionId);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}

function noteDeliveryState(
  persistence: { readonly destination: "omi"; readonly status: string } | undefined,
): NoteDeliveryState {
  if (!persistence) return "suggested";
  if (persistence.status === "pending") return "omi-pending";
  if (persistence.status === "synced") return "omi-synced";
  return "omi-failed";
}

function noteLabel(delivery: NoteDeliveryState, title?: string): string {
  const prefix = (() => {
    switch (delivery) {
      case "session": return "Captured this session";
      case "omi-pending": return "Omi sync pending";
      case "omi-synced": return "Omi synced";
      case "omi-failed": return "Omi sync failed";
      default: return "Note suggested";
    }
  })();
  return title ? `${prefix} · ${title}` : prefix;
}

function noteMeta(tags?: readonly string[], failureCode?: string): string | undefined {
  const parts = [...(tags ?? [])];
  if (failureCode) parts.push(`Sync error: ${failureCode}`);
  return parts.length ? parts.join(" · ") : undefined;
}
