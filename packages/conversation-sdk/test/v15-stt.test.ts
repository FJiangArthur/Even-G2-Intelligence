import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectProviderError } from "../src/direct-providers.js";
import { RealtimeTranscriber, pcm16Base64, resample16kTo24k, type RealtimeSocketLike } from "../src/realtime-transcription.js";

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
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  of(type: string) { return this.sent.filter(m => m.type === type); }
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const ok: Fetcher = async () => Response.json({ value: "ek_test" });
const chunk = (value = 4000) => new Int16Array(1600).fill(value);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function setup(fetcher: Fetcher = ok) {
  const sockets: FakeSocket[] = [];
  const errors: { error: DirectProviderError; turn?: string }[] = [], completed: { turn: string; text: string }[] = [];
  const fetch = vi.fn(fetcher);
  const transcriber = new RealtimeTranscriber<string>({
    fetch, key: "k", webSocketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    onPartial: () => {}, onCompleted: (turn, text) => completed.push({ turn, text }), onError: (error, turn) => errors.push({ error, turn }),
  });
  return { transcriber, fetch, sockets, errors, completed };
}
/** Appends one chunk, lets the mint settle and opens the newest socket. */
async function connected(fetcher?: Fetcher) {
  const ctx = setup(fetcher);
  ctx.transcriber.append(chunk());
  await tick(0);
  const socket = ctx.sockets.at(-1)!; socket.open();
  socket.server({ type: "session.created" });
  return { ...ctx, socket };
}

