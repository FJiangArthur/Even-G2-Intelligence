import {
  OsEventTypeList,
  type AudioEvent,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { SHORTCUT_ACTIONS, type ShortcutActionId } from "./shortcut-actions";

type EventEnvelope = { readonly eventType?: OsEventTypeList };

export interface EvenEventHandlers {
  readonly onAudio: (audio: AudioEvent) => void;
  readonly onClick: () => void;
  readonly onHold: () => void;
  readonly onCommit: () => void;
  readonly onDoubleClick: () => void;
  /** SYSTEM_EXIT (the wearer closed the app) or ABNORMAL_EXIT. */
  readonly onExit: (kind?: "system" | "abnormal") => void;
  readonly onMenu: (id: ShortcutActionId) => void;
  /** OS foreground layer (native context menu, system UI) entered/exited over the app. */
  readonly onForeground: (kind?: "enter" | "exit") => void;
  /** Swipe up (SCROLL_TOP_EVENT=1): previous page/view on the glasses HUD. */
  readonly onScrollUp?: () => void;
  /** Swipe down (SCROLL_BOTTOM_EVENT=2): next page/view on the glasses HUD. */
  readonly onScrollDown?: () => void;
  /**
   * Click on the glasses MENU list container (listEvent). The firmware moves the highlight
   * itself and reports only the click; index 0 is omitted on the wire (simulator 0.9.5).
   * Without this handler a list click falls back to onClick.
   */
  readonly onListSelect?: (index: number, name?: string) => void;
}

export type RoutedEvent = "audio" | "click" | "double-click" | "hold" | "commit" | "exit" | "ignored" | "menu" | "foreground"
  | "scroll-up" | "scroll-down" | "list-select";

/**
 * CLICK_EVENT has protobuf value zero and is omitted on the wire. Resolve that
 * default only after proving the containing event envelope exists.
 */
export function eventTypeOf(envelope?: EventEnvelope): OsEventTypeList | null {
  if (!envelope) return null;
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT;
}

export function routeEvenHubEvent(
  event: EvenHubEvent,
  handlers: EvenEventHandlers,
): RoutedEvent {
  const audio = event.audioEvent;
  const sysType = eventTypeOf(event.sysEvent);
  const textType = eventTypeOf(event.textEvent);
  const listType = eventTypeOf(event.listEvent);
  const types = [sysType, textType, listType];
  // Lifecycle and explicit gestures win over protobuf's omitted zero click.
  if (types.includes(OsEventTypeList.SYSTEM_EXIT_EVENT) || types.includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
    handlers.onExit(types.includes(OsEventTypeList.SYSTEM_EXIT_EVENT) ? "system" : "abnormal");
    return "exit";
  }
  if (event.menuItemClickEvent) {
    if (audio?.audioPcm.byteLength) handlers.onAudio(audio);
    const id = event.menuItemClickEvent.itemID;
    if (!SHORTCUT_ACTIONS.some(action => action.itemID === id)) { handlers.onForeground(); return "ignored"; }
    handlers.onMenu(id as ShortcutActionId);
    return "menu";
  }
  if (types.includes(OsEventTypeList.FOREGROUND_ENTER_EVENT) || types.includes(OsEventTypeList.FOREGROUND_EXIT_EVENT)) {
    if (audio?.audioPcm.byteLength) handlers.onAudio(audio);
    handlers.onForeground(types.includes(OsEventTypeList.FOREGROUND_ENTER_EVENT) ? "enter" : "exit");
    return "foreground";
  }

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT
    || textType === OsEventTypeList.DOUBLE_CLICK_EVENT
    || listType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    handlers.onDoubleClick();
    return "double-click";
  }

  if (
    types.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)
  ) {
    if (audio?.audioPcm.byteLength) handlers.onAudio(audio);
    handlers.onCommit();
    return "commit";
  }
  if (types.includes(OsEventTypeList.LONG_PRESS_EVENT)) {
    handlers.onHold();
    if (audio?.audioPcm.byteLength) handlers.onAudio(audio);
    return "hold";
  }
  if (audio?.audioPcm.byteLength) handlers.onAudio(audio);
  if (listType === OsEventTypeList.CLICK_EVENT) {
    // Simulator-verified: { listEvent: { containerID, containerName, currentSelectItemIndex? } }.
    const list = event.listEvent!;
    const index = Number.isInteger(list.currentSelectItemIndex) && list.currentSelectItemIndex! >= 0 ? list.currentSelectItemIndex! : 0;
    if (!handlers.onListSelect) { handlers.onClick(); return "click"; }
    handlers.onListSelect(index, list.currentSelectItemName || undefined);
    return "list-select";
  }
  // Swipes are explicit, non-zero types, so they can never be an omitted click.
  // The capture container must not overflow, or the firmware scrolls it instead.
  if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) {
    if (!handlers.onScrollUp) return "ignored";
    handlers.onScrollUp();
    return "scroll-up";
  }
  if (types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
    if (!handlers.onScrollDown) return "ignored";
    handlers.onScrollDown();
    return "scroll-down";
  }
  if (types.includes(OsEventTypeList.CLICK_EVENT)) {
    handlers.onClick();
    return "click";
  }

  return audio?.audioPcm.byteLength ? "audio" : "ignored";
}

export function pcmS16LeBytesToSamples(bytes: Uint8Array): Int16Array {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const samples = new Int16Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}
