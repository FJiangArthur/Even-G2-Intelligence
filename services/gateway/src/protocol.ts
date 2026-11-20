import {
  HELIX_PROTOCOL_VERSION,
  normalizeSessionStartCredentials,
  validateSessionConfig,
  type AudioFrameCommand,
  type ClientCommand,
  type SessionConfig,
  type Speaker,
} from "@helix/conversation-sdk";

export type CommandParseResult =
  | { readonly ok: true; readonly command: ClientCommand }
  | {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
    readonly sessionId?: string;
    readonly fatal: boolean;
  };

const SESSION_START_KEYS = new Set([
  "protocolVersion",
  "commandId",
  "sentAt",
  "type",
  "session",
  "credentials",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAudioFrameCommand(value: Record<string, unknown>): value is Record<string, unknown> & AudioFrameCommand {
  return (
    Number.isSafeInteger(value.sequence)
    && (value.sequence as number) >= 1
    && Number.isSafeInteger(value.sampleCount)
    && (value.sampleCount as number) >= 1
    && value.sampleRateHz === 16_000
    && value.channels === 1
    && (value.source === undefined || nonEmptyString(value.source, 128))
    && (
      value.direction === undefined
      || value.direction === null
      || (Number.isInteger(value.direction) && (value.direction as number) >= -32_768 && (value.direction as number) <= 32_767)
    )
    && (
      value.speakerRole === undefined
      || value.speakerRole === "self"
      || value.speakerRole === "other"
      || value.speakerRole === "unknown"
    )
    && (value.capturedAt === undefined || validTimestamp(value.capturedAt))
  );
}

function nonEmptyString(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maxLength;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSpeaker(value: unknown): value is Speaker {
  if (!isRecord(value)) return false;
  return (
    (value.id === undefined || nonEmptyString(value.id, 128))
    && nonEmptyString(value.label, 128)
    && (value.role === "self" || value.role === "other" || value.role === "unknown")
  );
}

function containsCredential(value: unknown, depth = 0): boolean {
  if (!isRecord(value) || depth > 5) return false;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api[_-]?key|authorization|credentials?|provider[_-]?key|secret|access[_-]?token)$/i.test(key)) {
      return true;
    }
    if (containsCredential(child, depth + 1)) return true;
  }
  return false;
}

function isSessionConfig(value: unknown): value is SessionConfig {
  try {
    validateSessionConfig(value);
    return true;
  } catch {
    return false;
  }
}

function extractedSessionId(value: Record<string, unknown>): string | undefined {
  if (typeof value.sessionId === "string") return value.sessionId;
  if (isRecord(value.session) && typeof value.session.sessionId === "string") {
    return value.session.sessionId;
  }
  return undefined;
}

/** Strict field-level validation for every JSON command accepted by the socket. */
export function parseClientCommand(value: unknown): CommandParseResult {
  if (!isRecord(value)) {
    return { ok: false, code: "invalid-command", message: "Command must be a JSON object", fatal: false };
  }
  const sessionId = extractedSessionId(value);
  const invalidEnvelope = (
    value.protocolVersion !== HELIX_PROTOCOL_VERSION
    || !nonEmptyString(value.commandId, 128)
    || !validTimestamp(value.sentAt)
    || typeof value.type !== "string"
  );
  if (invalidEnvelope) {
    return {
      ok: false,
      code: "invalid-command-envelope",
      message: `Commands require protocolVersion ${HELIX_PROTOCOL_VERSION}, commandId, sentAt, and type`,
      ...(sessionId === undefined ? {} : { sessionId }),
      fatal: false,
    };
  }

  if (value.type === "session.start") {
    if (Object.keys(value).some((key) => !SESSION_START_KEYS.has(key))) {
      return {
        ok: false,
        code: "invalid-session-start-envelope",
        message: "session.start contains an unsupported field",
        ...(sessionId === undefined ? {} : { sessionId }),
        fatal: true,
      };
    }
    if (containsCredential(value.session)) {
      return {
        ok: false,
        code: "provider-credential-forbidden",
        message: "Provider credentials must use the session.start credentials field",
        ...(sessionId === undefined ? {} : { sessionId }),
        fatal: true,
      };
    }
    if (!isSessionConfig(value.session)) {
      return {
        ok: false,
        code: "invalid-session",
        message: "session.start contains an invalid session, prompt, endpoint, audio, or speaker configuration",
        ...(sessionId === undefined ? {} : { sessionId }),
        fatal: true,
      };
    }
    let credentials;
    try {
      credentials = normalizeSessionStartCredentials(value.credentials);
    } catch {
      return {
        ok: false,
        code: "provider-credential-invalid",
        message: "session.start provider credentials are invalid",
        ...(sessionId === undefined ? {} : { sessionId }),
        fatal: true,
      };
    }
    return {
      ok: true,
      command: {
        protocolVersion: HELIX_PROTOCOL_VERSION,
        commandId: value.commandId,
        sentAt: value.sentAt,
        type: "session.start",
        session: value.session,
        ...(credentials === undefined ? {} : { credentials }),
      } as unknown as ClientCommand,
    };
  }

  if (containsCredential(value)) {
    return {
      ok: false,
      code: "provider-credential-forbidden",
      message: "Provider credentials are accepted only with session.start",
      ...(sessionId === undefined ? {} : { sessionId }),
      fatal: true,
    };
  }

  if (!nonEmptyString(value.sessionId, 128)) {
    return { ok: false, code: "invalid-session-id", message: "Command sessionId is required", fatal: false };
  }
  if (value.type === "session.end") {
    if (value.reason !== "user" && value.reason !== "client-error" && value.reason !== "shutdown") {
      return { ok: false, code: "invalid-command", message: "session.end reason is invalid", sessionId: value.sessionId, fatal: false };
    }
    return { ok: true, command: value as unknown as ClientCommand };
  }
  if (value.type === "audio.commit") {
    if (
      !Number.isSafeInteger(value.sequence)
      || (value.sequence as number) < 1
      || (value.reason !== "manual" && value.reason !== "vad")
      || !isSpeaker(value.speaker)
    ) {
      return { ok: false, code: "invalid-command", message: "audio.commit fields are invalid", sessionId: value.sessionId, fatal: false };
    }
    return { ok: true, command: value as unknown as ClientCommand };
  }
  if (value.type === "audio.frame") {
    if (!isAudioFrameCommand(value)) {
      return { ok: false, code: "invalid-command", message: "audio.frame fields are invalid", sessionId: value.sessionId, fatal: false };
    }
    return { ok: true, command: value as unknown as ClientCommand };
  }
  if (value.type === "query") {
    if (
      !nonEmptyString(value.requestId, 128)
      || !nonEmptyString(value.text, 4_000)
      || !isSpeaker(value.speaker)
    ) {
      return { ok: false, code: "invalid-command", message: "query fields are invalid", sessionId: value.sessionId, fatal: false };
    }
    return { ok: true, command: value as unknown as ClientCommand };
  }

  return {
    ok: false,
    code: "unknown-command",
    message: `Unsupported command type: ${value.type}`,
    ...(sessionId === undefined ? {} : { sessionId }),
    fatal: false,
  };
}
