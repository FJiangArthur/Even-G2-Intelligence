import {
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  MenuContainerProperty,
  MenuItemProperty,
  type RebuildPageContainer,
  type ImageRawDataUpdate,
  type ImageRawDataUpdateResult,
} from "@evenrealities/even_hub_sdk";
import { AnswerPager, paginateAnswer } from "./answer-pager";
import { SHORTCUT_ACTIONS } from "./shortcut-actions";

export const GLASSES_CONTAINER_ID = 1;
export const GLASSES_CONTAINER_NAME = "helix-main";
const MIN_RENDER_DEBOUNCE_MS = 120;
/** v0.15: how long a glasses write may stay unanswered before it counts as failed (the Even bridge has no timeout of its own). */
export const TEXT_WRITE_DEADLINE_MS = 15_000, PAGE_WRITE_DEADLINE_MS = 20_000;
/** Pause before the next write after an unanswered one: 5 s, doubling to 30 s while it keeps happening. */
export const WRITE_TIMEOUT_BACKOFF_MS = 5000, WRITE_TIMEOUT_BACKOFF_MAX_MS = 30_000;
export function writeTimeoutBackoff(consecutive: number): number {
  return Math.min(WRITE_TIMEOUT_BACKOFF_MAX_MS, WRITE_TIMEOUT_BACKOFF_MS * 2 ** Math.max(0, Math.min(8, consecutive - 1)));
}
export class BridgeTimeoutError extends Error {}
/**
 * `promise`, or a BridgeTimeoutError when it has not settled after `ms`. The call itself cannot be
 * cancelled; a late answer is ignored.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BridgeTimeoutError(`G2 did not answer the ${what} within ${Math.round(ms / 1000)} s`)), ms);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export interface GlassesRenderBridge {
  createStartUpPageContainer(container: CreateStartUpPageContainer): Promise<StartUpPageCreateResult>;
  textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean>;
  updateImageRawData?(image: ImageRawDataUpdate): Promise<ImageRawDataUpdateResult>;
  /** Full page redraw (list menu, lifecycle re-push). Omitting menuObject clears the OS menu. */
  rebuildPageContainer?(container: RebuildPageContainer): Promise<boolean>;
}

export interface AttributedText {
  readonly text: string;
  readonly speaker?: string;
}

export type NoteDeliveryState =
  | "suggested"
  | "session"
  | "omi-pending"
  | "omi-synced"
  | "omi-failed";

export interface GlassesConversationState {
  readonly status: string;
  readonly transcript?: AttributedText & { readonly final: boolean };
  /** role/trigger (v0.8): who asked and why it was answered ("manual" | "question" | "proactive"). */
  readonly question?: AttributedText & { readonly confidence?: number; readonly role?: "self" | "other" | "unknown"; readonly trigger?: string };
  /** partial (v0.14): the provider cut the answer short; the text is what arrived. */
  readonly answer?: AttributedText & { readonly streaming: boolean; readonly id?: string; readonly questionId?: string; readonly partial?: boolean };
  readonly answerResetRevision?: number;
  readonly cue?: { readonly id: string; readonly text: string };
  readonly manualPending?: boolean;
  readonly note?: AttributedText & {
    readonly id: string;
    readonly delivery: NoteDeliveryState;
  };
  /** Session-ending failure only (status "failed"); it hides the answer. */
  readonly error?: string;
  /** v0.14: a transient problem (busy, a failed retry, a copilot failure). Shown briefly; the answer stays up. */
  readonly notice?: { readonly id: number; readonly text: string };
  readonly interaction?: string;
  /** v0.8 lifecycle: set after a cold start that interrupted a live session; tap resumes. */
  readonly resumePrompt?: string;
  /** v0.10 conversation mode (modeProfile id): header badge, view labels, answer keys. */
  readonly mode?: string;
}

export interface GlassesRendererOptions {
  readonly debounceMs?: number;
  readonly onError?: (error: Error) => void;
}

export class GlassesRenderer {
  private readonly debounceMs: number;
  private timer?: ReturnType<typeof globalThis.setTimeout>;
  private currentFrame = buildGlassesDashboard({ status: "starting" });
  private readonly lastRendered = new Map<number, string>();
  private initialized = false;
  private generation = 0;
  private initializing?: Promise<void>;
  private inFlight?: Promise<void>;
  /** v0.15: no scheduled write before this time (set after an unanswered write). */
  private blockedUntil = 0;
  private timeouts = 0;
  private cueTimer?: ReturnType<typeof setTimeout>;
  private cueText = "";
  private cueId?: string;
  private readonly consumedCues = new Set<string>();
  private readonly pager = new AnswerPager((text) => {
    if (text) this.clearCue();
    this.currentFrame = [answerPanel(text || this.cueText)];
    this.schedule();
  });

  public constructor(
    private readonly bridge: GlassesRenderBridge,
    private readonly options: GlassesRendererOptions = {},
  ) {
    this.debounceMs = Math.max(MIN_RENDER_DEBOUNCE_MS, options.debounceMs ?? MIN_RENDER_DEBOUNCE_MS);
  }

