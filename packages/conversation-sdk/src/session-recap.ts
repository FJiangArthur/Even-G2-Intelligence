/**
 * v0.13 session recap: what a saved session is called and its one-to-two line summary.
 *
 * A Helix session gets a generated title + overview when it ends (session-digest.ts, one model call,
 * provenance in `session.recap`). Everything else gets the deterministic fallback below, computed
 * from what is saved and never from the first thing that was said: sessions recorded before v0.13,
 * sessions that ended without a key or with a failed call, and interrupted sessions.
 */
import type { HistoryEntry, HistorySession } from "./local-history.js";
import type { KnowledgeSource } from "./copilot-types.js";

export interface SessionRecapView {
  readonly title: string;
  /** One or two sentences. "" when nothing is known about the session. */
  readonly overview: string;
  /** model: written by the summary model · fallback: derived on the phone · imported: the stored title as it came. */
  readonly origin: "model" | "fallback" | "imported";
}

/** Transcript text below this is not worth a model call (a stray word, a mic test). */
export const MIN_RECAP_TRANSCRIPT_CHARS = 40;

const FILLER = new Set(("about above actually after again against almost already also although always another anything around basically because been before being "
  + "below between both cannot could does doing done down during each either else enough even ever every everything from further gets getting give "
  + "goes going gonna good great guess have having hello here hers himself into just kind know known later least less like little look looking "
  + "lots made make makes many maybe mean means might more most much must myself need needs never next nice nothing okay once only onto other "
  + "ours over really right said same says seem seems shall should since some something sort still stuff such sure take taken tell than thank "
  + "thanks that thats their theirs them then there these they thing things think this those though through together told took under until upon "
  + "very want wants well were what whatever when where whether which while will with within without would yeah yes your yours helix speaker").split(" "));
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1), space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:·—–-]+$/u, "")}…`;
}
const spoken = (entries: readonly HistoryEntry[]) => entries.filter(entry => entry.kind === "transcript" && entry.text.trim()
  && entry.metadata?.origin !== "omi-summary" && !/^omi summary$/iu.test(entry.speaker?.trim() ?? ""));

/** True when the session has something worth keeping: any saved line, knowledge the copilot extracted, or a to-do / note (Notes mode). */
export function sessionHasContent(session: HistorySession, entryCount: number): boolean {
  return entryCount > 0 || !!(session.summary?.length || session.keyFacts?.length || session.people?.length || session.concepts?.length
    || session.todos?.length || session.notes?.length);
}

/** What was said, oldest first, without re-sent partials (a line that the next line starts with). */
function spokenTexts(entries: readonly HistoryEntry[]): string[] {
  const lines = spoken(entries).slice().sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)).map(entry => entry.text.replace(/\b(?:https?|wss?):\/\/\S+/giu, " ").replace(/\s+/gu, " ").trim());
  const flat = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return lines.filter((text, index) => text && !(index + 1 < lines.length && flat(lines[index + 1]!).startsWith(flat(text))));
}

/**
 * Topic words of the transcript, in the order they first came up. Deliberately strict, because a
 * wrong topic is worse than none: an acronym or code (CDTF, G2, RTX4090) counts from its first
 * mention, a name (capitalised inside a sentence) from two lines, an ordinary word from three.
 */
export function sessionKeywords(entries: readonly HistoryEntry[], max = 3): string[] {
  const found = new Map<string, { count: number; first: number; text: string; rank: number }>();
  let position = 0;
  for (const text of spokenTexts(entries)) {
    const seen = new Set<string>();
    for (const match of text.normalize("NFKC").matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
      position++;
      const word = match[0].replace(/['’]s$/u, ""), key = word.toLowerCase();
      if (/['’]/u.test(word) || CJK.test(word) || FILLER.has(key) || /^\d+$/u.test(word) || seen.has(key)) continue;
      const before = text.slice(0, match.index).trimEnd();
      const rank = /^(?=.*\p{Lu})[\p{Lu}\p{N}-]{2,}$/u.test(word) ? 3 : /^\p{Lu}/u.test(word) && before && !/[.!?。！？:]$/u.test(before) ? 2 : 1;
      if (rank === 1 && key.length < 5) continue;
      seen.add(key); // once per line: a word repeated in one sentence is not a topic
      const item = found.get(key);
      if (!item) found.set(key, { count: 1, first: position, text: rank > 1 ? word : key, rank });
      else { item.count++; if (rank > item.rank) { item.rank = rank; item.text = word; } }
    }
  }
  return [...found.values()].filter(item => item.count >= (item.rank === 3 ? 1 : item.rank === 2 ? 2 : 3))
    .sort((a, b) => b.rank * b.count - a.rank * a.count || a.first - b.first).slice(0, max)
    .sort((a, b) => a.first - b.first).map(item => item.text);
}

function partOfDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Saved";
  const hour = date.getHours();
  return hour < 5 ? "Late-night" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : hour < 22 ? "Evening" : "Late-night";
}

/**
 * Deterministic title + overview from what is saved (no model call): the copilot's summary bullets when
 * there are any, else the transcript's topic words ("About CDTF, Jetson"), else the time of day
 * ("Evening conversation"). Never the first thing that was said.
 */
export function fallbackSessionRecap(session: HistorySession, entries: readonly HistoryEntry[] = []): { title: string; overview: string } {
  const bullets = (session.summary ?? []).map(item => item.trim()).filter(Boolean);
  const speech = spokenTexts(entries), answers = entries.filter(entry => entry.kind === "answer").length;
  const keywords = sessionKeywords(entries);
  const title = bullets.length ? clip(bullets[0]!.replace(/[.。!！]+$/u, ""), 64)
    : keywords.length ? clip(`About ${keywords.join(", ")}`, 64)
      : `${partOfDay(session.startedAt)} conversation`;
  let overview = "";
  if (bullets.length) overview = clip(bullets.slice(0, 2).join(" "), 240);
  else if (speech.length) {
    const facts = (session.keyFacts ?? []).slice(0, 2).join("; ");
    const opening = clip(speech[0]!, 110);
    overview = clip(`${facts ? `${facts}. ` : ""}Not summarised yet${keywords.length ? ` · mentions ${keywords.join(", ")}` : ""}. Opens with “${opening}”`, 240);
  } else if (answers) overview = `Not summarised yet · ${answers} Helix answer${answers === 1 ? "" : "s"}, no transcript.`;
  else if (session.keyFacts?.length) overview = clip(session.keyFacts.slice(0, 2).join("; "), 240);
  else if (session.todos?.length || session.notes?.length) {
    // Notes mode with nothing else saved: say what the record holds.
    const todos = session.todos?.length ?? 0, open = (session.todos ?? []).filter(item => !item.done).length, notes = session.notes?.length ?? 0;
    overview = [todos ? `${todos} to-do${todos === 1 ? "" : "s"} (${open} open)` : "", notes ? `${notes} note${notes === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  }
  return { title, overview };
}

