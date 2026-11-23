/** v0.15 phone UI cost: cheap signatures, hidden panels, bounded paragraphs, mirror reuse, slim memory sources. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerMeta, DirectConversationOptions, HistoryEntry, HistorySession, HudMirror, RetrievedMemory, Speaker, TranscriptFinalEvent, TranscriptPartialEvent } from "@helix/conversation-sdk";
import { WebSocketConversationTransport } from "@helix/conversation-sdk";
import { G2ConversationController } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { renderGlassesMirror } from "../src/glasses-mirror";
import { ConversationPresentation, feedBlocks, type FeedItem, type PresentationSnapshot } from "../src/presentation";
import { PanelGate, feedItemSignature, panelSignature, shouldPaintMirror } from "../src/ui";
import { FakeBridge, FakeWebSocket, form } from "./controller-fakes";

afterEach(() => { vi.unstubAllGlobals(); FakeWebSocket.latest = undefined; });

const ctx = (label: string, role: Speaker["role"]) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  speaker: { label, role }, latencyMs: { totalMs: 10 },
});
const base = { protocolVersion: "2.1" as const, sessionId: "s" };
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 8, 20, 0, 0) + seconds * 1000).toISOString();
const final = (id: string, text: string, seconds = 0, label = "Other speaker", role: Speaker["role"] = "other") =>
  ({ ...base, occurredAt: at(seconds), type: "transcript.final", eventId: `e-${id}`, transcriptId: id, text, context: ctx(label, role) }) as TranscriptFinalEvent;
const partial = (text: string, seconds = 0) =>
  ({ ...base, occurredAt: at(seconds), type: "transcript.partial", eventId: "e-p", transcriptId: "p", revision: 1, text, context: ctx("Other speaker", "other") }) as TranscriptPartialEvent;
function live(): ConversationPresentation { const p = new ConversationPresentation(); p.setStatus("listening"); return p; }

const session = (id: string): HistorySession => ({
  id, source: "omi", title: `Session ${id}`, startedAt: at(0), updatedAt: at(60),
  summary: ["long summary ".repeat(30)], keyFacts: ["fact ".repeat(80)], concepts: ["RAG"], overview: "overview",
  todos: [{ id: "todo", text: "Send quote" }] as unknown as HistorySession["todos"],
});
const memory = (id: string): RetrievedMemory => ({
  entry: { id: `${id}:e1`, sessionId: id, kind: "transcript", text: "The budget is 40k.", occurredAt: at(0), speaker: "Mei" } as HistoryEntry,
  session: session(id), score: 0.8,
});

describe("finding 17: feed card signature does not re-serialize unchanged sources and meta", () => {
  it("serializes each sources / memorySources / meta object once across renders", () => {
    let serialized = 0;
    const counted = <T extends object>(value: T): T => Object.defineProperty(value, "toJSON", { enumerable: false, value: () => { serialized++; return Array.isArray(value) ? [...value] : { ...value }; } });
    const memorySources = counted([memory("one")]);
    const sources = counted([{ url: "https://example.com/a", title: "A" }]);
    const meta = counted({ answerId: "a1", grounded: true } as unknown as AnswerMeta);
    const item: FeedItem = { id: "a1", kind: "answer", label: "Helix · answer", body: "Forty thousand.", memorySources, sources };
    const first = feedItemSignature(item, meta);
    expect(serialized).toBe(3);
    // The snapshot copies feed items shallowly, so the arrays keep their identity between renders.
    expect(feedItemSignature({ ...item }, meta)).toBe(first);
    expect(feedItemSignature({ ...item }, meta)).toBe(first);
    expect(serialized).toBe(3);
  });

  it("keeps the exact signature and still changes with the content", () => {
    const item: FeedItem = { id: "a1", kind: "answer", label: "Helix · answer", body: "Forty thousand.", sources: [{ url: "https://example.com/a", title: "A" }] };
    const meta = { answerId: "a1", grounded: true } as unknown as AnswerMeta;
    const signature = feedItemSignature(item, meta);
    expect(signature).toContain(JSON.stringify(item.sources));
    expect(signature).toContain(JSON.stringify(meta));
    expect(feedItemSignature({ id: "x", kind: "note", label: "Note", body: "b" })).toBe(["note", "", "Note", "b", "", "settled", "[]", "[]", ""].join("\u001f"));
    expect(feedItemSignature({ ...item, sources: [{ url: "https://example.com/b", title: "B" }] }, meta)).not.toBe(signature);
    expect(feedItemSignature(item, { ...meta, grounded: false } as unknown as AnswerMeta)).not.toBe(signature);
    expect(feedItemSignature({ ...item, body: "Fifty." }, meta)).not.toBe(signature);
  });
});

describe("finding 18: hidden copilot panels", () => {
  const withConcept = () => {
    const p = live();
    p.apply(final("t1", "We're moving to CDTF."));
    p.applyConcept({ id: "c1", sessionId: "s", transcriptId: "t1", term: "CDTF", explanation: "Fusion.", origin: "copilot", createdAt: at(0) } as never);
    return p;
  };

  it("does not change the concepts signature for a new partial or a new sentence", () => {
    const p = withConcept();
    expect(p.snapshot().concepts).toHaveLength(1);
    const before = panelSignature("concepts", p.snapshot());
    p.apply(partial("and lanes"));
    expect(panelSignature("concepts", p.snapshot())).toBe(before);
    p.apply(final("t2", "and lanes stay consistent."));
    expect(panelSignature("concepts", p.snapshot())).toBe(before);
  });

  it("still changes the concepts signature when a concept arrives or its transcript line leaves the feed", () => {
    const p = withConcept();
    const before = panelSignature("concepts", p.snapshot());
    const snapshot = p.snapshot();
    expect(panelSignature("concepts", { ...snapshot, feed: snapshot.feed.filter(item => item.id !== "t1") })).not.toBe(before);
    p.applyConcept({ id: "c2", sessionId: "s", transcriptId: "t1", term: "RAG", explanation: "Retrieval.", origin: "copilot", createdAt: at(1) } as never);
    expect(panelSignature("concepts", p.snapshot())).not.toBe(before);
  });

  it("does not sign or build a panel whose tab is hidden, and builds it once when shown", () => {
    const gate = new PanelGate();
    const signature = vi.fn(() => "v1");
    expect(gate.due("concepts", false, signature)).toBe(false);
    expect(gate.due("concepts", false, signature)).toBe(false);
    expect(signature).not.toHaveBeenCalled();
    expect(gate.isStale("concepts")).toBe(true);
    expect(gate.isStale("qa")).toBe(false);
    expect(gate.due("concepts", true, signature)).toBe(true);
    expect(gate.isStale("concepts")).toBe(false);
    expect(gate.due("concepts", true, signature)).toBe(false);
    expect(gate.due("concepts", true, () => "v2")).toBe(true);
    // Hidden again with new data, then shown with the content it already has: nothing to rebuild.
    expect(gate.due("concepts", false, () => "v3")).toBe(false);
    expect(gate.due("concepts", true, () => "v2")).toBe(false);
  });
});

describe("finding 19: a single-speaker stretch is split into bounded paragraphs", () => {
  const paragraphs = (feed: readonly FeedItem[]) => feedBlocks(feed).filter(block => block.type === "paragraph");

  it("after 12 finals of one speaker, starts a new paragraph at each two-minute clock window", () => {
    const p = live();
    for (let index = 0; index < 60; index++) p.apply(final(`t${index}`, `Sentence ${index}.`, index * 10)); // 6 per minute, 10 minutes
    const blocks = paragraphs(p.snapshot().feed);
    expect(blocks.length).toBe(5);
    expect(blocks.map(block => block.segments.length)).toEqual([12, 12, 12, 12, 12]);
    expect(blocks.map(block => block.id)).toEqual(["para:t0", "para:t12", "para:t24", "para:t36", "para:t48"]);
    expect(blocks.flatMap(block => block.segments.map(segment => segment.id))).toEqual(Array.from({ length: 60 }, (_, index) => `t${index}`));
  });

  it("keeps short stretches, same-minute bursts and undated lines in one paragraph", () => {
    const short = live();
    for (let index = 0; index < 11; index++) short.apply(final(`t${index}`, `Sentence ${index}.`, index * 30));
    expect(paragraphs(short.snapshot().feed)).toHaveLength(1);
    const burst = live();
    for (let index = 0; index < 30; index++) burst.apply(final(`t${index}`, `Sentence ${index}.`, index));
    expect(paragraphs(burst.snapshot().feed)).toHaveLength(1);
    const undated: FeedItem[] = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}`, kind: "transcript" as const, label: "Speaker", body: `Sentence ${index}.` }));
    expect(paragraphs(undated)).toHaveLength(1);
  });

  it("appends the live partial to the last paragraph and does not copy the segment list per line", () => {
    const p = live();
    for (let index = 0; index < 26; index++) p.apply(final(`t${index}`, `Sentence ${index}.`, index * 10));
    p.apply(partial("and so", 270));
    const blocks = paragraphs(p.snapshot().feed);
    expect(blocks.map(block => block.segments.length)).toEqual([12, 12, 2]);
    expect(blocks.at(-1)?.partial?.body).toBe("and so");
    expect(blocks[0]?.partial).toBeUndefined();
  });
});

/* A DOM just large enough for the mirror: elements, attributes, children. */
class FakeElement {
  public static parses = 0;
  public children: FakeElement[] = [];
  public textContent = "";
  public parent?: FakeElement;
  private readonly attributes = new Map<string, string>();
  private markup = "";
  public constructor(public readonly localName: string, public readonly ownerDocument: FakeDocument) {}
  public get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  public get childElementCount(): number { return this.children.length; }
  public setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  public getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  public removeAttribute(name: string): void { this.attributes.delete(name); }
  public get innerHTML(): string { return this.markup; }
  public set innerHTML(value: string) { FakeElement.parses++; this.markup = value; }
  public append(...nodes: FakeElement[]): void { for (const node of nodes) { node.detach(); node.parent = this; this.children.push(node); } }
  public replaceChildren(...nodes: FakeElement[]): void { for (const child of this.children) child.parent = undefined; this.children = []; this.append(...nodes); }
  private detach(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; }
  public all(name: string): FakeElement[] { return this.children.filter(child => child.localName === name); }
}
class FakeDocument {
  public created: string[] = [];
  public createElementNS(_namespace: string, name: string): FakeElement { this.created.push(name); return new FakeElement(name, this); }
}
const hud = (over: Partial<HudMirror> = {}): HudMirror => ({
  view: "live", header: "Helix", title: "Helix", status: "listening", body: "First line\nSecond line", caption: "hello there", menuOpen: false, updatedAt: 1,
  images: { mascot: "mascot:listening", badge: "badge:general" }, ...over,
});

