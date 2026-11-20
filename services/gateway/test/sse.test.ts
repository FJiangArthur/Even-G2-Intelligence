import { describe, expect, it } from "vitest";
import {
  parseChatCompletionStream,
  parseResponsesStream,
  parseServerSentEvents,
} from "../src/provider/sse.js";

function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("SSE parsing", () => {
  it("parses fields and multiline data across arbitrary chunks", async () => {
    const stream = byteStream([
      ": heartbeat\r\nid: 7\r\nevent: token\r\ndata: first\r\n",
      "data: second\r\n\r",
      "\n",
    ]);
    const events = [];
    for await (const event of parseServerSentEvents(stream)) events.push(event);
    expect(events).toEqual([{ id: "7", event: "token", data: "first\nsecond" }]);
  });

  it("does not mistake a CRLF split across chunks for an event boundary", async () => {
    const events = [];
    for await (const event of parseServerSentEvents(byteStream([
      "data: first\r",
      "\ndata: second\r\n\r\n",
    ]))) events.push(event);
    expect(events).toEqual([{ data: "first\nsecond" }]);
  });

  it("yields OpenAI-compatible text deltas before DONE", async () => {
    const stream = byteStream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r',
      '\ndata: {"choices":[{"delta":{"content":"ix"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const deltas = [];
    for await (const delta of parseChatCompletionStream(stream)) deltas.push(delta);
    expect(deltas).toEqual(["Hel", "ix"]);
  });

  it("yields only typed Responses output text deltas", async () => {
    const stream = byteStream([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"fast"}\n\n',
      'data: {"type":"response.output_text.delta","delta":" answer"}\n\n',
      'data: {"type":"response.completed"}\n\n',
    ]);
    const deltas = [];
    for await (const delta of parseResponsesStream(stream)) deltas.push(delta);
    expect(deltas).toEqual(["fast", " answer"]);
  });
});
