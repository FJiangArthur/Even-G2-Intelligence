/**
 * Notes mode: the to-do list model. Pure and deterministic (no model call, no storage):
 * explicit list operations with stable ids, update-instead-of-append dedupe, spoken edit
 * commands, glasses confirmations and Markdown checkbox lines.
 */

/** Where a to-do came from. Copilot items keep the transcript passage and the model that proposed them. */
export interface TodoSource {
  transcriptId?: string;
  /** The spoken words that justified the item or its last change. */
  quote?: string;
  speaker?: string;
  model?: string;
  promptVersion?: string;
}
export type TodoOrigin = "copilot" | "voice" | "user";
export interface TodoItem {
  id: string;
  text: string;
  /** As stated in the conversation ("Mei", "Me"). */
  owner?: string;
  /** As stated in the conversation ("Friday", "March 3"); never resolved to a calendar date. */
  due?: string;
  done: boolean;
  origin: TodoOrigin;
  source?: TodoSource;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
/** One running conversation note (Notes mode). */
export interface SessionNote { id: string; text: string; transcriptId?: string; createdAt: string }

/** In `update`, an absent field is unchanged and "" clears owner or due. */
export type TodoOp =
  | { readonly op: "add"; readonly text: string; readonly owner?: string; readonly due?: string; readonly id?: string }
  | { readonly op: "update"; readonly id: string; readonly text?: string; readonly owner?: string; readonly due?: string }
  | { readonly op: "complete"; readonly id: string; readonly done?: boolean }
  | { readonly op: "remove"; readonly id: string }
  | { readonly op: "move"; readonly id: string; readonly to: number };
export interface TodoChange {
  readonly kind: "added" | "updated" | "completed" | "reopened" | "removed" | "moved";
  readonly item: TodoItem;
  readonly previous?: TodoItem;
}
export interface TodoOpContext {
  readonly origin: TodoOrigin;
  readonly source?: TodoSource;
  /** ISO timestamp (default: now). */
  readonly now?: string;
  readonly newId?: () => string;
}
export interface TodoOpResult { readonly list: TodoItem[]; readonly change?: TodoChange }

export const MAX_TODOS = 60, MAX_SESSION_NOTES = 80;
export const MAX_TODO_TEXT = 200, MAX_TODO_FIELD = 60, MAX_NOTE_TEXT = 300;
/** Prompt version recorded in the provenance of copilot-proposed to-dos and notes. */
export const NOTEBOOK_PROMPT_VERSION = "notes-1";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const line = (value: unknown, max: number): string => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
const isoDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const capital = (text: string) => text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
/** Normalized comparison key: NFKC, lowercase, letters and digits only. */
export const todoKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const STOP = new Set("a an the to of for and or with on in at by from my our your their his her this that it is be up about some all please".split(" "));
const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
/** Content tokens: stop words dropped, plural "s" folded, CJK runs as bigrams. */
function tokens(text: string): Set<string> {
  const result = new Set<string>();
  const separated = text.normalize("NFKC").toLowerCase().replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, " $& ");
  for (const token of separated.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (CJK_RUN.test(token)) { const chars = [...token]; if (chars.length === 1) result.add(token); else chars.slice(0, -1).forEach((c, i) => result.add(c + chars[i + 1])); continue; }
    if (STOP.has(token)) continue;
    result.add(token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token);
  }
  return result;
}
const shared = (a: Set<string>, b: Set<string>) => { let n = 0; for (const token of a) if (b.has(token)) n++; return n; };
/** Same task, possibly reworded: equal keys, most content words shared, or one wording contained in the other. */
export function sameTodoText(left: string, right: string): boolean {
  const a = todoKey(left), b = todoKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = tokens(left), tb = tokens(right), common = shared(ta, tb), small = Math.min(ta.size, tb.size);
  if (!common) return false;
  if (common / (ta.size + tb.size - common) >= 0.6) return true;
  return small >= 2 && common / small >= 0.75;
}