/**
 * True when a stored title is not a real one: the live placeholder ("Helix · <ISO time>"), or, for
 * sessions recorded before v0.13, the first utterance cut to 100 characters (how they were titled).
 */
export function isAutoSessionTitle(session: HistorySession, entries: readonly HistoryEntry[] = []): boolean {
  if (session.source !== "helix" || session.recap) return false;
  const title = session.title.trim();
  if (!title || /^Helix · \d{4}-/u.test(title)) return true;
  let first: HistoryEntry | undefined;
  for (const entry of entries) if (entry.kind === "transcript" && (!first || Date.parse(entry.occurredAt) < Date.parse(first.occurredAt))) first = entry;
  return !!first && first.text.slice(0, 100).trim() === title;
}

/**
 * Title + overview to show for a session. Generated titles (session.recap), imported titles and titles
 * someone chose are used as stored; an automatic one (see isAutoSessionTitle) shows the fallback instead.
 */
export function sessionRecap(session: HistorySession, entries: readonly HistoryEntry[] = []): SessionRecapView {
  const stored = session.title.replace(/\s+/gu, " ").trim();
  const fallback = fallbackSessionRecap(session, entries);
  if (isAutoSessionTitle(session, entries)) return { ...fallback, origin: "fallback" };
  // An Omi overview stands in for the summary of an imported conversation.
  const imported = entries.find(entry => entry.metadata?.origin === "omi-summary" || /^omi summary$/iu.test(entry.speaker?.trim() ?? ""));
  const overview = session.overview?.trim() || (!session.summary?.length && imported ? clip(imported.text, 240) : fallback.overview);
  return { title: stored || fallback.title, overview, origin: session.recap?.origin ?? "imported" };
}

