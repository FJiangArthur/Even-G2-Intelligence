import { clearDiagnostics, diagnosticsReport, previousPageExit } from "./diagnostics";
import {
  ANSWER_MODELS,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_COPILOT_MODEL,
  MODE_PROFILES,
  PICKER_MODES,
  TRANSCRIPTION_CATALOG,
  modeProfile,
  formatMs,
  formatUsd,
  type AnswerMeta,
  type Citation,
  type CopilotClaim,
  type HudMirror,
  type TranscriptionModelInfo,
} from "@helix/conversation-sdk";
import { feedBlocks, PARTIAL_TRANSCRIPT_ID, type PresentationSnapshot, type FeedItem, type FeedBlock, type CompanionTab } from "./presentation";
import { HistoryPanel, copyToClipboard, sourceLink } from "./history-panel";
import { KnowledgePanel } from "./knowledge-panel";
import { PeoplePanel } from "./people-panel";
import * as glassesHud from "./glasses-hud";
import type { G2ConversationController } from "./controller";
import { SHORTCUT_ACTIONS, type ShortcutActionId } from "./shortcut-actions";
import {
  DEFAULT_TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_PROVIDERS,
  type PluginConfig,
  type ProviderCredentialLoadResult,
  type ProviderCredentialPersistenceResult,
  type SessionFormState,
} from "./config";
import { icon, mascotMarkup, modeIcon, pixelSvg, pixelText, MASCOT_FRAMES, type IconName, type MascotState } from "./pixel-art";
import { TAB_DEFINITIONS, defaultTabForHudView, shouldFollowHud, tabFromKey } from "./tabs";

/* v0.8 glasses mirror contract (glasses agent, src/glasses-mirror.ts). Resolved without a static
 * import so the phone UI builds before that module lands; falls back to a local text mirror. */
interface GlassesMirrorModule {
  readonly renderGlassesMirror?: (container: HTMLElement, mirror: HudMirror) => void;
  readonly tabForHudView?: (view: string) => CompanionTab | undefined;
}
const MIRROR_MODULES = import.meta.glob<GlassesMirrorModule>("./glasses-mirror.ts", { eager: true });
const MIRROR: GlassesMirrorModule = Object.values(MIRROR_MODULES)[0] ?? {};
export function tabForHud(view: string | undefined): CompanionTab | undefined {
  try { const mapped = view === undefined ? undefined : MIRROR.tabForHudView?.(view); if (mapped) return mapped; } catch { /* fall back */ }
  return defaultTabForHudView(view);
}
const FOLLOW_IDLE_MS = 8000;

/** GESTURE_HELP from glasses-hud.ts, whatever its exact shape (string, lines or {gesture, action} rows). */
export function gestureHelpLines(value: unknown = (glassesHud as unknown as Record<string, unknown>).GESTURE_HELP): string[] {
  const row = (item: unknown): string | undefined => {
    if (typeof item === "string") return item.trim() || undefined;
    if (Array.isArray(item) && item.length >= 2) return `${String(item[0])}: ${String(item[1])}`;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const key = record.gesture ?? record.input ?? record.label ?? record.name ?? record.key;
      const action = record.action ?? record.does ?? record.description ?? record.text ?? record.value;
      if (key !== undefined && action !== undefined) return `${String(key)}: ${String(action)}`;
    }
    return undefined;
  };
  let lines: string[] = [];
  if (typeof value === "string") lines = splitOutsideParens(value).map(line => line.trim()).filter(Boolean);
  else if (Array.isArray(value)) lines = value.map(row).filter((line): line is string => Boolean(line));
  else if (value && typeof value === "object") lines = Object.entries(value as Record<string, unknown>).map(([key, action]) => `${key}: ${String(action)}`);
  return lines.length ? lines.slice(0, 12) : [
    "Press: select or ask about the last minute",
    "Double press: open the glasses menu (whole-conversation answer is there)",
    "Swipe up/down: switch views or scroll",
    "Hold: talk, release to submit",
  ];
}

/** Splits "A: x (p · q) · B: y" on " · " or newlines, but not inside parentheses. */
function splitOutsideParens(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, current = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "(") depth++;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === "\n" || (char === "·" && text[index - 1] === " " && text[index + 1] === " "))) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

export type RehearsalSpeed = 1 | 2 | 4;

export interface CompanionUiActions {
  readonly onConnect: (form: SessionFormState) => Promise<void>;
  readonly onStart: () => Promise<void>;
  readonly onTogglePause: () => Promise<void>;
  readonly onDisconnect: () => Promise<void>;
  readonly onAsk: (question: string) => Promise<void>;
  readonly onAskLocal: () => Promise<void>;
  readonly onAskGlobal: () => Promise<void>;
  readonly onClearProviderKeys: () => Promise<ProviderCredentialPersistenceResult>;
  readonly onShortcut: (id: ShortcutActionId) => Promise<void>;
  readonly onAutoExplainTerms: (enabled: boolean) => Promise<void>;
  /** Debounced (~300 ms) after any setup change. API-key fields are always blank here. */
  readonly onSettingsChange?: (form: SessionFormState) => void | Promise<void>;
  /** Verify any point: an answer, summary bullet, concept or ask result. */
  readonly onVerify?: (target: string, id?: string) => void | Promise<void>;
  /** v0.8: verify a stored claim by id (controller.verifyClaim). Falls back to onVerify(text, id). */
  readonly onVerifyClaim?: (claimId: string) => void | Promise<void>;
  readonly onRehearse?: (scriptId: string, speed: RehearsalSpeed) => void | Promise<void>;
  readonly onStopRehearsal?: () => void | Promise<void>;
  /** Run the copilot lane now (summary/concepts/suggestions refresh). */
  readonly onRunCopilot?: () => void | Promise<void>;
  /** Setup → Test key. Resolves to a short human-readable verdict. */
  readonly onTestKey?: (key: string, model: string) => Promise<{ readonly status: string; readonly message: string }>;
  /** Called when the wearer opens a tab that has unseen items; wire to presentation.markSeen. */
  readonly onTabSeen?: (tab: CompanionTab) => void;
  /** The wearer tapped a phone tab; the integrator moves the glasses HUD to the matching view. */
  readonly onTabSelect?: (tab: CompanionTab) => void;
  /** v0.11: the editable system prompt of a mode. `custom` = the user changed it. */
  readonly getModePrompt?: (mode: SessionFormState["conversationMode"]) => { readonly text: string; readonly custom: boolean };
  /** Save (or, with "", reset) the system prompt of a mode. */
  readonly onModePromptChange?: (mode: SessionFormState["conversationMode"], prompt: string) => void | Promise<void>;
  /** v0.10: a mode chip (or the Setup mode select) was chosen; switches live. */
  readonly onModeChange?: (mode: SessionFormState["conversationMode"]) => void | Promise<void>;
}

export interface RehearsalScriptOption { readonly id: string; readonly title: string }

export interface CompanionUiOptions {
  readonly rehearsalScripts?: readonly RehearsalScriptOption[];
  /** Debounce for onSettingsChange. Default 300 ms. */
  readonly settingsDebounceMs?: number;
}

const CUSTOM_MODEL = "__custom__";
const MIRROR_OPEN_KEY = "helix.mirror.open.v1";
const CONTROLS_OPEN_KEY = "helix.controls.open.v1";
const ACTIVE = ["connected", "listening", "paused"];
const PEEK_MS = 4500;

