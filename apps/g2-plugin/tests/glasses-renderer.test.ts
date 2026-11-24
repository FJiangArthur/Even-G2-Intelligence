import {
  StartUpPageCreateResult,
  ImageRawDataUpdateResult,
  type CreateStartUpPageContainer,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GLASSES_CONTAINER_NAME,
  GlassesRenderer,
  buildGlassesDashboard,
  formatGlassesState,
  type GlassesRenderBridge,
} from "../src/glasses-renderer";

class FakeBridge implements GlassesRenderBridge {
  public readonly creates: CreateStartUpPageContainer[] = [];
  public readonly updates: TextContainerUpgrade[] = [];

  public async createStartUpPageContainer(
    container: CreateStartUpPageContainer,
  ): Promise<StartUpPageCreateResult> {
    this.creates.push(container);
    return StartUpPageCreateResult.success;
  }

  public async textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean> {
    this.updates.push(container);
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("G2 glasses renderer", () => {
  it("never overlays a visible answer or replays a dropped cue after answer expiry", async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge(), renderer = new GlassesRenderer(bridge); await renderer.initialize();
    const answer = { id: "answer", text: "Manual answer", streaming: false };
    const cue = { id: "during-answer", text: "Do not show" };
    renderer.render({ status: "listening", answer, cue }); await renderer.flush();
    expect(bridge.updates.at(-1)?.content?.trim()).toBe("Manual answer"); // v0.16: complete pages are centred
    await vi.advanceTimersByTimeAsync(8000); await renderer.flush();
    renderer.render({ status: "listening", answer, cue }); await renderer.flush();
    expect(bridge.updates.at(-1)?.content?.trim()).toBe("");
    renderer.render({ status: "listening", answer, cue: { id: "fresh", text: "Fresh idle insight" } }); await renderer.flush();
    expect(bridge.updates.at(-1)?.content?.trim()).toBe("Fresh idle insight");
    renderer.render({ status: "listening", manualPending: true }); await renderer.flush();
    await vi.advanceTimersByTimeAsync(9000); await renderer.flush();
    expect(bridge.updates.at(-1)?.content?.trim()).toBe(""); renderer.dispose();
  });
  it("registers native shortcuts on every startup page", async () => {
    const bridge = new FakeBridge(), renderer = new GlassesRenderer(bridge);
    await renderer.initialize(); renderer.dispose(); await renderer.initialize();
    for (const page of bridge.creates) {
      expect(page.menuObject?.menuItems?.map(item => item.itemID)).toEqual([1, 2, 3, 4, 5]);
      for (const item of page.menuObject!.menuItems!) expect(new TextEncoder().encode(item.itemName).length).toBeLessThan(32);
    }
    renderer.dispose();
  });
  it("shows a cue for eight seconds, drops busy cues permanently and clears on disconnect", async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge(), renderer = new GlassesRenderer(bridge);
    await renderer.initialize();
    const cue = { id: "c", text: "RAG: Retrieval." };
    renderer.render({ status: "listening", cue }); await renderer.flush();
    expect(bridge.updates.at(-1)?.content?.trim()).toBe("RAG: Retrieval."); // v0.16: a cue is centred
    await vi.advanceTimersByTimeAsync(8000); await renderer.flush();
    expect(bridge.updates.at(-1)?.content?.trim()).toBe("");
    renderer.render({ status: "listening", cue }); await renderer.flush();
    expect(bridge.updates.at(-1)?.content?.trim()).toBe("");
    renderer.render({ status: "listening", cue: { id: "busy", text: "Dropped" }, manualPending: true });
    renderer.render({ status: "listening", cue: { id: "busy", text: "Dropped" } }); await renderer.flush();
    expect(bridge.updates.at(-1)?.content?.trim()).toBe("");
    renderer.render({ status: "listening", cue: { id: "next", text: "Next" } }); await renderer.flush();
    renderer.render({ status: "stopped" }); await renderer.flush();
    expect(bridge.updates.at(-1)?.content?.trim()).toBe(""); renderer.dispose();
  });
  it("creates one full-width, borderless, visually blank event container and no image", async () => {
    const bridge = Object.assign(new FakeBridge(), { updateImageRawData: vi.fn(async () => ImageRawDataUpdateResult.success) });
    const renderer = new GlassesRenderer(bridge);
    await renderer.initialize();
    expect(new TextEncoder().encode(GLASSES_CONTAINER_NAME).length).toBeLessThanOrEqual(16);
    expect(bridge.creates[0]).toMatchObject({
      containerTotalNum: 1,
      textObject: [{ containerID: 1, xPosition: 4, yPosition: 4, width: 568, height: 280,
        paddingLength: 0, borderWidth: 0, isEventCapture: 1, content: " " }],
    });
    expect(bridge.creates[0]?.imageObject).toBeUndefined();
    expect(bridge.updateImageRawData).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("keeps transcripts, questions, notes, errors and idle cues off glasses", () => {
    for (const state of [
      { status: "ready" }, { status: "paused" }, { status: "listening", transcript: { text: "Private", final: false } },
      { status: "listening", question: { text: "Private?" } },
      { status: "listening", note: { id: "n", text: "Private", delivery: "session" as const } },
      { status: "failed", error: "Provider detail", answer: { text: "Stale answer", streaming: false } },
    ]) {
      expect(formatGlassesState(state)).toBe("");
      expect(buildGlassesDashboard(state)).toHaveLength(1);
      expect(buildGlassesDashboard(state)[0]?.content.trim()).toBe("");
    }
  });

  it("hides completed answers without transcript revival and clears failure immediately", async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge(), renderer = new GlassesRenderer(bridge);
    await renderer.initialize();
    const answer = { id: "a", text: "Read this answer.", streaming: false };
    renderer.render({ status: "listening", answer });
    await renderer.flush();
    await vi.advanceTimersByTimeAsync(8120);
    expect(bridge.updates.at(-1)?.content).toBe(" ");
    const count = bridge.updates.length;
    renderer.render({ status: "paused", answer, transcript: { text: "New transcript", final: true } });
    await renderer.flush();
    expect(bridge.updates).toHaveLength(count);
    renderer.render({ status: "listening", answer: { ...answer, id: "b" } });
    await renderer.flush();
    renderer.render({ status: "failed", answer: { ...answer, id: "b" }, error: "Failed" });
    await renderer.flush();
    expect(bridge.updates.at(-1)?.content).toBe(" ");
    renderer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });



  it("coalesces rapid state changes and never writes faster than 120ms", async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const renderer = new GlassesRenderer(bridge, { debounceMs: 1 });
    await renderer.initialize();

    renderer.render({ status: "hearing", transcript: { text: "First", speaker: "Speaker", final: false } });
    renderer.render({ status: "answering", answer: { text: "Latest answer", streaming: true } });

    await vi.advanceTimersByTimeAsync(119);
    expect(bridge.updates).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.updates.filter((update) => update.containerID === 1)).toHaveLength(1);
    expect(bridge.updates[0]?.content).toContain("Latest answer");
    expect(bridge.updates[0]?.content).not.toContain("First");
  });






