/**
 * Notes mode on the phone: the editable to-do list and the running notes of one session. Used live
 * (Summary tab) and for saved sessions (History). Every edit is one explicit list operation
 * (add / update / complete / remove / move) handed to the host; spoken text never enters markup.
 */
import type { SessionNote, TodoItem, TodoOp } from "@helix/conversation-sdk";

export interface NotebookPanelData { readonly todos: readonly TodoItem[]; readonly notes: readonly SessionNote[] }
export interface NotebookPanelOptions {
  /** False: checkboxes and fields are read-only (e.g. the live session shown in History). */
  readonly editable?: boolean;
  /** Shown under the list when it is read-only. */
  readonly readOnlyNote?: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function field(className: string, value: string, label: string, placeholder: string, editable: boolean, commit: (value: string) => void): HTMLInputElement {
  const input = el("input", className);
  input.type = "text"; input.value = value; input.placeholder = placeholder; input.setAttribute("aria-label", label);
  input.autocomplete = "off"; input.readOnly = !editable;
  input.addEventListener("change", () => { const next = input.value.replace(/\s+/gu, " ").trim(); if (next !== value) commit(next); });
  input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); input.blur(); } });
  return input;
}
function iconButton(label: string, glyph: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = el("button", "button button-quiet todo-button", glyph);
  button.type = "button"; button.title = label; button.setAttribute("aria-label", label); button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}
/** Where a to-do came from: the quoted passage and speaker (copilot / voice), or "Added on phone". */
export function todoProvenance(item: TodoItem): string {
  const quote = item.source?.quote?.trim(), speaker = item.source?.speaker?.trim();
  if (quote) return `${speaker ? `${speaker}: ` : ""}“${quote}”`;
  return item.origin === "user" ? "Added on phone" : item.origin === "voice" ? "Added by voice" : "";
}

/** The To-dos (+ Notes) block. `edit` receives one operation per user action. */
export function renderNotebook(data: NotebookPanelData, edit: (op: TodoOp) => void, options: NotebookPanelOptions = {}): HTMLElement {
  const editable = options.editable !== false;
  const root = el("section", "notebook");
  const open = data.todos.filter(item => !item.done).length;
  root.append(el("h3", "section-label", data.todos.length ? `To-dos · ${open} open` : "To-dos"));
  if (editable) {
    const form = el("form", "todo-add");
    const input = el("input", "todo-new");
    input.type = "text"; input.placeholder = "Add a to-do"; input.setAttribute("aria-label", "New to-do"); input.autocomplete = "off"; input.maxLength = 200;
    const add = el("button", "button button-secondary button-small", "Add"); add.type = "submit";
    form.append(input, add);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const text = input.value.replace(/\s+/gu, " ").trim();
      if (!text) return;
      input.value = ""; edit({ op: "add", text });
    });
    root.append(form);
  }
  if (!data.todos.length) root.append(el("p", "field-note", "No to-dos yet. Action items from the conversation land here; say “add a to-do …” or add one above."));
  const list = el("ul", "todo-list");
  data.todos.forEach((item, index) => {
    const row = el("li", `todo-row${item.done ? " is-done" : ""}`);
    row.dataset.todoId = item.id;
    const check = el("input", "todo-check");
    check.type = "checkbox"; check.checked = item.done; check.disabled = !editable; check.setAttribute("aria-label", `Done: ${item.text}`);
    check.addEventListener("change", () => edit({ op: "complete", id: item.id, done: check.checked }));
    const main = el("div", "todo-main");
    main.append(field("todo-text", item.text, "To-do", "To-do", editable, text => { if (text) edit({ op: "update", id: item.id, text }); }));
    const meta = el("div", "todo-meta");
    meta.append(
      field("todo-owner", item.owner ?? "", `Owner of ${item.text}`, "Owner", editable, owner => edit({ op: "update", id: item.id, owner })),
      field("todo-due", item.due ?? "", `Due date of ${item.text}`, "Due", editable, due => edit({ op: "update", id: item.id, due })));
    main.append(meta);
    const source = todoProvenance(item);
    if (source) main.append(el("p", "todo-source", source));
    row.append(check, main);
    if (editable) {
      const actions = el("div", "todo-actions");
      actions.append(
        iconButton(`Move up: ${item.text}`, "↑", () => edit({ op: "move", id: item.id, to: index - 1 }), index === 0),
        iconButton(`Move down: ${item.text}`, "↓", () => edit({ op: "move", id: item.id, to: index + 1 }), index === data.todos.length - 1),
        iconButton(`Delete: ${item.text}`, "✕", () => edit({ op: "remove", id: item.id })));
      row.append(actions);
    }
    list.append(row);
  });
  if (data.todos.length) root.append(list);
  if (!editable && options.readOnlyNote) root.append(el("p", "field-note", options.readOnlyNote));
  if (data.notes.length) {
    root.append(el("h3", "section-label", "Notes"));
    const notes = el("ul", "note-list");
    for (const note of data.notes) notes.append(el("li", "note-row", note.text));
    root.append(notes);
  }
  return root;
}