describe("v0.15 realtime transcription reliability", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("after the reconnect attempts are used up, appends do not start new connects and the outage is reported once", async () => {
    const { transcriber, fetch, errors } = setup(async () => { throw new TypeError("offline"); });
    for (let i = 0; i < 400; i++) { transcriber.append(chunk()); await tick(100); } // 40 s of audio while offline
    expect(fetch).toHaveBeenCalledTimes(6); // first try + 5 back-off retries
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.message).toMatch(/unavailable/);
    // One slow probe per cool-down, still no second report.
    for (let i = 0; i < 100; i++) { transcriber.append(chunk()); await tick(100); }
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(errors).toHaveLength(1);
    transcriber.close();
  });

  it("a non-retryable connect error is reported once and cools down instead of repeating per append", async () => {
    const { transcriber, fetch, errors } = setup(async () => Response.json({}));
    for (let i = 0; i < 50; i++) { transcriber.append(chunk()); await tick(100); }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.code).toBe("provider-response");
    transcriber.close();
  });

  it("resumeAfterSuspend ends the cool-down and retries at once", async () => {
    let online = false;
    const { transcriber, fetch, sockets, errors } = setup(async () => { if (!online) throw new TypeError("offline"); return Response.json({ value: "ek" }); });
    for (let i = 0; i < 200; i++) { transcriber.append(chunk()); await tick(100); }
    expect(fetch).toHaveBeenCalledTimes(6);
    online = true;
    expect(transcriber.resumeAfterSuspend(10_000)).toBe(true);
    await tick(0);
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    // A later outage is reported again.
    online = false; sockets[0]!.drop();
    await tick(60_000);
    expect(errors).toHaveLength(2);
    transcriber.close();
  });

  it("a stalled client-secret request is aborted after 10 s and retried through the back-off", async () => {
    let signal: AbortSignal | undefined;
    const { transcriber, fetch, errors } = setup((_url, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); });
    transcriber.append(chunk());
    await tick(9_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await tick(1_100);
    expect(signal?.aborted).toBe(true);
    await tick(600);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(0);
    transcriber.close();
  });

  it("a WebSocket that never opens is closed after 10 s and retried", async () => {
    const { transcriber, sockets, errors } = setup();
    transcriber.append(chunk());
    await tick(0);
    expect(sockets).toHaveLength(1);
    await tick(10_100);
    expect(sockets[0]!.closed).toBe(true);
    await tick(600);
    expect(sockets).toHaveLength(2);
    expect(errors).toHaveLength(0);
    // The replacement works normally.
    sockets[1]!.open();
    expect(sockets[1]!.of("input_audio_buffer.append")).toHaveLength(1);
    transcriber.close();
  });

  it("clear() while disconnected drops only the audio after the last queued commit and queues no clear", async () => {
    const { transcriber, sockets } = setup();
    transcriber.append(chunk(1000)); transcriber.append(chunk(1000));
    expect(transcriber.commit("first")).toBe(true);
    transcriber.append(chunk(2000)); transcriber.append(chunk(2000)); transcriber.append(chunk(2000));
    transcriber.clear();
    transcriber.append(chunk(3000));
    await tick(0);
    sockets[0]!.open();
    expect(sockets[0]!.sent.map(m => m.type)).toEqual(["session.update", "input_audio_buffer.append", "input_audio_buffer.append", "input_audio_buffer.commit", "input_audio_buffer.append"]);
    expect(sockets[0]!.sent[4]!.audio).toBe(pcm16Base64(resample16kTo24k(chunk(3000))));
    transcriber.close();
  });

  it("audio queued while disconnected is capped at 30 s of the open turn, keeping the newest", async () => {
    const { transcriber, sockets } = setup();
    for (let i = 0; i < 400; i++) transcriber.append(chunk(i + 1)); // 40 s, connect still pending
    await tick(0);
    sockets[0]!.open();
    const appends = sockets[0]!.of("input_audio_buffer.append");
    expect(appends).toHaveLength(300);
    expect(appends.at(-1)!.audio).toBe(pcm16Base64(resample16kTo24k(chunk(400))));
    expect(appends[0]!.audio).toBe(pcm16Base64(resample16kTo24k(chunk(101))));
    transcriber.close();
  });

  it("a commit that gets no acknowledgement and no other server event for 10 s forces a reconnect", async () => {
    const { transcriber, socket, sockets, errors } = await connected();
    transcriber.append(chunk());
    expect(transcriber.commit("turn-1")).toBe(true);
    await tick(9_000);
    expect(socket.closed).toBe(false);
    await tick(1_100);
    expect(socket.closed).toBe(true);
    expect(errors.map(e => e.turn)).toEqual(["turn-1"]);
    await tick(600);
    expect(sockets).toHaveLength(2);
    transcriber.close();
  });

  it("a head turn with no result after 15 s is failed so later turns are delivered", async () => {
    const { transcriber, socket, errors, completed } = await connected();
    transcriber.append(chunk()); transcriber.commit("a");
    socket.server({ type: "input_audio_buffer.committed", item_id: "A" });
    transcriber.append(chunk()); transcriber.commit("b");
    socket.server({ type: "input_audio_buffer.committed", item_id: "B" });
    socket.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "B", transcript: "Second." });
    await tick(14_000);
    expect(completed).toEqual([]);
    await tick(1_100);
    expect(errors.map(e => e.turn)).toEqual(["a"]);
    expect(completed).toEqual([{ turn: "b", text: "Second." }]);
    expect(socket.closed).toBe(false);
    transcriber.close();
  });

  it("a timed-out head turn keeps the words that were already streamed", async () => {
    const { transcriber, socket, errors, completed } = await connected();
    transcriber.append(chunk()); transcriber.commit("a");
    socket.server({ type: "input_audio_buffer.committed", item_id: "A" });
    socket.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "A", delta: "Hello there" });
    await tick(15_100);
    expect(completed).toEqual([{ turn: "a", text: "Hello there" }]);
    expect(errors).toEqual([]);
    transcriber.close();
  });

  it("an unacknowledged head turn on a live socket is given up after 15 s on a new socket, so later acknowledgements pair correctly", async () => {
    const { transcriber, socket, sockets, errors, completed } = await connected();
    transcriber.append(chunk()); transcriber.commit("a");
    await tick(5_000);
    socket.server({ type: "session.updated" }); // the server is alive, the acknowledgement is just missing
    await tick(9_000);
    expect(socket.closed).toBe(false); // not the 10 s dead-socket rule
    await tick(1_100);
    // Acknowledgements are paired in order, so the old socket's order can no longer be trusted.
    expect(socket.closed).toBe(true);
    expect(errors.map(e => e.turn)).toEqual(["a"]);
    transcriber.append(chunk()); transcriber.commit("b");
    await tick(600);
    const next = sockets.at(-1)!; next.open();
    next.server({ type: "input_audio_buffer.committed", item_id: "B" });
    next.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "B", transcript: "Next." });
    expect(completed).toEqual([{ turn: "b", text: "Next." }]);
    transcriber.close();
  });

  it("an acknowledgement without item_id fails that turn instead of blocking the queue", async () => {
    const { transcriber, socket, errors, completed } = await connected();
    transcriber.append(chunk()); transcriber.commit("a");
    socket.server({ type: "input_audio_buffer.committed" });
    transcriber.append(chunk()); transcriber.commit("b");
    socket.server({ type: "input_audio_buffer.committed", item_id: "B" });
    socket.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "B", transcript: "Second." });
    expect(errors.map(e => e.turn)).toEqual(["a"]);
    expect(completed).toEqual([{ turn: "b", text: "Second." }]);
    transcriber.close();
  });

  it("turns committed while disconnected start their deadline when the socket opens", async () => {
    const { transcriber, sockets, errors } = setup();
    transcriber.append(chunk()); transcriber.commit("a");
    await tick(8_000); // handshake still pending
    sockets[0]!.open();
    await tick(5_000);
    expect(sockets[0]!.closed).toBe(false);
    expect(errors).toEqual([]);
    sockets[0]!.server({ type: "input_audio_buffer.committed", item_id: "A" });
    await tick(9_000);
    expect(errors).toEqual([]);
    transcriber.close();
  });

  it("the back-off grows across open-then-close cycles and resets only after a server message", async () => {
    const { transcriber, fetch, sockets } = setup();
    transcriber.append(chunk());
    await tick(0);
    sockets[0]!.open(); sockets[0]!.drop();
    await tick(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    sockets[1]!.open(); sockets[1]!.drop();
    await tick(600);
    expect(fetch).toHaveBeenCalledTimes(2); // second delay is 1 s, not 0.5 s again
    await tick(500);
    expect(fetch).toHaveBeenCalledTimes(3);
    sockets[2]!.open(); sockets[2]!.server({ type: "session.created" }); sockets[2]!.drop();
    await tick(500);
    expect(fetch).toHaveBeenCalledTimes(4);
    transcriber.close();
  });

  it("skips audio while the socket send buffer is over 1 MB but still sends the commit", async () => {
    const { transcriber, socket } = await connected();
    const before = socket.of("input_audio_buffer.append").length;
    socket.bufferedAmount = 2_000_000;
    transcriber.append(chunk()); transcriber.append(chunk());
    expect(socket.of("input_audio_buffer.append")).toHaveLength(before);
    expect(transcriber.commit("a")).toBe(true);
    expect(socket.of("input_audio_buffer.commit")).toHaveLength(1);
    socket.bufferedAmount = 0;
    transcriber.append(chunk());
    expect(socket.of("input_audio_buffer.append")).toHaveLength(before + 1);
    transcriber.close();
  });

  it("forgets results for unknown items after 60 s", async () => {
    const { transcriber, socket, completed } = await connected();
    socket.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "OLD", transcript: "Stale." });
    await tick(61_000);
    socket.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "OTHER", transcript: "Other." });
    transcriber.append(chunk()); transcriber.commit("a");
    socket.server({ type: "input_audio_buffer.committed", item_id: "OLD" });
    expect(completed).toEqual([]);
    transcriber.close();
  });
});
