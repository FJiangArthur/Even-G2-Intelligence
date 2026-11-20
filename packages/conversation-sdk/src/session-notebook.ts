/**
 * Notes mode: the live notebook of one session (to-do list + running notes). The host owns one
 * per session and persists it; the copilot lane proposes operations from speech, the wearer edits
 * by voice (handleTranscript) and the phone edits directly (apply). Every change goes through
 * applyTodoOp, so the list is edited in place and never gains duplicates.
 */
import { containsSensitiveNoteText } from "./automatic-notes.js";
import {
  MAX_NOTE_TEXT, MAX_SESSION_NOTES, applyTodoOp, cleanSessionNotes, cleanTodos, parseTodoCommand, sameTodoText, todoConfirmation, todoKey, todoSentences,
  type SessionNote, type TodoChange, type TodoItem, type TodoOp, type TodoOrigin, type TodoSource,
} from "./todo-list.js";

export interface NotebookEvent {
  readonly todos: readonly TodoItem[];
  readonly notes: readonly SessionNote[];
  /** The to-do change that caused this event, when any. */
  readonly change?: TodoChange;
  /** Short glasses confirmation for `change` ("TODO + Send quote - Mei, Fri"). */
  readonly confirmation?: string;
  readonly noteAdded?: SessionNote;
}
export interface SessionNotebookOptions {
  readonly todos?: readonly TodoItem[];
  readonly notes?: readonly SessionNote[];
  readonly onChange?: (event: NotebookEvent) => void;
  readonly now?: () => string;
  readonly newId?: () => string;
}
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export class SessionNotebook {
  private list: TodoItem[];
  private noteList: SessionNote[];
  private lastId?: string;
  private readonly listeners = new Set<(event: NotebookEvent) => void>();
  constructor(private readonly options: SessionNotebookOptions = {}) {
    this.list = cleanTodos(options.todos ?? []) ?? [];
    this.noteList = cleanSessionNotes(options.notes ?? []) ?? [];
    if (options.onChange) this.listeners.add(options.onChange);
  }
  get todos(): readonly TodoItem[] { return this.list.map(item => structuredClone(item)); }
  get notes(): readonly SessionNote[] { return this.noteList.map(note => ({ ...note })); }
  /** The item most recently added or changed ("it", "change the deadline to Friday"). */
  get lastTouchedId(): string | undefined { return this.lastId; }
  subscribe(listener: (event: NotebookEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }

  /** Applies one list operation. Returns the change, or undefined when nothing changed. */
  apply(op: TodoOp, context: { readonly origin: TodoOrigin; readonly source?: TodoSource }): TodoChange | undefined {
    if ((op.op === "add" || op.op === "update") && op.text && containsSensitiveNoteText(op.text)) return undefined;
    const result = applyTodoOp(this.list, op, { ...context, now: this.now(), ...(this.options.newId ? { newId: this.options.newId } : {}) });
    if (!result.change) return undefined;
    this.list = result.list;
    if (result.change.kind !== "removed") this.lastId = result.change.item.id;
    else if (this.lastId === result.change.item.id) this.lastId = undefined;
    const confirmation = todoConfirmation(result.change);
    this.emit({ change: result.change, ...(confirmation ? { confirmation } : {}) });
    return result.change;
  }

  /**
   * Spoken edit commands in one final transcript line ("add a to-do ...", "mark the vendor call done").
   * Speech attributed to another speaker is ignored here (the copilot lane still hears it).
   */
  handleTranscript(transcriptId: string, text: string, speaker?: { readonly label?: string; readonly role?: string }): TodoChange[] {
    if (speaker?.role === "other") return [];
    const changes: TodoChange[] = [];
    for (const sentence of todoSentences(text).slice(0, 8)) {
      const op = parseTodoCommand(sentence, this.list, this.lastId);
      if (!op) continue;
      const change = this.apply(op, { origin: "voice", source: { transcriptId, quote: sentence, ...(speaker?.label ? { speaker: speaker.label } : {}) } });
      if (change) changes.push(change);
    }
    return changes;
  }

  /** Adds a running note unless it repeats an earlier one. The oldest notes drop past MAX_SESSION_NOTES. */
  addNote(text: string, transcriptId?: string): SessionNote | undefined {
    const clean = cleanSessionNotes([{ id: (this.options.newId ?? randomId)(), text: String(text ?? "").slice(0, MAX_NOTE_TEXT * 2), ...(transcriptId ? { transcriptId } : {}), createdAt: this.now() }])?.[0];
    if (!clean || !todoKey(clean.text) || containsSensitiveNoteText(clean.text)) return undefined;
    if (this.noteList.some(note => sameTodoText(note.text, clean.text))) return undefined;
    this.noteList = [...this.noteList, clean].slice(-MAX_SESSION_NOTES);
    this.emit({ noteAdded: clean });
    return clean;
  }
  removeNote(id: string): boolean {
    const next = this.noteList.filter(note => note.id !== id);
    if (next.length === this.noteList.length) return false;
    this.noteList = next; this.emit({});
    return true;
  }

  private emit(extra: Pick<NotebookEvent, "change" | "confirmation" | "noteAdded">): void {
    const event: NotebookEvent = { todos: this.todos, notes: this.notes, ...extra };
    for (const listener of this.listeners) { try { listener(event); } catch { /* isolate host */ } }
  }
}
