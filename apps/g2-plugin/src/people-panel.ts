/**
 * v0.8 People tab (P2): people mentioned or speaking in the live session (presentation.people via
 * copilot onPerson) plus everyone saved in history (LocalHistoryStore.listPeople()).
 */
import type { CopilotPerson, HistorySession, PersonAggregate } from "@helix/conversation-sdk";
import type { G2ConversationController } from "./controller";
import type { PresentationSnapshot } from "./presentation";
import { cleanLineText, formatSessionDate, SOURCE_LABEL, sessionSource, sessionTitle } from "./history-panel";
import { icon, type IconName } from "./pixel-art";

export interface PersonView {
  readonly key: string;
  readonly name: string;
  readonly role?: string;
  readonly context?: string;
  /** Live mentions + saved mentions from other sessions. */
  readonly mentions: number;
  readonly sessionIds: readonly string[];
  readonly live: boolean;
  readonly lastSeen?: string;
}

export const personKey = (name: string): string => name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Merges live people with history aggregates by normalized name. Live people come first (most
 * mentioned first), then saved people; the live session's own saved record is not double-counted.
 */
export function mergePeople(live: readonly CopilotPerson[], saved: readonly PersonAggregate[], liveSessionId?: string): PersonView[] {
  const byKey = new Map<string, PersonView>();
  for (const person of saved) {
    const key = personKey(person.name);
    if (!key) continue;
    byKey.set(key, { key, name: person.name, ...(person.roles[0] ? { role: person.roles[0] } : {}), mentions: person.mentions,
      sessionIds: [...person.sessionIds], live: false, lastSeen: person.lastSeen });
  }
  for (const person of live) {
    const key = personKey(person.name ?? "");
    if (!key) continue;
    const saved = byKey.get(key);
    const otherSessions = saved ? saved.sessionIds.filter(id => id !== liveSessionId) : [];
    // The live session may already be saved with (roughly) the live count; count other sessions once.
    const otherMentions = !saved ? 0 : liveSessionId && saved.sessionIds.includes(liveSessionId) ? Math.max(0, saved.mentions - person.mentions) : saved.mentions;
    byKey.set(key, {
      key, name: person.name.trim(), ...(person.role || saved?.role ? { role: person.role || saved!.role } : {}),
      ...(person.context ? { context: person.context } : {}),
      mentions: Math.max(1, person.mentions) + otherMentions,
      sessionIds: liveSessionId ? [liveSessionId, ...otherSessions] : otherSessions, live: true, lastSeen: person.lastSeen,
    });
  }
  return [...byKey.values()].sort((a, b) => Number(b.live) - Number(a.live) || b.mentions - a.mentions || a.name.localeCompare(b.name));
}

/** Prompt for "Ask about <name>": uses the whole captured conversation. */
export function askAboutPrompt(name: string): string {
  return `Using the whole conversation so far, what do we know about ${name}? Their role, what they said or own, decisions involving them, and open follow-ups. Say so briefly if little is known.`;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
};
const iconSpan = (name: IconName, className = "card-icon"): HTMLElement => { const span = el("span", className); span.setAttribute("aria-hidden", "true"); span.innerHTML = icon(name); return span; };
const initials = (name: string) => name.split(/\s+/u).filter(Boolean).slice(0, 2).map(part => [...part][0]!.toUpperCase()).join("") || "?";

export interface PeoplePanelOptions {
  readonly ask: (question: string) => void;
  readonly openSession: (id: string) => void;
}

export class PeoplePanel {
  private readonly panel = el("div", "people-panel");
  private readonly liveList = el("ol", "card-list people-list");
  private readonly savedList = el("ol", "card-list people-list");
  private readonly liveHeading = el("h3", "section-label", "In this conversation");
  private readonly savedHeading = el("h3", "section-label", "From history");
  private readonly empty = el("div", "panel-empty");
  private readonly unsubscribe: () => void;
  private live: readonly CopilotPerson[] = [];
  private connected = false;
  private signature = "";
  private readonly expanded = new Set<string>();
  private focusKey?: string;

  constructor(root: HTMLElement, private readonly controller: G2ConversationController, private readonly options: PeoplePanelOptions) {
    const art = el("span", "panel-empty-icon"); art.setAttribute("aria-hidden", "true"); art.innerHTML = icon("people");
    this.empty.append(art, el("strong", "", "No people yet"), el("p", "", "People who speak or are mentioned show up here, linked to the sessions they appear in."));
    this.panel.append(this.empty, this.liveHeading, this.liveList, this.savedHeading, this.savedList);
    root.append(this.panel);
    this.unsubscribe = controller.subscribeHistory(() => this.render());
  }

  public dispose(): void { this.unsubscribe(); this.panel.remove(); }