/** Total length of what was said in a session (decides whether a summary call is worth making). */
export function spokenChars(entries: readonly HistoryEntry[]): number {
  return spoken(entries).reduce((sum, entry) => sum + entry.text.trim().length, 0);
}

/* ------------------------------------------------------------------ v0.16 history clean-up */

/** A saved manual tap ("answer the last few sentences" / "the whole conversation"): a question entry with no words of the wearer's own. */
export function contextAskScope(entry: Pick<HistoryEntry, "kind" | "speaker">): "recent" | "whole" | undefined {
  if (entry.kind !== "question") return undefined;
  const label = (entry.speaker ?? "").trim();
  return /^local context$/iu.test(label) ? "recent" : /^whole conversation$/iu.test(label) ? "whole" : undefined;
}

export type CleanupReason = "little-speech" | "answers-only" | "duplicate-import";
export interface CleanupRemoval {
  readonly id: string; readonly reason: CleanupReason; readonly source: KnowledgeSource;
  readonly title: string; readonly startedAt: string;
  /** duplicate-import: the session that is kept. */
  readonly duplicateOf?: string;
}
/** Two Helix sessions minutes apart: `fromId` (the later one) would be moved into `intoId`. */
export interface CleanupMerge {
  readonly fromId: string; readonly intoId: string; readonly fromTitle: string; readonly intoTitle: string;
  readonly fromStartedAt: string; readonly intoStartedAt: string; readonly gapMs: number;
}
export interface HistoryCleanupProposal { readonly removals: CleanupRemoval[]; readonly merges: CleanupMerge[] }
export interface CleanupRecord { readonly session: HistorySession; readonly entries: readonly HistoryEntry[] }
export interface CleanupOptions {
  /** Sessions that are never proposed: the live one, ones being removed, ones whose saved lines cannot be read. */
  readonly skip?: Iterable<string>;
  /** Longest pause between two Helix sessions that are offered as one (default CLEANUP_MERGE_GAP_MS). */
  readonly mergeGapMs?: number;
}
/** A second Helix session that starts within this long of the first one ending is offered as a merge. */
export const CLEANUP_MERGE_GAP_MS = 10 * 60_000;
/** An Omi copy of a Helix session matches when the start times are this close (Omi may round to the second). */
const SAME_START_MS = 1000;

const flatText = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const isDocument = (session: HistorySession) => session.id.startsWith("pdf:");
/** True when the session carries something of its own that a clean-up must not throw away: a model recap, a chosen title, extracted knowledge, to-dos or notes. */
function hasOwnRecap(session: HistorySession, entries: readonly HistoryEntry[]): boolean {
  if (session.recap?.origin === "model" || session.overview?.trim()) return true;
  if (session.summary?.length || session.keyFacts?.length || session.people?.length || session.concepts?.length || session.todos?.length || session.notes?.length) return true;
  return !session.recap && !isAutoSessionTitle(session, entries);
}
/** A question the wearer typed: not a tap, and not detected from speech (its words are not in the transcript). */
function hasTypedQuestion(entries: readonly HistoryEntry[]): boolean {
  const said = entries.filter(entry => entry.kind === "transcript").map(entry => flatText(entry.text)).filter(Boolean);
  return entries.some(entry => {
    if (entry.kind !== "question" || contextAskScope(entry)) return false;
    const asked = flatText(entry.text);
    return !!asked && !said.some(text => text.includes(asked));
  });
}
function sessionEnd(session: HistorySession, entries: readonly HistoryEntry[]): number {
  let end = Date.parse(session.endedAt ?? "");
  for (const entry of entries) { const at = Date.parse(entry.occurredAt); if (Number.isFinite(at) && !(at <= end)) end = at; }
  return Number.isFinite(end) ? end : Date.parse(session.updatedAt);
}

/**
 * What History -> Clean up offers (pure; nothing is removed here). Removals, ticked by default:
 * (a) Helix sessions with almost no speech and no recap, title, knowledge, to-dos or notes of their own;
 * (b) Helix sessions that hold only answers to manual taps and no transcript;
 * (c) duplicate imports: the same source, title and start time, or an Omi conversation whose title and
 *     start time match a Helix session (Helix sent it there).
 * Merges, offered unticked: two Helix sessions where the second starts within `mergeGapMs` of the first ending.
 * An imported session is never proposed under (a) or (b); PDF documents are never proposed at all.
 */
