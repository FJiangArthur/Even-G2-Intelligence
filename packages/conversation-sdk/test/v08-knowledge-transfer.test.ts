import { describe, expect, it, vi } from "vitest";
import {
  LocalHistoryStore, OMI_DEV_API, exportToOmi, importOmiConversations, markdownToSession, sessionDiagram, sessionToMarkdown, vaultBundle,
  type HistoryEntry, type HistorySession,
} from "../src/index.js";

const session: HistorySession = {
  id: "session_abc", source: "helix", title: "Jetson procurement (Q4)", startedAt: "2026-11-08T17:00:00.000Z", updatedAt: "2026-11-08T17:30:00.000Z",
  summary: ["Team discussed Jetson Orin procurement and lead times.", "Budget moved from $40k to $25k."], keyFacts: ["Budget $25k", "Ship by March 3"],
  people: [{ name: "Elaine Chen", role: "head of robotics", mentions: 3 }, { name: "Bob" }], concepts: ["CDTF", "NVMe"], tags: ["jetson", "procurement q4"],
};
const at = (s: number) => new Date(Date.parse(session.startedAt) + s * 1000).toISOString();
const entries: HistoryEntry[] = [
  { id: "1", sessionId: "session_abc", kind: "transcript", text: "Jetson boards have a long lead time right now, see https://nvidia.com/x.", occurredAt: at(5), speaker: "Other speaker", metadata: { model: "gpt-6.1-terra", provider: "openai", endpoint: "https://api.openai.com/v1/responses", promptVersion: "7", latencyMs: "812" } },
  { id: "3", sessionId: "session_abc", kind: "transcript", text: "What lead time are you seeing?", occurredAt: at(8), speaker: "You" },
  { id: "2", sessionId: "session_abc", kind: "question", text: "What lead time are you seeing?", occurredAt: at(9), speaker: "You" },
  { id: "4", sessionId: "session_abc", kind: "answer", text: "Distributors list about 12 weeks [M1] ([NVIDIA](https://nvidia.com/a)).", occurredAt: at(12), speaker: "Helix", metadata: { model: "gpt-6.1-terra", endpoint: "https://api.openai.com/v1/responses" } },
  { id: "5", sessionId: "session_abc", kind: "question", text: "Summarize the budget", occurredAt: at(60), speaker: "You" },
  { id: "6", sessionId: "session_abc", kind: "fact-check", text: "Orin has 64 GB\nSupported by the spec sheet.", occurredAt: at(120), sources: [{ url: "https://example.com/spec", title: "Spec" }] },
  { id: "7", sessionId: "session_abc", kind: "transcript", text: "Elaine Chen approves orders over $10k.", occurredAt: at(130), speaker: "Other speaker" },
];