  public renderLive(snapshot: PresentationSnapshot): void {
    this.live = snapshot.people ?? [];
    this.connected = ["connected", "listening", "paused"].includes(snapshot.status);
    this.render();
  }

  /** Expand and scroll to a person (from a History chip). */
  public focusPerson(name: string): void {
    this.focusKey = personKey(name); this.expanded.add(this.focusKey); this.signature = ""; this.render();
    const card = this.panel.querySelector<HTMLElement>(`[data-person="${this.focusKey}"]`);
    card?.scrollIntoView?.({ block: "nearest" }); card?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }

  private dirty = false;
  /** Called when the People tab is shown. */
  public refresh(): void { if (this.dirty) { this.dirty = false; this.render(); } }
  private render(): void {
    if (this.panel.closest("[hidden]")) { this.dirty = true; return; }
    const sessions = this.controller.listHistorySessions();
    const liveSessionId = this.controller.liveSessionId();
    const people = mergePeople(this.live, this.controller.listPeople(), liveSessionId);
    const signature = JSON.stringify([people, this.connected, [...this.expanded], this.focusKey, sessions.map(session => [session.id, session.title])]);
    if (signature === this.signature) return;
    this.signature = signature;
    const byId = new Map(sessions.map(session => [session.id, session]));
    const live = people.filter(person => person.live), saved = people.filter(person => !person.live);
    this.empty.hidden = people.length > 0;
    this.liveHeading.hidden = this.liveList.hidden = !live.length;
    this.savedHeading.hidden = this.savedList.hidden = !saved.length;
    this.liveList.replaceChildren(...live.map(person => this.card(person, byId)));
    this.savedList.replaceChildren(...saved.map(person => this.card(person, byId)));
  }

  private card(person: PersonView, sessions: ReadonlyMap<string, HistorySession>): HTMLElement {
    const card = el("li", `card person-card${person.live ? " is-live" : ""}${this.focusKey === person.key ? " is-focused" : ""}`);
    card.dataset.person = person.key;
    const head = el("div", "card-head");
    const avatar = el("span", "person-avatar", initials(person.name)); avatar.setAttribute("aria-hidden", "true");
    const title = el("div", "person-title");
    title.append(el("h3", "card-title", person.name));
    if (person.role) title.append(el("span", "person-role", person.role));
    head.append(avatar, title);
    if (person.live) head.append(el("span", "status-pill pill-live", "Live"));
    card.append(head);
    if (person.context) card.append(el("p", "card-body person-context", cleanLineText(person.context)));
    const known = person.sessionIds.filter(id => sessions.has(id));
    card.append(el("p", "panel-meta", `${person.mentions} mention${person.mentions === 1 ? "" : "s"} · ${known.length} session${known.length === 1 ? "" : "s"}${person.lastSeen ? ` · last ${formatSessionDate(person.lastSeen)}` : ""}`));
    const actions = el("div", "card-actions");
    const ask = el("button", "button button-secondary button-small"); ask.type = "button";
    ask.append(iconSpan("question", "button-icon"), el("span", "button-label", `Ask about ${person.name.split(/\s+/u)[0]}`));
    ask.disabled = !this.connected;
    ask.title = this.connected ? "" : "Connect to ask Helix";
    ask.setAttribute("aria-label", `Ask Helix about ${person.name} using the whole conversation`);
    ask.addEventListener("click", () => this.options.ask(askAboutPrompt(person.name)));
    actions.append(ask);
    if (known.length) {
      const open = this.expanded.has(person.key);
      const toggle = el("button", "button button-quiet button-small"); toggle.type = "button";
      toggle.append(iconSpan("clock", "button-icon"), el("span", "button-label", open ? "Hide sessions" : `Sessions (${known.length})`));
      toggle.setAttribute("aria-expanded", String(open));
      toggle.addEventListener("click", () => { if (this.expanded.has(person.key)) this.expanded.delete(person.key); else this.expanded.add(person.key); this.signature = ""; this.render(); });
      actions.append(toggle);
    }
    card.append(actions);
    if (known.length && this.expanded.has(person.key)) {
      const list = el("ul", "person-sessions");
      for (const id of known.slice(0, 20)) {
        const session = sessions.get(id)!;
        const row = el("li");
        const go = el("button", "person-session"); go.type = "button";
        const source = sessionSource(session);
        go.append(el("span", `source-badge badge-${source}`, SOURCE_LABEL[source]), el("span", "person-session-title", sessionTitle({ ...session, title: this.controller.historyTitle(session) })), el("small", "", formatSessionDate(session.startedAt)));
        go.addEventListener("click", () => this.options.openSession(id));
        row.append(go); list.append(row);
      }
      card.append(list);
    }
    return card;
  }
}