export class CompanionUi {
  private historyPanel?: HistoryPanel;
  private knowledgePanel?: KnowledgePanel;
  private peoplePanel?: PeoplePanel;
  /** Transcript id -> paragraph element that contains it (merged transcript). */
  private readonly transcriptHosts = new Map<string, HTMLElement>();
  private lastTouchAt = Number.NEGATIVE_INFINITY;
  private lastHud?: { readonly view: string; readonly lastGesture?: string };
  private mirrorSignature = "";
  private loadModePrompt?: () => void;
  private controller?: G2ConversationController;
  private actions?: CompanionUiActions;
  private unsubscribeSettings?: () => void;
  private readonly memoryDefaults: Pick<PluginConfig, "useLocalMemory" | "liveWebFactCheck">;
  private readonly root: HTMLElement;
  private readonly options: CompanionUiOptions;
  private readonly sessionIdentity: Pick<
    PluginConfig,
    "endpointId" | "provider" | "model" | "promptId" | "promptVersion"
  >;
  private readonly feedElements = new Map<
    string,
    { readonly element: HTMLElement; signature: string }
  >();
  private readonly panelSignatures = new Map<string, string>();
  private activeTab: CompanionTab = "answers";
  private lastSnapshot?: PresentationSnapshot;
  private lastPeekSeq = 0;
  private peekTimer?: ReturnType<typeof setTimeout>;
  private settingsTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    root: HTMLElement,
    initial: PluginConfig,
    providerCredentials: ProviderCredentialLoadResult = {
      credentials: {},
      saveApiKeysOnPhone: false,
    },
    options: CompanionUiOptions = {},
  ) {
    this.root = root;
    this.options = options;
    this.memoryDefaults = initial;
    this.sessionIdentity = {
      endpointId: initial.endpointId,
      provider: initial.provider,
      model: initial.model,
      promptId: initial.promptId,
      promptVersion: initial.promptVersion,
    };
    this.mount();
    this.writeConfig(initial);
    this.writeProviderCredentials(providerCredentials);
    this.updateProfileSummary();
    this.updateModelNotes();
  }

  public get currentTab(): CompanionTab { return this.activeTab; }

  public bind(actions: CompanionUiActions): void {
    this.actions = actions;
    for (const tab of TAB_DEFINITIONS) {
      // User taps only (not programmatic follow-the-glasses switches): mirror the view to the glasses.
      this.button(`tab-${tab.id}`).addEventListener("click", () => { this.selectTab(tab.id); actions.onTabSelect?.(tab.id); });
    }
    this.element("tabbar").addEventListener("scroll", () => this.updateTabFade(), { passive: true });
    this.element("tabbar").addEventListener("keydown", (event) => {
      const next = tabFromKey(this.activeTab, event.key);
      if (!next) return;
      event.preventDefault();
      this.selectTab(next);
      this.button(`tab-${next}`).focus();
    });
    this.button("peek-button").addEventListener("click", () => {
      const tab = this.element("peek").dataset.tab as CompanionTab | undefined;
      this.hidePeek();
      if (tab) this.selectTab(tab);
    });
    const toggleShortcuts = () => {
      const panel = this.element("shortcut-panel"); panel.hidden = !panel.hidden;
      this.button("open-shortcuts-button").setAttribute("aria-expanded", String(!panel.hidden));
      this.button("gesture-strip").setAttribute("aria-expanded", String(!panel.hidden));
    };
    this.button("open-shortcuts-button").addEventListener("click", toggleShortcuts);
    this.button("gesture-strip").addEventListener("click", toggleShortcuts);
    for (const action of SHORTCUT_ACTIONS) this.button(`shortcut-${action.itemID}`).addEventListener("click", () => { void this.runAction(() => actions.onShortcut(action.itemID)); });
    this.input("auto-explain-terms").addEventListener("change", () => { void this.runAction(() => actions.onAutoExplainTerms(this.input("auto-explain-terms").checked)); });
    this.button("ask-local-button").addEventListener("click", () => { void this.runAction(actions.onAskLocal); });
    this.button("ask-global-button").addEventListener("click", () => { void this.runAction(actions.onAskGlobal); });
    this.button("connect-button").addEventListener("click", () => {
      void this.runAction(() => actions.onConnect(this.readForm()));
    });
    this.button("start-button").addEventListener("click", () => {
      void this.runAction(actions.onStart);
    });
    this.button("pause-button").addEventListener("click", () => {
      void this.runAction(actions.onTogglePause);
    });
    this.button("disconnect-button").addEventListener("click", () => {
      void this.runAction(actions.onDisconnect);
    });
    this.button("clear-provider-keys").addEventListener("click", () => {
      void actions.onClearProviderKeys().then((result) => {
        this.setProviderKeyNotice(result.message, !result.ok);
        if (result.ok) this.clearProviderKeys();
      }).catch(() => {
        this.setProviderKeyNotice("Saved API keys could not be cleared. They may remain on this phone.", true);
      });
    });
    // v0.11: Connect / Listen / Pause / Stop fold away to save space; the choice is remembered.
    const setControlsOpen = (open: boolean) => {
      this.root.querySelector<HTMLElement>(".hud")!.dataset.controls = open ? "open" : "closed";
      this.button("controls-toggle").setAttribute("aria-expanded", String(open));
    };
    try { if (globalThis.localStorage?.getItem(CONTROLS_OPEN_KEY) === "false") setControlsOpen(false); } catch { /* storage unavailable */ }
    this.button("controls-toggle").addEventListener("click", () => {
      const open = this.root.querySelector<HTMLElement>(".hud")!.dataset.controls === "closed";
      setControlsOpen(open);
      try { globalThis.localStorage?.setItem(CONTROLS_OPEN_KEY, String(open)); } catch { /* storage unavailable */ }
    });
    // v0.11: per-mode system prompt editor (Setup → How Helix should help).
    const promptMode = () => this.select("conversation-mode").value as SessionFormState["conversationMode"];
    this.loadModePrompt = () => {
      const current = actions.getModePrompt?.(promptMode());
      if (!current) return;
      this.textarea("mode-prompt").value = current.text;
      this.element("mode-prompt-status").textContent = current.custom ? `Your prompt for ${modeProfile(promptMode()).label}.` : `Built-in prompt for ${modeProfile(promptMode()).label}. Edit and save to change how Helix answers in this mode.`;
      this.button("mode-prompt-reset").disabled = !current.custom;
    };
    const savePrompt = (text: string) => void Promise.resolve(actions.onModePromptChange?.(promptMode(), text)).then(() => this.loadModePrompt?.(), () => { this.element("mode-prompt-status").textContent = "The prompt could not be saved."; });
    this.button("mode-prompt-save").addEventListener("click", () => savePrompt(this.textarea("mode-prompt").value));
    this.button("mode-prompt-reset").addEventListener("click", () => savePrompt(""));
    this.loadModePrompt();
    // v0.10 mode chips: switch live; the controller applies the presets and echoes the config back.
    this.element("modebar").addEventListener("click", event => {
      const chip = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-mode]");
      if (!chip?.dataset.mode) return;
      this.showMode(chip.dataset.mode);
      void Promise.resolve(actions.onModeChange?.(chip.dataset.mode as SessionFormState["conversationMode"])).catch(() => undefined);
    });
    const configuration = this.element("configuration-panel");
    const onSetupChange = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.id === "conversation-mode" && actions.onModeChange) {
        const mode = this.select("conversation-mode").value as SessionFormState["conversationMode"];
        this.showMode(mode);
        void Promise.resolve(actions.onModeChange(mode)).catch(() => undefined);
        return; // the controller saves the mode with its presets
      }
      if (target?.id === "answer-model") this.syncCustomModel(true);
      this.updateProfileSummary();
      this.updateModelNotes();
      if (target?.closest("[data-no-persist]")) return;
      this.scheduleSettingsSave();
    };
    configuration.addEventListener("change", onSetupChange);
    configuration.addEventListener("input", (event) => {
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && target.type === "checkbox") return; // handled by change
      if (target instanceof HTMLSelectElement) return;
      onSetupChange(event);
    });
    this.button("run-copilot-button").addEventListener("click", () => { void this.runAction(async () => { await actions.onRunCopilot?.(); }); });
    const testKey = async () => {
      const key = this.input("openai-api-key").value.trim();
      const status = this.element("key-test-status");
      if (!key) { status.dataset.state = "error"; status.textContent = "Enter an OpenAI API key first."; return; }
      if (!actions.onTestKey) return;
      const button = this.button("test-openai-key");
      button.disabled = true; status.dataset.state = "testing"; status.textContent = "Testing key…";
      try {
        const result = await actions.onTestKey(key, this.readSettings().model);
        status.dataset.state = result.status === "ok" ? "ok" : "error"; status.textContent = result.message;
      } catch (error) {
        status.dataset.state = "error"; status.textContent = error instanceof Error ? error.message : String(error);
      } finally { button.disabled = false; }
    };
    this.button("test-openai-key").addEventListener("click", () => { void testKey(); });
    const showDiagnostics = () => { const log = this.element("diagnostics-log"); log.hidden = false; log.textContent = diagnosticsReport(); };
    // v0.9.1: say at a glance whether the phone killed the previous page (iOS memory pressure).
    const lastExit = previousPageExit(), exitNote = this.root.querySelector<HTMLElement>("#diagnostics-last-exit");
    if (exitNote && lastExit) { exitNote.hidden = false; exitNote.textContent = `Last run: ${lastExit}`; exitNote.classList.toggle("is-warning", lastExit.startsWith("ended unexpectedly")); }
    this.button("diagnostics-refresh").addEventListener("click", showDiagnostics);
    this.button("diagnostics-copy").addEventListener("click", () => { showDiagnostics(); void this.copyText(diagnosticsReport(), this.button("diagnostics-copy")); });
    this.button("diagnostics-clear").addEventListener("click", () => { clearDiagnostics(); showDiagnostics(); });
    this.input("openai-api-key").addEventListener("change", () => { void testKey(); });
    this.button("rehearse-play").addEventListener("click", () => {
      const scriptId = this.select("rehearsal-script").value;
      const speed = Number.parseInt(this.select("rehearsal-speed").value, 10) as RehearsalSpeed;
      if (!scriptId) return;
      void this.runAction(async () => { await actions.onRehearse?.(scriptId, speed); });
    });
    this.button("rehearse-stop").addEventListener("click", () => { void this.runAction(async () => { await actions.onStopRehearsal?.(); }); });
    this.button("empty-setup-shortcut").addEventListener("click", () => this.openKeys());
    // Mirror-follow: any touch on the phone pauses following the glasses for 8 s.
    const touched = () => { this.lastTouchAt = Date.now(); };
    for (const type of ["pointerdown", "keydown", "wheel", "touchstart"] as const) this.root.addEventListener(type, touched, { passive: true, capture: true });
    // v0.10: the glasses display is shown on the phone by default; collapsing it is remembered.
    const setMirrorOpen = (open: boolean) => {
      this.element("mirror").dataset.open = String(open);
      this.button("mirror-toggle").setAttribute("aria-expanded", String(open));
      this.mirrorSignature = "";
      if (this.lastSnapshot) this.renderMirror(this.lastSnapshot);
    };
    try { if (globalThis.localStorage?.getItem(MIRROR_OPEN_KEY) === "false") setMirrorOpen(false); } catch { /* storage unavailable */ }
    this.button("mirror-toggle").addEventListener("click", () => {
      const open = this.element("mirror").dataset.open !== "true";
      setMirrorOpen(open);
      try { globalThis.localStorage?.setItem(MIRROR_OPEN_KEY, String(open)); } catch { /* storage unavailable */ }
    });
    // Long-press (550 ms) on an "Ask them" suggestion copies it instead of asking Helix.
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressClick: HTMLElement | undefined;
    this.root.addEventListener("pointerdown", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-longpress='copy']");
      if (!target) return;
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { pressTimer = undefined; suppressClick = target; void this.copyText(target.dataset.target ?? "", target); }, 550);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) {
      this.root.addEventListener(type, () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = undefined; } });
    }
    this.root.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement | null)?.closest("[data-longpress='copy']")) event.preventDefault();
    });
    // Delegated actions inside rendered lists.
    this.root.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
      if (!target || !this.root.contains(target)) return;
      if (suppressClick === target) { suppressClick = undefined; event.preventDefault(); return; }
      const { action, target: text = "", id } = target.dataset;
      if (action === "verify") {
        target.dataset.state = "sent";
        target.setAttribute("aria-label", "Verification requested");
        void this.runAction(async () => { await actions.onVerify?.(text, id); });
      } else if (action === "ask") {
        void this.runAction(() => actions.onAsk(text));
        this.selectTab("answers");
      } else if (action === "verify-claim" && id) {
        target.dataset.state = "sent";
        target.setAttribute("aria-label", "Verification requested");
        void this.runAction(async () => { if (actions.onVerifyClaim) await actions.onVerifyClaim(id); else await actions.onVerify?.(text, id); });
      } else if (action === "copy") {
        void this.copyText(text, target);
      } else if ((action === "goto-transcript" || action === "goto-feed") && id) {
        this.selectTab("answers");
        const live = this.feedNode(id);
        if (live) { live.tabIndex = -1; live.focus({ preventScroll: true }); live.scrollIntoView?.({ block: "nearest" }); }
      }
    });
    this.form("question-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = this.input("manual-question");
      const question = input.value.trim();
      if (!question) return;
      void this.runAction(async () => {
        await actions.onAsk(question);
        input.value = "";
      });
    });
  }

  public attachHistory(controller: G2ConversationController): void {
    this.controller = controller;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = controller.subscribeHistory(state => {
      this.input("auto-explain-terms").checked = state.autoExplainTerms;
      this.element("explanation-settings-status").textContent = state.settingsError ?? "";
    });
    this.historyPanel?.dispose();
    this.historyPanel = new HistoryPanel(this.element("history-mount"), controller, {
      onAsk: question => this.actions?.onAsk(question) ?? Promise.resolve(),
      omiKey: () => this.input("omi-api-key").value,
      openaiKey: () => this.input("openai-api-key").value,
      onShowPeople: name => { this.selectTab("people"); this.peoplePanel?.focusPerson(name); },
    });
    this.knowledgePanel?.dispose();
    this.knowledgePanel = new KnowledgePanel(this.element("knowledge-mount"), controller, {
      omiKey: () => this.input("omi-api-key").value,
      openaiKey: () => this.input("openai-api-key").value,
      openSession: id => { this.selectTab("history"); this.historyPanel?.open(id); },
    });
    this.peoplePanel?.dispose();
    this.peoplePanel = new PeoplePanel(this.element("people-mount"), controller, {
      ask: question => { this.selectTab("answers"); void this.runAction(() => this.actions?.onAsk(question) ?? Promise.resolve()); },
      openSession: id => { this.selectTab("history"); this.historyPanel?.open(id); },
    });
    if (this.lastSnapshot) this.peoplePanel.renderLive(this.lastSnapshot);
  }
  public dispose(): void {
    this.historyPanel?.dispose(); this.knowledgePanel?.dispose(); this.peoplePanel?.dispose(); this.unsubscribeSettings?.();
    if (this.peekTimer) clearTimeout(this.peekTimer);
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
  }

  /** Switch the visible panel (role=tab semantics). */
  /**
   * The page scroller. v0.13: the document itself (v0.11.5 scrolled the 100dvh shell, a second
   * scroller nested in the document); every tab, the header and the tab bar move as one page.
   */
  private scroller(): HTMLElement | null {
    const doc = this.root.ownerDocument;
    return (doc?.scrollingElement as HTMLElement | null) ?? doc?.documentElement ?? null;
  }
  /**
   * Tabs share one scroller: a newly shown panel starts at its top when the page was scrolled into the
   * previous one (the header stays where it is otherwise); Answers returns to the newest message.
   */
  private alignPanel(tab: CompanionTab, previous: CompanionTab): void {
    const scroller = this.scroller(), bar = this.root.querySelector<HTMLElement>("#tabbar-wrap"), panels = this.root.querySelector<HTMLElement>(".panels");
    if (!scroller || !bar || !panels || tab === previous) return;
    this.tabBarHeight(bar);
    // Where the page is scrolled exactly far enough for the tab bar to stick: the panels' own (never
    // sticky) top edge, minus what stays pinned above them. The bar's own offset is useless once it sticks.
    const top = panelScrollTop({ scrollTop: scroller.scrollTop, panelsTop: panels.getBoundingClientRect().top, pinnedBottom: bar.getBoundingClientRect().bottom });
    if (top !== undefined) scroller.scrollTop = top;
    if (tab === "answers" && this.lastSnapshot?.feed.length) { // back to the newest message
      const delta = feedFollowDelta(this.feedEdges(this.element("conversation-feed")));
      if (delta > 0 && Number.isFinite(delta)) scroller.scrollTop += delta;
    }
  }
  private tabBarHeight(bar: HTMLElement): void {
    const height = bar.offsetHeight;
    if (height) this.root.querySelector<HTMLElement>(".shell")?.style.setProperty("--tabbar-h", `${height}px`);
  }

  public selectTab(tab: CompanionTab): void {
    const previousTab = this.activeTab;
    this.activeTab = tab;
    for (const definition of TAB_DEFINITIONS) {
      const selected = definition.id === tab;
      const button = this.button(`tab-${definition.id}`);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      this.element(`panel-${definition.id}`).hidden = !selected;
    }
    this.root.querySelector<HTMLElement>(".shell")?.setAttribute("data-tab", tab);
    this.alignPanel(tab, previousTab);
    this.revealTab(tab);
    if (tab === "history") this.historyPanel?.refresh();
    if (tab === "knowledge") this.knowledgePanel?.refresh();
    if (tab === "people") this.peoplePanel?.refresh();
    if (this.element("peek").dataset.tab === tab) this.hidePeek();
    if (this.lastSnapshot) this.renderBadges(this.lastSnapshot);
  }

  /** Keeps the selected tab visible in the scrollable tab bar; hides the edge fade at the end. */
  private revealTab(tab: CompanionTab): void {
    const bar = this.element("tabbar"), button = this.button(`tab-${tab}`);
    if (bar.scrollWidth > bar.clientWidth) {
      const left = button.offsetLeft, right = left + button.offsetWidth;
      if (left < bar.scrollLeft) bar.scrollLeft = Math.max(0, left - 24);
      else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth + 24;
    }
    this.updateTabFade();
  }
  private updateTabFade(): void {
    const bar = this.element("tabbar");
    this.element("tabbar-wrap").dataset.end = String(bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 2);
  }

  /** Integrator hook: reflect rehearsal playback in the controls. */
  public setRehearsalState(state: { readonly playing: boolean; readonly label?: string }): void {
    this.button("rehearse-play").disabled = state.playing;
    this.button("rehearse-stop").disabled = !state.playing;
    this.element("rehearsal-status").textContent = state.label ?? (state.playing ? "Rehearsal playing" : "");
    this.root.querySelector(".shell")?.classList.toggle("is-rehearsing", state.playing);
  }

  public render(input: PresentationSnapshot): void {
    const snapshot = withSnapshotDefaults(input);
    this.lastSnapshot = snapshot;
    const status = this.element("session-status");
    status.textContent = snapshot.status;
    status.className = `status status-${snapshot.status}`;
    this.element("session-status-detail").textContent = statusDetail(snapshot.status, snapshot.error);

    const connected = ACTIVE.includes(snapshot.status);
    const connecting = ["connecting", "authorizing"].includes(snapshot.status);
    const listening = snapshot.status === "listening";
    this.button("connect-button").disabled = connected || connecting || snapshot.status === "exited";
    this.button("start-button").disabled = !connected || listening;
    this.button("pause-button").disabled = !connected || snapshot.status === "connected";
    setButtonLabel(this.button("pause-button"), snapshot.status === "paused" ? "Resume" : "Pause");
    this.button("disconnect-button").disabled = !connected && !connecting;
    this.input("manual-question").disabled = !connected;
    this.button("ask-button").disabled = !connected;
    this.button("ask-local-button").disabled = !connected;
    this.button("ask-global-button").disabled = !connected;

    if (snapshot.glasses.mode) this.showMode(snapshot.glasses.mode);
    const glasses = this.element("glasses-state");
    glasses.className = `chip glasses-state glasses-state-${snapshot.status}`;
    const glassesValue = glasses.querySelector<HTMLElement>("strong");
    if (glassesValue) glassesValue.textContent = glassesDetail(snapshot.status);

    this.renderHud(snapshot);
    this.renderMirror(snapshot);
    this.renderFeed(snapshot, connected, connecting);
    this.renderPanel("concepts", snapshot, () => this.renderConcepts(snapshot));
    this.renderPanel("summary", snapshot, () => this.renderSummary(snapshot));
    this.renderPanel("qa", snapshot, () => this.renderQa(snapshot, connected));
    this.renderPanel("checks", snapshot, () => this.renderChecks(snapshot));
    this.peoplePanel?.renderLive(snapshot);
    this.followGlasses(snapshot);
    this.renderBadges(snapshot);
    this.renderPeek(snapshot);
  }

  /* ---------------------------------------------------- glasses mirror */

  private renderMirror(snapshot: PresentationSnapshot): void {
    const hud = snapshotHud(snapshot);
    const strip = this.element("mirror");
    strip.hidden = !hud;
    if (!hud) return;
    const open = strip.dataset.open === "true";
    const signature = JSON.stringify([open, hud.view, hud.header, hud.title, hud.status, hud.images, hud.body, hud.caption, hud.menuOpen, hud.selection]);
    if (signature === this.mirrorSignature) return;
    this.mirrorSignature = signature;
    const view = hud.menuOpen ? "MENU" : (hud.view || "live").toUpperCase();
    this.element("mirror-view").textContent = view;
    const firstBody = hud.body.split("\n").map(line => line.replace(/^▶\s*/u, "").trim()).find(Boolean);
    this.element("mirror-line").textContent = oneLine(firstBody || hud.caption || hud.header || "");
    const screen = this.element("mirror-screen");
    screen.hidden = !open;
    if (!open) return;
    if (MIRROR.renderGlassesMirror) {
      try { MIRROR.renderGlassesMirror(screen, hud); return; } catch { /* fall back to the text mirror */ }
    }
    const header = el("p", "mirror-header", hud.header);
    const body = el("p", "mirror-body");
    hud.body.split("\n").slice(0, 7).forEach((line, index) => {
      const row = el("span", `mirror-row${hud.selection === index ? " is-selected" : ""}`, line || " ");
      body.append(row);
    });
    const caption = el("p", "mirror-caption", hud.caption);
    screen.replaceChildren(header, body, ...(hud.caption ? [caption] : []));
  }

  /** Follow ring/temple operations: switch tab when a glasses gesture changed the HUD and the phone is idle. */
  private followGlasses(snapshot: PresentationSnapshot): void {
    const hud = snapshotHud(snapshot);
    if (!hud) return;
    const target = tabForHud(hud.view);
    const follow = shouldFollowHud({ hud, ...(this.lastHud ? { previous: this.lastHud } : {}), lastTouchAt: this.lastTouchAt,
      now: Date.now(), currentTab: this.activeTab, target, idleMs: FOLLOW_IDLE_MS });
    this.lastHud = { view: hud.view, ...(hud.lastGesture ? { lastGesture: hud.lastGesture } : {}) };
    if (follow && target) this.selectTab(target);
  }

  private feedNode(id: string): HTMLElement | undefined {
    return this.feedElements.get(id)?.element
      ?? this.transcriptHosts.get(id)?.querySelector<HTMLElement>(`[data-transcript-id="${cssEscape(id)}"]`)
      ?? this.transcriptHosts.get(id);
  }

  private async copyText(text: string, target?: HTMLElement): Promise<boolean> {
    const ok = await copyToClipboard(text);
    if (target) {
      target.dataset.copied = ok ? "true" : "false";
      setTimeout(() => { delete target.dataset.copied; }, 1600);
    }
    this.element("copy-status").textContent = ok ? "Copied" : "Copy blocked: long-press the text to select it";
    return ok;
  }

  public clearToken(): void {
    // Compatibility hook: phone-only sessions have no Helix access token.
  }

  public clearProviderKeys(preserveImportKey = false): void {
    for (const id of ["openai-api-key", "deepgram-api-key", "soniox-api-key", "omi-api-key"]) {
      if (preserveImportKey && id === "omi-api-key") continue;
      this.input(id).value = "";
    }
    this.input("save-api-keys").checked = false;
  }

  public setProviderKeyNotice(message: string, warning = false): void {
    const notice = this.element("provider-key-status");
    notice.textContent = message;
    notice.className = `field-note provider-key-status${warning ? " is-warning" : ""}`;
  }

  public readForm(): SessionFormState {
    return {
      gatewayUrl: "",
      accessToken: "",
      openaiApiKey: this.input("openai-api-key").value,
      deepgramApiKey: this.input("deepgram-api-key").value,
      sonioxApiKey: this.input("soniox-api-key").value,
      omiApiKey: this.input("omi-api-key").value,
      saveApiKeysOnPhone: this.input("save-api-keys").checked,
      ...this.sessionIdentity,
      model: this.selectedAnswerModel(),
      instructions: this.textarea("instructions").value.trim(),
      locale: this.input("locale").value.trim(),
      maxResponseSentences: Number.parseInt(this.input("sentence-limit").value, 10),
      conversationMode: this.select("conversation-mode").value as SessionFormState["conversationMode"],
      responseStrategy: this.select("response-strategy").value as SessionFormState["responseStrategy"],
      transcriptionProvider: this.select("transcription-provider").value as SessionFormState["transcriptionProvider"],
      answerProvider: this.select("answer-provider").value as SessionFormState["answerProvider"],
      autoQuestion: this.input("auto-question").checked,
      autoAnswer: this.input("auto-answer").checked,
      autoNotes: this.input("auto-notes").checked,
      readOmiContext: false,
      syncOmiNotes: false,
      useLocalMemory: this.root.querySelector<HTMLInputElement>("#use-local-memory")?.checked ?? this.memoryDefaults.useLocalMemory,
      liveWebFactCheck: this.root.querySelector<HTMLInputElement>("#live-web-fact-check")?.checked ?? this.memoryDefaults.liveWebFactCheck,
      autoExplainTerms: this.input("auto-explain-terms").checked,
      copilotModel: this.select("copilot-model").value || DEFAULT_COPILOT_MODEL,
      copilotSummarize: this.input("copilot-summarize").checked,
      copilotConcepts: this.input("copilot-concepts").checked,
      copilotConflicts: this.input("copilot-conflicts").checked,
      copilotSuggestions: this.input("copilot-suggestions").checked,
      copilotImplicitAsks: this.input("copilot-implicit-asks").checked,
      copilotWebGrounding: this.input("copilot-web-grounding").checked,
      copilotClaims: this.input("copilot-claims").checked,
      copilotPeople: this.input("copilot-people").checked,
    };
  }

  /** The settings-persistence payload: identical to readForm but never carries keys. */
  public readSettings(): SessionFormState {
    return { ...this.readForm(), openaiApiKey: "", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", accessToken: "" };
  }

  private scheduleSettingsSave(): void {
    if (!this.actions?.onSettingsChange) return;
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => {
      this.settingsTimer = undefined;
      const save = this.actions?.onSettingsChange;
      if (!save) return;
      void Promise.resolve().then(() => save(this.readSettings())).catch(() => {
        this.setSettingsNotice("Settings could not be saved on this phone. They apply to this session only.", true);
      });
      this.setSettingsNotice("Saved on this phone");
    }, this.options.settingsDebounceMs ?? 300);
  }

  private setSettingsNotice(message: string, warning = false): void {
    const notice = this.element("settings-save-status");
    notice.textContent = message;
    notice.classList.toggle("is-warning", warning);
  }

  private mount(): void {
    this.root.innerHTML = companionMarkup(this.options.rehearsalScripts ?? []);
  }

  /** Marks catalog models the key's project cannot call, and reflects a fallback selection. */
  public setModelAccess(accessible: readonly string[], selected?: { readonly model: string; readonly copilotModel: string }): void {
    const ids = new Set(accessible);
    for (const id of ["answer-model", "copilot-model"]) {
      for (const option of this.select(id).options) {
        if (!option.value || option.value === CUSTOM_MODEL) continue;
        const base = option.dataset.label ?? option.textContent ?? option.value;
        option.dataset.label = base;
        const blocked = !ids.has(option.value);
        option.disabled = blocked;
        option.textContent = blocked ? `${base} · no access` : base;
      }
    }
    if (selected) {
      if (ANSWER_MODELS.some(model => model.id === selected.model)) this.select("answer-model").value = selected.model;
      this.select("copilot-model").value = selected.copilotModel;
      this.updateModelNotes();
    }
  }

  /** v0.10: highlight the active mode chip and show its one-liner. */
  public showMode(mode: string | undefined): void {
    const profile = modeProfile(mode);
    const bar = this.root.querySelector<HTMLElement>("#modebar");
    if (!bar || bar.dataset.mode === profile.id) return;
    bar.dataset.mode = profile.id;
    for (const chip of bar.querySelectorAll<HTMLButtonElement>("[data-mode]")) chip.setAttribute("aria-pressed", String(chip.dataset.mode === profile.id));
    const blurb = this.root.querySelector<HTMLElement>("#mode-blurb");
    if (blurb) blurb.textContent = profile.blurb;
    const select = this.root.querySelector<HTMLSelectElement>("#conversation-mode");
    if (select && select.value !== profile.id && [...select.options].some(option => option.value === profile.id)) select.value = profile.id;
    this.loadModePrompt?.();
    bar.querySelector<HTMLElement>(`[data-mode="${profile.id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  /** v0.10: after a live mode switch, re-read the mode's presets into Setup (no save is triggered). */
  public applyModeConfig(config: PluginConfig): void {
    this.writeConfig(config);
    this.showMode(config.conversationMode);
    this.updateProfileSummary();
  }

  private writeConfig(config: PluginConfig): void {
    this.input("auto-explain-terms").checked = config.autoExplainTerms;
    const known = ANSWER_MODELS.some(model => model.id === config.model);
    this.select("answer-model").value = known ? config.model : CUSTOM_MODEL;
    this.input("answer-model-custom").value = known ? "" : config.model;
    this.syncCustomModel(false);
    const copilot = this.select("copilot-model");
    if (![...copilot.options].some(option => option.value === config.copilotModel)) {
      const option = document.createElement("option"); option.value = config.copilotModel; option.textContent = `${config.copilotModel} (saved)`;
      copilot.append(option);
    }
    copilot.value = config.copilotModel;
    this.textarea("instructions").value = config.instructions;
    this.input("locale").value = config.locale;
    this.input("sentence-limit").value = String(config.maxResponseSentences);
    this.select("conversation-mode").value = modeProfile(config.conversationMode).picker ? config.conversationMode : "general";
    this.showMode(config.conversationMode);
    this.select("response-strategy").value = config.responseStrategy;
    this.select("transcription-provider").value = config.transcriptionProvider;
    if (this.select("transcription-provider").value !== config.transcriptionProvider) this.select("transcription-provider").value = DEFAULT_TRANSCRIPTION_PROVIDER;
    this.select("answer-provider").value = config.answerProvider;
    this.input("auto-question").checked = config.autoQuestion;
    this.input("auto-answer").checked = config.autoAnswer;
    this.input("auto-notes").checked = config.autoNotes;
    this.input("copilot-summarize").checked = config.copilotSummarize;
    this.input("copilot-concepts").checked = config.copilotConcepts;
    this.input("copilot-conflicts").checked = config.copilotConflicts;
    this.input("copilot-suggestions").checked = config.copilotSuggestions;
    this.input("copilot-implicit-asks").checked = config.copilotImplicitAsks;
    this.input("copilot-web-grounding").checked = config.copilotWebGrounding;
    this.input("copilot-claims").checked = config.copilotClaims !== false;
    this.input("copilot-people").checked = config.copilotPeople !== false;
  }

  private selectedAnswerModel(): string {
    const value = this.select("answer-model").value;
    if (value !== CUSTOM_MODEL) return value || DEFAULT_ANSWER_MODEL;
    return this.input("answer-model-custom").value.trim() || DEFAULT_ANSWER_MODEL;
  }

  private syncCustomModel(focus: boolean): void {
    const custom = this.select("answer-model").value === CUSTOM_MODEL;
    const field = this.element("answer-model-custom-field");
    field.hidden = !custom;
    if (custom && focus) this.input("answer-model-custom").focus({ preventScroll: true });
  }

  private writeProviderCredentials(state: ProviderCredentialLoadResult): void {
    this.input("openai-api-key").value = state.credentials.openai ?? "";
    this.input("deepgram-api-key").value = state.credentials.deepgram ?? "";
    this.input("soniox-api-key").value = state.credentials.soniox ?? "";
    this.input("omi-api-key").value = state.credentials.omi ?? "";
    this.input("save-api-keys").checked = state.saveApiKeysOnPhone;
    if (state.warning !== undefined) this.setProviderKeyNotice(state.warning, true);
  }

  private updateProfileSummary(): void {
    const mode = selectLabel(this.select("conversation-mode"));
    const strategy = selectLabel(this.select("response-strategy"));
    const sttProfile = this.select("transcription-provider").value;
    const transcription = transcriptionCatalog().find(item => item.profileId === sttProfile)?.model ?? selectLabel(this.select("transcription-provider"));
    const answer = this.selectedAnswerModel();
    this.element("session-profile-summary").textContent =
      `${mode} · ${strategy} · ${transcription} → ${answer}`;
  }

  private updateModelNotes(): void {
    const model = ANSWER_MODELS.find(item => item.id === this.selectedAnswerModel());
    this.element("answer-model-note").textContent = model
      ? `${model.price ? `$${model.price.input} in · $${model.price.output} out per 1M tokens` : "No published price: cost shows as n/a"}${model.reasoning ? " · reasoning model" : ""}${model.responsesOnly ? " · Responses API" : ""}`
      : "Custom id: sent as-is. Cost shows as n/a unless the id matches a known model.";
    const stt = transcriptionCatalog().find(item => item.profileId === this.select("transcription-provider").value);
    this.element("transcription-note").textContent = stt ? transcriptionNote(stt) : "";
    this.element("transcription-note").classList.toggle("is-warning", Boolean(stt?.deprecated));
  }

  private openKeys(): void {
    this.selectTab("setup");
    this.input("openai-api-key").focus({ preventScroll: true });
    this.element("provider-keys-title").scrollIntoView?.({ block: "start" });
  }

  /* ------------------------------------------------------------- HUD */

  private renderHud(snapshot: PresentationSnapshot): void {
    const mascot = this.element("mascot");
    const state = mascotStateFor(snapshot);
    if (mascot.dataset.mascot !== state) mascot.dataset.mascot = state;
    const streaming = snapshot.feed.some(item => item.id === "transcript-partial" && item.streaming);
    const mic = this.element("mic-state");
    const micState = streaming ? "streaming" : snapshot.status === "listening" ? "on" : snapshot.status === "paused" ? "paused" : "off";
    if (mic.dataset.state !== micState) {
      mic.dataset.state = micState;
      this.element("mic-state-text").textContent = { streaming: "Streaming", on: "Mic on", paused: "Mic paused", off: "Mic off" }[micState];
    }
    const usage = snapshot.usage;
    const cost = usage.requests === 0 ? "$0" : `${formatUsd(usage.costUsd)}${usage.unknownCostCount ? "+" : ""}`;
    this.element("cost-value").textContent = cost;
    this.element("hud-cost").title = usage.unknownCostCount
      ? `${usage.unknownCostCount} request(s) used a model without a published price and are not included.`
      : "Estimated from provider usage × list price";
    this.element("token-value").textContent = `${formatTokens(usage.inputTokens + usage.outputTokens)} tok`;
    this.element("latency-value").textContent = snapshot.lastLatencyMs === undefined ? "–" : formatMs(snapshot.lastLatencyMs);
  }

  private renderBadges(snapshot: PresentationSnapshot): void {
    for (const tab of TAB_DEFINITIONS) {
      const count = tab.id === this.activeTab ? 0 : snapshot.unseen[tab.id] ?? 0;
      const badge = this.element(`badge-${tab.id}`);
      const text = count > 9 ? "9+" : String(count);
      badge.hidden = count === 0;
      if (badge.textContent !== text) badge.textContent = text;
      this.button(`tab-${tab.id}`).setAttribute("aria-label", count ? `${tab.label}, ${count} new` : tab.label);
    }
    if ((snapshot.unseen[this.activeTab] ?? 0) > 0) this.actions?.onTabSeen?.(this.activeTab);
  }

  private renderPeek(snapshot: PresentationSnapshot): void {
    const peek = snapshot.peek;
    if (!peek || peek.seq <= this.lastPeekSeq) return;
    this.lastPeekSeq = peek.seq;
    if (peek.tab === this.activeTab) return;
    const strip = this.element("peek");
    strip.dataset.tab = peek.tab;
    strip.dataset.kind = peek.kind;
    const iconName: IconName = { concept: "bulb", conflict: "warning", ask: "magnifier", verification: "shield", suggestion: "question" }[peek.kind] as IconName;
    this.element("peek-icon").innerHTML = icon(iconName);
    this.element("peek-title").textContent = peek.title;
    this.element("peek-text").textContent = peek.text;
    strip.hidden = false;
    strip.classList.remove("is-in"); void strip.offsetWidth; strip.classList.add("is-in");
    if (this.peekTimer) clearTimeout(this.peekTimer);
    this.peekTimer = setTimeout(() => this.hidePeek(), PEEK_MS);
  }

  private hidePeek(): void {
    const strip = this.element("peek");
    strip.hidden = true; delete strip.dataset.tab;
    if (this.peekTimer) { clearTimeout(this.peekTimer); this.peekTimer = undefined; }
  }

  /* ------------------------------------------------------------ feed */

  private renderFeed(snapshot: PresentationSnapshot, connected: boolean, connecting: boolean): void {
    const feed = this.element("conversation-feed");
    // v0.11.5: the page is the scroller (the feed has no scrollbar of its own).
    const scroller = this.scroller() ?? feed;
    // v0.13: follow new messages when the reader is at the end of the page or can see the end of the
    // feed (e.g. at the top of the page with a short feed); never while they have scrolled away to read.
    const followUpdates = this.activeTab === "answers" && (shouldAutoScrollConversationFeed({
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
    }) || feedFollowDelta(this.feedEdges(feed)) <= FEED_FOLLOW_SLACK_PX);
    feed.setAttribute("aria-busy", String(connecting));
    let contentChanged = false;
    const empty = this.element("feed-empty");
    if (snapshot.feed.length === 0) {
      for (const rendered of this.feedElements.values()) rendered.element.remove();
      contentChanged = this.feedElements.size > 0;
      this.feedElements.clear();
      this.transcriptHosts.clear();
      empty.hidden = false;
      contentChanged = this.updateEmptyState(empty, connected) || contentChanged;
    } else {
      empty.hidden = true;
      // v0.8 continuous transcript: same-speaker finals (+ the live partial) render as one paragraph.
      const blocks = feedBlocks(snapshot.feed);
      const nextIds = new Set(blocks.map((block) => block.id));
      // A paragraph that began as the live partial keeps its element when its first final lands.
      const livePara = this.feedElements.get(`para:${PARTIAL_TRANSCRIPT_ID}`);
      if (livePara && !nextIds.has(`para:${PARTIAL_TRANSCRIPT_ID}`)) {
        const adopt = blocks.find(block => block.type === "paragraph" && !this.feedElements.has(block.id));
        this.feedElements.delete(`para:${PARTIAL_TRANSCRIPT_ID}`);
        if (adopt) { livePara.element.dataset.messageId = adopt.id; this.feedElements.set(adopt.id, livePara); }
        else livePara.element.remove();
      }
      for (const [id, rendered] of this.feedElements) {
        if (nextIds.has(id)) continue;
        rendered.element.remove();
        this.feedElements.delete(id);
        contentChanged = true;
      }
      this.transcriptHosts.clear();

      blocks.forEach((block, index) => {
        const rendered = block.type === "card" ? this.renderCardBlock(block.item, snapshot) : this.renderParagraphBlock(block);
        if (rendered.changed) contentChanged = true;
        // Child 0 is the persistent empty-state block.
        const nodeAtIndex = feed.children.item(index + 1);
        if (nodeAtIndex !== rendered.element) {
          feed.insertBefore(rendered.element, nodeAtIndex);
          contentChanged = true;
        }
      });
    }
    if (contentChanged && followUpdates) {
      // Scroll only as far as the newest message needs: a short feed leaves the header where it is.
      const follow = () => { const delta = feedFollowDelta(this.feedEdges(feed)); if (delta > 0 && Number.isFinite(delta)) scroller.scrollTop += delta; };
      follow();
      // Late layout (fonts, the live caret line) can grow the feed after this frame: follow it once more.
      globalThis.requestAnimationFrame?.(() => { if (this.activeTab === "answers") follow(); });
    }
  }
  /** Viewport geometry of the feed's last message and the sticky composer under it. */
  private feedEdges(feed: HTMLElement): FeedEdges {
    const last = feed.lastElementChild as HTMLElement | null, composer = this.root.querySelector<HTMLElement>(".composer");
    const rect = last && !last.hidden ? last.getBoundingClientRect?.() : undefined;
    return { endBottom: rect && (rect.width || rect.height) ? rect.bottom : undefined, viewportHeight: globalThis.innerHeight ?? 0, composerHeight: composer?.offsetHeight ?? 0 };
  }

  private renderCardBlock(item: FeedItem, snapshot: PresentationSnapshot): { element: HTMLElement; changed: boolean } {
    const meta = snapshot.answerMeta[item.id];
    const signature = feedItemSignature(item, meta);
    let rendered = this.feedElements.get(item.id);
    if (!rendered) {
      rendered = { element: this.feedElement(item, meta), signature };
      this.feedElements.set(item.id, rendered);
      return { element: rendered.element, changed: true };
    }
    if (rendered.signature === signature) return { element: rendered.element, changed: false };
    this.updateFeedElement(rendered.element, item, meta);
    rendered.signature = signature;
    return { element: rendered.element, changed: true };
  }

  /** One flowing paragraph: a span per final (stable, so text never jumps) plus the live partial with a caret. */
  private renderParagraphBlock(block: Extract<FeedBlock, { type: "paragraph" }>): { element: HTMLElement; changed: boolean } {
    const signature = paragraphSignature(block);
    let rendered = this.feedElements.get(block.id);
    let changed = false;
    if (!rendered) {
      const article = document.createElement("article");
      article.dataset.messageId = block.id;
      article.setAttribute("aria-atomic", "false");
      const header = el("header", "message-header");
      header.append(el("strong", "", block.speaker), el("span", "message-time"));
      article.append(header, el("p", "paragraph"));
      rendered = { element: article, signature: "" };
      this.feedElements.set(block.id, rendered);
      changed = true;
    }
    const article = rendered.element;
    for (const segment of block.segments) this.transcriptHosts.set(segment.id, article);
    if (rendered.signature === signature) return { element: article, changed };
    rendered.signature = signature;
    const live = Boolean(block.partial);
    article.className = `message message-transcript message-paragraph role-${block.role}${live ? " is-live" : ""}`;
    article.setAttribute("aria-label", `${block.speaker} said`);
    const label = article.querySelector<HTMLElement>(".message-header strong");
    if (label && label.textContent !== block.speaker) label.textContent = block.speaker;
    const time = article.querySelector<HTMLElement>(".message-time");
    const first = block.segments[0]?.occurredAt ?? block.partial?.occurredAt;
    const clock = first ? formatClock(first) : "";
    if (time && time.textContent !== clock) time.textContent = clock;
    const body = article.querySelector<HTMLElement>("p.paragraph")!;
    const existing = new Map([...body.querySelectorAll<HTMLElement>("span.seg[data-transcript-id]")].map(node => [node.dataset.transcriptId!, node]));
    const wanted: HTMLElement[] = [];
    block.segments.forEach((segment, index) => {
      const text = `${index ? " " : ""}${segment.body.trim()}`;
      let node = existing.get(segment.id);
      if (!node) { node = el("span", "seg"); node.dataset.transcriptId = segment.id; }
      if (node.textContent !== text) node.textContent = text;
      wanted.push(node);
    });
    if (block.partial) {
      let node = body.querySelector<HTMLElement>("span.seg-live");
      if (!node) node = el("span", "seg seg-live");
      const text = `${block.segments.length ? " " : ""}${block.partial.body.trim()}`;
      if (node.textContent !== text) node.textContent = text;
      wanted.push(node);
    }
    for (const node of [...body.children]) if (!wanted.includes(node as HTMLElement)) node.remove();
    wanted.forEach((node, index) => { if (body.children.item(index) !== node) body.insertBefore(node, body.children.item(index)); });
    return { element: article, changed: true };
  }

  private updateEmptyState(empty: HTMLElement, connected: boolean): boolean {
    const title = empty.querySelector<HTMLElement>("strong");
    const copy = empty.querySelector<HTMLElement>("p");
    if (!title || !copy) return false;

    const nextTitle = connected ? "Ready when you are" : "A little help, in the moment";
    const nextCopy = connected
      ? "Start listening on G2, or ask below. Your conversation, answers, and notes will appear here."
      : "Add your OpenAI API key in Setup, then connect and start listening. No Helix server needed.";
    const changed = title.textContent !== nextTitle || copy.textContent !== nextCopy;
    if (title.textContent !== nextTitle) title.textContent = nextTitle;
    if (copy.textContent !== nextCopy) copy.textContent = nextCopy;
    this.button("empty-setup-shortcut").hidden = connected;
    return changed;
  }

  private feedElement(item: FeedItem, meta?: AnswerMeta): HTMLElement {
    const article = document.createElement("article");
    article.dataset.messageId = item.id;
    article.setAttribute("aria-atomic", "false");

    const header = document.createElement("header");
    header.className = "message-header";
    const label = document.createElement("strong");
    header.append(label);

    const body = document.createElement("p");
    article.append(header, body);
    this.updateFeedElement(article, item, meta);
    if (item.kind === "insight") {
      const details = document.createElement("details");
      const summary = document.createElement("summary"); summary.textContent = "Explanation";
      details.append(summary, body);
      const source = document.createElement("button"); source.type = "button"; source.textContent = "Original transcript";
      source.addEventListener("click", () => {
        const live = item.sourceTranscriptId ? this.feedNode(item.sourceTranscriptId) : undefined;
        if (live) { live.tabIndex = -1; live.focus({ preventScroll: true }); live.scrollIntoView({ block: "nearest" }); return; }
        const saved = item.sourceSessionId ? this.controller?.openHistorySession(item.sourceSessionId) : undefined;
        const entry = saved?.entries.find(entry => entry.id === `${item.sourceSessionId}:${item.sourceTranscriptId}`);
        if (saved && entry) { this.selectTab("history"); this.historyPanel?.openSource({ session: saved.session, entry, score: 1 }); }
        else source.textContent = "Original transcript unavailable";
      });
      const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.textContent = "Dismiss";
      dismiss.setAttribute("aria-label", `Dismiss explanation for ${item.label}`);
      dismiss.addEventListener("click", () => this.controller?.dismissInsight(item.id));
      const controls = document.createElement("div"); controls.className = "insight-controls"; controls.append(source, dismiss);
      article.append(details, controls);
    }
    return article;
  }

  private updateFeedElement(article: HTMLElement, item: FeedItem, meta?: AnswerMeta): void {
    const partial = item.id === "transcript-partial";
    const kind = item.kind === "question" && item.questionKind ? ` question-${item.questionKind}` : "";
    const className = `message message-${item.kind}${kind}${item.streaming ? " is-streaming" : ""}${partial ? " is-partial" : ""}`;
    if (article.className !== className) article.className = className;
    const ariaLabel = `${item.label} message`;
    if (article.getAttribute("aria-label") !== ariaLabel) {
      article.setAttribute("aria-label", ariaLabel);
    }

    const header = article.querySelector<HTMLElement>(".message-header");
    const label = header?.querySelector<HTMLElement>("strong");
    const body = article.querySelector<HTMLElement>("p");
    if (!header || !label || !body) return;
    if (label.textContent !== item.label) label.textContent = item.label;
    if (body.textContent !== item.body) body.textContent = item.body;

    article.querySelector(".message-sources")?.remove();
    article.querySelector(".message-footer")?.remove();
    const webSources = mergeSources(item.sources ?? [], meta?.sources ?? []);
    if (webSources.length || item.memorySources?.length) {
      const sources = document.createElement("div"); sources.className = "message-sources";
      for (const source of webSources) { const link = sourceLink(source); if (link) { link.className = "source-link"; sources.append(link); } }
      for (const source of item.memorySources ?? []) {
        const chip = document.createElement("button"); chip.type = "button"; chip.className = "memory-chip";
        chip.textContent = `Memory · ${source.session.title} · ${source.entry.speaker ?? source.session.source}`;
        chip.addEventListener("click", () => { this.selectTab("history"); this.historyPanel?.openSource(source); }); sources.append(chip);
      }
      article.append(sources);
    }
    if (item.kind === "answer" && !item.streaming) {
      const footer = document.createElement("div"); footer.className = "message-footer";
      const line = answerMetaLine(meta, item.meta);
      if (line) { const metaLine = document.createElement("small"); metaLine.className = "answer-meta"; metaLine.textContent = line; footer.append(metaLine); }
      const retrieval = retrievalNote(meta);
      if (retrieval) { const note = document.createElement("small"); note.className = "retrieval-note"; note.textContent = retrieval; footer.append(note); }
      footer.append(verifyButton(item.body, item.id, "answer"));
      article.append(footer);
    }
    if (item.kind === "question" && item.questionKind === "you") {
      // The wearer's own question is never auto-answered; offer it explicitly.
      const footer = el("div", "message-footer");
      footer.append(el("small", "answer-meta", "Not auto-answered"), actionButton("ask", "Ask Helix", { target: item.body }, "button button-secondary button-small"));
      article.append(footer);
    }

    let headerMeta = header.querySelector<HTMLElement>("span");
    // Answers carry their meta in the footer line.
    const showHeaderMeta = item.meta && item.kind !== "answer" ? item.meta : undefined;
    if (!showHeaderMeta) {
      headerMeta?.remove();
      return;
    }
    if (!headerMeta) {
      headerMeta = document.createElement("span");
      header.append(headerMeta);
    }
    if (headerMeta.textContent !== showHeaderMeta) headerMeta.textContent = showHeaderMeta;
  }

  /* ---------------------------------------------------- copilot tabs */

  private renderPanel(tab: CompanionTab, snapshot: PresentationSnapshot, build: () => Node[]): void {
    const signature = panelSignature(tab, snapshot);
    if (this.panelSignatures.get(tab) === signature) return;
    this.panelSignatures.set(tab, signature);
    this.element(`${tab}-content`).replaceChildren(...build());
  }

  private renderConcepts(snapshot: PresentationSnapshot): Node[] {
    if (!snapshot.concepts.length) return [emptyBlock("bulb", "No concepts yet", "When someone uses a technical term or acronym, Helix explains it here.")];
    const list = el("ol", "card-list concept-list");
    for (const concept of [...snapshot.concepts].reverse()) {
      const card = el("li", "card concept-card");
      card.dataset.id = concept.id;
      const head = el("div", "card-head");
      head.append(iconNode("bulb"), el("h3", "card-title", concept.term), el("span", `origin-chip origin-${concept.origin}`, originLabel(concept.origin)));
      const actions = el("div", "card-actions");
      if (concept.transcriptId && snapshot.feed.some(item => item.id === concept.transcriptId)) {
        actions.append(actionButton("goto-transcript", "Show in transcript", { id: concept.transcriptId }));
      }
      actions.append(verifyButton(`${concept.term}: ${concept.explanation}`, concept.id, "concept"));
      card.append(head, el("p", "card-body", concept.explanation), actions);
      list.append(card);
    }
    return [list];
  }

  private renderSummary(snapshot: PresentationSnapshot): Node[] {
    const summary = snapshot.summary;
    if (!summary || (!summary.bullets.length && !summary.keyFacts.length)) {
      return [emptyBlock("scroll", "No summary yet", "A rolling summary builds as the conversation goes. Use Refresh to build one now.")];
    }
    const nodes: Node[] = [el("p", "panel-meta", `Updated ${formatClock(summary.updatedAt)} · ${formatTokens(summary.transcriptChars)} characters heard`)];
    if (summary.bullets.length) {
      const list = el("ul", "card-list summary-list");
      summary.bullets.forEach((bullet, index) => {
        const row = el("li", "card summary-bullet");
        row.append(el("span", "bullet-mark"), el("p", "card-body", bullet), verifyButton(bullet, `summary-${index}`, "point"));
        list.append(row);
      });
      nodes.push(list);
    }
    if (summary.keyFacts.length) {
      nodes.push(el("h3", "section-label", "Key facts"));
      const facts = el("ul", "fact-list");
      for (const fact of summary.keyFacts) {
        const row = el("li", "fact-row");
        row.append(el("span", "fact-text", fact), verifyButton(fact, undefined, "fact"));
        facts.append(row);
      }
      nodes.push(facts);
    }
    return nodes;
  }

  private renderQa(snapshot: PresentationSnapshot, connected: boolean): Node[] {
    const nodes: Node[] = [];
    // v0.8 kind "ask": questions the wearer could ask the other party.
    nodes.push(el("h3", "section-label", "Ask them"));
    if (snapshot.suggestions.length) {
      nodes.push(el("p", "field-note", "Say these to the other person. Tap to ask Helix instead; hold or use Copy to copy."));
      const list = el("ul", "card-list suggestion-list");
      for (const suggestion of snapshot.suggestions) {
        const row = el("li", "suggestion");
        const button = actionButton("ask", "", { target: suggestion.question }, "suggestion-button");
        button.dataset.longpress = "copy";
        button.disabled = !connected;
        button.append(iconNode("question"), el("span", "suggestion-text", suggestion.question));
        if (suggestion.why) button.append(el("small", "suggestion-why", suggestion.why));
        button.setAttribute("aria-label", `Ask Helix: ${suggestion.question}`);
        const copy = actionButton("copy", "", { target: suggestion.question }, "copy-button");
        copy.innerHTML = `${icon("copy", "icon copy-icon")}<span>Copy</span>`;
        copy.setAttribute("aria-label", `Copy: ${suggestion.question}`);
        row.append(button, copy);
        list.append(row);
      }
      nodes.push(list);
      if (!connected) nodes.push(el("p", "field-note", "Connect to ask Helix a suggested question. Copy works offline."));
    } else {
      nodes.push(el("p", "field-note", "Questions worth asking the other person appear here as the conversation develops."));
    }
    // v0.8 kind "answer": questions others asked the wearer (answered on the glasses).
    const asked = snapshot.feed.filter(item => item.kind === "question" && (item.questionKind === "they" || item.questionKind === "you"));
    if (asked.length) {
      nodes.push(el("h3", "section-label", "Asked in conversation"));
      const list = el("ol", "card-list asked-list");
      for (const item of [...asked].reverse().slice(0, 12)) {
        const row = el("li", `asked-row asked-${item.questionKind}`);
        const go = actionButton("goto-feed", "", { id: item.id }, "asked-button");
        go.append(el("span", `asked-kind kind-${item.questionKind}`, item.questionKind === "you" ? "You asked" : "They asked"), el("span", "asked-text", item.body));
        go.setAttribute("aria-label", `${item.questionKind === "you" ? "You asked" : "They asked"}: ${item.body}. Show in Answers`);
        row.append(go);
        list.append(row);
      }
      nodes.push(list);
    }
    // v0.8 kind "implicit": information needs inside statements.
    nodes.push(el("h3", "section-label", "Heard in conversation"));
    if (!snapshot.asks.length) {
      nodes.push(el("p", "field-note", "When someone mentions something to look up or decide (a lead time, a price, a design choice), Helix picks it up here."));
      return nodes;
    }
    const list = el("ol", "card-list ask-list");
    for (const ask of [...snapshot.asks].reverse()) {
      const card = el("li", `card ask-card status-${ask.status}`);
      card.dataset.id = ask.id;
      const head = el("div", "card-head");
      head.append(iconNode(ask.kind === "lookup" ? "magnifier" : ask.kind === "propose" ? "bulb" : "question"),
        el("h3", "card-title", ask.topic), el("span", `status-pill pill-${ask.status}`, askStatusLabel(ask.status)));
      card.append(head, el("p", "ask-kind", `${askKindLabel(ask.kind)} · “${ask.trigger}”`));
      if (ask.status === "pending") card.append(el("p", "card-body is-working", ask.kind === "lookup" ? "Searching the web" : "Drafting an answer"));
      if (ask.answer) card.append(el("p", "card-body", ask.answer));
      if (ask.status === "failed" && !ask.answer) card.append(el("p", "card-body", "No answer. Check the connection or ask it directly."));
      const sources = sourceList(ask.sources ?? []);
      if (sources) card.append(sources);
      if (ask.status === "done" && ask.answer) {
        const actions = el("div", "card-actions"); actions.append(verifyButton(`${ask.topic}: ${ask.answer}`, ask.id, "answer")); card.append(actions);
      }
      list.append(card);
    }
    nodes.push(list);
    return nodes;
  }

  private renderChecks(snapshot: PresentationSnapshot): Node[] {
    const nodes: Node[] = [];
    const claims = snapshotClaims(snapshot);
    if (!claims.length && !snapshot.conflicts.length && !snapshot.verifications.length && !snapshot.factChecks.length) {
      return [emptyBlock("shield", "Nothing to check yet", "Checkable claims, conflicting statements and verification results land here. Tap Verify on any claim, answer or summary point.")];
    }
    if (claims.length) {
      nodes.push(el("h3", "section-label", "Claims"));
      const results = new Map(snapshot.verifications.map(result => [result.id, result]));
      const verifying = new Set((snapshot as PresentationSnapshot & { verifying?: readonly string[] }).verifying ?? []);
      const list = el("ol", "card-list claim-list");
      for (const claim of [...claims].reverse()) {
        const result = results.get(claim.id);
        const row = el("li", `card claim-card${result ? ` tone-${result.status}` : ""}`);
        row.dataset.id = claim.id;
        const head = el("div", "card-head");
        head.append(iconNode(claim.scope === "public" ? "magnifier" : "bubble"), el("p", "claim-text", claim.text));
        const meta = el("div", "claim-meta");
        meta.append(el("span", `origin-chip scope-${claim.scope}`, claim.scope === "public" ? "Web-checkable" : "Said earlier"));
        if (claim.speaker) meta.append(el("span", "claim-speaker", claim.speaker));
        if (result) meta.append(el("span", `status-pill pill-${result.status}`, verificationLabel(result.status)));
        const pending = verifying.has(claim.id);
        if (pending) meta.append(el("span", "status-pill pill-pending", "Verifying…"));
        const verify = verifyButton(claim.text, claim.id, "claim");
        verify.dataset.action = "verify-claim";
        if (result || pending) verify.dataset.state = "sent";
        meta.append(verify);
        row.append(head, meta);
        if (result?.summary) row.append(el("p", "card-body claim-result", result.summary));
        const sources = result ? sourceList(result.sources) : undefined;
        if (sources) row.append(sources);
        list.append(row);
      }
      nodes.push(list);
    }
    if (snapshot.conflicts.length) {
      nodes.push(el("h3", "section-label", "Conflicts"));
      const list = el("ol", "card-list");
      for (const conflict of [...snapshot.conflicts].reverse()) {
        const card = el("li", "card check-card tone-conflict");
        const head = el("div", "card-head");
        head.append(iconNode("warning"), el("h3", "card-title", "Statements disagree"), el("span", "status-pill pill-conflict", "Conflict"));
        const pair = el("dl", "conflict-pair");
        pair.append(el("dt", "", "Earlier"), el("dd", "", conflict.earlier), el("dt", "", "Later"), el("dd", "", conflict.later));
        card.append(head, pair, el("p", "card-body", conflict.explanation));
        list.append(card);
      }
      nodes.push(list);
    }
    const checks = [
      ...snapshot.verifications.filter(item => !claims.some(claim => claim.id === item.id)).map(item => ({ id: item.id, title: item.target, status: item.status, summary: item.summary, sources: item.sources, at: item.checkedAt, by: item.requestedBy === "user" ? "You asked" : "Auto" })),
      ...snapshot.factChecks.map(item => ({ id: item.id, title: item.claim, status: item.status, summary: item.summary, sources: item.sources, at: item.checkedAt, by: "Live web check" })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    if (checks.length) {
      nodes.push(el("h3", "section-label", "Verification"));
      const list = el("ol", "card-list");
      for (const check of checks) {
        const card = el("li", `card check-card tone-${check.status}`);
        const head = el("div", "card-head");
        head.append(iconNode(check.status === "supported" ? "check" : check.status === "contradicted" ? "cross" : "shield"),
          el("h3", "card-title", check.title), el("span", `status-pill pill-${check.status}`, verificationLabel(check.status)));
        card.append(head, el("p", "card-body", check.summary || "No summary returned."));
        const sources = sourceList(check.sources);
        if (sources) card.append(sources);
        card.append(el("p", "panel-meta", `${check.by} · ${formatClock(check.at)}`));
        list.append(card);
      }
      nodes.push(list);
    }
    return nodes;
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = this.element("session-status");
      status.textContent = "failed";
      status.className = "status status-failed";
      this.element("session-status-detail").textContent = message;
    }
  }

  private element(id: string): HTMLElement {
    const element = this.root.querySelector<HTMLElement>(`#${id}`);
    if (!element) throw new Error(`Missing UI element #${id}`);
    return element;
  }

  private input(id: string): HTMLInputElement {
    const element = this.root.querySelector<HTMLInputElement>(`#${id}`);
    if (!element) throw new Error(`Missing input #${id}`);
    return element;
  }

  private select(id: string): HTMLSelectElement {
    const element = this.root.querySelector<HTMLSelectElement>(`#${id}`);
    if (!element) throw new Error(`Missing select #${id}`);
    return element;
  }

  private textarea(id: string): HTMLTextAreaElement {
    const element = this.root.querySelector<HTMLTextAreaElement>(`#${id}`);
    if (!element) throw new Error(`Missing textarea #${id}`);
    return element;
  }

  private button(id: string): HTMLButtonElement {
    const element = this.root.querySelector<HTMLButtonElement>(`#${id}`);
    if (!element) throw new Error(`Missing button #${id}`);
    return element;
  }

  private form(id: string): HTMLFormElement {
    const element = this.root.querySelector<HTMLFormElement>(`#${id}`);
    if (!element) throw new Error(`Missing form #${id}`);
    return element;
  }
}