describe("sessionToMarkdown", () => {
  const md = sessionToMarkdown(session, entries);
  it("writes YAML frontmatter, knowledge sections, a Mermaid mindmap and a clean transcript", () => {
    expect(md.startsWith('---\ntitle: "Jetson procurement (Q4)"\ndate: 2026-11-08\nsource: helix\nhelix_session_id: "session_abc"\n')).toBe(true);
    expect(md).toContain('people:\n  - "Elaine Chen"\n  - "Bob"\ntags:\n  - "jetson"\n  - "procurement-q4"\n---');
    for (const heading of ["# Jetson procurement (Q4)", "## Summary", "## Key facts", "## People", "## Concepts", "## Diagram", "## Transcript"]) expect(md).toContain(`\n${heading}\n`);
    expect(md).toContain("- **Elaine Chen** — head of robotics\n- **Bob**");
    expect(md).toContain("```mermaid\nmindmap\n  root((Jetson procurement Q4))\n    Topics\n      Team discussed Jetson Orin procurement\n");
    expect(md).toContain("    People\n      Elaine Chen - head of robotics\n      Bob\n    Concepts\n      CDTF\n      NVMe\n```");
    expect(md).toContain("**Other speaker:** Jetson boards have a long lead time right now, see.\n\n**You:** What lead time are you seeing?\n\n> Helix: Distributors list about 12 weeks.\n\n> Asked Helix: Summarize the budget\n\n> Helix check: Orin has 64 GB — Supported by the spec sheet.");
  });
  it("never writes URLs, endpoints, model names, latency or memory markers", () => {
    expect(md).not.toMatch(/https?:|api\.openai|gpt-6|openai|812|\[M1\]|nvidia\.com|example\.com/u);
    // Detected questions duplicate the transcript and are not repeated.
    expect(md.match(/What lead time are you seeing\?/gu)).toHaveLength(1);
  });
  it("uses an Omi overview entry as the summary when the session has none and escapes structural lines", () => {
    const omi: HistorySession = { id: "omi:x", source: "omi", title: "Standup", startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
    const text = sessionToMarkdown(omi, [
      { id: "o", sessionId: "omi:x", kind: "answer", text: "Team synced. Release slips.", occurredAt: "2026-09-01T00:00:00Z", speaker: "Omi summary", metadata: { origin: "omi-summary" } },
      { id: "t", sessionId: "omi:x", kind: "transcript", text: "# not a heading", occurredAt: "2026-09-01T00:00:01Z" },
      { id: "other", sessionId: "omi:y", kind: "transcript", text: "Other session", occurredAt: "2026-09-01T00:00:01Z" },
    ]);
    expect(text).toContain("## Summary\n- Team synced.\n- Release slips.");
    expect(text).not.toContain("Omi summary");
    expect(text).toContain("\n\\# not a heading\n");
    expect(text).not.toContain("Other session");
    expect(text).toContain("people: []\ntags: []");
  });
  it("sessionDiagram sanitizes node text so Mermaid shapes cannot be injected", () => {
    const diagram = sessionDiagram({ ...session, title: "A (b) [c] {d}", summary: ["))evil((node]]"], people: [{ name: "Eve\nroot" }], concepts: [] });
    expect(diagram.split("\n")[1]).toBe("  root((A b c d))");
    expect(diagram).not.toMatch(/\)\)evil|\[\[|\]\]/u);
    expect(diagram.split("\n").every(line => !/[()[\]{}]/u.test(line.replace("root((A b c d))", "")))).toBe(true);
  });
});

