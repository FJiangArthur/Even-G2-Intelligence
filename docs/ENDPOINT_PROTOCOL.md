# Helix conversation gateway protocol

Status: implemented contract, protocol `2.1`

Transport: WebSocket at `wss://<allowlisted-gateway>/v2/conversations`

Audio: each `audio.frame` JSON command is followed immediately by one binary frame of raw PCM16LE, 16 kHz, mono audio. One socket carries one active session.

## Authentication

The browser opens the socket with the `helix.v2` subprotocol. When the gateway requires an access token, it also offers `helix-auth.<base64url-token>` during the WebSocket handshake. The server selects only `helix.v2`; the token never appears in a URL, JSON command, persisted plugin setting, or provider request. Phase 0 compares this value with the operator-configured `HELIX_GATEWAY_TOKEN`; issuance, expiry, refresh, and per-user authorization belong to the Phase 3 pairing service.

Provider keys can come from server environment fallbacks or the optional
command-level `session.start.credentials` envelope. The latter accepts only
`openai`, `deepgram`, `soniox`, and `omi`, trims blanks, caps each value at
8,192 characters, and is never echoed. Any credential field elsewhere is
rejected and the socket is closed. BYOK clients must connect over WSS.

Version 0.3 uses `HELIX_PROTOCOL_VERSION = "2.1"`, WebSocket subprotocol `helix.v2`, and route `/v2/conversations`. The command revision adds the optional transient credential envelope, so BYOK clients and gateways must be deployed together. Credential-free 2.1 clients preserve the environment-key and mock flows. Event readers tolerate unknown additive members while continuing to reject credentials in every server event.

## Common envelopes

Every client command includes:

```json
{
  "protocolVersion": "2.1",
  "commandId": "command_01",
  "sentAt": "2026-09-06T18:00:00.000Z",
  "type": "session.start"
}
```

Every gateway event includes:

```json
{
  "protocolVersion": "2.1",
  "eventId": "event_01",
  "sessionId": "session_01",
  "occurredAt": "2026-09-06T18:00:00.010Z",
  "type": "session.started"
}
```

IDs are opaque strings. Timestamps are ISO 8601. Unknown, malformed, oversized, out-of-sequence, or wrong-session commands produce typed errors.

## Client commands

### Start a session

```json
{
  "protocolVersion": "2.1",
  "commandId": "command_01",
  "sentAt": "2026-09-06T18:00:00.000Z",
  "type": "session.start",
  "session": {
    "sessionId": "session_01",
    "endpoint": {
      "id": "my-endpoint",
      "url": "wss://helix.example.com/v2/conversations",
      "provider": "openai-compatible",
      "model": "my-model"
    },
    "prompt": {
      "id": "default-direct",
      "version": "1",
      "system": "Answer directly in no more than three sentences.",
      "mode": "general",
      "maxResponseSentences": 3
    },
    "audio": {
      "encoding": "pcm_s16le",
      "sampleRateHz": 16000,
      "channels": 1
    },
    "locale": "en",
    "speaker": {
      "label": "G2 conversation",
      "role": "unknown"
    },
    "mode": "office-discussion",
    "responseStrategy": "both",
    "providers": {
      "transcriptionProvider": "deepgram",
      "answerProvider": "openai-responses"
    },
    "memory": {
      "readOmiContext": true,
      "syncNotes": true
    },
    "automation": {
      "detectQuestions": true,
      "answerQuestions": true,
      "saveNotes": true
    },
    "client": {
      "name": "@helix/g2-plugin",
      "version": "0.3.0",
      "device": "Even Realities G2"
    }
  },
  "credentials": {
    "openai": "<entered at runtime>",
    "deepgram": "<entered at runtime>",
    "soniox": "<entered at runtime>",
    "omi": "<entered at runtime>"
  }
}
```

The endpoint object is browser-safe provenance and routing identity. It contains the fixed Helix server URL, not an upstream credential. `providers` contains server-owned, allowlisted profile IDs—not URLs or keys. `credentials` is outside `session`, appears only on this command, and never grants endpoint/model/profile authority. The effective key is the matching session key, then the server environment fallback. The G2 UI value **Gateway default** is not a profile ID: for each selector left at that default, the plugin omits the corresponding `providers` member and the server resolves its configured default before applying the matching key. The accepted event reports only the resolved profile/model.

Known modes are `general`, `interviewee`, `interviewer`, `social`, `office-discussion`, and `passive`. `reactive` answers detected questions, `proactive` intervenes only on useful non-question actions/decisions/blockers/risks, and `both` enables both automatic paths. A manual `query` works under every strategy. Omi settings are explicit opt-ins and a gateway rejects the start when the requested capability is not configured.

### Send an audio frame

First send metadata:

```json
{
  "protocolVersion": "2.1",
  "commandId": "command_02",
  "sentAt": "2026-09-06T18:00:00.020Z",
  "type": "audio.frame",
  "sessionId": "session_01",
  "sequence": 1,
  "sampleCount": 320,
  "sampleRateHz": 16000,
  "channels": 1,
  "source": "glasses",
  "direction": 12,
  "speakerRole": "other",
  "capturedAt": "2026-09-06T18:00:00.019Z"
}
```