describe("finding 20: the phone mirror reuses its svg and pixel-art groups", () => {
  const mount = () => {
    const document = new FakeDocument(), container = new FakeElement("div", document);
    const render = (mirror?: HudMirror) => renderGlassesMirror(container as unknown as HTMLElement, mirror) as unknown as FakeElement;
    return { document, container, render };
  };
  const texts = (svg: FakeElement) => svg.all("text").map(node => node.textContent);

  it("keeps the same svg and image groups when only the text changes", () => {
    const { document, container, render } = mount();
    FakeElement.parses = 0;
    const svg = render(hud());
    expect(container.children).toEqual([svg]);
    const groups = svg.all("g");
    expect(groups.map(group => group.getAttribute("data-image"))).toEqual(["mascot:listening", "badge:general"]);
    expect(FakeElement.parses).toBe(2);
    expect(texts(svg)).toContain("hello there");

    const again = render(hud({ caption: "hello there, how are you", body: "Third line" }));
    expect(again).toBe(svg);
    expect(container.children).toEqual([svg]);
    expect(svg.all("g")).toEqual(groups);
    expect(svg.all("g")[0]).toBe(groups[0]);
    expect(FakeElement.parses).toBe(2);
    expect(document.created.filter(name => name === "svg")).toHaveLength(1);
    expect(texts(svg)).toContain("hello there, how are you");
    expect(texts(svg)).toContain("Third line");
    expect(texts(svg)).not.toContain("hello there");
    expect(texts(svg)).not.toContain("First line");
    expect(svg.getAttribute("aria-label")).toContain("Third line");
  });

  it("replaces only the image group whose key changed, in the same paint order", () => {
    const { render } = mount();
    const svg = render(hud());
    const [mascot, badge] = svg.all("g");
    FakeElement.parses = 0;
    render(hud({ images: { mascot: "mascot:thinking", badge: "badge:general" } }));
    const [nextMascot, nextBadge] = svg.all("g");
    expect(nextBadge).toBe(badge);
    expect(nextMascot).not.toBe(mascot);
    expect(nextMascot?.getAttribute("data-image")).toBe("mascot:thinking");
    expect(FakeElement.parses).toBe(1);
    // Paint order: backdrop, frame, then per image its black box and art, then the text.
    expect(svg.children.map(child => child.localName).slice(0, 6)).toEqual(["rect", "rect", "rect", "g", "rect", "g"]);
  });

  it("draws the same elements on a reused svg as on a fresh one", () => {
    const shape = (svg: FakeElement) => svg.children.map(child => `${child.localName}:${child.getAttribute("x") ?? child.getAttribute("data-image")}:${child.textContent}`);
    const menu = hud({ menuOpen: true, body: "▶ Verify\n  Summary\n  Exit", selection: 0, content: "Body text", ambient: false });
    const fresh = mount().render(menu);
    const reused = mount();
    reused.render(hud({ ambient: true }));
    const svg = reused.render(menu);
    expect(shape(svg)).toEqual(shape(fresh));
    for (const name of ["aria-label", "data-view", "data-menu", "data-ambient", "viewBox", "class", "role"]) expect(svg.getAttribute(name)).toBe(fresh.getAttribute(name));
    expect(svg.getAttribute("data-ambient")).toBeNull();
  });

  it("goes back to the not-connected display on the same svg", () => {
    const { container, render } = mount();
    const svg = render(hud());
    const off = render(undefined);
    expect(off).toBe(svg);
    expect(container.children).toEqual([svg]);
    expect(svg.all("g")).toEqual([]);
    expect(texts(svg)).toEqual(["glasses not connected"]);
    expect(svg.getAttribute("aria-label")).toBe("Glasses display (not connected)");
    expect(svg.getAttribute("data-view")).toBeNull();
    expect(svg.getAttribute("data-menu")).toBeNull();
  });

  it("builds a new svg when the container holds something else (text fallback)", () => {
    const { document, container, render } = mount();
    container.append(new FakeElement("p", document), new FakeElement("p", document));
    const svg = render(hud());
    expect(container.children).toEqual([svg]);
    expect(svg.localName).toBe("svg");
  });

  it("skips the screen rebuild only while a painted mirror is off screen", () => {
    expect(shouldPaintMirror({ offscreen: false, wasHidden: false, painted: true })).toBe(true);
    expect(shouldPaintMirror({ offscreen: true, wasHidden: false, painted: true })).toBe(false);
    // Just opened (or never painted): paint now, the observer has not reported the new position yet.
    expect(shouldPaintMirror({ offscreen: true, wasHidden: true, painted: true })).toBe(true);
    expect(shouldPaintMirror({ offscreen: true, wasHidden: false, painted: false })).toBe(true);
  });
});