export function proposeHistoryCleanup(records: readonly CleanupRecord[], options: CleanupOptions = {}): HistoryCleanupProposal {
  const skip = new Set(options.skip ?? []), gap = typeof options.mergeGapMs === "number" && options.mergeGapMs >= 0 ? options.mergeGapMs : CLEANUP_MERGE_GAP_MS;
  const usable = records.filter(record => !skip.has(record.session.id) && !isDocument(record.session));
  const titleOf = (record: CleanupRecord) => sessionRecap(record.session, record.entries).title;
  const removals: CleanupRemoval[] = [], going = new Set<string>();
  const remove = (record: CleanupRecord, reason: CleanupReason, duplicateOf?: string) => {
    going.add(record.session.id);
    removals.push({ id: record.session.id, reason, source: record.session.source, title: titleOf(record), startedAt: record.session.startedAt, ...(duplicateOf ? { duplicateOf } : {}) });
  };
  const helix = usable.filter(record => record.session.source === "helix");
  for (const record of helix) {
    const { session, entries } = record;
    if (!entries.length || hasOwnRecap(session, entries) || hasTypedQuestion(entries)) continue;
    const said = spokenChars(entries);
    if (!said && entries.some(entry => entry.kind === "answer")) remove(record, "answers-only");
    else if (said < MIN_RECAP_TRANSCRIPT_CHARS) remove(record, "little-speech");
  }
  // (c) the same import twice: the copy with the most saved lines (then the newest) is kept.
  const imported = usable.filter(record => record.session.source !== "helix"), groups = new Map<string, CleanupRecord[]>();
  for (const record of imported) {
    const title = flatText(record.session.title), at = Date.parse(record.session.startedAt);
    if (!title || !Number.isFinite(at)) continue;
    const key = `${record.session.source}|${at}|${title}`, group = groups.get(key);
    if (group) group.push(record); else groups.set(key, [record]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort((a, b) => b.entries.length - a.entries.length || Date.parse(b.session.updatedAt) - Date.parse(a.session.updatedAt) || a.session.id.localeCompare(b.session.id));
    for (const record of rest) remove(record, "duplicate-import", keep!.session.id);
  }
  // (c) an Omi conversation that is a Helix session sent to Omi and imported back.
  const kept = helix.filter(record => !going.has(record.session.id)).map(record => ({ id: record.session.id, at: Date.parse(record.session.startedAt), titles: [flatText(record.session.title), flatText(titleOf(record))].filter(Boolean) }));
  for (const record of imported) {
    if (record.session.source !== "omi" || going.has(record.session.id)) continue;
    const title = flatText(record.session.title), at = Date.parse(record.session.startedAt);
    const original = title ? kept.find(item => Math.abs(item.at - at) <= SAME_START_MS && item.titles.includes(title)) : undefined;
    if (original) remove(record, "duplicate-import", original.id);
  }
  // (d) merges: neighbours in time among the Helix sessions that stay.
  const merges: CleanupMerge[] = [];
  const line = helix.filter(record => !going.has(record.session.id) && Number.isFinite(Date.parse(record.session.startedAt)))
    .sort((a, b) => Date.parse(a.session.startedAt) - Date.parse(b.session.startedAt) || a.session.id.localeCompare(b.session.id));
  for (let i = 1; i < line.length; i++) {
    const first = line[i - 1]!, second = line[i]!, pause = Date.parse(second.session.startedAt) - sessionEnd(first.session, first.entries);
    if (!(pause >= 0 && pause <= gap)) continue;
    merges.push({ fromId: second.session.id, intoId: first.session.id, fromTitle: titleOf(second), intoTitle: titleOf(first),
      fromStartedAt: second.session.startedAt, intoStartedAt: first.session.startedAt, gapMs: pause });
  }
  return { removals, merges };
}

/** What History -> Remove all can be limited to. "all" also covers PDF documents. */
export type HistoryRemoveScope = "helix" | "omi" | "obsidian" | "all";
/** Ids of the saved sessions in a Remove-all scope (pure). PDFs are stored beside Obsidian notes but belong only to "all". */
export function historyScopeIds(sessions: readonly HistorySession[], scope: HistoryRemoveScope, skip: Iterable<string> = []): string[] {
  const out = new Set(skip);
  return sessions.filter(session => !out.has(session.id) && (scope === "all" || (session.source === scope && !isDocument(session)))).map(session => session.id);
}