Then send exactly 640 binary bytes for the 320 signed 16-bit samples. `direction` and `speakerRole` preserve the G2 SDK’s per-frame hints; neither is treated as a stable speaker identity.

### Commit buffered audio

```json
{
  "protocolVersion": "2.1",
  "commandId": "command_03",
  "sentAt": "2026-09-06T18:00:01.000Z",
  "type": "audio.commit",
  "sessionId": "session_01",
  "sequence": 25,
  "reason": "vad",
  "speaker": {
    "label": "Other speaker",
    "role": "other"
  }
}
```

The sequence must equal the most recently received audio frame and must be newer than the previous commit. Automatic VAD and manual long-press release use the same command.

### Ask a typed question

```json
{
  "protocolVersion": "2.1",
  "commandId": "command_04",
  "sentAt": "2026-09-06T18:00:02.100Z",
  "type": "query",
  "sessionId": "session_01",
  "requestId": "query_01",
  "text": "What should I clarify next?",
  "speaker": {
    "label": "You",
    "role": "self"
  }
}
```

### End a session

```json
{
  "protocolVersion": "2.1",
  "commandId": "command_05",
  "sentAt": "2026-09-06T18:05:00.000Z",
  "type": "session.end",
  "sessionId": "session_01",
  "reason": "user"
}
```

Allowed reasons are `user`, `client-error`, and `shutdown`.

## Gateway events

### Session accepted

```json
{
  "protocolVersion": "2.1",
  "eventId": "event_01",
  "sessionId": "session_01",
  "occurredAt": "2026-09-06T18:00:00.010Z",
  "type": "session.started",
  "accepted": {
    "prompt": { "id": "helix-conversation", "version": "1" },
    "endpoint": {
      "id": "my-endpoint",
      "url": "urn:helix:provider:my-endpoint",
      "provider": "openai-compatible",
      "model": "my-model"
    },
    "audio": {
      "encoding": "pcm_s16le",
      "sampleRateHz": 16000,
      "channels": 1
    },
    "mode": "office-discussion",
    "responseStrategy": "both",
    "transcriptionProvider": { "profileId": "deepgram", "model": "nova-3" },
    "answerProvider": { "profileId": "openai-responses", "model": "gpt-4.1-mini" },
    "memory": { "readOmiContext": true, "syncNotes": true },
    "automation": {
      "detectQuestions": true,
      "answerQuestions": true,
      "saveNotes": true
    }
  }
}
```

The accepted prompt and endpoint describe the server-selected policy and answer model. The endpoint URL is an opaque `urn:helix:provider:*` identifier, so the upstream host, path, and credentials never reach the client. Separate profile selections identify transcription and answering. `accepted.automation` acknowledges `detectQuestions`, `answerQuestions`, and `saveNotes` exactly; the SDK checks each explicitly requested boolean and rejects an omission or substitution as `SESSION_ACCEPTANCE_MISMATCH`. Explicit mode, strategy, provider, and memory requests are checked the same way. This accepted selection is copied into downstream provenance.

### Final transcript and detected question

```json
{
  "protocolVersion": "2.1",
  "eventId": "event_02",
  "sessionId": "session_01",
  "occurredAt": "2026-09-06T18:00:01.250Z",
  "type": "transcript.final",
  "transcriptId": "transcript_01",
  "text": "Could you explain the delivery risk?",
  "context": {
    "prompt": { "id": "helix-conversation", "version": "1" },
    "endpoint": {
      "id": "my-endpoint",
      "url": "urn:helix:provider:my-endpoint",
      "provider": "openai-compatible",
      "model": "my-model"
    },
    "speaker": { "label": "Other speaker", "role": "other" },
    "latencyMs": { "captureMs": 1000, "transcriptionMs": 240, "totalMs": 250 }
  }
}
```

```json
{
  "protocolVersion": "2.1",
  "eventId": "event_03",
  "sessionId": "session_01",
  "occurredAt": "2026-09-06T18:00:01.252Z",
  "type": "question.detected",
  "questionId": "question_01",
  "text": "Could you explain the delivery risk?",
  "confidence": 0.92,
  "sourceTranscriptId": "transcript_01",
  "context": {
    "prompt": { "id": "helix-conversation", "version": "1" },
    "endpoint": {
      "id": "my-endpoint",
      "url": "urn:helix:provider:my-endpoint",
      "provider": "openai-compatible",
      "model": "my-model"
    },
    "speaker": { "label": "Other speaker", "role": "other" },
    "latencyMs": {
      "captureMs": 1000,
      "transcriptionMs": 240,
      "questionDetectionMs": 1,
      "totalMs": 252
    }
  }
}
```

`transcript.partial` uses the same context plus `text` and a monotonically increasing `revision`; partial STT is reserved for a provider that supports it.

### Streaming answer