const clone = (item: TodoItem): TodoItem => ({ ...item, ...(item.source ? { source: { ...item.source } } : {}) });
function cleanSource(value: unknown): TodoSource | undefined {
  if (!record(value)) return undefined;
  const source: TodoSource = {};
  const transcriptId = line(value.transcriptId, 300), quote = line(value.quote, 400), speaker = line(value.speaker, MAX_TODO_FIELD);
  const model = line(value.model, 100), promptVersion = line(value.promptVersion, 40);
  if (transcriptId) source.transcriptId = transcriptId;
  if (quote) source.quote = quote;
  if (speaker) source.speaker = speaker;
  if (model) source.model = model;
  if (promptVersion) source.promptVersion = promptVersion;
  return Object.keys(source).length ? source : undefined;
}

/**
 * Applies one list operation and reports what changed (undefined change = nothing to do).
 * `add` never duplicates: an item that says the same thing is updated instead (owner/due merged),
 * and re-adding a finished item is ignored. Never mutates `list`.
 */
export function applyTodoOp(list: readonly TodoItem[], op: TodoOp, context: TodoOpContext): TodoOpResult {
  const now = isoDate(context.now) ? context.now : new Date().toISOString();
  const source = cleanSource(context.source);
  const unchanged: TodoOpResult = { list: [...list] };
  const patch = (index: number, fields: { text?: string; owner?: string; due?: string }): TodoOpResult => {
    const previous = list[index]!, item = clone(previous);
    if (fields.text !== undefined) { const text = line(fields.text, MAX_TODO_TEXT); if (text) item.text = text; }
    for (const key of ["owner", "due"] as const) {
      if (fields[key] === undefined) continue;
      const value = line(fields[key], MAX_TODO_FIELD);
      if (value) item[key] = value; else delete item[key];
    }
    if (item.text === previous.text && item.owner === previous.owner && item.due === previous.due) return unchanged;
    item.updatedAt = now; if (source) item.source = source;
    const next = [...list]; next[index] = item;
    return { list: next, change: { kind: "updated", item: clone(item), previous: clone(previous) } };
  };
  switch (op.op) {
    case "add": {
      const text = line(op.text, MAX_TODO_TEXT), owner = line(op.owner, MAX_TODO_FIELD), due = line(op.due, MAX_TODO_FIELD);
      if (!todoKey(text)) return unchanged;
      const open = list.findIndex(item => !item.done && sameTodoText(item.text, text));
      // Reworded or repeated: only new owner/due information changes the existing item.
      if (open >= 0) return patch(open, { ...(owner ? { owner } : {}), ...(due ? { due } : {}) });
      if (list.some(item => item.done && todoKey(item.text) === todoKey(text))) return unchanged;
      if (list.length >= MAX_TODOS) return unchanged;
      const wanted = line(op.id, 100);
      const id = wanted && !list.some(item => item.id === wanted) ? wanted : (context.newId ?? randomId)();
      const item: TodoItem = { id, text, ...(owner ? { owner } : {}), ...(due ? { due } : {}), done: false, origin: context.origin,
        ...(source ? { source } : {}), createdAt: now, updatedAt: now };
      return { list: [...list, item], change: { kind: "added", item: clone(item) } };
    }
    case "update": {
      const index = list.findIndex(item => item.id === op.id);
      return index < 0 ? unchanged : patch(index, op);
    }
    case "complete": {
      const index = list.findIndex(item => item.id === op.id), done = op.done !== false;
      if (index < 0 || list[index]!.done === done) return unchanged;
      const previous = list[index]!, item = clone(previous);
      item.done = done; item.updatedAt = now;
      if (done) item.completedAt = now; else delete item.completedAt;
      if (source) item.source = source;
      const next = [...list]; next[index] = item;
      return { list: next, change: { kind: done ? "completed" : "reopened", item: clone(item), previous: clone(previous) } };
    }
    case "remove": {
      const index = list.findIndex(item => item.id === op.id);
      if (index < 0) return unchanged;
      return { list: list.filter((_, i) => i !== index), change: { kind: "removed", item: clone(list[index]!) } };
    }
    case "move": {
      const index = list.findIndex(item => item.id === op.id);
      const to = Number.isFinite(op.to) ? Math.max(0, Math.min(list.length - 1, Math.floor(op.to))) : index;
      if (index < 0 || to === index) return unchanged;
      const next = [...list], [item] = next.splice(index, 1);
      next.splice(to, 0, item!);
      return { list: next, change: { kind: "moved", item: clone(item!) } };
    }
    default: return unchanged;
  }
}

