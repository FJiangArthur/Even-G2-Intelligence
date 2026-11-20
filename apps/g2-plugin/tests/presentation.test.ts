import type {
  AnswerCompletedEvent,
  AnswerDeltaEvent,
  GatewayErrorEvent,
  NotePersistenceOutcome,
  NoteSuggestedEvent,
  QuestionDetectedEvent,
  TranscriptFinalEvent,
  FactCheckResult,
} from "@helix/conversation-sdk";
import { describe, expect, it, vi } from "vitest";
import { ConversationPresentation } from "../src/presentation";
import { AnswerPager, paginateAnswer } from "../src/answer-pager";

it("keeps explanation cards source-linked, clears cues on explicit asks and supports dismiss", () => {
  const p = new ConversationPresentation(); p.setStatus("listening");
  const insight = { id: "i", sessionId: "s", transcriptId: "t", term: "RAG", explanation: "Retrieval.", createdAt: "2026-09-12T00:00:00Z" };
  p.applyInsight(insight, true);
  expect(p.snapshot().feed[0]).toMatchObject({ kind: "insight", sourceTranscriptId: "t", sourceSessionId: "s", label: "RAG", body: "Retrieval." });
  expect(p.snapshot().glasses.cue?.text).toBe("RAG: Retrieval.");
  p.beginRequest(); expect(p.snapshot().glasses.cue).toBeUndefined(); expect(p.snapshot().glasses.manualPending).toBe(true);
  p.applyInsight({ ...insight, id: "busy" }, true); expect(p.snapshot().glasses.cue).toBeUndefined();
  p.dismissInsight("i"); expect(p.snapshot().feed.some(item => item.id === "i")).toBe(false);
  p.setStatus("stopped"); p.applyInsight({ ...insight, id: "late" }, true);
  expect(p.snapshot().feed.some(item => item.id === "late")).toBe(false);
});

it("keeps supported and unsourced checks phone-only and never interrupts an active answer", () => {
  const p = new ConversationPresentation(); p.setStatus("listening");
  const fact: FactCheckResult = { id: "fact", sessionId: "session", transcriptId: "transcript", claim: "Claim", summary: "Sourced correction", checkedAt: "2026-09-11T00:00:00Z", status: "supported", sources: [{ url: "https://example.com/source", title: "Source" }] };
  p.applyFactCheck(fact, true); expect(p.snapshot().glasses.answer).toBeUndefined();
  p.applyFactCheck({ ...fact, status: "contradicted", sources: [{ url: "javascript:alert(1)", title: "Unsafe" }] }, true);
  expect(p.snapshot().glasses.answer).toBeUndefined(); expect(p.snapshot().feed[0]?.sources).toEqual([]);
  p.apply(questionEvent("q", "A question")); p.apply(answerDeltaEvent("a", "q", "Partial answer"));
  p.applyFactCheck({ ...fact, status: "contradicted" }, true);
  expect(p.snapshot().glasses.answer?.text).toBe("Partial answer");
  p.setStatus("stopped"); p.applyFactCheck({ ...fact, id: "late", status: "contradicted" }, true);
  expect(p.snapshot().feed.some(item => item.id === "late")).toBe(false);
});