```json
{
  "protocolVersion": "2.1",
  "eventId": "event_04",
  "sessionId": "session_01",
  "occurredAt": "2026-09-06T18:00:01.700Z",
  "type": "answer.delta",
  "answerId": "answer_01",
  "questionId": "question_01",
  "delta": "The main risk is ",
  "context": {
    "prompt": { "id": "helix-conversation", "version": "1" },
    "endpoint": {
      "id": "my-endpoint",
      "url": "urn:helix:provider:my-endpoint",
      "provider": "openai-compatible",
      "model": "my-model"
    },
    "speaker": { "label": "Other speaker", "role": "other" },
    "latencyMs": { "firstTokenMs": 700, "totalMs": 700 }
  }
}
```

`answer.completed` has the same IDs and context, replaces `delta` with final `text`, and records `completionMs` and `totalMs`. The gateway’s OpenAI-compatible adapter consumes upstream SSE incrementally; it does not replay a buffered answer as fake streaming.

### Automatic note suggestion

```json
{
  "protocolVersion": "2.1",
  "eventId": "event_06",
  "sessionId": "session_01",
  "occurredAt": "2026-09-06T18:00:02.250Z",
  "type": "note.suggested",
  "note": {
    "id": "note_01",
    "title": "Could you explain the delivery risk",
    "text": "The main risk is the untested hardware resume path.",
    "tags": ["helix", "automatic", "question"],
    "persistence": {
      "destination": "omi",
      "status": "pending"
    },
    "provenance": {
      "sessionId": "session_01",
      "sourceEventId": "event_05",
      "sourceType": "answer",
      "capturedAt": "2026-09-06T18:00:02.250Z",
      "prompt": { "id": "helix-conversation", "version": "1" },
      "endpoint": {
        "id": "my-endpoint",
        "url": "urn:helix:provider:my-endpoint",
        "provider": "openai-compatible",
        "model": "my-model"
      },
      "speaker": { "label": "Other speaker", "role": "other" },
      "latencyMs": { "completionMs": 1250, "totalMs": 1250 }
    }
  },
  "context": {
    "prompt": { "id": "helix-conversation", "version": "1" },
    "endpoint": {
      "id": "my-endpoint",
      "url": "urn:helix:provider:my-endpoint",
      "provider": "openai-compatible",
      "model": "my-model"
    },
    "speaker": { "label": "Other speaker", "role": "other" },
    "latencyMs": { "completionMs": 1250, "totalMs": 1250 }
  }
}
```

The gateway emits a note only if the text first matches a conservative useful-memory signal: a decision/commitment; action item, next step, follow-up, owner, or deadline; requirement, preference, risk, blocker, trade-off, or priority; or an explicit first-person/team/project plan or obligation. A candidate without one is rejected as `not-useful`. It must also pass deterministic canned-error, uncertainty, sensitive-content, question-like, and recent-duplicate checks. The browser SDK then invokes its configured `NoteSink` automatically. Its current local sink is bounded and volatile, so the UI labels it as captured for the session rather than locally saved.

When Omi sync is requested and enabled, the first safe note event carries `pending`. The gateway later emits the same note ID with `synced` and an optional opaque `recordId`, or `failed` and a stable `failureCode`. Absence of `persistence` is not evidence of remote storage. Omi credentials and error bodies never cross the gateway boundary.

### Typed failure

```json
{
  "protocolVersion": "2.1",
  "eventId": "event_07",
  "sessionId": "session_01",
  "occurredAt": "2026-09-06T18:00:03.000Z",
  "type": "error",
  "code": "provider-rate-limited",
  "message": "Conversation provider request was rate limited",
  "retryable": true,
  "fatal": false
}
```

Provider error bodies and credentials must never be echoed to the client.

## Current ordering guarantees

- Audio frame sequences increase for the life of a session; each commit names its last included frame.
- A committed audio buffer is isolated from later frames before slow STT or answer work starts.
- Up to three questions from one transcript may be answered concurrently, while completed results and note decisions are applied in source order.
- A manual query and committed audio turn may run while the client continues sending audio.
- The SDK deduplicates accepted note text per session and rejects reuse of a note ID with different content.

Protocol-level replay deduplication, reconnect/resume, cancellation, durable local note receipts, fast/deep query roles, and partial-transcript question pickup are planned extensions; this document does not claim them for the current build.

## Server endpoint roles

The gateway has independent allowlists for transcription and answers. Implemented STT adapters are `mock`, OpenAI-compatible multipart transcription, Deepgram prerecorded raw PCM16, and Soniox real-time WebSocket transcription. For Soniox, one socket starts on the first live frame of a turn, receives subsequent frames immediately, and receives an empty binary final frame on commit; the generic buffered fallback sends 3,840-byte PCM chunks with 120 ms pacing. Implemented answer adapters are `mock`, OpenAI Responses, and OpenAI-compatible chat completions. Profiles, models, endpoints, and all Deepgram, Soniox, OpenAI, custom-provider, and Omi keys are configured entirely through server environment variables. The Omi client continues to call its independent `/v1/dev/user/memories` API; this is not a Helix v1 route. Future roles may add classifier, fast/deep answer, fact-check, or additional memory sinks without changing the client secret boundary.
