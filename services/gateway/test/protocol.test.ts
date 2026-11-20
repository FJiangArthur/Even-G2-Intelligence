import {
  HELIX_PROTOCOL_VERSION,
  MAX_PROVIDER_CREDENTIAL_LENGTH,
  type SessionConfig,
} from "@helix/conversation-sdk";
import { describe, expect, it } from "vitest";
import { parseClientCommand } from "../src/protocol.js";

const session: SessionConfig = {
  sessionId: "session-credentials",
  endpoint: {
    id: "gateway",
    url: "wss://gateway.example.test/v2/conversations",
    provider: "self-hosted",
    model: "gateway-selected",
  },
  prompt: { id: "direct", version: "1", system: "Answer directly." },
  speaker: { label: "User", role: "self" },
};

function start(credentials?: unknown, sessionValue: unknown = session): Record<string, unknown> {
  return {
    protocolVersion: HELIX_PROTOCOL_VERSION,
    commandId: "command-1",
    sentAt: "2026-09-07T22:00:00.000Z",
    type: "session.start",
    session: sessionValue,
    ...(credentials === undefined ? {} : { credentials }),
  };
}

describe("runtime provider credential protocol", () => {
  it("accepts only the four trimmed credential fields on session.start", () => {
    const parsed = parseClientCommand(start({
      openai: " openai-runtime ",
      deepgram: "deepgram-runtime",
      soniox: "soniox-runtime",
      omi: "omi-runtime",
    }));
    expect(parsed).toMatchObject({
      ok: true,
      command: {
        type: "session.start",
        credentials: {
          openai: "openai-runtime",
          deepgram: "deepgram-runtime",
          soniox: "soniox-runtime",
          omi: "omi-runtime",
        },
      },
    });
  });

  it.each([
    ["apiKey", "must-not-echo-api-key"],
    ["accessToken", "must-not-echo-access-token"],
    ["secret", "must-not-echo-secret"],
    ["authorization", "must-not-echo-authorization"],
    ["unrelated", "must-not-echo-unknown"],
  ])("rejects the unknown root session.start field %s with a value-free fatal error", (field, submittedValue) => {
    const parsed = parseClientCommand({ ...start(), [field]: submittedValue });
    expect(parsed).toMatchObject({
      ok: false,
      code: "invalid-session-start-envelope",
      message: "session.start contains an unsupported field",
      fatal: true,
    });
    expect(JSON.stringify(parsed)).not.toContain(submittedValue);
  });

  it.each([{}, { openai: "   " }])("omits an empty normalized credential bundle", (credentials) => {
    const parsed = parseClientCommand(start(credentials));
    expect(parsed).toMatchObject({ ok: true, command: { type: "session.start" } });
    if (!parsed.ok) throw new Error("Expected session.start to parse");
    expect(parsed.command).not.toHaveProperty("credentials");
  });

  it.each(["apiKey", "accessToken"])(
    "rejects the nested session credential field %s without echoing its value",
    (field) => {
      const submittedValue = `must-not-echo-nested-${field}`;
      const parsed = parseClientCommand(start(undefined, {
        ...session,
        [field]: submittedValue,
      }));
      expect(parsed).toMatchObject({
        ok: false,
        code: "provider-credential-forbidden",
        sessionId: session.sessionId,
        fatal: true,
      });
      expect(JSON.stringify(parsed)).not.toContain(submittedValue);
    },
  );

  it("rejects a non-credential invalid session without echoing its raw value", () => {
    const submittedValue = "must-not-echo-invalid-mode";
    const parsed = parseClientCommand(start(undefined, {
      ...session,
      mode: submittedValue,
    }));
    expect(parsed).toMatchObject({
      ok: false,
      code: "invalid-session",
      sessionId: session.sessionId,
      fatal: true,
    });
    expect(JSON.stringify(parsed)).not.toContain(submittedValue);
  });

  it.each([
    { unknown: "must-not-echo-unknown" },
    { openai: { nested: "must-not-echo-nested" } },
    { deepgram: "x".repeat(MAX_PROVIDER_CREDENTIAL_LENGTH + 1) },
    { soniox: "line\nbreak" },
  ])("rejects malformed credentials with a value-free fatal error", (credentials) => {
    const serialized = JSON.stringify(credentials);
    const parsed = parseClientCommand(start(credentials));
    expect(parsed).toMatchObject({ ok: false, code: "provider-credential-invalid", fatal: true });
    expect(JSON.stringify(parsed)).not.toContain(serialized.slice(-24));
  });

  it("rejects provider credentials on every command after session start", () => {
    const parsed = parseClientCommand({
      protocolVersion: HELIX_PROTOCOL_VERSION,
      commandId: "command-2",
      sentAt: "2026-09-07T22:00:01.000Z",
      type: "query",
      sessionId: session.sessionId,
      requestId: "request-1",
      text: "What next?",
      speaker: session.speaker,
      credentials: { openai: "must-not-echo-late" },
    });
    expect(parsed).toMatchObject({ ok: false, code: "provider-credential-forbidden", fatal: true });
    expect(JSON.stringify(parsed)).not.toContain("must-not-echo-late");
  });
});