describe("finding 28: memory sources are kept slim and bounded", () => {
  const answer = (p: ConversationPresentation, questionId: string) => p.apply({
    ...base, occurredAt: at(0), type: "answer.completed", eventId: `e-a-${questionId}`, answerId: `a-${questionId}`, questionId, text: "Forty thousand.", context: ctx("Helix", "unknown"),
  } as never);

  it("keeps what the chip and History need and drops the rest of the saved session", () => {
    const p = live();
    const items = [memory("one")];
    p.setMemorySources(items, "q1");
    answer(p, "q1");
    const stored = p.snapshot().feed.find(item => item.id === "a-q1")?.memorySources;
    expect(stored).toHaveLength(1);
    expect(stored?.[0]?.entry).toEqual(items[0]!.entry);
    expect(stored?.[0]?.entry).not.toBe(items[0]!.entry);
    expect(stored?.[0]?.score).toBe(0.8);
    expect(stored?.[0]?.session).toEqual({ id: "one", source: "omi", title: "Session one", startedAt: at(0), updatedAt: at(60) });
    expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(items).length / 2);
    expect(items[0]!.session.summary).toBeDefined(); // the caller's copy is untouched
  });

  it("keeps the sources of the most recent 50 questions only", () => {
    const p = live();
    for (let index = 0; index < 60; index++) p.setMemorySources([memory(`m${index}`)], `q${index}`);
    p.setMemorySources([memory("refreshed")], "q10"); // set again: counts as recent
    const kept = (p as unknown as { memorySources: Map<string, RetrievedMemory[]> }).memorySources;
    expect(kept.size).toBe(50);
    expect(kept.has("q9")).toBe(false);
    expect(kept.has("q11")).toBe(true);
    expect(kept.get("q10")?.[0]?.session.id).toBe("refreshed");
    expect(kept.has("q59")).toBe(true);
    answer(p, "q59");
    expect(p.snapshot().feed.find(item => item.id === "a-q59")?.memorySources?.[0]?.session.id).toBe("m59");
  });

  it("bounds the controller's per-question memory to the most recent 50 questions", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge(), presentation = new ConversationPresentation();
    let options: DirectConversationOptions | undefined;
    const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge), presentation, given => {
      options = given;
      return new WebSocketConversationTransport({ url: "ws://127.0.0.1:8787/v2/conversations", protocols: ["helix.v2", "helix-auth.c2hvcnQtbGl2ZWQtdG9rZW4"] });
    });
    await controller.initialize(); await controller.connect(form);
    expect(options?.onMemoryRetrieved).toBeTypeOf("function");
    for (let index = 0; index < 60; index++) options!.onMemoryRetrieved!([memory(`m${index}`)], `q${index}`);
    const kept = (controller as unknown as { memoryByQuestion: Map<string, RetrievedMemory[]> }).memoryByQuestion;
    expect(kept.size).toBe(50);
    expect(kept.has("q9")).toBe(false);
    expect(kept.has("q10")).toBe(true);
    expect(kept.get("q59")?.[0]?.session.summary).toBeDefined(); // the archive copy stays whole
    await controller.dispose();
  });
});

describe("finding 16 (presentation part): a mirror update is marked so the glasses are not rendered again for it", () => {
  it("marks only the emit caused by setHud", () => {
    const p = live();
    const seen: PresentationSnapshot[] = [];
    p.subscribe(snapshot => seen.push(snapshot));
    expect(seen.at(-1)?.reason).toBeUndefined();
    p.setHud(hud());
    expect(seen).toHaveLength(2);
    expect(seen.at(-1)?.reason).toBe("hud");
    expect(seen.at(-1)?.hud?.caption).toBe("hello there");
    p.setHud(hud()); // unchanged: no emit
    expect(seen).toHaveLength(2);
    p.apply(final("t1", "Hello."));
    expect(seen.at(-1)?.reason).toBeUndefined();
    expect(p.snapshot().reason).toBeUndefined();
  });
});
