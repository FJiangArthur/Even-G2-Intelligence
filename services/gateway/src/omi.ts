import type { OmiConfig } from "./config.js";
import {
  defaultFetch,
  mapProviderFailure,
  providerFetch,
  providerRequestUrl,
  type FetchLike,
} from "./provider/http.js";

export interface OmiMemory {
  readonly id?: string;
  readonly content: string;
  readonly category?: string;
  readonly createdAt?: string;
}

export interface OmiWriteResult {
  readonly recordId?: string;
}

export class OmiError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OmiError";
  }
}

function memoryArray(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.memories)) return record.memories;
  if (Array.isArray(record.data)) return record.data;
  return [];
}

function optionalField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function safeRecordId(value: string | undefined): string | undefined {
  if (value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return undefined;
  if (/^eyJ|^sk-/i.test(value)) return undefined;
  return value;
}

function parseMemory(value: unknown): OmiMemory | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const content = optionalField(record, "content", "text", "memory");
  if (content === undefined) return undefined;
  const id = optionalField(record, "id", "memory_id");
  const category = optionalField(record, "category");
  const createdAt = optionalField(record, "created_at", "createdAt");
  return {
    content,
    ...(id === undefined ? {} : { id }),
    ...(category === undefined ? {} : { category }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function omiHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

function mapOmiError(error: unknown, operation: "read" | "write"): OmiError {
  if (error instanceof OmiError) return error;
  if (error instanceof Error && error.name === "ProviderError") {
    return new OmiError(`omi-${operation}-failed`, `Omi memory ${operation} was unavailable`);
  }
  return new OmiError(`omi-${operation}-failed`, `Omi memory ${operation} failed`);
}

export class OmiClient {
  public constructor(
    public readonly config: OmiConfig,
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  public get configured(): boolean {
    return this.config.apiKey !== undefined;
  }

  /** Creates an immutable, session-scoped client without mutating shared config. */
  public withApiKey(apiKey: string): OmiClient {
    return new OmiClient({ ...this.config, apiKey }, this.fetchImpl);
  }

  public async fetchRecentMemories(signal?: AbortSignal): Promise<readonly OmiMemory[]> {
    const apiKey = this.config.apiKey;
    if (apiKey === undefined) throw new OmiError("omi-not-configured", "Omi memory is not configured");
    const url = new URL(providerRequestUrl(this.config.baseUrl, this.config.memoriesPath));
    url.searchParams.set("limit", String(this.config.maxRecentMemories));
    url.searchParams.set("offset", "0");
    if (this.config.category !== undefined) url.searchParams.set("categories", this.config.category);
    try {
      const response = await providerFetch(
        this.fetchImpl,
        url.toString(),
        {
          method: "GET",
          headers: omiHeaders(apiKey),
          ...(signal === undefined ? {} : { signal }),
        },
        this.config.requestTimeoutMs,
      );
      if (!response.ok) throw mapProviderFailure(response.status);
      const payload = await response.json() as unknown;
      return memoryArray(payload)
        .slice(0, this.config.maxRecentMemories)
        .map(parseMemory)
        .filter((memory): memory is OmiMemory => memory !== undefined);
    } catch (error) {
      throw mapOmiError(error, "read");
    }
  }

  public async writeMemory(content: string, signal?: AbortSignal): Promise<OmiWriteResult> {
    const apiKey = this.config.apiKey;
    if (apiKey === undefined) throw new OmiError("omi-not-configured", "Omi memory is not configured");
    const bounded = Array.from(content.trim()).slice(0, 500).join("").trim();
    if (bounded === "") throw new OmiError("omi-write-invalid", "Omi memory content is empty");
    try {
      const response = await providerFetch(
        this.fetchImpl,
        providerRequestUrl(this.config.baseUrl, this.config.memoriesPath),
        {
          method: "POST",
          headers: { ...omiHeaders(apiKey), "Content-Type": "application/json" },
          body: JSON.stringify({ content: bounded }),
          ...(signal === undefined ? {} : { signal }),
        },
        this.config.requestTimeoutMs,
      );
      if (!response.ok) throw mapProviderFailure(response.status);
      const payload = await response.json() as unknown;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
      const recordId = safeRecordId(optionalField(payload as Record<string, unknown>, "id", "memory_id"));
      return recordId === undefined ? {} : { recordId };
    } catch (error) {
      throw mapOmiError(error, "write");
    }
  }
}

const MEMORY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "for", "from", "had", "has", "have",
  "how", "i", "if", "in", "is", "it", "its", "may", "me", "might", "my",
  "of", "on", "or", "our", "should", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "those", "to", "was", "we", "were", "what",
  "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

function normalizedTokens(input: string): Set<string> {
  const normalized = input.normalize("NFKC").toLocaleLowerCase("en-US");
  const tokens = new Set(
    (normalized.match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) => !MEMORY_STOPWORDS.has(token)),
  );
  for (const token of [...tokens]) {
    if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) continue;
    const characters = Array.from(token);
    for (const character of characters) tokens.add(character);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      tokens.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return tokens;
}

function overlapScore(query: Set<string>, content: string): number {
  if (query.size === 0) return 0;
  const candidate = normalizedTokens(content);
  let common = 0;
  for (const token of query) if (candidate.has(token)) common += 1;
  return common / query.size;
}

/** Ranks a bounded recent cache locally; unrelated memories are never injected. */
export function relevantMemoryContext(
  memories: readonly OmiMemory[],
  query: string,
  limits: Pick<OmiConfig, "maxContextMemories" | "maxContextCharacters">,
): string | undefined {
  const queryTokens = normalizedTokens(query);
  const ranked = memories
    .map((memory, index) => ({ memory, index, score: overlapScore(queryTokens, memory.content) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limits.maxContextMemories);
  const lines: string[] = [];
  let characters = 0;
  for (const { memory } of ranked) {
    const compact = memory.content.replace(/\s+/g, " ").trim();
    const remaining = limits.maxContextCharacters - characters - (lines.length === 0 ? 0 : 1);
    if (remaining <= 2) break;
    const line = `- ${Array.from(compact).slice(0, Math.max(0, remaining - 2)).join("")}`;
    const lineCharacters = Array.from(line).length;
    if (lineCharacters <= 2) break;
    lines.push(line);
    characters += lineCharacters;
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}

export async function boundedMemoryContext(
  memories: Promise<readonly OmiMemory[]>,
  query: string,
  config: OmiConfig,
): Promise<string | undefined> {
  if (config.answerWaitMs === 0) return undefined;
  // Attach rejection handling before the race. A provider failure arriving
  // after the short answer deadline must never become an unhandled rejection.
  const safeMemories = memories.catch(() => [] as readonly OmiMemory[]);
  const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, config.answerWaitMs));
  const available = await Promise.race([safeMemories, timeout]);
  if (available === undefined) return undefined;
  return relevantMemoryContext(available, query, config);
}