describe("markdownToSession", () => {
  it("round-trips sessionToMarkdown output as an obsidian session the store accepts", async () => {
    const { session: parsed, entries: parsedEntries, helixSessionId } = markdownToSession(sessionToMarkdown(session, entries), "Helix/2026-11-08 Jetson procurement Q4.md");
    expect(helixSessionId).toBe("session_abc");
    expect(parsed).toEqual({
      id: "obsidian:session_abc", source: "obsidian", title: "Jetson procurement (Q4)", startedAt: session.startedAt, updatedAt: session.updatedAt,
      summary: session.summary, keyFacts: session.keyFacts, people: [{ name: "Elaine Chen", role: "head of robotics" }, { name: "Bob" }],
      concepts: ["CDTF", "NVMe"], tags: ["jetson", "procurement-q4"],
    });
    expect(parsedEntries.map(e => [e.kind, e.speaker, e.text])).toEqual([
      ["transcript", "Other speaker", "Jetson boards have a long lead time right now, see."],
      ["transcript", "You", "What lead time are you seeing?"],
      ["answer", "Helix", "Distributors list about 12 weeks."],
      ["question", "You", "Summarize the budget"],
      ["fact-check", "Helix", "Orin has 64 GB — Supported by the spec sheet."],
      ["transcript", "Other speaker", "Elaine Chen approves orders over $10k."],
    ]);
    // Stable re-import identity, monotonic times.
    expect(markdownToSession(sessionToMarkdown(session, entries), "renamed.md").session.id).toBe(parsed.id);
    expect(parsedEntries.every((e, i) => i === 0 || Date.parse(e.occurredAt) > Date.parse(parsedEntries[i - 1]!.occurredAt))).toBe(true);
    const store = new LocalHistoryStore({ getLocalStorage: async () => "", setLocalStorage: async () => true });
    await store.load(); await store.upsertSession(parsed); await store.upsertEntries(parsedEntries);
    expect(store.retrieve("Elaine approves orders")[0]?.session.source).toBe("obsidian");
    // Markdown -> Helix -> Markdown is stable.
    const again = markdownToSession(sessionToMarkdown(parsed, parsedEntries), "x.md");
    expect(again.entries.map(e => [e.kind, e.speaker, e.text])).toEqual(parsedEntries.map(e => [e.kind, e.speaker, e.text]));
  });
  it("imports a plain Obsidian note: headings, paragraphs, bullets, links, tags, callouts; skips mermaid and comments", () => {
    const note = [
      "# Robotics sync", "", "Met with [[Elaine Chen|Elaine]] about the #jetson order. See [spec](https://example.com/spec).", "continued line.", "",
      "## Decisions", "- [x] Order 4 Orin kits", "- Budget is **$25k**", "", "> [!note] Callout", "> Lead time ~12 weeks", "",
      "```mermaid", "graph LR; A-->B", "```", "", "%% private comment %%", "<!-- hidden -->", "```python", "print('hi')", "```",
      "## People", "- Elaine Chen (head of robotics)", "- Bob — vendor", "", "| a | b |", "|---|---|", "| 1 | 2 |",
    ].join("\n");
    const { session: s, entries: e } = markdownToSession(note, "Work/2026-09-14 Robotics sync.md", { now: "2026-11-08T00:00:00Z" });
    expect(s).toMatchObject({ id: "obsidian:Work%2F2026-09-14%20Robotics%20sync", source: "obsidian", title: "Robotics sync", startedAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z", tags: ["jetson"], people: [{ name: "Elaine Chen", role: "head of robotics" }, { name: "Bob", role: "vendor" }] });
    expect(e.map(x => x.text)).toEqual([
      "Met with Elaine about the jetson order. See spec. continued line.", "Decisions", "Order 4 Orin kits", "Budget is $25k", "Callout", "Lead time ~12 weeks", "print('hi')", "a b", "1 2",
    ]);
    expect(e[1]!.metadata).toEqual({ origin: "obsidian-heading", section: "Decisions" });
    expect(e[2]!.metadata).toEqual({ origin: "obsidian-bullet", section: "Decisions" });
    expect(JSON.stringify(e)).not.toMatch(/private comment|hidden|A-->B|https?:/u);
  });
  it("parses frontmatter variants and falls back to the file name and the given time", () => {
    const fm = markdownToSession("---\ntitle: 'It''s a plan'\ntags: [alpha, \"beta gamma\"]\npeople: Ann, Bo Li\ncreated: 2026-01-02\n---\nBody text.", "plan.md");
    expect(fm.session).toMatchObject({ title: "It's a plan", tags: ["alpha", "beta-gamma"], people: [{ name: "Ann" }, { name: "Bo Li" }], startedAt: "2026-01-02T00:00:00.000Z" });
    const bare = markdownToSession("Just a thought.", "Inbox/Idea.md", { now: "2026-11-08T12:00:00Z" });
    expect(bare.session).toMatchObject({ title: "Idea", startedAt: "2026-11-08T12:00:00.000Z" });
    expect(bare.helixSessionId).toBeUndefined();
    expect(() => markdownToSession("x".repeat(2_000_001), "big.md")).toThrow(/too large/i);
  });
});

describe("vaultBundle", () => {
  it("writes one note per session under Helix/YYYY-MM-DD title.md with safe, unique names", () => {
    const { files } = vaultBundle([
      { session, entries },
      { session: { ...session, id: "s2", title: "Jetson procurement (Q4)" }, entries: [] },
      { session: { ...session, id: "s3", title: 'a/b:c*?"<>|#^[x]' }, entries: [] },
      { session: { ...session, id: "s4", title: "   " }, entries: [] },
    ]);
    expect(files.map(f => f.path)).toEqual(["Helix/2026-11-08 Jetson procurement (Q4).md", "Helix/2026-11-08 Jetson procurement (Q4) (2).md", "Helix/2026-11-08 a b c x.md", "Helix/2026-11-08 Session.md"]);
    expect(files[0]!.content).toBe(sessionToMarkdown(session, entries));
    expect(vaultBundle([{ session, entries: [] }], { folder: "../Notes//Helix" }).files[0]!.path).toBe("Notes/Helix/2026-11-08 Jetson procurement (Q4).md");
  });
});

describe("exportToOmi (developer API)", () => {
  const key = "omi_dev_placeholder";
  const ok = (body: unknown = { id: "conv_789", status: "completed", discarded: false }) => Response.json(body);
  it("POSTs transcript segments to conversations/from-segments with an idempotent client_session_id", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    const result = await exportToOmi({ key, session, entries, fetch: fetcher, language: "en-US" });
    expect(result).toEqual({ status: "exported", conversationId: "conv_789", endpoint: "from-segments", segments: 3, discarded: false });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${OMI_DEV_API}/conversations/from-segments`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ client_session_id: "helix-session_abc", source: "external_integration", started_at: session.startedAt, language: "en" });
    expect(body.transcript_segments).toEqual([
      { text: "Jetson boards have a long lead time right now, see.", start: 5, end: 9, speaker: "SPEAKER_00", is_user: false },
      { text: "What lead time are you seeing?", start: 9, end: 11.4, speaker: "SPEAKER_01", is_user: true },
      { text: "Elaine Chen approves orders over $10k.", start: 130, end: 132.4, speaker: "SPEAKER_00", is_user: false },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/Distributors|Helix|https?:/u); // answers are not spoken speech
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it("uses create-from-text for sessions with only a summary, and skips Omi or empty sessions", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => ok({ id: "conv_456", status: "completed", discarded: false }));
    const textOnly = { ...session, id: "obsidian:n", source: "obsidian" as const };
    await expect(exportToOmi({ key, session: textOnly, entries: [], fetch: fetcher })).resolves.toMatchObject({ status: "exported", endpoint: "from-text", conversationId: "conv_456", segments: 0 });
    expect(fetcher.mock.calls[0]![0]).toBe(`${OMI_DEV_API}/conversations`);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ text_source: "other_text", text_source_spec: "helix" });
    expect(body.text).toContain("Budget moved from $40k to $25k.");
    await expect(exportToOmi({ key, session: { ...session, source: "omi" }, entries, fetch: fetcher })).resolves.toMatchObject({ status: "skipped" });
    await expect(exportToOmi({ key, session: { ...textOnly, summary: [], keyFacts: [] }, entries: [], fetch: fetcher })).resolves.toMatchObject({ status: "skipped" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("maps failures without leaking the key and never calls Omi with an invalid key", async () => {
    const fetcher = vi.fn();
    await expect(exportToOmi({ key: "bad key", session, entries, fetch: fetcher })).resolves.toMatchObject({ status: "failed", code: "invalid-key" });
    expect(fetcher).not.toHaveBeenCalled();
    for (const [status, code] of [[401, "auth"], [403, "auth"], [429, "rate-limited"], [422, "rejected"], [500, "http"]] as const) {
      const result = await exportToOmi({ key, session, entries, fetch: async () => new Response(`private ${key}`, { status }) });
      expect(result).toMatchObject({ status: "failed", code }); expect(JSON.stringify(result)).not.toContain(key);
    }
    await expect(exportToOmi({ key, session, entries, fetch: async () => { throw new Error(key); } })).resolves.toMatchObject({ status: "failed", code: "network" });
    await expect(exportToOmi({ key, session, entries, fetch: async () => ok({ nope: true }) })).resolves.toMatchObject({ status: "failed", code: "invalid-response" });
    await expect(exportToOmi({ key, session, entries, fetch: async () => ok({ id: "conv_789", status: "deleted", discarded: true }) })).resolves.toEqual({ status: "skipped", reason: expect.stringMatching(/deleted/), conversationId: "conv_789" });
  });
  it("optionally saves key facts as Omi memories (batch) and reports memory failures separately", async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("memories/batch") ? Response.json({ memories: [], created_count: 2 }) : ok());
    await expect(exportToOmi({ key, session, entries, fetch: fetcher, memories: true })).resolves.toMatchObject({ status: "exported", memories: 2 });
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({ memories: [{ content: "Budget $25k", tags: ["helix"] }, { content: "Ship by March 3", tags: ["helix"] }] });
    const denied = await exportToOmi({ key, session, entries, memories: true, fetch: async url => url.endsWith("memories/batch") ? new Response("", { status: 403 }) : ok() });
    expect(denied).toMatchObject({ status: "exported", conversationId: "conv_789", memoriesError: expect.stringMatching(/memories:write/) });
  });
  it("throws AbortError when cancelled", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(exportToOmi({ key, session, entries, signal: abort.signal, fetch: async () => ok() })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("merges same-speaker runs to stay within Omi's 500-segment limit", async () => {
    const many: HistoryEntry[] = Array.from({ length: 1200 }, (_, i) => ({ id: `m${i}`, sessionId: session.id, kind: "transcript", text: `Line ${i}.`, occurredAt: at(i), speaker: i % 3 === 0 ? "You" : "Other speaker" }));
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    const result = await exportToOmi({ key, session, entries: many, fetch: fetcher });
    const segments = JSON.parse(fetcher.mock.calls[0]![1]!.body as string).transcript_segments as { start: number; end: number }[];
    expect(segments.length).toBeLessThanOrEqual(500); expect(result).toMatchObject({ segments: segments.length });
    expect(segments.every((s, i) => s.end >= s.start && (i === 0 || s.start >= segments[i - 1]!.start))).toBe(true);
  });
});

describe("Omi import knowledge fields", () => {
  it("adds summary (overview), key facts (action items), tags (category) and named non-user speakers as people", async () => {
    const store = new LocalHistoryStore({ getLocalStorage: async () => "", setLocalStorage: async () => true }); await store.load();
    const conversation = {
      id: "c1", created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:10:00Z",
      structured: { title: "Robotics sync", overview: "Team reviewed Jetson orders. Elaine approved the budget.", category: "work", action_items: [{ description: "Order 4 Orin kits", completed: false }, "Book the lab", 7] },
      participants_included: true, participants: [{ speaker_id: 0, person_id: null, is_user: true }, { speaker_id: 1, person_id: "p1", is_user: false }],
      transcript_segments: [
        { id: "s0", text: "I can place the order.", speaker_id: 0, speaker_name: "Art", start: 0, end: 2 },
        { id: "s1", text: "Approved.", speaker_id: 1, speaker_name: "Elaine", start: 3, end: 4 },
        { id: "s2", text: "Noted.", speaker_id: 2, speaker_name: "Speaker 2", start: 5, end: 6 },
        { id: "s3", text: "Thanks.", speaker_id: 1, speaker_name: "Elaine", start: 7, end: 8 },
      ],
    };
    await importOmiConversations({ key: "omi_dev_x", store, fetch: async () => Response.json([conversation]) });
    expect(store.listSessions()[0]).toMatchObject({
      id: "omi:c1", source: "omi", summary: ["Team reviewed Jetson orders.", "Elaine approved the budget."], keyFacts: ["Order 4 Orin kits", "Book the lab"],
      tags: ["work"], people: [{ name: "Elaine" }],
    });
    expect(store.listPeople()).toEqual([{ name: "Elaine", roles: [], sessionIds: ["omi:c1"], mentions: 1, lastSeen: "2026-09-01T00:10:00.000Z" }]);
    expect(store.stats().omi).toEqual({ sessions: 1, entries: 5, lastUpdated: "2026-09-01T00:10:00.000Z" });
  });
});
