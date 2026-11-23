import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectProviderError } from "../src/direct-providers.js";
import { RealtimeTranscriber, type RealtimeSocketLike } from "../src/realtime-transcription.js";

class FakeSocket implements RealtimeSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  server(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  of(type: string) { return this.sent.filter(m => m.type === type); }
}
const chunk = (value = 4000) => new Int16Array(1600).fill(value);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const COMMITTED = "input_audio_buffer.committed";
const DELTA = "conversation.item.input_audio_transcription.delta";
const COMPLETED = "conversation.item.input_audio_transcription.completed";

async function connected() {
  const sockets: FakeSocket[] = [];
  const errors: { error: DirectProviderError; turn?: string }[] = [], completed: { turn: string; text: string }[] = [];
  const transcriber = new RealtimeTranscriber<string>({
    fetch: async () => Response.json({ value: "ek_test" }), key: "k",
    webSocketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    onPartial: () => {}, onCompleted: (turn, text) => completed.push({ turn, text }), onError: (error, turn) => errors.push({ error, turn }),
  });
  transcriber.append(chunk());
  await tick(0);
  const socket = sockets.at(-1)!; socket.open();
  socket.server({ type: "session.created" });
  return { transcriber, sockets, socket, errors, completed };
}

describe("v0.15 realtime transcription: review fixes", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("an acknowledgement that arrives after its turn's deadline is never paired with the next turn", async () => {
    const { transcriber, socket, sockets, errors, completed } = await connected();
    transcriber.append(chunk()); transcriber.commit("a");
    await tick(5_000);
    socket.server({ type: "session.updated" }); // the server is alive, the acknowledgement is only late
    await tick(10_100); // a's deadline has passed
    transcriber.append(chunk()); transcriber.commit("b");
    // The late acknowledgement and result of turn a.
    socket.server({ type: COMMITTED, item_id: "A" });
    socket.server({ type: COMPLETED, item_id: "A", transcript: "Words of turn a." });
    await tick(1_000);
    expect(completed.filter(c => c.turn === "b" && c.text === "Words of turn a.")).toEqual([]);
    expect(errors.map(e => e.turn)).toEqual(["a"]);
    // Turn b is still transcribed, on a socket whose acknowledgement order is known.
    const next = sockets.at(-1)!;
    expect(next).not.toBe(socket);
    next.open(); next.server({ type: "session.created" });
    expect(next.of("input_audio_buffer.commit")).toHaveLength(1);
    next.server({ type: COMMITTED, item_id: "B" });
    next.server({ type: COMPLETED, item_id: "B", transcript: "Words of turn b." });
    expect(completed).toEqual([{ turn: "b", text: "Words of turn b." }]);
    transcriber.close();
  });

  it("a turn queued behind a slow head gets its full time once it becomes the head", async () => {
    const { transcriber, socket, errors, completed } = await connected();
    transcriber.append(chunk()); transcriber.commit("a");
    socket.server({ type: COMMITTED, item_id: "A" });
    await tick(3_000);
    transcriber.append(chunk()); transcriber.commit("b");
    socket.server({ type: COMMITTED, item_id: "B" });
    socket.server({ type: DELTA, item_id: "B", delta: "Hello there" });
    await tick(11_000); // t = 14 s
    socket.server({ type: COMPLETED, item_id: "A", transcript: "First sentence." });
    await tick(4_500); // t = 18.5 s: 15 s after b's commit, 4.5 s after it became the head
    expect(completed).toEqual([{ turn: "a", text: "First sentence." }]);
    await tick(1_500); // t = 20 s
    socket.server({ type: COMPLETED, item_id: "B", transcript: "Hello there, how are you today?" });
    expect(completed).toEqual([{ turn: "a", text: "First sentence." }, { turn: "b", text: "Hello there, how are you today?" }]);
    expect(errors).toEqual([]);
    transcriber.close();
  });

  it("words still streaming for the head turn keep its deadline open", async () => {
    const { transcriber, socket, errors, completed } = await connected();
    transcriber.append(chunk()); transcriber.commit("a");
    socket.server({ type: COMMITTED, item_id: "A" });
    for (let i = 0; i < 6; i++) { await tick(4_000); socket.server({ type: DELTA, item_id: "A", delta: `w${i} ` }); }
    expect(completed).toEqual([]); // 24 s in, but never 15 s without progress
    socket.server({ type: COMPLETED, item_id: "A", transcript: "Full text." });
    expect(completed).toEqual([{ turn: "a", text: "Full text." }]);
    expect(errors).toEqual([]);
    transcriber.close();
  });

  it("a result that arrives after its turn timed out is not delivered again and does not reach a later turn", async () => {
    const { transcriber, socket, errors, completed } = await connected();
    transcriber.append(chunk()); transcriber.commit("a");
    socket.server({ type: COMMITTED, item_id: "A" });
    socket.server({ type: DELTA, item_id: "A", delta: "Hello there" });
    await tick(15_100);
    expect(completed).toEqual([{ turn: "a", text: "Hello there" }]);
    socket.server({ type: COMPLETED, item_id: "A", transcript: "Hello there, late." });
    transcriber.append(chunk()); transcriber.commit("b");
    socket.server({ type: COMMITTED, item_id: "B" });
    socket.server({ type: COMPLETED, item_id: "B", transcript: "Second." });
    expect(completed).toEqual([{ turn: "a", text: "Hello there" }, { turn: "b", text: "Second." }]);
    expect(errors).toEqual([]);
    transcriber.close();
  });

  it("a commit queued behind a slowly draining send buffer is not treated as a dead socket", async () => {
    const { transcriber, socket, sockets, errors, completed } = await connected();
    socket.bufferedAmount = 1_200_000; // about 30 s at 40 KB/s
    transcriber.append(chunk());
    expect(transcriber.commit("a")).toBe(true);
    for (let i = 0; i < 30; i++) { await tick(1_000); socket.bufferedAmount = Math.max(0, socket.bufferedAmount - 40_000); }
    expect(socket.closed).toBe(false);
    expect(errors).toEqual([]);
    expect(sockets).toHaveLength(1);
    // The commit reaches the server once the buffer is empty; its answer then has the normal time.
    await tick(8_000);
    expect(socket.closed).toBe(false);
    socket.server({ type: COMMITTED, item_id: "A" });
    socket.server({ type: COMPLETED, item_id: "A", transcript: "Late but whole." });
    expect(completed).toEqual([{ turn: "a", text: "Late but whole." }]);
    expect(errors).toEqual([]);
    transcriber.close();
  });

  it("a send buffer that stops draining is still found: reconnect after 10 s without progress", async () => {
    const { transcriber, socket, sockets, errors } = await connected();
    socket.bufferedAmount = 1_200_000;
    transcriber.append(chunk());
    transcriber.commit("a");
    for (let i = 0; i < 5; i++) { await tick(1_000); socket.bufferedAmount -= 40_000; }
    expect(socket.closed).toBe(false);
    await tick(9_000); // no bytes left the buffer since
    expect(socket.closed).toBe(false);
    await tick(1_600);
    expect(socket.closed).toBe(true);
    expect(errors.map(e => e.turn)).toEqual(["a"]);
    await tick(600);
    expect(sockets).toHaveLength(2);
    transcriber.close();
  });

  it("once the buffer is empty an unanswered commit still forces a reconnect after 10 s", async () => {
    const { transcriber, socket, errors } = await connected();
    socket.bufferedAmount = 100_000;
    transcriber.append(chunk());
    transcriber.commit("a");
    await tick(2_000);
    socket.bufferedAmount = 0;
    await tick(9_000);
    expect(socket.closed).toBe(false);
    await tick(2_000);
    expect(socket.closed).toBe(true);
    expect(errors.map(e => e.turn)).toEqual(["a"]);
    transcriber.close();
  });
});
