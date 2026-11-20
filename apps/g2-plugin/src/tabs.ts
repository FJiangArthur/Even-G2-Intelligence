import type { CompanionTab } from "./presentation";
import type { IconName } from "./pixel-art";

export interface TabDefinition { readonly id: CompanionTab; readonly label: string; readonly icon: IconName }

/** Order is the visual order of the tab bar. v0.8 adds People and Knowledge; Setup moves last. */
export const TAB_DEFINITIONS: readonly TabDefinition[] = [
  { id: "answers", label: "Answers", icon: "bubble" },
  { id: "concepts", label: "Concepts", icon: "bulb" },
  { id: "summary", label: "Summary", icon: "scroll" },
  { id: "qa", label: "Q&A", icon: "question" },
  { id: "checks", label: "Checks", icon: "shield" },
  { id: "people", label: "People", icon: "people" },
  { id: "history", label: "History", icon: "clock" },
  { id: "knowledge", label: "Knowledge", icon: "database" },
  { id: "setup", label: "Setup", icon: "gear" },
];

/** WAI-ARIA tabs keyboard model: arrows wrap, Home/End jump. */
export function tabFromKey(current: CompanionTab, key: string): CompanionTab | undefined {
  const index = TAB_DEFINITIONS.findIndex(tab => tab.id === current);
  const last = TAB_DEFINITIONS.length - 1;
  const next = key === "ArrowRight" ? (index + 1) % TAB_DEFINITIONS.length
    : key === "ArrowLeft" ? (index - 1 + TAB_DEFINITIONS.length) % TAB_DEFINITIONS.length
      : key === "Home" ? 0 : key === "End" ? last : undefined;
  return next === undefined ? undefined : TAB_DEFINITIONS[next]!.id;
}

/** Glasses HUD view -> phone tab, used when the phone follows ring/temple operations. */
export function defaultTabForHudView(view: string | undefined): CompanionTab | undefined {
  switch ((view ?? "").toLowerCase()) {
    case "live": case "answer": case "answers": return "answers";
    case "qa": case "q&a": case "ask": return "qa";
    case "concepts": return "concepts";
    case "summary": return "summary";
    case "checks": case "claims": case "verify": return "checks";
    case "people": return "people";
    case "history": return "history";
    default: return undefined;
  }
}

/**
 * Mirror-follow rule: switch the phone tab only when a glasses gesture (ring/temple, not a
 * phone-initiated view change or a lifecycle re-push) changed the HUD view or gesture since the
 * last mirror seen, the wearer has not touched the phone in `idleMs`, and the tab differs.
 * Content-only updates (new captions, answer text) keep lastGesture and never move the phone.
 */
export function shouldFollowHud(input: {
  readonly hud?: { readonly view: string; readonly updatedAt: number; readonly lastGesture?: string };
  readonly previous?: { readonly view: string; readonly lastGesture?: string };
  readonly lastTouchAt: number;
  readonly now: number;
  readonly currentTab: CompanionTab;
  readonly target: CompanionTab | undefined;
  readonly idleMs?: number;
}): boolean {
  const { hud, target, previous } = input;
  if (!hud?.lastGesture || !target) return false;
  if (/^phone:|^repush$/u.test(hud.lastGesture)) return false;
  if (previous && previous.view === hud.view && previous.lastGesture === hud.lastGesture) return false;
  if (input.now - input.lastTouchAt < (input.idleMs ?? 8000)) return false;
  return target !== input.currentTab;
}