it("keeps a completed manual answer paging and expiring through automatic detection without an answer", () => {
  vi.useFakeTimers();
  const p = new ConversationPresentation();
  const pager = new AnswerPager(() => {});
  const unsubscribe = p.subscribe(({ glasses }) => pager.update(glasses.answer, glasses.answerResetRevision));
  try {
    p.beginRequest();
    p.apply(questionEvent("manual", "Help", "manual"));
    const answer = "A complete answer worth reading. ".repeat(45);
    const pages = paginateAnswer(answer);
    expect(pages.length).toBeGreaterThan(1);
    p.apply(answerCompletedEvent("answer", "manual", answer));
    vi.advanceTimersByTime(2000);
    p.apply(questionEvent("automatic", "Another question?")); // Detection enabled, auto-answer disabled.
    expect(p.snapshot().feed.some(item => item.id === "automatic")).toBe(true);
    expect(p.snapshot().glasses.answer?.id).toBe("answer");
    expect(pager.text).toBe(pages[0]);
    vi.advanceTimersByTime(8000);
    expect(pager.pageIndex).toBe(1);
    expect(pager.text).toBe(pages[1]);
    vi.runAllTimers();
    expect(pager.text).toBe("");
    p.apply(questionEvent("later", "Still listening?"));
    expect(pager.text).toBe("");
  } finally { unsubscribe(); pager.dispose(); vi.useRealTimers(); }
});

it("clears requests immediately, rejects retired streams, and keeps a manual answer through unrelated detection", () => {
  const p = new ConversationPresentation();
  p.setStatus("listening");
  p.apply(questionEvent("q1", "Old question"));
  p.apply(answerDeltaEvent("a1", "q1", "Old output"));
  p.beginRequest();
  expect(p.snapshot().glasses.answer).toBeUndefined();
  expect(p.snapshot().feed.some(item => item.body === "Old output")).toBe(true);
  expect(p.snapshot().feed.find(item => item.body === "Old output")?.streaming).toBe(false);
  expect(p.snapshot().feed.find(item => item.body === "Old output")?.label).toContain("interrupted");
  p.apply(answerDeltaEvent("a1", "q1", " stale"));
  expect(p.snapshot().glasses.answer).toBeUndefined();
  p.apply(questionEvent("q2", "Manual request", "manual"));
  p.apply(answerDeltaEvent("a2", "q2", "Manual answer"));
  p.apply(questionEvent("q3", "Unrelated speech?"));
  expect(p.snapshot().glasses.answer).toMatchObject({ id: "a2", questionId: "q2", text: "Manual answer" });
  p.apply(answerCompletedEvent("a2", "q2", "Manual answer completed"));
  expect(p.snapshot().glasses.answer?.text).toBe("Manual answer completed");
  p.beginRequest();
  p.apply(answerCompletedEvent("a2", "q2", "Late old completion"));
  expect(p.snapshot().glasses.answer).toBeUndefined();
});

it("clears output and rejects late tokens after failure or stop", () => {
  for (const status of ["failed", "stopped", "exited", "ready"]) {
    const p = new ConversationPresentation();
    p.apply(answerDeltaEvent("a", "q", "Answer"));
    p.setStatus(status);
    p.apply(answerDeltaEvent("a", "q", " late"));
    expect(p.snapshot().glasses.answer).toBeUndefined();
  }
});

it("allows a new answer identity for the same question and ignores the superseded identity", () => {
  const p = new ConversationPresentation();
  p.apply(questionEvent("q", "Question?"));
  p.apply(answerDeltaEvent("a", "q", "First"));
  p.apply(answerDeltaEvent("b", "q", "Replacement"));
  p.apply(answerDeltaEvent("a", "q", " stale"));
  p.apply(answerDeltaEvent("b", "q", " continues"));
  p.apply(questionEvent("q", "Question?"));
  expect(p.snapshot().glasses.answer).toMatchObject({ id: "b", text: "Replacement continues" });
});

it("retires submit feedback on reply completion without overriding an active hold", () => {
  const presentation = new ConversationPresentation();
  presentation.setInteraction("SENT / WAITING FOR RESPONSE");
  presentation.apply(answerDeltaEvent("a", "q", "Hello"));
  expect(presentation.snapshot().glasses.interaction).toBe("ANSWER / RECEIVING");
  presentation.apply(answerCompletedEvent("a", "q", "Hello there"));
  expect(presentation.snapshot().glasses.interaction).toBeUndefined();
  presentation.setInteraction("[ HOLDING ] RELEASE TO SUBMIT");
  presentation.apply(answerCompletedEvent("b", "q", "Another answer"));
  expect(presentation.snapshot().glasses.interaction).toContain("HOLDING");
});