  it("only changes the answer panel for a streaming token and skips identical frames", async () => {
    const bridge = new FakeBridge();
    const renderer = new GlassesRenderer(bridge);
    renderer.render({ status: "answering", answer: { text: "First", streaming: true } });
    await renderer.initialize();
    renderer.render({ status: "answering", answer: { text: "First token", streaming: true } });
    await renderer.flush();
    expect(bridge.updates).toHaveLength(1);
    expect(bridge.updates[0]?.containerID).toBe(1);
    renderer.render({ status: "answering", answer: { text: "First token", streaming: true } });
    await renderer.flush();
    expect(bridge.updates).toHaveLength(1);
    renderer.dispose();
  });

  it("keeps renders received during startup instead of marking them already delivered", async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    let finish!: (result: StartUpPageCreateResult) => void;
    vi.spyOn(bridge, "createStartUpPageContainer").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const renderer = new GlassesRenderer(bridge);
    const startup = renderer.initialize();
    expect(renderer.initialize()).toBe(startup);
    renderer.render({ status: "answering", answer: { text: "Arrived during startup", streaming: true } });
    finish(StartUpPageCreateResult.success);
    await startup;
    await vi.advanceTimersByTimeAsync(120);
    expect(bridge.updates[0]?.content).toBe("Arrived during startup");
    renderer.dispose();
  });

  it("serializes bridge writes and delivers the newest streaming frame after a slow write", async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const renderer = new GlassesRenderer(bridge);
    renderer.render({ status: "answering", answer: { text: "Start", streaming: true } });
    await renderer.initialize();
    let finish!: (updated: boolean) => void;
    const update = vi.spyOn(bridge, "textContainerUpgrade");
    update.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderer.render({ status: "answering", answer: { text: "Older", streaming: true } });
    const first = renderer.flush();
    renderer.render({ status: "answering", answer: { text: "Newest", streaming: true } });
    expect(renderer.flush()).toBe(first);
    expect(update).toHaveBeenCalledTimes(1);
    finish(true);
    await first;
    await vi.advanceTimersByTimeAsync(120);
    expect(update).toHaveBeenCalledTimes(2);
    expect(bridge.updates[0]?.content).toBe("Newest");
    renderer.dispose();
  });

  it("retries the single rejected answer panel", async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const onError = vi.fn();
    const renderer = new GlassesRenderer(bridge, { onError });
    await renderer.initialize();
    const update = vi.spyOn(bridge, "textContainerUpgrade");
    update.mockResolvedValueOnce(false);
    renderer.render({ status: "answering", answer: { text: "Answer", streaming: true } });
    await renderer.flush();
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120);
    expect(update.mock.calls.filter(([panel]) => panel.containerID === 1)).toHaveLength(2);
    renderer.dispose();
  });

  it("does not revive or update the page when disposal happens during startup", async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    let finish!: (result: StartUpPageCreateResult) => void;
    vi.spyOn(bridge, "createStartUpPageContainer").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const renderer = new GlassesRenderer(bridge);
    const startup = renderer.initialize();
    renderer.dispose();
    finish(StartUpPageCreateResult.success);
    await startup;
    renderer.render({ status: "listening" });
    await renderer.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.updates).toHaveLength(0);
  });

  it("stops the remaining panel writes and retry timer when disposed during an update", async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const onError = vi.fn();
    const renderer = new GlassesRenderer(bridge, { onError });
    await renderer.initialize();
    let finish!: (updated: boolean) => void;
    const update = vi.spyOn(bridge, "textContainerUpgrade");
    update.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderer.render({ status: "listening", answer: { id: "a", text: "Answer", streaming: true } });
    const flushing = renderer.flush();
    renderer.dispose();
    finish(false);
    await flushing;
    await vi.advanceTimersByTimeAsync(1000);
    expect(update).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });


});