/** Validated, bounded to-dos from storage or an import (invalid items are dropped). Non-arrays yield undefined. */
export function cleanTodos(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: TodoItem[] = [], ids = new Set<string>();
  for (const raw of value) {
    if (!record(raw)) continue;
    const id = line(raw.id, 100), text = line(raw.text, MAX_TODO_TEXT);
    if (!id || !todoKey(text) || ids.has(id)) continue;
    const owner = line(raw.owner, MAX_TODO_FIELD), due = line(raw.due, MAX_TODO_FIELD), source = cleanSource(raw.source);
    const createdAt = isoDate(raw.createdAt) ? raw.createdAt : new Date(0).toISOString();
    ids.add(id);
    result.push({ id, text, ...(owner ? { owner } : {}), ...(due ? { due } : {}), done: raw.done === true,
      origin: raw.origin === "voice" || raw.origin === "user" ? raw.origin : "copilot", ...(source ? { source } : {}),
      createdAt, updatedAt: isoDate(raw.updatedAt) ? raw.updatedAt : createdAt, ...(raw.done === true && isoDate(raw.completedAt) ? { completedAt: raw.completedAt } : {}) });
    if (result.length >= MAX_TODOS) break;
  }
  return result;
}
/** Validated, bounded session notes (the newest MAX_SESSION_NOTES are kept). Non-arrays yield undefined. */
export function cleanSessionNotes(value: unknown): SessionNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: SessionNote[] = [], ids = new Set<string>();
  for (const raw of value) {
    const text = line(record(raw) ? raw.text : raw, MAX_NOTE_TEXT);
    if (!text) continue;
    const id = (record(raw) ? line(raw.id, 100) : "") || `note-${result.length + 1}`;
    if (ids.has(id)) continue;
    ids.add(id);
    const transcriptId = record(raw) ? line(raw.transcriptId, 300) : "";
    result.push({ id, text, ...(transcriptId ? { transcriptId } : {}), createdAt: record(raw) && isoDate(raw.createdAt) ? raw.createdAt : new Date(0).toISOString() });
  }
  return result.slice(-MAX_SESSION_NOTES);
}

/* ------------------------------------------------------------------ display */

const details = (item: Pick<TodoItem, "owner" | "due">, due: (value: string) => string) => [item.owner, item.due ? due(item.due) : ""].filter(Boolean).join(", ");
/** One-line form for lists and Markdown: "Send the quote (Mei, due Friday)". */
export function todoLine(item: Pick<TodoItem, "text" | "owner" | "due">): string {
  const extra = details(item, value => `due ${value}`);
  return extra ? `${item.text} (${extra})` : item.text;
}
/** Reads a todoLine back ("Send the quote (Mei, due Friday)"). */
export function parseTodoLine(text: string): { text: string; owner?: string; due?: string } {
  const clean = line(text, MAX_TODO_TEXT + 2 * MAX_TODO_FIELD + 10);
  const match = /^(.*\S)\s+\((?:([^()]*?),\s+)?due\s+([^()]+)\)$/u.exec(clean) ?? /^(.*\S)\s+\(([^()]+)\)()$/u.exec(clean);
  if (!match) return { text: line(clean, MAX_TODO_TEXT) };
  const owner = line(match[2], MAX_TODO_FIELD), due = line(match[3], MAX_TODO_FIELD);
  return { text: line(match[1], MAX_TODO_TEXT), ...(owner ? { owner } : {}), ...(due ? { due } : {}) };
}
const DAY = /\b(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)\b/giu;
const shortDue = (value: string) => value.replace(DAY, (_all, day: string) => capital(day.toLowerCase()));
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
/** Glasses row: "Send the quote - Mei, Fri". */
export function todoShort(item: Pick<TodoItem, "text" | "owner" | "due">, max = 48): string {
  const extra = details(item, shortDue);
  return extra ? `${clip(item.text, max)} - ${extra}` : clip(item.text, max);
}
/** Short glasses confirmation of a change, e.g. "TODO + Send quote - Mei, Fri". Undefined for reorders. */
export function todoConfirmation(change: TodoChange): string | undefined {
  switch (change.kind) {
    case "added": return `TODO + ${todoShort(change.item)}`;
    case "updated": return `TODO ~ ${todoShort(change.item)}`;
    case "completed": return `TODO done: ${clip(change.item.text, 48)}`;
    case "reopened": return `TODO open: ${clip(change.item.text, 48)}`;
    case "removed": return `TODO removed: ${clip(change.item.text, 48)}`;
    default: return undefined;
  }
}

