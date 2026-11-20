# Helix Gateway

`@helix/gateway` is the self-hostable speech and conversation boundary for
Helix G2. The browser plugin sends raw PCM16 and session commands to
`/v2/conversations`; an optional BYOK envelope appears only on the initial
`session.start`. The server binds those keys to immutable per-session adapters,
calls the selected upstream directly, and never persists or echoes them.

Provider URLs, authorization headers, and keys are never serialized into
client events. `GET /health` exposes only health and the legacy gateway mode.

## Secret-free demo

From the `Helix-G2` repository root:

```bash
npm install
HELIX_MODE=mock npm run dev:gateway
```

Mock mode transcribes every committed turn as `HELIX_MOCK_TRANSCRIPT` and
streams deterministic answers. It exercises the full SDK/plugin UI path
without a provider account or network call.

To use an env file:

```bash
npm run build -w @helix/gateway
node --env-file=services/gateway/.env services/gateway/dist/bin.js
```

## Wire flow

The gateway consumes the strict types exported by
`@helix/conversation-sdk` 0.3.0 using wire protocol 2.1. One socket owns one session:

1. Open `ws://HOST:PORT/v2/conversations` with the `helix.v2` subprotocol.
2. Send `session.start`.
3. Before each binary message, send matching `audio.frame` metadata.
4. Send exactly `sampleCount` raw little-endian signed PCM16 samples. Audio is
   fixed at 16 kHz, mono.
5. Send `audio.commit` with the last frame sequence, or `query` for an
   explicit manual answer.
6. Send `session.end` when finished.

The gateway emits `session.started`, `transcript.final`,
`question.detected`, `answer.delta`, `answer.completed`,
`note.suggested`, and typed `error` events. Session acceptance and event
context echo the actual mode, response strategy, memory settings, automation
settings, and selected non-secret provider IDs/models. When the client supplies
automation, `accepted.automation` is an exact acknowledgement of all three
booleans: `detectQuestions`, `answerQuestions`, and `saveNotes`.

On commit, the current audio buffer is snapshotted and cleared before any
upstream work. New G2 audio therefore continues to be accepted while a prior
STT, memory, or answer request is pending. Multiple detected questions start
their answer streams concurrently, but client-visible deltas/completions remain
in source order.

## Server-side provider profiles

Transcription and answering are selected independently:

- transcription: `mock`, `openai-compatible`, `deepgram`, or `soniox`;
- answering: `mock`, `openai-responses`, or `openai-compatible`.

`session.providers.transcriptionProvider` and
`session.providers.answerProvider` contain profile IDs only. The gateway
resolves them against `HELIX_ALLOWED_TRANSCRIPTION_PROFILES` and
`HELIX_ALLOWED_ANSWER_PROFILES`. An unavailable ID rejects session start with
a typed error.

The G2 companion defaults both selectors to **Gateway default**. This is a UI
sentinel, not a provider profile: the plugin omits the corresponding member from
`session.providers`, and the gateway resolves `HELIX_TRANSCRIPTION_PROVIDER` or
`HELIX_ANSWER_PROVIDER`. The resulting profile and model are always returned in
`session.started.accepted`; the literal string `gateway-default` is never sent.

Built-in profile metadata can be configured and allowlisted without an
environment key. At session start, the matching non-empty BYOK key wins for
that session; otherwise the server environment key is used. If neither exists,
startup fails with `provider-credential-required`. Keys never change the
server-controlled endpoint, model, path, headers, or allowlist.

| Provider | Server variables | Default model |
| --- | --- | --- |
| OpenAI transcription | `HELIX_OPENAI_API_KEY` | `gpt-4o-mini-transcribe` |
| OpenAI Responses | `HELIX_OPENAI_API_KEY` | `gpt-4.1-mini` |
| Deepgram | `HELIX_DEEPGRAM_API_KEY` | `nova-3` |
| Soniox | `HELIX_SONIOX_API_KEY` | `stt-rt-v5` |

`HELIX_API_KEY` remains a compatibility alias for the OpenAI environment
fallback. The client-side logical key is `credentials.openai`; the other exact
fields are `deepgram`, `soniox`, and `omi`. Each is capped at 8,192 characters
and accepted only on `session.start`.

Named profiles use credential-free JSON; the effective key comes from the
matching session BYOK field or provider environment fallback. They are
selectable by the reusable SDK or another custom client. The G2 companion's v0.3 selector intentionally
offers only the built-in IDs listed above; dynamic profile discovery is future
work.

```dotenv
HELIX_TRANSCRIPTION_PROFILES_JSON={"meeting-stt":{"kind":"deepgram","model":"nova-3"}}
HELIX_ANSWER_PROFILES_JSON={"fast-answer":{"kind":"openai-responses","model":"gpt-4.1-mini"}}
HELIX_TRANSCRIPTION_PROVIDER=meeting-stt
HELIX_ANSWER_PROVIDER=fast-answer
HELIX_ALLOWED_TRANSCRIPTION_PROFILES=mock,meeting-stt
HELIX_ALLOWED_ANSWER_PROFILES=mock,fast-answer
```

