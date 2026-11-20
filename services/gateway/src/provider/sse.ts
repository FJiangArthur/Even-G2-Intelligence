import { ProviderError } from "./types.js";

export interface ServerSentEvent {
  readonly event?: string;
  readonly id?: string;
  readonly data: string;
}

function parseEventBlock(block: string): ServerSentEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") data.push(value);
    if (field === "event") event = value;
    if (field === "id" && !value.includes("\0")) id = value;
  }

  if (data.length === 0) return undefined;
  return {
    ...(event === undefined ? {} : { event }),
    ...(id === undefined ? {} : { id }),
    data: data.join("\n"),
  };
}

/** Incrementally parses SSE across arbitrary transport chunk boundaries. */
export async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingCarriageReturn = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      let decoded = decoder.decode(value, { stream: !done });
      if (pendingCarriageReturn) {
        decoded = `\r${decoded}`;
        pendingCarriageReturn = false;
      }
      if (!done && decoded.endsWith("\r")) {
        pendingCarriageReturn = true;
        decoded = decoded.slice(0, -1);
      }
      buffer += decoded.replace(/\r\n?/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseEventBlock(block);
        if (parsed !== undefined) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }

      if (done) break;
    }

    if (pendingCarriageReturn) buffer += "\n";
    const finalEvent = parseEventBlock(buffer);
    if (finalEvent !== undefined) yield finalEvent;
  } finally {
    reader.releaseLock();
  }
}

interface ChatCompletionChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | readonly { readonly type?: string; readonly text?: string }[];
    };
  }[];
}

type ChatContent = string | readonly { readonly type?: string; readonly text?: string }[];

function contentText(content: ChatContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === undefined || part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

export async function* parseChatCompletionStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  for await (const event of parseServerSentEvents(stream)) {
    if (event.data.trim() === "[DONE]") return;

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(event.data) as ChatCompletionChunk;
    } catch {
      throw new ProviderError("provider-response", "Provider returned malformed streaming data", false);
    }

    for (const choice of chunk.choices ?? []) {
      const content = choice.delta?.content;
      if (content === undefined) continue;
      const text = contentText(content);
      if (text !== "") yield text;
    }
  }
}

interface ResponsesStreamChunk {
  readonly type?: unknown;
  readonly delta?: unknown;
  readonly error?: unknown;
}

/** Extracts text deltas from the typed SSE stream returned by POST /responses. */
export async function* parseResponsesStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  for await (const event of parseServerSentEvents(stream)) {
    if (event.data.trim() === "[DONE]") return;
    let chunk: ResponsesStreamChunk;
    try {
      chunk = JSON.parse(event.data) as ResponsesStreamChunk;
    } catch {
      throw new ProviderError("provider-response", "OpenAI Responses returned malformed streaming data", false);
    }
    const type = typeof chunk.type === "string" ? chunk.type : event.event;
    if (type === "response.output_text.delta") {
      if (typeof chunk.delta !== "string") {
        throw new ProviderError("provider-response", "OpenAI Responses returned an invalid text delta", false);
      }
      if (chunk.delta !== "") yield chunk.delta;
      continue;
    }
    if (type === "response.completed") return;
    if (type === "response.failed" || type === "error") {
      throw new ProviderError("provider-response", "OpenAI Responses stream failed", false);
    }
  }
}