/* ------------------------------------------------------------ markup */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

/** Catalog plus the realtime profile, which may land in the SDK catalog separately. */
export function transcriptionCatalog(): TranscriptionModelInfo[] {
  const items = TRANSCRIPTION_CATALOG.filter(item => (TRANSCRIPTION_PROVIDERS as readonly string[]).includes(item.profileId));
  if (!items.some(item => item.profileId === "openai-realtime")) {
    items.unshift({ profileId: "openai-realtime", model: "gpt-live-transcribe", label: "OpenAI Realtime · gpt-live-transcribe", pricePerMinute: 0.017 });
  }
  return items;
}

export function transcriptionNote(item: TranscriptionModelInfo): string {
  const parts = [item.model];
  if (item.profileId === "openai-realtime") parts.push("streaming · lowest latency");
  parts.push(item.pricePerMinute === undefined ? "price n/a" : `$${item.pricePerMinute}/min`);
  if (item.deprecated) parts.push(item.deprecated);
  return parts.join(" · ");
}

export function answerModelOptionsMarkup(): string {
  const group = (tier: "current" | "legacy", label: string) => `<optgroup label="${label}">${ANSWER_MODELS.filter(model => model.tier === tier)
    .map(model => `<option value="${model.id}">${escapeHtml(model.label)}</option>`).join("")}</optgroup>`;
  return `${group("current", "Current")}${group("legacy", "Legacy")}<option value="${CUSTOM_MODEL}">Custom model id…</option>`;
}