Deepgram receives the committed raw body with
`Content-Type: audio/l16;rate=16000`,
`encoding=linear16&sample_rate=16000&smart_format=true`, and
`Authorization: Token …`. For a live G2 turn, Soniox opens one official
real-time WebSocket when the first audio frame arrives, sends the v5 PCM
configuration, forwards subsequent binary PCM frames as they arrive, and sends
an empty binary frame on `audio.commit`. It concatenates only final tokens until
Soniox reports `finished`. If the generic buffered `transcribe()` path is used
instead, the adapter splits PCM into 3,840-byte chunks (120 ms at 16 kHz mono
PCM16) and waits 120 ms between chunks before the same empty final frame.

OpenAI Responses sends per-request `model`, protected `instructions`,
`input`, and `stream: true`, parsing only
`response.output_text.delta` SSE events. The custom OpenAI-compatible route
retains multipart `/audio/transcriptions` and streaming
`/chat/completions` support.

Upstream HTTP/WS plaintext is accepted only for loopback development. Public
provider endpoints must use HTTPS/WSS. Base URLs reject user information,
query, and fragments; configured request paths cannot escape their origin.

## Modes and response strategy

The protected server prompt is augmented with one G1-style mode:
`general`, `interviewee`, `interviewer`, `social`,
`office-discussion`, or `passive`.

- `reactive`: automatically answer detected questions only.
- `proactive`: automatically intervene only for useful non-question
  decisions, actions, blockers, or risks.
- `both`: enable both behaviors.

Manual `query` commands always answer. Proactive pickup is deterministic and
suppresses acknowledgements, filler, and short fragments. `passive` never
proactively interrupts. Answer context records `question`, `proactive`, or
`manual` as its trigger.

Question pickup is a fast local pass with no extra LLM round trip for obvious
questions. It preserves source order, deduplicates, returns at most three, and
covers explicit `?`, `？`, `؟` plus common unpunctuated English, Chinese,
Arabic, Spanish, and Japanese forms.

## Omi memory and automatic notes

Set `HELIX_OMI_API_KEY` as an administrator fallback, or submit an Omi BYOK key,
to allow a session to request `memory.readOmiContext`. At session start, the gateway prefetches at most 25
recent memories from `GET /v1/dev/user/memories`, optionally filtering
`categories=interesting|system|manual`. It ranks that bounded cache locally
by normalized token overlap with each question/utterance and injects only the
top relevant entries under strict count/character caps. A short answer deadline
prevents Omi latency from blocking the critical path; failures are sanitized,
non-secret, and answers continue without memory.

The Omi `/v1/dev/user/memories` route is the unchanged upstream Developer API;
it is independent of Helix protocol `2.1`, `helix.v2`, and the Helix
`/v2/conversations` WebSocket route.

Omi writes require all three:

- a session Omi key or server `HELIX_OMI_API_KEY`;
- server `HELIX_OMI_WRITE_ENABLED=true`; and
- session `memory.syncNotes=true`.

Only notes already accepted by the gateway safety/dedup policy are posted to
`POST /v1/dev/user/memories`, with content capped at 500 characters. The
first `note.suggested` reports Omi `pending`; a later event for the same note
reports `synced` only after a successful POST, or `failed` while preserving
the local suggestion.

The automatic-note policy first requires at least one conservative useful-memory
signal: a decision or commitment; next step, action item, follow-up, owner, or
deadline; requirement, preference, risk, blocker, trade-off, or priority; or an
explicit first-person/team/project plan or obligation. Otherwise the candidate
is rejected as `not-useful`. It also rejects uncertainty, canned failures,
credentials/JWTs/private keys, common financial identifiers, explicit medical
details, questions, and same-session duplicates. Provenance includes source
event, prompt, redacted endpoint, speaker, latency, mode, strategy, both provider
selections, and response trigger.

## Prompt and gateway authentication

`HELIX_SYSTEM_PROMPT`, `HELIX_PROMPT_ID`, and
`HELIX_PROMPT_VERSION` are protected server settings. Client prompt text is
ignored unless `HELIX_ALLOW_CLIENT_PROMPT=true`; when allowed, it remains
subordinate and cannot replace the protected instruction.

Set `HELIX_GATEWAY_TOKEN` to require browser authentication:

```ts
new WebSocket(url, helixWebSocketProtocols(shortLivedAccessToken));
```

The browser offers `helix.v2` and
`helix-auth.<base64url-short-lived-token>`; the gateway timing-safely compares
the decoded token and selects only `helix.v2`. Do not put any token in a URL.
The gateway token is handshake authentication; provider keys use only the
bounded command-level `session.start.credentials` envelope over WSS.

## Verification

```bash
npm run build -w @helix/gateway
npm run test -w @helix/gateway
```

The suite uses deterministic mocked HTTP/WebSocket transports only. It covers
profile validation/redaction and selection, exact Deepgram and Soniox request
flows, OpenAI Responses SSE parsing, Omi GET/POST/ranking/deadlines/outcomes,
mode/strategy behavior, multilingual question fixtures, note safety,
continuous audio ingestion during upstream latency, manual query concurrency,
and source-ordered answer completion. It makes no live credential call.
