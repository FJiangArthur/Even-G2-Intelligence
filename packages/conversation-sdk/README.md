# Helix Conversation SDK

Device-neutral TypeScript client for Helix conversation sessions. It owns typed
commands and events, session state, ordered PCM16 audio delivery, utterance
segmentation, manual questions, streamed-answer events, and safe automatic note
sinks. It has no dependency on the Even Hub SDK and contains no provider keys.

## Use

```ts
import {
  HelixConversationClient,
  InMemoryNoteSink,
  DirectConversationTransport,
} from '@helix/conversation-sdk'

const transport = new DirectConversationTransport()

const client = new HelixConversationClient(transport, {
  noteSink: new InMemoryNoteSink(),
  autoSaveSuggestedNotes: true,
})

await client.start({
  sessionId: crypto.randomUUID(),
  endpoint: {
    id: 'openai-direct',
    url: 'https://api.openai.com/v1/responses',
    provider: 'openai',
    model: 'gpt-4.1-mini',
  },
  prompt: {
    id: 'my-prompt',
    version: '1',
    system: 'Answer directly and concisely.',
    maxResponseSentences: 3,
  },
  mode: 'office-discussion',
  responseStrategy: 'both',
  // Fixed direct-provider profile IDs, never keys or arbitrary URLs.
  providers: {
    transcriptionProvider: 'openai-whisper',
    answerProvider: 'openai-responses',
  },
  memory: {
    readOmiContext: false,
    syncNotes: false,
  },
  audio: { encoding: 'pcm_s16le', sampleRateHz: 16_000, channels: 1 },
  speaker: { label: 'Conversation', role: 'unknown' },
  automation: {
    detectQuestions: true,
    answerQuestions: true,
    saveNotes: true,
  },
}, {
  // Runtime input, outside SessionConfig. Only the matching provider receives it.
  openai: openaiApiKey,
})

await client.sendAudio(samples, {
  source: 'glasses',
  speakerRole: 'other',
})
await client.ask('What should I clarify next?')
await client.askContext('local')  // Recent six sentences + relevant earlier background.
await client.askContext('global') // Whole captured session, not just the visible phone feed.
client.subscribe((event) => render(event))
await client.dispose()
```

`samples` must be a non-empty `Int16Array` containing mono 16 kHz PCM. Audio
metadata and binary bytes are serialized as one non-interleavable pair.

## v0.5 context and request lifecycle

`askContext(scope: ContextScope, speaker?: Speaker): Promise<string>` accepts `local` or `global` and returns the request ID. It requests an answer to the latest unresolved question, or a useful follow-up/next response if no question is present. `QueryCommand.contextScope` is optional, preserving ordinary `ask(text)` callers. Scope behavior is implemented by the direct phone adapter; legacy gateways do not gain it automatically.

Every manual request immediately supersedes the previous answer, aborts its provider operation and invalidates stale continuations. A context request waits for the snapshot of already-queued speech, not future audio. Automatic work cannot replace active explicit help. Transcription ingestion is separate from answer generation so a slow response does not hold up phone transcript updates.

`TranscriptContext` retains captured speech independently of UI feed limits and previous answers. The 96,000 UTF-8-byte limit raises actionable `context-limit` rather than deleting older speech. Local focus uses the last six punctuation-delimited sentences; related earlier context uses lexical matching, not semantic retrieval. Global includes the whole captured session. Ordinary typed follow-ups keep a separate bounded history of completed manual exchanges. Disconnect clears all in-memory session data.

The client commits continuously submitted PCM at six-second boundaries in addition to VAD/manual commits. This bounds clip duration, not network latency. Whisper emits completed clip transcripts; Soniox tentative tokens can produce `transcript.partial`. Consumers should render transcript events on the phone, and reserve glasses for answer deltas/completion.

## Conversation policy and provenance