/* ------------------------------------------------------------------ spoken edit commands */

/**
 * The item a spoken phrase refers to: at least 60% of its content words occur in the item (or one
 * wording contains the other). Ties go to open items, then to the most recently changed one.
 */
export function findTodo(list: readonly TodoItem[], query: string): TodoItem | undefined {
  const wanted = tokens(query), key = todoKey(query);
  if (!wanted.size || !key) return undefined;
  let best: TodoItem | undefined, bestScore = 0;
  for (const item of list) {
    const itemKey = todoKey(item.text);
    const contained = key.length >= 4 && (itemKey.includes(key) || (itemKey.length >= 4 && key.includes(itemKey)));
    const score = contained ? 1 : shared(wanted, tokens(item.text)) / wanted.size;
    if (score < 0.6) continue;
    const better = !best || score > bestScore || (score === bestScore && (best.done !== item.done ? !item.done : Date.parse(item.updatedAt) > Date.parse(best.updatedAt)));
    if (better) { best = item; bestScore = score; }
  }
  return best;
}

const TODO = "(?:to[-\\s]?dos?|tasks?|action\\s+items?|reminders?)";
const NAME = "[\\p{Lu}][\\p{L}'’-]*(?:\\s[\\p{Lu}][\\p{L}'’-]*)?";
const LEAD = /^(?:(?:hey|ok(?:ay)?|so|and|also|now|then|please|helix)[,\s]+)*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/iu;
const WHEN = "(?:(?:next|this|the)\\s+)?(?:end\\s+of\\s+(?:the\\s+)?)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|week|month|quarter|year|day|eod|noon|midnight"
  + "|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*"
  + "|the\\s+\\d{1,2}(?:st|nd|rd|th)|\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?|\\d{1,2}(?::\\d{2})?\\s?(?:am|pm))(?:\\s+(?:morning|afternoon|evening|night))?(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?\\s?(?:am|pm)?)?";
