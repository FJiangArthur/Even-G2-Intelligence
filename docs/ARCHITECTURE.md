# Phone-only architecture — v0.5

```text
G2 microphone / gestures / 576×288 HUD
               ↕ Even SDK bridge (BLE owned by Even)
Even Realities app on the phone
  G2 adapter + companion UI
               ↕
  Helix conversation SDK
  VAD → PCM/WAV → transcript → question/mode policy → streamed answer
  Session history, prompt, provenance, conservative automatic notes
               ↕ direct HTTPS / provider WSS
  OpenAI | Deepgram | Soniox | optional Omi
```

There is no Helix server. `DirectConversationTransport` is an in-process adapter for existing typed SDK commands/events, despite legacy names such as `GatewayEvent`. The plugin never instantiates the legacy WebSocket gateway transport. The old gateway imports shared question/mode/note policy for regression compatibility only.

## Providers

| Purpose | Profile / model | Direct destination |
| --- | --- | --- |
| Whisper transcription (default) | openai-whisper / whisper-1 | OpenAI HTTPS audio/transcriptions |
| GPT transcription | openai-compatible / gpt-4o-mini-transcribe | OpenAI HTTPS audio/transcriptions |
| Deepgram transcription | deepgram / nova-3 | Deepgram HTTPS listen |
| Soniox transcription | soniox / stt-rt-v5 | Soniox provider WSS |
| GPT answers | Responses or Chat Completions; GPT-4.1 mini or GPT-4o mini | OpenAI HTTPS |
| Optional memory | explicitly enabled read/sync | Omi HTTPS |

The manifest contains only fixed provider origins. Soniox WSS belongs to Soniox, not a user-hosted Helix server. Arbitrary custom endpoints are not exposed in this release. Provider availability and WebView networking still need physical-device verification.

## Runtime and safety

- Keys are provided separately from non-secret config and remain session-private; disconnect clears credentials and aborts requests. No redirects or cookie credentials on provider fetches.
- Persistence is opt-in ordinary Even plugin local storage; never described as Keychain/secure storage. QA refuses key persistence.
- VAD submits short speech clips; continuously submitted PCM is committed at six-second boundaries. Silence-only/tiny clips do not upload. Pending STT segments are capped at four, with bounded request timeouts.
- Ordered STT ingestion is independent from answer generation. An explicit request aborts the previous answer immediately and waits only for the snapshot of speech already queued when pressed. Epoch checks suppress stale deltas/completions/errors and post-cancellation notes. New automatic requests do not preempt active manual help.
- A dedicated raw transcript retains the current session up to 96,000 UTF-8 bytes, with an actionable failure at the limit instead of silent trimming. Local focus is six sentences with lexically related earlier background; global context includes the whole captured session. Typed follow-ups use separate bounded manual/assistant history. Selected question/proactive instructions remain explicit answer targets.
- The glasses presentation is answer-only. One full-screen event-capture text container remains visually empty while idle; a timed pager advances through answers and expires the last page. Phone transcript updates cannot revive expired answers. Single and double press request local and global help; phone controls retain microphone pause/disconnect.
- Provider errors are sanitized. Auth/billing errors block further automatic calls and stop the microphone. Exit cancels work and suppresses late output.
- Omi is off by default. Enabling context sends selected memory content to the answer provider. Enabling sync sends accepted notes directly to Omi, with pending/synced/failed status.
- Automatic notes pass useful-content, uncertainty, sensitive-content and duplicate filters. Explicit spoken decisions can be captured before the answer. Without Omi, notes live only in the session's in-memory sink.

Historical server design is in LEGACY_GATEWAY_ARCHITECTURE.md, not the deployment target.
