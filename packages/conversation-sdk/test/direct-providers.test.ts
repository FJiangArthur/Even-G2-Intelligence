import { describe, expect, it, vi } from "vitest";
import { answerDirect, transcribeDirect } from "../src/direct-providers.js";

const signal = () => new AbortController().signal;
async function collect(iterator: AsyncGenerator<string>) { let result = ""; for await (const delta of iterator) result += delta; return result; }
function chunks(parts: string[]) {
  return new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }));
}
describe("direct browser providers", () => {
  it.each(["openai-responses", "openai-compatible"])("bounds the assembled multilingual %s request without dropping the current transcript", async profile => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => chunks([profile === "openai-responses" ? 'data: {"type":"response.completed"}\n\n' : 'data: [DONE]\n\n']));
    const transcript = "讨论。".repeat(10_200); // 91,800 UTF-8 bytes.
    const current = { role: "user", content: `GLOBAL BACKGROUND\n${JSON.stringify(transcript)}\nREQUEST\nWho should act?` };
    const history = Array.from({ length: 9 }, (_, i) => [{ role: "user", content: `${i}${"问题".repeat(3999)}` }, { role: "assistant", content: "回答".repeat(4000) }]).flat();
    const instructions = `Custom prompt: ${"说明".repeat(3990)}\nOmi context: ${"记忆".repeat(750)}`;
    await collect(answerDirect(fetcher, "runtime", profile, "gpt-4o-mini", instructions, [...history, current], signal()));
    const serialized = fetcher.mock.calls[0]![1]!.body as string;
    expect(new TextEncoder().encode(serialized).length + 600 + 1024).toBeLessThanOrEqual(128_000);
    const body = JSON.parse(serialized);
    expect((body.input ?? body.messages).at(-1)).toEqual(current);
    expect(body.instructions ?? body.messages[0].content).toBe(instructions);
    expect((body.input ?? body.messages).length).toBeLessThan(history.length);
    if (profile === "openai-responses") expect(body.truncation).toBe("disabled");
  });
  it("rejects an oversized mandatory request before dispatch instead of truncating it", async () => {
    const fetcher = vi.fn();
    await expect(collect(answerDirect(fetcher, "runtime", "openai-responses", "gpt-4o-mini", "说明".repeat(6000), [{ role: "user", content: "谈".repeat(32000) }], signal()))).rejects.toMatchObject({ code: "prompt-context-limit" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["context_length_exceeded", "context_window_exceeded"])("sanitizes provider %s errors into actionable context guidance", async code => {
    const fetcher = async () => Response.json({ error: { code, message: "private transcript and runtime key" } }, { status: 400 });
    await expect(collect(answerDirect(fetcher, "runtime", "openai-responses", "gpt-4o-mini", "", [], signal()))).rejects.toMatchObject({ code: "prompt-context-limit", message: expect.stringMatching(/shorten.*prompt.*new session/i) });
    await expect(collect(answerDirect(fetcher, "runtime", "openai-responses", "gpt-4o-mini", "", [], signal()))).rejects.not.toThrow("private transcript");
  });
  it("uses a provisional 4096 budget for unknown IDs without substituting another model", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => chunks(['data: {"type":"response.completed"}\n\n']));
    await collect(answerDirect(fetcher, "runtime", "openai-responses", "custom-model", "", [{ role: "user", content: "Hello?" }], signal()));
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).model).toBe("custom-model");
    await expect(collect(answerDirect(fetcher, "runtime", "openai-responses", "custom-model", "", [{ role: "user", content: "语".repeat(1000) }], signal()))).rejects.toMatchObject({ code: "prompt-context-limit", message: expect.stringContaining("provisional") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["gpt-4.1-mini", "gpt-4.1", "gpt-4.1-nano"])("uses the larger verified %s window and retains affordable complete exchanges", async model => {
    const history = [{ role: "user", content: "问题".repeat(4000) }, { role: "assistant", content: "回答".repeat(4000) }, { role: "user", content: "谈".repeat(32000) }];
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => chunks(['data: {"type":"response.completed"}\n\n']));
    await collect(answerDirect(fetcher, "runtime", "openai-responses", model, "", history, signal()));
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).input).toEqual(history);
    await collect(answerDirect(fetcher, "runtime", "openai-responses", "gpt-4o-mini", "", history, signal()));
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).input).toEqual(history.slice(-1));
  });
  it("sanitizes context overflow in streamed response failures", async () => {
    await expect(collect(answerDirect(async () => chunks(['data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"private data"}}}\n\n']), "runtime", "openai-responses", "gpt-4o-mini", "", [], signal()))).rejects.toMatchObject({ code: "prompt-context-limit", message: expect.not.stringContaining("private data") });
  });
  it("forwards Soniox tentative text separately from final tokens and ignores late socket messages", async () => {
    let socket!: FakeSocket;
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      onclose?: () => void;
      constructor() { socket = this; }
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    try {
      const partial = vi.fn();
      const result = transcribeDirect(vi.fn(), "soniox", "runtime", new Int16Array(3200), "en", signal(), partial);
      socket.onmessage?.({ data: JSON.stringify({ tokens: [{ text: "Hello ", is_final: true }, { text: "world", is_final: false }] }) });
      expect(partial).toHaveBeenCalledWith("Hello world");
      socket.onmessage?.({ data: JSON.stringify({ tokens: [{ text: "there.", is_final: true }], finished: true }) });
      await expect(result).resolves.toBe("Hello there.");
      socket.onmessage?.({ data: JSON.stringify({ tokens: [{ text: "late", is_final: false }] }) });
      expect(partial).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("does not manufacture Whisper partials or make speculative uploads", async () => {
    const partial = vi.fn(), fetcher = vi.fn(async () => Response.json({ text: "Final clip." }));
    await expect(transcribeDirect(fetcher, "openai-whisper", "runtime", new Int16Array(3200), "en", signal(), partial)).resolves.toBe("Final clip.");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(partial).not.toHaveBeenCalled();
  });
  it("parses SSE split across arbitrary chunks including CRLF boundaries", async () => {
    const fetcher = async () => chunks(['data: {"type":"response.output_text.', 'delta","delta":"Hello."}\r', '\n\r', '\ndata: {"type":"response.completed"}\r\n\r\n']);
    await expect(collect(answerDirect(fetcher, "runtime", "openai-responses", "gpt-4.1-mini", "Instructions", [], signal()))).resolves.toBe("Hello.");
  });
  it("does not mark a truncated partial answer complete", async () => {
    await expect(collect(answerDirect(async () => chunks(['data: {"type":"response.output_text.delta","delta":"Partial"}\n\n']), "runtime", "openai-responses", "gpt-4.1-mini", "", [], signal()))).rejects.toThrow("before completion");
  });
  it("rejects incomplete stream events without echoing upstream details", async () => {
    await expect(collect(answerDirect(async () => chunks(['data: {"type":"response.incomplete","error":"private detail"}\n\n']), "runtime", "openai-responses", "gpt-4.1-mini", "", [], signal()))).rejects.toThrow("could not complete");
  });
  it("routes chat answers to the correct endpoint and accepts the terminal marker", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => chunks(['data: {"choices":[{"delta":{"content":"Hello."}}]}\n\ndata: [DONE]\n\n']));
    await expect(collect(answerDirect(fetcher, "runtime", "openai-compatible", "gpt-4o-mini", "Custom prompt", [], signal()))).resolves.toBe("Hello.");
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toMatchObject({ model: "gpt-4o-mini", messages: [{ role: "system", content: "Custom prompt" }], store: false });
  });
  it("routes Deepgram WAV only to Deepgram with its own key", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ results: { channels: [{ alternatives: [{ transcript: "Hello there." }] }] } }));
    await expect(transcribeDirect(fetcher, "deepgram", "deepgram-runtime", new Int16Array(3200), "en", signal())).resolves.toBe("Hello there.");
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: "Token deepgram-runtime", "Content-Type": "audio/wav" }, redirect: "error" });
  });
  it("rejects malformed Whisper JSON", async () => {
    await expect(transcribeDirect(async () => Response.json({ text: 42 }), "openai-whisper", "runtime", new Int16Array(3200), "en", signal())).rejects.toThrow("invalid transcription data");
  });
});
