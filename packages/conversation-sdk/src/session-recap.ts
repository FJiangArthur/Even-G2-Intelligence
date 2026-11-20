/**
 * v0.13 session recap: what a saved session is called and its one-to-two line summary.
 *
 * A Helix session gets a generated title + overview when it ends (session-digest.ts, one model call,
 * provenance in `session.recap`). Everything else gets the deterministic fallback below, computed
 * from what is saved and never from the first thing that was said: sessions recorded before v0.13,
 * sessions that ended without a key or with a failed call, and interrupted sessions.
 */
import type { HistoryEntry, HistorySession } from "./local-history.js";

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