`CONVERSATION_MODES` exposes `general`, `interviewee`, `interviewer`, `social`,
`office-discussion`, and `passive`. `RESPONSE_STRATEGIES` exposes `reactive`,
`proactive`, and `both`. The legacy prompt mode `interview` is accepted as input
and normalized to `interviewee`; custom legacy `prompt.mode` strings remain
source-compatible and are preserved in the prompt. A custom prompt mode does
not widen session policy: the normalized session mode defaults to `general`
unless a known session mode is also selected. New integrations should put
`mode` and `responseStrategy` at the session level.

`normalizeSessionConfig()` validates untrusted settings and returns the
canonical payload used by `HelixConversationClient.start()`. It supplies safe
defaults (`general`, `reactive`, no Omi context read, and no Omi note sync) and
normalizes provider profile IDs without accepting credentials.

`normalizeSessionStartCredentials()` separately accepts only `openai`,
`deepgram`, `soniox`, and `omi`, trims blank fields, and caps each value at
8,192 characters. `start(config, credentials)` sends the normalized envelope
only with `session.start`; credentials are not retained in normalized
`SessionConfig` or acceptance expectations. The direct adapter retains these only for the session and calls fixed HTTPS/WSS provider endpoints. Legacy WebSocket transport callers must use WSS for BYOK.

A gateway can report its actual selections through optional
`session.started.accepted` and `ConversationContext` fields:

```ts
{
  mode: 'office-discussion',
  responseStrategy: 'both',
  transcriptionProvider: { profileId: 'fast-stt', model: 'nova-3' },
  answerProvider: { profileId: 'private-answer', model: 'answer-2' },
  memory: { readOmiContext: true, syncNotes: true },
  automation: {
    detectQuestions: true,
    answerQuestions: true,
    saveNotes: true,
  },
  trigger: 'proactive',
}
```

These descriptors deliberately have no URL, authorization, or key field.
`trigger` is event provenance and is therefore present on conversation/note
context, not on session acceptance.

When a caller explicitly requests a known mode, response strategy, provider
profile, memory setting, or automation object, `start()` requires the gateway
to echo that choice exactly in `session.started.accepted`. Automation is checked
field by field (`detectQuestions`, `answerQuestions`, and `saveNotes`). An
omitted or substituted selection rejects the start with `HelixProtocolError`
code `SESSION_ACCEPTANCE_MISMATCH` and names the exact acknowledgement field.
Callers that omit optional settings remain compatible with a minimal protocol
2.1 acknowledgement. Wire protocol 1.0/`helix.v1` and 2.0 clients are
intentionally rejected because their strict readers cannot consume the current
event context and transient credential envelope safely.

The v0.4 G2 companion defaults to `openai-whisper` and `openai-responses`. Old mock/gateway defaults migrate to these phone-only choices. The WebSocket adapter remains available for legacy integrations but is not used by the G2 app.

An optional `note.persistence` value can truthfully report an Omi outcome as
`pending`, `synced`, or `failed`. If it is absent, consumers must not claim the
note reached Omi. A successful local `NoteSink` result alone is not Omi sync
evidence. `InMemoryNoteSink` applies persistence-only updates for the same note
from no outcome to `pending`, then to `synced` or `failed`; it rejects attempts
to regress or replace a terminal outcome and rejects any content or provenance
change under the same note ID.

## Trust boundaries

- Direct endpoint provenance accepts credential-free HTTPS; legacy WebSocket transport still accepts only WS/WSS. No user-supplied URL changes the direct adapter's fixed provider destinations.
- `helixWebSocketProtocols(token)` carries a gateway token in the WebSocket
  subprotocol negotiation; it does not place it in the URL or JSON commands.
- Provider and Omi keys are supplied for the active direct session. They never appear in gateway events,
  endpoint provenance, URLs, notes, or SDK persistence.
- The shared conservative `not-useful` gate runs before either adapter emits an automatic
  note; emitted notes still pass the SDK's mandatory provenance, credential,
  question, uncertainty, and deduplication checks before a sink can save them.
- `InMemoryNoteSink` is a Phase 0 demonstration sink, not durable storage.

See the repository's `docs/ENDPOINT_PROTOCOL.md` for the versioned wire
contract and `docs/ARCHITECTURE.md` for the G2 integration boundary.
