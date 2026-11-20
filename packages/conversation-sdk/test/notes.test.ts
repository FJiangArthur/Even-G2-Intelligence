import { describe, expect, it } from "vitest";
import {
  InMemoryNoteSink,
  isSafeEndpointReference,
  validateAutomaticNoteCandidate,
  type NoteCandidate,
} from "../src/index.js";

describe("InMemoryNoteSink", () => {
  it("deduplicates normalized text per session and returns defensive copies", async () => {
    const sink = new InMemoryNoteSink();
    const original = candidate("note-1", "  Ship   the SDK  ");
    expect(await sink.save(original)).toMatchObject({ status: "saved" });
    expect(await sink.save(candidate("note-2", "ship the sdk"))).toMatchObject({ status: "duplicate" });

    const listed = sink.list();
    expect(listed[0]?.text).toBe("Ship   the SDK");
    const mutable = listed[0] as { text: string };
    mutable.text = "changed";
    expect(sink.list()[0]?.text).toBe("Ship   the SDK");
  });

  it("rejects unsafe content, oversized notes, and conflicting ids", async () => {
    const sink = new InMemoryNoteSink({ maxTextLength: 12 });
    expect(await sink.save(candidate("unsafe", "hello\u0000world"))).toMatchObject({ status: "rejected" });
    expect(await sink.save(candidate("long", "this is much too long"))).toMatchObject({ status: "rejected" });
    expect(await sink.save(candidate("same", "first"))).toMatchObject({ status: "saved" });
    expect(await sink.save(candidate("same", "second"))).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("different content"),
    });
  });

  it("rejects credentials, JWTs, questions, uncertainty, bidi controls, and unsafe endpoint provenance", async () => {
    const cases: [string, NoteCandidate, string][] = [
      ["api key", candidate("api-key", "api_key=abcdefghijklmnop"), "credential"],
      ["JWT", candidate("jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhcnQifQ.signature123"), "credential"],
      ["question", candidate("question", "What should we ship?"), "questions"],
      ["uncertainty", candidate("uncertain", "Maybe the release is ready."), "uncertain"],
      ["bidi", candidate("bidi", "release\u202Eready"), "control"],
      ["endpoint", withEndpoint(candidate("endpoint", "Ship the SDK."), "wss://user:secret@example.test"), "endpoint"],
      [
        "encoded provenance credential",
        withEndpoint(
          candidate("encoded", "Ship the SDK."),
          `urn:helix:provider:${["sk", "proj", "abcdefghijklmnop"].join("-")}`,
        ),
        "credential",
      ],
      [
        "answer profile credential",
        withAnswerProvider(
          candidate("profile", "Ship the SDK."),
          ["sk", "proj", "abcdefghijklmnop"].join("-"),
        ),
        "credential",
      ],
    ];

    for (const [label, note, expectedReason] of cases) {
      expect(validateAutomaticNoteCandidate(note), label).toContain(expectedReason);
      expect(await new InMemoryNoteSink().save(note), label).toMatchObject({ status: "rejected" });
    }
  });

  it("accepts a percent-encoded, non-routable provider reference", () => {
    const url = "urn:helix:provider:private%20cluster";
    expect(isSafeEndpointReference(url)).toBe(true);
    expect(isSafeEndpointReference("urn:helix:provider:private%2Gcluster")).toBe(false);
    expect(validateAutomaticNoteCandidate(withEndpoint(candidate("safe", "Ship the SDK."), url))).toBeUndefined();
  });

  it("preserves a truthful Omi persistence outcome in defensive copies", async () => {
    const sink = new InMemoryNoteSink();
    const note: NoteCandidate = {
      ...candidate("omi", "Sync the approved decision."),
      persistence: { destination: "omi", status: "synced", recordId: "omi-note-1" },
    };
    expect(await sink.save(note)).toMatchObject({ status: "saved" });
    const stored = sink.list()[0]!;
    expect(stored.persistence).toEqual(note.persistence);
    (stored.persistence as { recordId?: string }).recordId = "changed";
    expect(sink.list()[0]?.persistence?.recordId).toBe("omi-note-1");
  });

  it("applies monotonic persistence-only updates for one note id", async () => {
    const sink = new InMemoryNoteSink();
    const base = candidate("omi-progress", "Sync the approved decision.");
    const pending: NoteCandidate = {
      ...base,
      persistence: { destination: "omi", status: "pending" },
    };
    const synced: NoteCandidate = {
      ...base,
      persistence: { destination: "omi", status: "synced", recordId: "omi-note-2" },
    };

    expect(await sink.save(pending)).toMatchObject({ status: "saved" });
    expect(await sink.save(synced)).toMatchObject({
      status: "saved",
      note: { persistence: { status: "synced", recordId: "omi-note-2" } },
    });
    expect(await sink.save(synced)).toMatchObject({ status: "duplicate" });
    expect(await sink.save(pending)).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("terminal synced"),
    });
    expect(await sink.save({
      ...base,
      persistence: { destination: "omi", status: "failed", failureCode: "UPSTREAM_TIMEOUT" },
    })).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("terminal synced"),
    });
    expect(sink.list()).toHaveLength(1);
    expect(sink.list()[0]?.persistence).toEqual(synced.persistence);
  });

  it("accepts pending-to-failed but rejects terminal conflicts and provenance changes", async () => {
    const sink = new InMemoryNoteSink();
    const base = candidate("omi-failed", "Keep the local decision record.");
    const pending: NoteCandidate = {
      ...base,
      persistence: { destination: "omi", status: "pending" },
    };
    const failed: NoteCandidate = {
      ...base,
      persistence: { destination: "omi", status: "failed", failureCode: "RATE_LIMITED" },
    };

    expect(await sink.save(pending)).toMatchObject({ status: "saved" });
    expect(await sink.save(failed)).toMatchObject({ status: "saved" });
    expect(await sink.save({
      ...base,
      persistence: { destination: "omi", status: "synced", recordId: "late-record" },
    })).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("terminal failed"),
    });
    expect(await sink.save({
      ...failed,
      provenance: {
        ...failed.provenance,
        speaker: { label: "Someone else", role: "other" },
      },
    })).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("content or provenance"),
    });
    expect(sink.list()[0]?.persistence).toEqual(failed.persistence);
  });
});

function candidate(id: string, text: string): NoteCandidate {
  return {
    id,
    text,
    provenance: {
      sessionId: "session-1",
      sourceEventId: `source-${id}`,
      sourceType: "answer",
      capturedAt: "2026-09-06T12:00:00.000Z",
      prompt: { id: "general", version: "3" },
      endpoint: {
        id: "endpoint-1",
        url: "wss://example.test",
        provider: "openai-compatible",
        model: "custom",
      },
      speaker: { label: "Art", role: "self" },
      latencyMs: { totalMs: 120 },
    },
  };
}

function withEndpoint(note: NoteCandidate, url: string): NoteCandidate {
  return {
    ...note,
    provenance: {
      ...note.provenance,
      endpoint: { ...note.provenance.endpoint, url },
    },
  };
}

function withAnswerProvider(note: NoteCandidate, profileId: string): NoteCandidate {
  return {
    ...note,
    provenance: {
      ...note.provenance,
      answerProvider: { profileId },
    },
  };
}