const context = {
  prompt: { id: "prompt", version: "1" },
  endpoint: {
    id: "gateway",
    url: "ws://127.0.0.1:8787/v2/conversations",
    provider: "mock",
    model: "mock-fast",
  },
  speaker: { label: "Helix", role: "unknown" as const },
  latencyMs: { totalMs: 12 },
};

function noteEvent(
  id: string,
  title?: string,
  persistence?: NotePersistenceOutcome,
): NoteSuggestedEvent {
  return {
    protocolVersion: "2.1",
    type: "note.suggested",
    eventId: `event_${id}`,
    sessionId: "session_1",
    occurredAt: "2026-09-07T00:00:00.000Z",
    note: {
      id,
      title,
      text: "Follow up with the team tomorrow.",
      persistence,
      provenance: {
        sessionId: "session_1",
        sourceEventId: "answer_1",
        sourceType: "answer",
        capturedAt: "2026-09-07T00:00:00.000Z",
        ...context,
      },
    },
    context,
  };
}

function questionEvent(
  id: string,
  text: string,
  trigger: "question" | "manual" = "question",
): QuestionDetectedEvent {
  return {
    protocolVersion: "2.1",
    type: "question.detected",
    eventId: `event_${id}`,
    sessionId: "session_1",
    occurredAt: "2026-09-07T00:00:00.000Z",
    questionId: id,
    text,
    confidence: trigger === "manual" ? 1 : 0.92,
    context: {
      ...context,
      speaker: trigger === "manual"
        ? { label: "You", role: "self" }
        : { label: "Other speaker", role: "other" },
      trigger,
    },
  };
}

function answerDeltaEvent(
  answerId: string,
  questionId: string | undefined,
  delta: string,
): AnswerDeltaEvent {
  return {
    protocolVersion: "2.1",
    type: "answer.delta",
    eventId: `event_${answerId}_delta`,
    sessionId: "session_1",
    occurredAt: "2026-09-07T00:00:00.000Z",
    answerId,
    ...(questionId === undefined ? {} : { questionId }),
    delta,
    context: { ...context, trigger: questionId === undefined ? "proactive" : "question" },
  };
}

function answerCompletedEvent(
  answerId: string,
  questionId: string,
  text: string,
): AnswerCompletedEvent {
  return {
    protocolVersion: "2.1",
    type: "answer.completed",
    eventId: `event_${answerId}_completed`,
    sessionId: "session_1",
    occurredAt: "2026-09-07T00:00:00.000Z",
    answerId,
    questionId,
    text,
    context: { ...context, trigger: "question" },
  };
}

describe("ConversationPresentation note state", () => {
  it("shows volatile session-only status explicitly for titled and untitled notes", () => {
    const presentation = new ConversationPresentation();

    presentation.apply(noteEvent("note_titled", "Next steps"));
    presentation.markNoteSaved("note_titled");
    expect(presentation.snapshot().feed.at(-1)?.label).toBe("Captured this session · Next steps");
    expect(presentation.snapshot().glasses.note?.delivery).toBe("session");

    presentation.apply(noteEvent("note_plain"));
    presentation.markNoteSaved("note_plain");
    expect(presentation.snapshot().feed.at(-1)?.label).toBe("Captured this session");
    expect(presentation.snapshot().glasses.note?.delivery).toBe("session");
  });

  it("does not conflate Omi sync success or failure with local capture", () => {
    const presentation = new ConversationPresentation();

    presentation.apply(noteEvent("note_synced", "Decision", {
      destination: "omi",
      status: "synced",
      recordId: "omi_record_1",
    }));
    presentation.markNoteSaved("note_synced");
    expect(presentation.snapshot().feed.at(-1)?.label).toBe("Omi synced · Decision");
    expect(presentation.snapshot().glasses.note?.delivery).toBe("omi-synced");

    presentation.apply(noteEvent("note_failed", undefined, {
      destination: "omi",
      status: "failed",
      failureCode: "authorization_required",
    }));
    presentation.markNoteSaved("note_failed");
    expect(presentation.snapshot().feed.at(-1)).toMatchObject({
      label: "Omi sync failed",
      meta: "Sync error: authorization_required",
      noteDelivery: "omi-failed",
    });
    expect(presentation.snapshot().glasses.note?.delivery).toBe("omi-failed");
  });
});