function copilotModelOptionsMarkup(): string {
  return ANSWER_MODELS.map(model => `<option value="${model.id}">${escapeHtml(model.label)}${model.id === DEFAULT_COPILOT_MODEL ? " · default" : ""}</option>`).join("");
}

function transcriptionOptionsMarkup(): string {
  return transcriptionCatalog().map(item => `<option value="${item.profileId}">${escapeHtml(item.label)}${item.profileId === "openai-realtime" && !/stream|latency/i.test(item.label) ? " · streaming" : ""}${item.deprecated ? " · retiring 2027" : ""}</option>`).join("");
}

function gestureLineMarkup(line: string): string {
  const at = line.indexOf(":");
  return at > 0 && at < 40 ? `<strong>${escapeHtml(line.slice(0, at))}</strong> ${escapeHtml(line.slice(at + 1).trim())}` : escapeHtml(line);
}
/** One-line summary for the Answers footer: "Press: select · Double press: menu · …". */
export function gestureStrip(lines: readonly string[] = gestureHelpLines()): string {
  return lines.slice(0, 5).map(line => {
    const at = line.indexOf(":");
    if (at <= 0) return line.split(/\s+/u).slice(0, 4).join(" ");
    const action = line.slice(at + 1).trim().split(/[,;(]/u)[0]!.trim().split(/\s+/u).slice(0, 3).join(" ");
    return `${line.slice(0, at).trim()} ${action.toLowerCase()}`;
  }).join(" · ");
}

function tabButton(tab: typeof TAB_DEFINITIONS[number], selected: boolean): string {
  return `<button id="tab-${tab.id}" class="tab" type="button" role="tab" aria-selected="${selected}" aria-controls="panel-${tab.id}" tabindex="${selected ? 0 : -1}">
    <span class="tab-icon">${icon(tab.icon)}</span><span class="tab-label">${tab.label}</span><span id="badge-${tab.id}" class="badge" hidden>0</span>
  </button>`;
}

function controlButton(id: string, label: string, iconName: IconName, variant: string, disabled = false): string {
  return `<button id="${id}" class="button ${variant}" type="button"${disabled ? " disabled" : ""}><span class="button-icon">${icon(iconName)}</span><span class="button-label">${label}</span></button>`;
}

function toggle(id: string, label: string, note?: string): string {
  return `<label class="toggle" for="${id}"><input id="${id}" type="checkbox" /><span>${label}${note ? `<small>${note}</small>` : ""}</span></label>`;
}

function panelHeading(title: string, iconName: IconName, aside = ""): string {
  return `<header class="panel-heading">${icon(iconName, "icon panel-icon")}<h2>${pixelText(title, "pixel-text panel-title")}</h2>${aside}</header>`;
}

export function companionMarkup(rehearsalScripts: readonly RehearsalScriptOption[] = []): string {
  const rehearsalHidden = rehearsalScripts.length === 0 ? " hidden" : "";
  return `
    <main class="shell" data-tab="answers">
      <header class="hud" aria-label="Helix status">
        <div class="hud-top">
          <div id="mascot" class="mascot" data-mascot="idle" aria-hidden="true">${mascotMarkup()}</div>
          <div class="hud-id">
            <h1 class="wordmark">${pixelText("Helix", "pixel-text wordmark-text")}</h1>
            <div class="session-state" role="status" aria-live="polite">
              <span id="session-status" class="status status-starting">starting</span>
              <span id="session-status-detail" class="status-detail">Preparing the G2 display</span>
            </div>
          </div>
          <dl class="hud-meters">
            <div id="hud-cost" class="meter meter-cost">${icon("coin", "icon meter-icon")}<dt class="sr-only">Session cost</dt><dd><span id="cost-value">$0</span><small id="token-value">0 tok</small></dd></div>
            <div id="hud-latency" class="meter meter-latency">${icon("hourglass", "icon meter-icon")}<dt class="sr-only">Last answer latency</dt><dd><span id="latency-value">–</span><small>last answer</small></dd></div>
          </dl>
        </div>
        <div class="hud-chips">
          <span id="mic-state" class="chip mic-state" data-state="off">${icon("mic", "icon chip-icon")}<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span id="mic-state-text">Mic off</span></span>
          <div id="glasses-state" class="chip glasses-state glasses-state-starting">${icon("glasses", "icon chip-icon")}<span>G2</span><strong>Preparing</strong></div>
          <button id="controls-toggle" class="chip controls-toggle" type="button" aria-expanded="true" aria-controls="transport" aria-label="Show or hide Connect, Listen, Pause and Stop"><span>Controls</span><span class="controls-chevron" aria-hidden="true"></span></button>
        </div>
        <nav id="transport" class="transport" aria-label="Conversation controls">
          ${controlButton("connect-button", "Connect", "plug", "button-primary")}
          ${controlButton("start-button", "Listen", "mic", "button-secondary", true)}
          ${controlButton("pause-button", "Pause", "pause", "button-secondary", true)}
          ${controlButton("disconnect-button", "Stop", "stop", "button-quiet", true)}
        </nav>
      </header>

      <section id="modebar-wrap" class="modebar-wrap" aria-label="Conversation mode">
        <div id="modebar" class="modebar" role="group" aria-label="Mode">
          ${PICKER_MODES.map(mode => `<button type="button" class="mode-chip" data-mode="${mode}" aria-pressed="${mode === "general"}">${icon(modeIcon(mode), "icon mode-icon")}<span>${MODE_PROFILES[mode].label}</span></button>`).join("")}
        </div>
        <p id="mode-blurb" class="mode-blurb">${MODE_PROFILES.general.blurb}</p>
      </section>

      <section id="mirror" class="mirror" data-open="true" aria-label="On your glasses" hidden>
        <button id="mirror-toggle" class="mirror-toggle" type="button" aria-expanded="true" aria-controls="mirror-screen">
          ${icon("glasses", "icon mirror-icon")}<span class="mirror-title">On your glasses</span><span id="mirror-view" class="mirror-view">LIVE</span><span id="mirror-line" class="mirror-line"></span><span class="mirror-chevron" aria-hidden="true"></span>
        </button>
        <div id="mirror-screen" class="mirror-screen" role="img" aria-label="Glasses display mirror" hidden></div>
      </section>

      <div id="tabbar-wrap" class="tabbar-wrap"><nav id="tabbar" class="tabbar" role="tablist" aria-label="Helix panels">
        ${TAB_DEFINITIONS.map((tab, index) => tabButton(tab, index === 0)).join("")}
      </nav></div>

      <div class="panels">
        <div id="peek" class="peek" role="status" aria-live="polite" hidden>
          <button id="peek-button" class="peek-button" type="button"><span id="peek-icon" class="peek-icon"></span><span class="peek-copy"><strong id="peek-title"></strong><span id="peek-text"></span></span><span class="peek-go">Open</span></button>
        </div>

        <section id="panel-answers" class="tabpanel conversation-card" role="tabpanel" aria-labelledby="tab-answers">
          <h2 id="conversation-title" class="sr-only">Live conversation</h2>
          <div
            id="conversation-feed"
            class="conversation-feed"
            role="log"
            aria-live="polite"
            aria-atomic="false"
            aria-relevant="additions text"
            aria-label="Live conversation messages"
            tabindex="0"
          ><div id="feed-empty" class="empty-state">
              <div class="empty-mascot" aria-hidden="true">${pixelSvg(MASCOT_FRAMES.idle[0]!, "empty-sprite")}</div>
              <strong>A little help, in the moment</strong>
              <p>Add your OpenAI API key in Setup, then connect and start listening. No Helix server needed.</p>
              <button id="empty-setup-shortcut" class="button button-secondary" type="button">${icon("gear", "icon button-icon")}<span>Open setup</span></button>
            </div></div>

          <div class="composer">
            <nav class="context-actions" aria-label="Ask using conversation context">
              <button id="ask-local-button" class="button button-secondary button-small" type="button" disabled>Ask local context</button>
              <button id="ask-global-button" class="button button-secondary button-small" type="button" disabled>Ask whole conversation</button>
              <button id="open-shortcuts-button" class="button button-quiet button-small button-square" type="button" aria-controls="shortcut-panel" aria-expanded="false" aria-label="Shortcuts">${icon("gear")}</button>
            </nav>
            <section id="shortcut-panel" class="shortcut-panel" aria-label="Shortcuts" hidden>
              <div class="shortcut-actions">${SHORTCUT_ACTIONS.map(action => `<button id="shortcut-${action.itemID}" class="button button-secondary button-small" type="button">${action.itemName}</button>`).join("")}</div>
              <ul class="gesture-list" aria-label="Glasses controls">${gestureHelpLines().map(line => `<li>${gestureLineMarkup(line)}</li>`).join("")}</ul>
            </section>
            <button id="gesture-strip" class="gesture-strip" type="button" aria-controls="shortcut-panel" aria-label="Glasses controls: ${escapeHtml(gestureStrip())}">${icon("glasses", "icon gesture-icon")}<span>${escapeHtml(gestureStrip())}</span></button>
            <p id="copy-status" class="sr-only" role="status" aria-live="polite"></p>
            <form id="question-form" class="question-form">
              <label class="sr-only" for="manual-question">Ask Helix a manual question</label>
              <input id="manual-question" type="text" placeholder="Ask Helix a question" autocomplete="off" disabled />
              <button id="ask-button" class="button button-primary" type="submit" disabled>Ask</button>
            </form>
          </div>
        </section>

        <section id="panel-concepts" class="tabpanel" role="tabpanel" aria-labelledby="tab-concepts" hidden>
          ${panelHeading("Concepts", "bulb", `<span class="ai-label">AI-generated · not web-verified</span>`)}
          <div id="concepts-content" class="panel-content"></div>
        </section>

        <section id="panel-summary" class="tabpanel" role="tabpanel" aria-labelledby="tab-summary" hidden>
          ${panelHeading("Summary", "scroll", `<button id="run-copilot-button" class="button button-secondary button-small" type="button">Refresh</button>`)}
          <div id="summary-content" class="panel-content"></div>
        </section>

        <section id="panel-qa" class="tabpanel" role="tabpanel" aria-labelledby="tab-qa" hidden>
          ${panelHeading("Q&A", "question")}
          <div id="qa-content" class="panel-content"></div>
        </section>

        <section id="panel-checks" class="tabpanel" role="tabpanel" aria-labelledby="tab-checks" hidden>
          ${panelHeading("Checks", "shield")}
          <div id="checks-content" class="panel-content"></div>
        </section>

        <section id="panel-setup" class="tabpanel" role="tabpanel" aria-labelledby="tab-setup" hidden>
          ${panelHeading("Setup", "gear", `<span id="settings-save-status" class="save-status" role="status" aria-live="polite"></span>`)}
          <div id="configuration-panel" class="configuration-panel">
            <p id="session-profile-summary" class="profile-summary">General · Reactive · Realtime → ${DEFAULT_ANSWER_MODEL}</p>

            <section id="rehearsal-group" class="config-group rehearsal-group" aria-labelledby="rehearsal-title" data-no-persist${rehearsalHidden}>
              <div class="config-group-heading"><h3 id="rehearsal-title">Rehearsal</h3><p>Play a scripted conversation through the live pipeline to try Helix without speaking. Connect first.</p></div>
              <div class="field-grid rehearsal-grid">
                <label for="rehearsal-script">Script
                  <select id="rehearsal-script">${rehearsalScripts.map(script => `<option value="${escapeHtml(script.id)}">${escapeHtml(script.title)}</option>`).join("")}</select>
                </label>
                <label for="rehearsal-speed">Speed
                  <select id="rehearsal-speed"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select>
                </label>
              </div>
              <div class="button-row">
                ${controlButton("rehearse-play", "Play rehearsal", "play", "button-primary")}
                ${controlButton("rehearse-stop", "Stop", "stop", "button-quiet", true)}
              </div>
              <p id="rehearsal-status" class="field-note" role="status" aria-live="polite"></p>
            </section>

            <section class="config-group" aria-labelledby="models-title">
              <div class="config-group-heading"><h3 id="models-title">Models</h3><p>Prices are list prices checked Nov 2026. Session cost in the header is estimated from provider usage.</p></div>
              <label for="answer-model">Answer model
                <select id="answer-model">${answerModelOptionsMarkup()}</select>
              </label>
              <label id="answer-model-custom-field" for="answer-model-custom" hidden>Custom model id
                <input id="answer-model-custom" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="100" placeholder="e.g. gpt-6.1-terra-2026-10-01" />
              </label>
              <p id="answer-model-note" class="field-note"></p>
              <label for="transcription-provider">Transcription
                <select id="transcription-provider">${transcriptionOptionsMarkup()}</select>
              </label>
              <p id="transcription-note" class="field-note"></p>
              <label for="copilot-model">Copilot model (summary, concepts, lookups)
                <select id="copilot-model">${copilotModelOptionsMarkup()}</select>
              </label>
              <label for="answer-provider">Answer API
                <select id="answer-provider">
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="openai-compatible">OpenAI Chat Completions</option>
                </select>
              </label>
              <p class="field-note">Audio goes directly from your phone to the selected provider. It is cloud transcription, not offline speech recognition. The same OpenAI key powers answers.</p>
            </section>

            <section class="config-group" aria-labelledby="copilot-title">
              <div class="config-group-heading"><h3 id="copilot-title">Copilot</h3><p>Runs in the background. Results appear on the glasses HUD (swipe to Q&amp;A, Concepts, Summary, Checks) and in these tabs.</p></div>
              <div class="explanation-settings">
                <label class="toggle" for="auto-explain-terms"><input id="auto-explain-terms" type="checkbox"><span>Explain technical terms automatically</span></label>
                <p class="field-note">Uses your selected answer model and incurs provider charges. AI-generated explanations are not web-verified.</p>
                <p id="explanation-settings-status" class="field-note" role="status"></p>
              </div>
              <fieldset class="toggle-group">
                <legend>Background features</legend>
                ${toggle("copilot-summarize", "Rolling summary")}
                ${toggle("copilot-concepts", "Concept cards")}
                ${toggle("copilot-conflicts", "Flag conflicting statements")}
                ${toggle("copilot-suggestions", "Suggest questions")}
                ${toggle("copilot-implicit-asks", "Answer things people mention", "Lead times, prices, design choices")}
                ${toggle("copilot-web-grounding", "Use web search", "$10 per 1,000 searches plus tokens")}
                ${toggle("copilot-claims", "Find claims to verify", "Checks tab and the glasses Verify action")}
                ${toggle("copilot-people", "Track people", "People tab; saved with each session")}
              </fieldset>
            </section>

            <section class="config-group" aria-labelledby="experience-title">
              <div class="config-group-heading"><h3 id="experience-title">How Helix should help</h3><p>Everything runs on your phone. It connects directly to your selected AI providers.</p></div>
              <div class="field-grid profile-grid">
                <label for="conversation-mode">Conversation mode
                  <select id="conversation-mode">
                    ${PICKER_MODES.map(mode => `<option value="${mode}">${MODE_PROFILES[mode].label}</option>`).join("")}
                  </select>
                </label>
                <label for="response-strategy">Response strategy
                  <select id="response-strategy">
                    <option value="reactive">Reactive</option>
                    <option value="proactive">Proactive</option>
                    <option value="both">Both</option>
                  </select>
                </label>
              </div>
              <div class="mode-prompt" data-no-persist>
                <label for="mode-prompt">System prompt for this mode</label>
                <textarea id="mode-prompt" rows="5" maxlength="4000" spellcheck="true"></textarea>
                <p id="mode-prompt-status" class="field-note" role="status"></p>
                <div class="mode-prompt-actions">
                  <button id="mode-prompt-save" class="button button-secondary button-small" type="button">Save prompt</button>
                  <button id="mode-prompt-reset" class="button button-quiet button-small" type="button" disabled>Reset to built-in</button>
                </div>
              </div>
              <fieldset class="toggle-group">
                <legend>Conversation automation</legend>
                <label class="toggle"><input id="auto-question" type="checkbox" /><span>Detect questions</span></label>
                <label class="toggle"><input id="auto-answer" type="checkbox" /><span>Answer automatically</span></label>
                <label class="toggle"><input id="auto-notes" type="checkbox" /><span>Capture useful notes</span></label>
              </fieldset>
            </section>

            <section class="config-group provider-key-group" aria-labelledby="provider-keys-title" data-no-persist>
              <div class="config-group-heading"><h3 id="provider-keys-title">API keys</h3><p>Bring your own keys. No server setup required.</p></div>
              <div class="field-grid provider-key-grid">
                <div class="key-test-field">
                  <label for="openai-api-key">OpenAI API key
                    <input id="openai-api-key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="8192" />
                  </label>
                  <div class="key-test-row">
                    <button id="test-openai-key" class="button button-secondary button-small" type="button">Test key</button>
                    <p id="key-test-status" class="field-note key-test-status" role="status" aria-live="polite" data-state="idle">Paste a key, then Test key. Helix checks access, credits and the selected model.</p>
                  </div>
                </div>
                <label for="deepgram-api-key">Deepgram API key
                  <input id="deepgram-api-key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="8192" />
                </label>
                <label for="soniox-api-key">Soniox API key
                  <input id="soniox-api-key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="8192" />
                </label>
                <label for="omi-api-key">Omi API key (explicit import only)
                  <input id="omi-api-key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="8192" />
                </label>
              </div>
              <label class="toggle credential-save-toggle">
                <input id="save-api-keys" type="checkbox" />
                <span>Save API keys on this phone when connecting</span>
              </label>
              <p class="field-note provider-key-disclosure">
                Keys go only to their selected provider over encrypted connections, directly from your phone. Saving uses Even App plugin local storage for convenience; it is not described as Keychain or encrypted secure storage. Keys are never built into the .ehpk. Leave saving off for memory-only use.
              </p>
              <div class="provider-key-actions">
                <button id="clear-provider-keys" class="button button-quiet button-small" type="button">Clear saved API keys</button>
                <p id="provider-key-status" class="field-note provider-key-status" role="status" aria-live="polite"></p>
              </div>
            </section>

            <section class="config-group" aria-labelledby="prompt-title">
              <div class="config-group-heading"><h3 id="prompt-title">Response guidance</h3><p>Your phone applies these instructions directly to GPT responses.</p></div>
              <label for="instructions">Instructions
                <textarea id="instructions" rows="4" maxlength="8000"></textarea>
              </label>
              <div class="field-grid prompt-grid">
                <label for="locale">Locale<input id="locale" type="text" /></label>
                <label for="sentence-limit">Max answer sentences<input id="sentence-limit" type="number" min="1" max="10" inputmode="numeric" /></label>
              </div>
            </section>

            <section class="config-group" aria-labelledby="diagnostics-title" data-no-persist>
              <div class="config-group-heading"><h3 id="diagnostics-title">Diagnostics</h3><p>If Helix freezes or disappears, reopen it, then copy this and send it to the developer. It keeps the previous run: lifecycle events, stalls, control names and errors. No keys, no transcripts.</p></div>
              <div class="provider-key-actions">
                <button id="diagnostics-refresh" class="button button-secondary button-small" type="button">Show log</button>
                <button id="diagnostics-copy" class="button button-quiet button-small" type="button">Copy</button>
                <button id="diagnostics-clear" class="button button-quiet button-small" type="button">Clear</button>
              </div>
              <label class="toggle" for="glasses-pixel-art"><input id="glasses-pixel-art" type="checkbox" checked data-no-persist /><span>Pixel art on the glasses<small>Turn off for a text-only glasses display with fewer writes to the glasses. Try this if Helix freezes or the glasses lag.</small></span></label>
              <label for="glasses-write-gap">Pause between glasses updates
                <select id="glasses-write-gap" data-no-persist>
                  <option value="80">Default (80 ms)</option><option value="250">250 ms</option><option value="500">500 ms</option><option value="1000">1 s</option>
                </select>
              </label>
              <p class="field-note">A longer pause puts less load on the glasses link; captions on the glasses update more slowly. Try it if Helix freezes.</p>
              <p id="diagnostics-last-exit" class="diagnostics-last-exit" hidden></p>
              <div id="diagnostics-log" class="diagnostics-log" role="log" hidden></div>
            </section>

            <section class="config-group" aria-labelledby="gesture-title">
              <div class="config-group-heading"><h3 id="gesture-title">G2 controls</h3><p>Temple touchpad and R1 ring share the same gestures. Start, pause or disconnect on this phone.</p></div>
              <ul class="gesture-list gesture-help" aria-label="Glasses gestures">${gestureHelpLines().map(line => `<li>${gestureLineMarkup(line)}</li>`).join("")}</ul>
              <p class="field-note">The phone follows the glasses: when you switch views with the ring or temple, the matching tab opens here unless you touched the phone in the last 8 seconds.</p>
            </section>
          </div>
        </section>

        <section id="panel-people" class="tabpanel" role="tabpanel" aria-labelledby="tab-people" hidden>
          ${panelHeading("People", "people", `<span class="ai-label">From what was said · AI-extracted</span>`)}
          <div id="people-mount" class="panel-content"></div>
        </section>

        <section id="panel-history" class="tabpanel" role="tabpanel" aria-labelledby="tab-history" hidden>
          ${panelHeading("History", "clock")}
          <div id="history-mount"></div>
        </section>

        <section id="panel-knowledge" class="tabpanel" role="tabpanel" aria-labelledby="tab-knowledge" hidden>
          ${panelHeading("Knowledge", "database")}
          <div id="knowledge-mount"></div>
        </section>
      </div>
    </main>
  `;
}

/* ----------------------------------------------------------- helpers */

/** Tolerates pre-v0.7 snapshot literals (QA fixtures) that lack copilot fields. */
function withSnapshotDefaults(snapshot: PresentationSnapshot): PresentationSnapshot {
  if (snapshot.usage && snapshot.unseen && snapshot.people && snapshot.unseen.knowledge !== undefined) return snapshot;
  const partial: Partial<PresentationSnapshot> = snapshot;
  return {
    ...snapshot,
    people: partial.people ?? [],
    concepts: partial.concepts ?? [], conflicts: partial.conflicts ?? [], suggestions: partial.suggestions ?? [],
    asks: partial.asks ?? [], verifications: partial.verifications ?? [], factChecks: partial.factChecks ?? [],
    answerMeta: partial.answerMeta ?? {},
    usage: partial.usage ?? { costUsd: 0, unknownCostCount: 0, inputTokens: 0, outputTokens: 0, requests: 0, byKind: {} },
    unseen: { answers: 0, concepts: 0, summary: 0, qa: 0, checks: 0, people: 0, history: 0, knowledge: 0, setup: 0, ...partial.unseen },
  };
}

/** v0.8 fields owned by the glasses agent; read defensively so the phone works before/without them. */
export function snapshotHud(snapshot: PresentationSnapshot): HudMirror | undefined {
  const hud = (snapshot as PresentationSnapshot & { hud?: HudMirror }).hud;
  return hud && typeof hud === "object" && typeof hud.view === "string" && typeof hud.updatedAt === "number"
    ? { ...hud, header: String(hud.header ?? ""), body: String(hud.body ?? ""), caption: String(hud.caption ?? "") } : undefined;
}
export function snapshotClaims(snapshot: PresentationSnapshot): CopilotClaim[] {
  const claims = (snapshot as PresentationSnapshot & { claims?: readonly CopilotClaim[] }).claims;
  return Array.isArray(claims) ? claims.filter(claim => claim && typeof claim.id === "string" && typeof claim.text === "string" && claim.text.trim()) : [];
}

function oneLine(text: string): string { return text.replace(/\s+/gu, " ").trim(); }
function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/gu, "\\$&");
}
function paragraphSignature(block: Extract<FeedBlock, { type: "paragraph" }>): string {
  return [block.speaker, block.role, ...block.segments.map(item => `${item.id}\u001e${item.body}\u001e${item.occurredAt ?? ""}`), block.partial?.body ?? ""].join("\u001f");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconNode(name: IconName): HTMLElement {
  const wrap = el("span", "card-icon"); wrap.setAttribute("aria-hidden", "true"); wrap.innerHTML = icon(name); return wrap;
}

function actionButton(action: string, label: string, data: { target?: string; id?: string }, className = "button button-quiet button-small"): HTMLButtonElement {
  const button = el("button", className, label || undefined);
  button.type = "button";
  button.dataset.action = action;
  if (data.target !== undefined) button.dataset.target = data.target;
  if (data.id !== undefined) button.dataset.id = data.id;
  return button;
}

function verifyButton(target: string, id: string | undefined, what: string): HTMLButtonElement {
  const button = actionButton("verify", "", { target, ...(id ? { id } : {}) }, "verify-button");
  button.innerHTML = `${icon("shield", "icon verify-icon")}<span>Verify</span>`;
  button.setAttribute("aria-label", `Verify this ${what}`);
  return button;
}

function emptyBlock(iconName: IconName, title: string, copy: string): HTMLElement {
  const block = el("div", "panel-empty");
  const art = el("span", "panel-empty-icon"); art.setAttribute("aria-hidden", "true"); art.innerHTML = icon(iconName);
  block.append(art, el("strong", "", title), el("p", "", copy));
  return block;
}

function sourceList(sources: readonly Citation[]): HTMLElement | undefined {
  const links = sources.map(source => sourceLink(source)).filter((link): link is HTMLAnchorElement => Boolean(link));
  if (!links.length) return;
  const wrap = el("div", "message-sources");
  for (const link of links) { link.className = "source-link"; wrap.append(link); }
  return wrap;
}

function mergeSources(a: readonly Citation[], b: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  return [...a, ...b].filter(source => !seen.has(source.url) && Boolean(seen.add(source.url)));
}

function setButtonLabel(button: HTMLButtonElement, label: string): void {
  const node = button.querySelector<HTMLElement>(".button-label") ?? button;
  if (node.textContent !== label) node.textContent = label;
}

function originLabel(origin: "copilot" | "insight" | "user"): string {
  return origin === "insight" ? "Term explainer" : origin === "user" ? "You asked" : "Copilot";
}
function askKindLabel(kind: "lookup" | "propose" | "question"): string {
  return kind === "lookup" ? "Web lookup" : kind === "propose" ? "Proposed answer" : "Question";
}
function askStatusLabel(status: "pending" | "done" | "failed"): string {
  return status === "pending" ? "Working" : status === "done" ? "Done" : "Failed";
}
function verificationLabel(status: string): string {
  return ({ supported: "Supported", contradicted: "Contradicted", uncertain: "Uncertain", unavailable: "Unavailable" } as Record<string, string>)[status] ?? status;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "speech→text 1.2 s · first word 0.8 s · total 2.4 s · $0.0012 · gpt-6.1-terra" */
export function answerMetaLine(meta: AnswerMeta | undefined, fallback?: string): string | undefined {
  if (!meta) return fallback;
  const parts: string[] = [];
  if (meta.timing.transcriptionMs !== undefined) parts.push(`speech→text ${formatMs(meta.timing.transcriptionMs)}`);
  if (meta.timing.firstTokenMs !== undefined) parts.push(`first word ${formatMs(meta.timing.firstTokenMs)}`);
  parts.push(`total ${formatMs(meta.timing.endToEndMs)}`);
  if (meta.usage) {
    parts.push(formatUsd(meta.usage.costUsd));
    parts.push(meta.usage.model);
  }
  return parts.join(" · ");
}

export function retrievalNote(meta: AnswerMeta | undefined): string | undefined {
  if (!meta) return;
  const { searchedEntries, matched, webUsed } = meta.retrieval;
  if (webUsed && !meta.sources.length) return "web searched · no citations returned";
  if (matched === 0 && !webUsed) return `no memory match (searched ${searchedEntries})`;
  if (matched > 0 && meta.retrieval.knowledge === "openai") return `${matched} passage${matched === 1 ? "" : "s"} from OpenAI knowledge base`;
  if (matched > 0) return `${matched} memory match${matched === 1 ? "" : "es"} of ${searchedEntries}`;
  return;
}

export function mascotStateFor(snapshot: Pick<PresentationSnapshot, "status" | "error" | "feed" | "asks">): MascotState {
  if (snapshot.status === "failed" || snapshot.error) return "error";
  if (snapshot.feed.some(item => item.kind === "answer" && item.streaming)) return "speaking";
  const last = [...snapshot.feed].reverse().find(item => item.kind === "question" || item.kind === "answer");
  if (ACTIVE.includes(snapshot.status) && (last?.kind === "question" || snapshot.asks.some(ask => ask.status === "pending"))) return "thinking";
  if (snapshot.status === "listening") return "listening";
  return "idle";
}

function panelSignature(tab: CompanionTab, snapshot: PresentationSnapshot): string {
  const connected = ACTIVE.includes(snapshot.status);
  switch (tab) {
    case "concepts": return JSON.stringify([snapshot.concepts, snapshot.feed.filter(item => item.kind === "transcript").map(item => item.id)]);
    case "summary": return JSON.stringify(snapshot.summary ?? null);
    case "qa": return JSON.stringify([snapshot.suggestions, snapshot.asks, connected,
      snapshot.feed.filter(item => item.kind === "question").map(item => [item.id, item.questionKind, item.body])]);
    case "checks": return JSON.stringify([snapshotClaims(snapshot), (snapshot as PresentationSnapshot & { verifying?: readonly string[] }).verifying ?? [], snapshot.conflicts, snapshot.verifications, snapshot.factChecks]);
    default: return "";
  }
}

function selectLabel(select: HTMLSelectElement): string {
  return select.selectedOptions[0]?.textContent?.trim() || select.value;
}

export interface ConversationFeedScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

export function shouldAutoScrollConversationFeed(
  metrics: ConversationFeedScrollMetrics,
  threshold = 48,
): boolean {
  const distanceFromBottom = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return distanceFromBottom <= threshold;
}

/** v0.13 page scroll helpers (pure). */
export interface FeedEdges { readonly endBottom: number | undefined; readonly viewportHeight: number; readonly composerHeight: number }
/** A message this far below the composer still counts as "the reader sees the end of the feed". */
export const FEED_FOLLOW_SLACK_PX = 48;
/**
 * How far the page must scroll (px) for the feed's last message to sit just above the sticky composer.
 * <= 0: already visible. Infinity: nothing is laid out (empty feed or hidden tab), so never follow.
 */
export function feedFollowDelta(edges: FeedEdges): number {
  if (edges.endBottom === undefined || !(edges.viewportHeight > 0)) return Number.POSITIVE_INFINITY;
  return edges.endBottom - (edges.viewportHeight - edges.composerHeight - 8);
}
/**
 * After a tab switch: the scroll position that puts the new panel's top right under the stuck tab bar,
 * or undefined when the page is not scrolled into the panels (the header stays where it is).
 * `panelsTop` and `pinnedBottom` (bottom edge of the tab bar) are viewport coordinates.
 */
export function panelScrollTop(metrics: { readonly scrollTop: number; readonly panelsTop: number; readonly pinnedBottom: number }): number | undefined {
  const overshoot = metrics.pinnedBottom - metrics.panelsTop;
  return overshoot > 1 ? Math.max(0, metrics.scrollTop - overshoot) : undefined;
}

function feedItemSignature(item: FeedItem, meta?: AnswerMeta): string {
  return [
    item.kind,
    item.label,
    item.body,
    item.meta ?? "",
    item.streaming ? "streaming" : "settled",
    JSON.stringify(item.sources ?? []),
    JSON.stringify(item.memorySources ?? []),
    meta ? JSON.stringify(meta) : "",
  ].join("\u001f");
}

export function statusDetail(status: string, error?: string): string {
  if (error) return error;
  switch (status) {
    case "ready": return "Glasses ready. Connect to begin.";
    case "connecting": return "Preparing direct provider connections";
    case "authorizing": return "Starting the conversation session";
    case "connected": return "Connected. Start listening when ready.";
    case "listening": return "Listening through the G2 microphone";
    case "paused": return "Paused. Resume when you are ready.";
    case "stopped": return "Conversation ended";
    case "exited": return "Session stopped. Reopen Helix to connect again.";
    case "failed": return "Something needs attention";
    default: return "Preparing the G2 display";
  }
}

function glassesDetail(status: string): string {
  switch (status) {
    case "ready": return "HUD ready · connect to start";
    case "connected":
    case "listening":
    case "paused": return "Live HUD · swipe for views";
    case "failed":
    case "stopped":
    case "exited": return "Display blank";
    default: return "Preparing";
  }
}