  public initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    const generation = this.generation;
    const operation = this.createPage(generation).finally(() => {
      if (this.initializing === operation) this.initializing = undefined;
    });
    this.initializing = operation;
    return operation;
  }

  private async createPage(generation: number): Promise<void> {
    const frame = this.currentFrame;
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: frame.length,
        textObject: frame.map((panel) => new TextContainerProperty(panel)),
        menuObject: new MenuContainerProperty({ menuItems: SHORTCUT_ACTIONS.map(item => new MenuItemProperty(item)) }),
      }),
    );
    if (generation !== this.generation) return;
    if (result !== StartUpPageCreateResult.success) {
      throw new Error(`G2 startup page creation failed with result ${result}`);
    }
    this.initialized = true;
    this.lastRendered.clear();
    for (const panel of frame) this.lastRendered.set(panel.containerID, panel.content);
    this.schedule();
  }

  public render(state: GlassesConversationState): void {
    this.pager.update(answerVisible(state) ? state.answer : undefined, state.answerResetRevision);
    const eligible = answerVisible(state) && !state.manualPending && !state.answer?.streaming && !this.pager.text;
    if (!eligible || state.cue?.id !== this.cueId) this.clearCue();
    if (state.cue && !this.consumedCues.has(state.cue.id)) {
      this.consumedCues.add(state.cue.id);
      if (this.consumedCues.size > 200) this.consumedCues.delete(this.consumedCues.values().next().value!);
      if (eligible) {
        this.cueId = state.cue.id; this.cueText = paginateAnswer(state.cue.text)[0] ?? "";
        this.cueTimer = setTimeout(() => { this.clearCue(); this.currentFrame = [answerPanel(this.pager.text)]; this.schedule(); }, 8000);
      }
    }
    this.currentFrame = [answerPanel(this.pager.text || this.cueText)]; this.schedule();
  }

  private clearCue(): void { clearTimeout(this.cueTimer); this.cueTimer = undefined; this.cueText = ""; this.cueId = undefined; }

  private schedule(): void {
    if (!this.initialized || this.timer || this.inFlight || !this.hasChanges()) return;
    this.timer = globalThis.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, Math.max(this.debounceMs, this.blockedUntil - Date.now()));
  }

  public flush(): Promise<void> {
    if (this.timer) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) return this.inFlight;
    if (!this.initialized || !this.hasChanges()) return Promise.resolve();
    const operation = this.updateFrame(this.generation).finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
      this.schedule();
    });
    this.inFlight = operation;
    return operation;
  }

  private hasChanges(): boolean {
    return this.currentFrame.some((panel) => this.lastRendered.get(panel.containerID) !== panel.content);
  }

  private async updateFrame(generation: number): Promise<void> {
    const frame = this.currentFrame;
    try {
      for (const panel of frame) {
        if (!this.initialized || generation !== this.generation) return;
        if (this.lastRendered.get(panel.containerID) === panel.content) continue;
        const updated = await withDeadline(this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: panel.containerID,
            containerName: panel.containerName,
            content: panel.content,
          }),
        ), TEXT_WRITE_DEADLINE_MS, `${panel.containerName} text update`);
        if (generation !== this.generation) return;
        this.timeouts = 0;
        if (!updated) throw new Error(`G2 rejected the ${panel.containerName} text update`);
        this.lastRendered.set(panel.containerID, panel.content);
      }
    } catch (error) {
      if (generation === this.generation) {
        // Unanswered: wait before the next write so retries do not pile up in a backed-up host.
        if (error instanceof BridgeTimeoutError) this.blockedUntil = Date.now() + writeTimeoutBackoff(++this.timeouts);
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  public dispose(): void {
    this.clearCue();
    this.initialized = false;
    this.pager.dispose();
    if (this.timer) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
    this.initialized = false;
    this.initializing = undefined;
    this.generation += 1;
  }
}

export interface GlassesDashboardPanel extends Omit<TextContainerProperty, "toJson"> {
  readonly containerID: number;
  readonly containerName: string;
  readonly content: string;
}

/** Exactly one full-canvas event capture region, including while visually blank. */
function answerPanel(text: string): GlassesDashboardPanel {
  return {
    containerID: GLASSES_CONTAINER_ID, containerName: GLASSES_CONTAINER_NAME,
    xPosition: 4, yPosition: 4, width: 568, height: 280,
    content: text || " ", textColor: 4, borderWidth: 0, borderColor: 0,
    borderRadius: 0, paddingLength: 0, isEventCapture: 1,
  };
}

function answerVisible(state: GlassesConversationState): boolean {
  return !state.error && !["failed", "error", "stopped", "exited", "ready", "starting", "connecting", "authorizing"].includes(state.status);
}

/** Stateless first-page export; GlassesRenderer owns timed reading state. */
export function buildGlassesDashboard(state: GlassesConversationState): GlassesDashboardPanel[] {
  return [answerPanel(formatGlassesState(state))];
}

export function formatGlassesState(state: GlassesConversationState): string {
  return answerVisible(state) ? paginateAnswer(state.answer?.text ?? "")[0] ?? "" : "";
}
