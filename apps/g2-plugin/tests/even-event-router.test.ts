import {
  AudioEvent,
  AudioInputSource,
  AudioSpeakerRole,
  OsEventTypeList,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { describe, expect, it, vi } from "vitest";
import {
  eventTypeOf,
  pcmS16LeBytesToSamples,
  routeEvenHubEvent,
  type EvenEventHandlers,
} from "../src/even-event-router";

function handlers(): EvenEventHandlers {
  return {
    onAudio: vi.fn(),
    onClick: vi.fn(),
    onHold: vi.fn(),
    onCommit: vi.fn(),
    onDoubleClick: vi.fn(),
    onExit: vi.fn(),
    onMenu: vi.fn(),
    onForeground: vi.fn(),
  };
}

function event(value: object): EvenHubEvent {
  return value as EvenHubEvent;
}

describe("Even Hub event routing", () => {
  it("routes known menu IDs before omitted clicks, ignores unknown IDs, and gives system exit priority", () => {
    const actions = handlers();
    expect(routeEvenHubEvent(event({ menuItemClickEvent: { itemID: 1 }, textEvent: {} }), actions)).toBe("menu");
    expect(actions.onMenu).toHaveBeenCalledWith(1);
    expect(actions.onClick).not.toHaveBeenCalled();
    expect(routeEvenHubEvent(event({ menuItemClickEvent: { itemID: 99 }, textEvent: {} }), actions)).toBe("ignored");
    routeEvenHubEvent(event({ menuItemClickEvent: { itemID: 2 }, sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } }), actions);
    expect(actions.onMenu).toHaveBeenCalledTimes(1); expect(actions.onExit).toHaveBeenCalledOnce();
  });
  it.each([OsEventTypeList.FOREGROUND_ENTER_EVENT, OsEventTypeList.FOREGROUND_EXIT_EVENT])("handles foreground overlay %s without exiting or clicking", eventType => {
    const actions = handlers();
    expect(routeEvenHubEvent(event({ sysEvent: { eventType }, textEvent: {} }), actions)).toBe("foreground");
    expect(actions.onForeground).toHaveBeenCalledOnce(); expect(actions.onClick).not.toHaveBeenCalled(); expect(actions.onExit).not.toHaveBeenCalled();
  });
  it.each([
    [OsEventTypeList.SYSTEM_EXIT_EVENT, "exit", "onExit"],
    [OsEventTypeList.ABNORMAL_EXIT_EVENT, "exit", "onExit"],
    [OsEventTypeList.LONG_PRESS_EVENT, "hold", "onHold"],
    [OsEventTypeList.LONG_PRESS_RELEASE_EVENT, "commit", "onCommit"],
  ] as const)("prioritizes explicit event %s over an empty click envelope", (eventType, expected, callback) => {
    const actions = handlers();
    expect(routeEvenHubEvent(event({ sysEvent: { eventType }, textEvent: {} }), actions)).toBe(expected);
    expect(actions[callback]).toHaveBeenCalledOnce();
    expect(actions.onClick).not.toHaveBeenCalled();
  });
  it("resolves omitted CLICK_EVENT=0 only inside an existing envelope", () => {
    expect(eventTypeOf(undefined)).toBeNull();
    expect(eventTypeOf({})).toBe(OsEventTypeList.CLICK_EVENT);

    const actions = handlers();
    expect(routeEvenHubEvent(event({ audioEvent: undefined }), actions)).toBe("ignored");
    expect(actions.onClick).not.toHaveBeenCalled();

    expect(routeEvenHubEvent(event({ sysEvent: { eventSource: 1 } }), actions)).toBe("click");
    expect(actions.onClick).toHaveBeenCalledOnce();
  });

  it("routes PCM independently without turning audio frames into taps", () => {
    const audio = new AudioEvent({
      audioPcm: new Uint8Array([0x34, 0x12]),
      source: AudioInputSource.Glasses,
      direction: -12,
      speakerRole: AudioSpeakerRole.Other,
    });
    const actions = handlers();

    expect(routeEvenHubEvent(event({ audioEvent: audio }), actions)).toBe("audio");
    expect(actions.onAudio).toHaveBeenCalledWith(audio);
    expect(actions.onClick).not.toHaveBeenCalled();
    expect(actions.onDoubleClick).not.toHaveBeenCalled();
  });

  it("checks double-click before the zero-valued click fallback", () => {
    const actions = handlers();
    const result = routeEvenHubEvent(event({
      sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT },
      textEvent: {},
    }), actions);

    expect(result).toBe("double-click");
    expect(actions.onDoubleClick).toHaveBeenCalledOnce();
    expect(actions.onClick).not.toHaveBeenCalled();
  });

  it("routes long-press release to an utterance commit and system exit to cleanup", () => {
    const actions = handlers();
    expect(routeEvenHubEvent(event({
      textEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT },
    }), actions)).toBe("commit");
    expect(actions.onCommit).toHaveBeenCalledOnce();

    expect(routeEvenHubEvent(event({
      sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT },
    }), actions)).toBe("exit");
    expect(actions.onExit).toHaveBeenCalledOnce();
  });

  it("routes swipe up/down (SCROLL_TOP=1 / SCROLL_BOTTOM=2) as explicit gestures, never as omitted clicks", () => {
    const actions = { ...handlers(), onScrollUp: vi.fn(), onScrollDown: vi.fn() };
    // Simulator 0.9.5 payload shape for "up" and "down" on the capture container.
    expect(routeEvenHubEvent(event({ textEvent: { containerID: 2, containerName: "hud-body", eventType: OsEventTypeList.SCROLL_TOP_EVENT } }), actions)).toBe("scroll-up");
    expect(routeEvenHubEvent(event({ textEvent: { containerID: 2, containerName: "hud-body", eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }), actions)).toBe("scroll-down");
    // An explicit swipe wins over a sibling envelope whose omitted type defaults to click.
    expect(routeEvenHubEvent(event({ sysEvent: {}, textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }), actions)).toBe("scroll-down");
    expect(routeEvenHubEvent(event({ sysEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } }), actions)).toBe("scroll-up");
    expect(actions.onScrollUp).toHaveBeenCalledTimes(2);
    expect(actions.onScrollDown).toHaveBeenCalledTimes(2);
    expect(actions.onClick).not.toHaveBeenCalled();
    // Lifecycle still wins over a swipe in the same event.
    expect(routeEvenHubEvent(event({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT }, textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } }), actions)).toBe("exit");
    expect(actions.onScrollUp).toHaveBeenCalledTimes(2);
  });

  it("forwards audio alongside a swipe and ignores swipes when no handler is registered", () => {
    const audio = new AudioEvent({ audioPcm: new Uint8Array([1, 0]), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Self });
    const withSwipes = { ...handlers(), onScrollDown: vi.fn() };
    expect(routeEvenHubEvent(event({ audioEvent: audio, textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }), withSwipes)).toBe("scroll-down");
    expect(withSwipes.onAudio).toHaveBeenCalledWith(audio);
    const legacy = handlers();
    expect(routeEvenHubEvent(event({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } }), legacy)).toBe("ignored");
    expect(legacy.onClick).not.toHaveBeenCalled();
  });

  it("routes MENU list clicks (simulator payloads; index 0 omitted) to onListSelect, list double/hold as usual", () => {
    const actions = { ...handlers(), onListSelect: vi.fn(), onScrollDown: vi.fn() };
    // Simulator 0.9.5: { listEvent: { containerID, containerName, currentSelectItemIndex? } }, eventType omitted (CLICK).
    expect(routeEvenHubEvent(event({ listEvent: { containerID: 4, containerName: "hud-menu", currentSelectItemIndex: 2 } }), actions)).toBe("list-select");
    expect(actions.onListSelect).toHaveBeenLastCalledWith(2, undefined);
    expect(routeEvenHubEvent(event({ listEvent: { containerID: 4, containerName: "hud-menu" } }), actions)).toBe("list-select");
    expect(actions.onListSelect).toHaveBeenLastCalledWith(0, undefined);
    expect(routeEvenHubEvent(event({ listEvent: { currentSelectItemIndex: 1, currentSelectItemName: "Answer whole conversation" } }), actions)).toBe("list-select");
    expect(actions.onListSelect).toHaveBeenLastCalledWith(1, "Answer whole conversation");
    expect(actions.onClick).not.toHaveBeenCalled();
    expect(routeEvenHubEvent(event({ listEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }), actions)).toBe("double-click");
    expect(routeEvenHubEvent(event({ listEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } }), actions)).toBe("hold");
    expect(routeEvenHubEvent(event({ listEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }), actions)).toBe("scroll-down");
    expect(actions.onListSelect).toHaveBeenCalledTimes(3);
    // Without a list handler a list click stays a plain click (v0.7 behavior).
    const legacy = handlers();
    expect(routeEvenHubEvent(event({ listEvent: { currentSelectItemIndex: 3 } }), legacy)).toBe("click");
    expect(legacy.onClick).toHaveBeenCalledOnce();
  });

  it("tells foreground enter from exit and system exit from abnormal exit", () => {
    const actions = handlers();
    routeEvenHubEvent(event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } }), actions);
    routeEvenHubEvent(event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } }), actions);
    expect(vi.mocked(actions.onForeground).mock.calls).toEqual([["enter"], ["exit"]]);
    routeEvenHubEvent(event({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } }), actions);
    routeEvenHubEvent(event({ sysEvent: { eventType: OsEventTypeList.ABNORMAL_EXIT_EVENT } }), actions);
    expect(vi.mocked(actions.onExit).mock.calls).toEqual([["system"], ["abnormal"]]);
  });

  it("decodes unaligned PCM bytes as signed little-endian samples", () => {
    const backing = new Uint8Array([0xff, 0x00, 0x80, 0xff, 0x7f, 0xee]);
    const samples = pcmS16LeBytesToSamples(backing.subarray(1, 5));
    expect([...samples]).toEqual([-32768, 32767]);
  });
});