describe("ConversationPresentation question attribution", () => {
  it("pairs each streamed or completed answer with its own detected question on glasses", () => {
    const presentation = new ConversationPresentation();

    presentation.apply(questionEvent("question_1", "What ships first?"));
    presentation.apply(questionEvent("question_2", "Who owns the follow-up?"));
    expect(presentation.snapshot().glasses.question).toBeUndefined();
    expect(presentation.snapshot().feed.at(-1)?.body).toBe("Who owns the follow-up?");

    presentation.apply(answerDeltaEvent("answer_1", "question_1", "The SDK ships first."));
    expect(presentation.snapshot().glasses).toMatchObject({
      question: { text: "What ships first?", speaker: "Other speaker" },
      answer: { text: "The SDK ships first.", streaming: true },
    });

    presentation.apply(answerCompletedEvent(
      "answer_2",
      "question_2",
      "Morgan owns the follow-up.",
    ));
    expect(presentation.snapshot().glasses).toMatchObject({
      question: { text: "Who owns the follow-up?", speaker: "Other speaker" },
      answer: { text: "Morgan owns the follow-up.", streaming: false },
    });

    presentation.apply(answerDeltaEvent("answer_proactive", undefined, "One more useful detail."));
    expect(presentation.snapshot().glasses.question).toBeUndefined();
  });

  it("uses the gateway trigger and speaker as the source of truth for manual attribution", () => {
    const presentation = new ConversationPresentation();

    presentation.apply(questionEvent("query_1", "Summarize that decision.", "manual"));

    expect(presentation.snapshot().feed.at(-1)).toMatchObject({
      id: "query_1",
      label: "You · manual question",
      body: "Summarize that decision.",
    });
    expect(presentation.snapshot().glasses.question).toMatchObject({
      text: "Summarize that decision.",
      speaker: "You",
      confidence: 1,
    });
  });
});

describe("ConversationPresentation status detail", () => {
  it("exposes an exact asynchronous error until a successful event supersedes it", () => {
    const presentation = new ConversationPresentation();
    const errorEvent: GatewayErrorEvent = {
      protocolVersion: "2.1",
      type: "error",
      eventId: "event_error",
      sessionId: "session_1",
      occurredAt: "2026-09-07T00:00:00.000Z",
      code: "soniox-timeout",
      message: "Soniox did not respond before the transcription deadline",
      retryable: true,
      fatal: false,
    };
    const transcriptEvent: TranscriptFinalEvent = {
      protocolVersion: "2.1",
      type: "transcript.final",
      eventId: "event_transcript",
      sessionId: "session_1",
      occurredAt: "2026-09-07T00:00:01.000Z",
      transcriptId: "transcript_1",
      text: "The retry succeeded.",
      context,
    };

    presentation.setStatus("listening");
    presentation.apply(errorEvent);
    expect(presentation.snapshot()).toMatchObject({
      status: "listening",
      error: "Soniox did not respond before the transcription deadline",
    });

    presentation.apply(transcriptEvent);
    expect(presentation.snapshot().error).toBeUndefined();
    expect(presentation.snapshot().glasses.error).toBeUndefined();
    expect(presentation.snapshot().feed.at(-1)?.body).toBe("The retry succeeded.");
    expect(presentation.snapshot().glasses.transcript).toBeUndefined();
  });
});