const DUE_TAIL = new RegExp(`\\s+(?:by|due|before|on|until)\\s+(${WHEN})$`, "iu");
const OWNER_TAIL = new RegExp(`,?\\s+(?:assigned\\s+to|owned\\s+by|owner(?:\\s+is)?)\\s+(${NAME})$`, "u");
const OWNER_HEAD = new RegExp(`^(${NAME})\\s+(?:will|should|needs\\s+to|has\\s+to|is\\s+going\\s+to)\\s+(.+)$`, "u");
const NOT_NAMES = new Set(["I", "We", "You", "They", "He", "She", "It", "Please", "The", "This", "That"]);
const rx = (source: string) => new RegExp(source, "iu");
const ADD = [
  rx(`^(?:add|create|make|note\\s+down|write\\s+down|jot\\s+down|new)\\s+(?:down\\s+)?(?:(?:a|an|another|one|new|the)\\s+)*${TODO}(?:\\s+item)?\\s*[:,-]?\\s*(?:(?:to|that|saying)\\s+)?(.+)$`),
  rx(`^(?:add|put)\\s+(.+?)\\s+(?:to|on)\\s+(?:my|the|our)\\s+${TODO}(?:\\s+list)?$`),
];
const ADD_FOR = new RegExp(`^for\\s+(${NAME}|me)\\s+to\\s+(.+)$`, "u");
const REMIND = /^remind\s+me\s+to\s+(.+)$/iu;
const DUE_CHANGE = [
  /^(?:change|move|set|push|update|shift)\s+(?:the\s+)?(?:deadline|due\s+date|date)(?:\s+(?:for|of|on)\s+(.+?))?\s+to\s+(.+)$/iu,
  /^(?:make|set)\s+(.+?)\s+due\s+(?:on\s+|by\s+)?(.+)$/iu,
  rx(`^(.+?\\s+${TODO})\\s+is\\s+(?:now\\s+)?due\\s+(?:on\\s+|by\\s+)?(.+)$`),
];
const OWNER_CHANGE = [
  /^(?:change|set|update)\s+(?:the\s+)?owner(?:\s+(?:of|for)\s+(.+?))?\s+to\s+(.+)$/iu,
  /^(?:assign|reassign|give)\s+(.+?)\s+to\s+(.+)$/iu,
];
const RENAME = [/^(?:rename|reword)\s+(.+?)\s+to\s+(.+)$/iu, rx(`^(?:change|update)\\s+(?:the\\s+|my\\s+)?${TODO}\\s+(.+?)\\s+to\\s+(.+)$`)];
const REOPEN = [/^(?:mark|set)\s+(.+?)\s+(?:as\s+)?(?:not\s+done|undone|open|incomplete)$/iu, /^(?:reopen|uncheck|unmark)\s+(.+)$/iu];
const COMPLETE = [
  /^(?:mark|set)\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/iu,
  /^(?:check|tick|cross)\s+off\s+(.+)$/iu, /^(?:check|tick|cross)\s+(.+?)\s+off$/iu,
  rx(`^(?:complete|finish)\\s+(?:the\\s+|my\\s+)?${TODO}\\s*[:,-]?\\s*(.+)$`),
  rx(`^(.+?\\s+${TODO})\\s+is\\s+(?:done|complete|completed|finished)$`),
];
const REMOVE = [
  rx(`^(?:remove|delete)\\s+(.+?)(?:\\s+from\\s+(?:my|the|our)\\s+(?:${TODO}\\s+)?list)?$`),
  rx(`^(?:cancel|drop|scratch|forget)\\s+(?:the\\s+|that\\s+|my\\s+)?${TODO}\\s*(?:to\\s+|for\\s+|about\\s+|[:,-]\\s*)?(.+)$`),
  rx(`^(?:cancel|drop|scratch|forget)\\s+(.+?\\s+${TODO})$`),
];
// Chinese: 添加待办 X / 把 X 标记为完成 / 完成待办 X / 删除待办 X.
const ZH_ADD = /^(?:请)?(?:添加|新增|加一?个|记一?个|记下|创建)(?:一个|个)?(?:待办事项|待办|任务|行动项)[:：,，\s]*(.+)$/u;
const ZH_COMPLETE = [/^(?:请)?把(.+?)(?:这个|那个)?(?:待办事项|待办|任务)?(?:标记为|标记成|标为|设为)(?:已)?完成$/u, /^(?:请)?完成(?:待办事项|待办|任务)[:：,，\s]*(.+)$/u];
const ZH_REMOVE = /^(?:请)?(?:删除|删掉|移除|取消)(?:待办事项|待办|任务)[:：,，\s]*(.+)$/u;
const PRONOUN = /^(?:it|that|this|that\s+one|this\s+one|the\s+last\s+(?:one|item|to[-\s]?do|task))$/iu;
const target = (value: string) => value.trim().replace(/^["'“‘]+|["'”’]+$/gu, "").replace(/^(?:the|my|that|our|this)\s+/iu, "")
  .replace(new RegExp(`\\s+(?:${TODO}|item|one)$`, "iu"), "").replace(new RegExp(`^${TODO}\\s*(?:to\\s+|for\\s+|about\\s+|[:,-]\\s*)?`, "iu"), "").trim();

/** Splits "Mei will send the quote by Friday" style text into text / owner / due. */
function addDetails(raw: string): { text: string; owner?: string; due?: string } {
  let text = raw.trim(), owner = "", due = "";
  const when = DUE_TAIL.exec(text);
  if (when) { due = capital(when[1]!.trim()); text = text.slice(0, when.index).trim(); }
  const tail = OWNER_TAIL.exec(text);
  if (tail) { owner = tail[1]!; text = text.slice(0, tail.index).trim(); }
  const lead = ADD_FOR.exec(text) ?? OWNER_HEAD.exec(text);
  if (lead && !owner && !NOT_NAMES.has(lead[1]!)) { owner = lead[1]!.toLowerCase() === "me" ? "Me" : lead[1]!; text = lead[2]!.trim(); }
  return { text: capital(text.replace(/^to\s+/iu, "")), ...(owner ? { owner } : {}), ...(due ? { due } : {}) };
}

/**
 * One spoken sentence -> a list operation, or undefined when it is not a to-do command or names an
 * item that is not on the list. `lastId` resolves "it" / "that one" and a deadline change without a target.
 */
export function parseTodoCommand(sentence: string, list: readonly TodoItem[], lastId?: string): TodoOp | undefined {
  const text = sentence.replace(/\s+/g, " ").trim().replace(/[.!?。！？]+$/u, "").replace(LEAD, "").trim();
  if (text.length < 4 || text.length > 300) return undefined;
  const last = lastId ? list.find(item => item.id === lastId) : undefined;
  const resolve = (phrase: string | undefined): TodoItem | undefined => {
    const clean = target(phrase ?? "");
    if (!clean || PRONOUN.test(clean)) return last ?? (list.filter(item => !item.done).length === 1 ? list.find(item => !item.done) : undefined);
    return findTodo(list, clean);
  };
  const first = (patterns: readonly RegExp[]) => { for (const pattern of patterns) { const match = pattern.exec(text); if (match) return match; } return undefined; };
  let match = first(DUE_CHANGE);
  if (match) { const item = resolve(match[1]), due = capital(match[2]!.trim()); return item && due ? { op: "update", id: item.id, due } : undefined; }
  match = first(OWNER_CHANGE);
  if (match) { const item = resolve(match[1]), owner = match[2]!.trim(); return item && owner ? { op: "update", id: item.id, owner: /^me$/iu.test(owner) ? "Me" : capital(owner) } : undefined; }
  match = first(RENAME);
  if (match) { const item = resolve(match[1]), next = match[2]!.trim(); return item && next ? { op: "update", id: item.id, text: capital(next) } : undefined; }
  match = first(REOPEN);
  if (match) { const item = resolve(match[1]); return item ? { op: "complete", id: item.id, done: false } : undefined; }
  match = first(COMPLETE) ?? first(ZH_COMPLETE);
  if (match) { const item = resolve(match[1]); return item ? { op: "complete", id: item.id } : undefined; }
  match = first(REMOVE) ?? ZH_REMOVE.exec(text) ?? undefined;
  if (match) { const item = resolve(match[1]); return item ? { op: "remove", id: item.id } : undefined; }
  match = first(ADD) ?? ZH_ADD.exec(text) ?? undefined;
  if (match) { const fields = addDetails(match[1]!); return todoKey(fields.text) ? { op: "add", ...fields } : undefined; }
  match = REMIND.exec(text) ?? undefined;
  if (match) { const fields = addDetails(match[1]!); return todoKey(fields.text) ? { op: "add", owner: "Me", ...fields } : undefined; }
  return undefined;
}

/** Sentences of one transcript line, for parseTodoCommand. */
export function todoSentences(text: string): string[] {
  return text.replace(/\s+/g, " ").match(/[^.!?。！？]+[.!?。！？]*/gu)?.map(part => part.trim()).filter(Boolean) ?? [];
}
