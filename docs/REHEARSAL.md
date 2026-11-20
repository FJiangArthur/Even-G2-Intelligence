# Rehearsal and end-to-end conversation testing (v0.7)

Goal: show that a whole conversation (an interview, a technical discussion, a regular meeting) runs through the Helix pipeline to the end. That means every detected question gets an answer, the copilot lane produces a summary, concepts, conflicts and asks, and nothing hangs or fails.

There are three layers:

| Layer | Where | Network | Proves |
|---|---|---|---|
| In-app rehearsal | `apps/g2-plugin/src/rehearsal.ts` + controller `rehearse()` | live OpenAI from the phone | The real app runs a scripted conversation to the end through `transport.injectTranscript` |
| Deterministic E2E | `apps/g2-plugin/tests/rehearsal.e2e.test.ts` + `tests/fake-openai.ts` | none (fake OpenAI) | Pipeline wiring, event ordering, completion, timing/cost bookkeeping, history archiving |
| Live harness | `scripts/live-rehearsal.mjs` | live OpenAI from your machine | Real model output, real STT, real latency and cost |

## Scripts

All three layers use one source, `apps/g2-plugin/src/rehearsal-scripts.json`. `rehearsal.ts` imports it, and the Node harness reads it directly.

| id | kind | What it exercises |
|---|---|---|
| `mock-interview-ml` | interview | Perception/ML interview practice: TensorRT and edge deployment questions, the acronym `CDTF`, a request not phrased as a question ("I'd like to hear about a time you dealt with a tight latency budget."), and a self-contradiction (30 FPS, later "about 12 FPS on Orin") |
| `hardware-planning` | technical | Robot compute planning: an implicit lookup ("Jetson devices are hard to order and have a long lead time right now"), an implicit proposal ("the architecture is 16 GB RAM with a 1 TB SSD"), a budget conflict ($40,000 vs $25,000), and the terms CDTF, NVMe and ROS 2 |
| `team-standup` | meeting | Decisions, owners, a ship-date change (Friday, then next Wednesday), and questions |

Each script has `expectations` (concepts, conflict, lookups, proposes, questions, implicitQuestions). The tests and the harness check results against them.

## 1. In-app rehearsal

`RehearsalPlayer` (in `rehearsal.ts`, pure, no DOM) plays a script line by line. It awaits each `inject(text, speaker)` before starting the next line. Between lines it pauses for `pauseMs / speed`; when a line has no `pauseMs`, the pause is the word count at about 150 wpm plus 600 ms. `stop()` aborts the run, including during a pause. Speaker mapping is `self` → `{label:"You", role:"self"}` and `other` → `{label:"Other speaker", role:"other"}`.

The integrator wires the player into `G2ConversationController.rehearse(scriptId, speed)` and `stopRehearsal()`, with `inject = transport.injectTranscript`. Injected text skips STT. Everything after STT is the real pipeline: question detection, answers, the copilot lane, notes and history. To use it, connect with your key in the phone UI, choose a rehearsal script and press play. A rehearsal makes real, billed OpenAI calls. They are cheap with the default models, and cost is shown per answer.

## 2. Deterministic E2E (no network)

```bash
npm run build -w @helix/conversation-sdk
cd apps/g2-plugin && npx vitest run tests/rehearsal.e2e.test.ts
```

`tests/fake-openai.ts` provides `createFakeOpenAI()`. It returns a `fetch` for `https://api.openai.com/v1/*` and a `webSocketFactory` for the realtime STT socket. Every output is computed from the request content, never chosen at random:

- `/audio/transcriptions`: returns the next text from a transcript queue, plus `usage.seconds`.
- `/responses` with `stream:true`: `response.output_text.delta` events, then `response.completed` with `usage {input_tokens, input_tokens_details.cached_tokens, output_tokens, output_tokens_details.reasoning_tokens}`. Requests that use web search also get `web_search_call` and `url_citation` annotation events.
- `/responses` JSON: a `text.format` json_schema is filled generically from the schema, using a conversation analysis that finds glossary terms (CDTF, NVMe, ROS 2, TensorRT…), conflicting FPS / $ / ship-day values, lookup / propose / implicit-question asks, and summary bullets. Fact-check and verify requests (web_search with a status JSON) return `supported` with citations.
- `/chat/completions`: SSE output. A usage chunk is added when `stream_options.include_usage` is set.
- `/realtime/client_secrets` and the `wss://…/realtime?intent=transcription` socket: `session.update` → `session.updated`; `input_audio_buffer.append` and `commit` → `committed`, then `…transcription.delta` events, then `…completed`. An empty commit gets the real `input_audio_buffer_commit_empty` error. The socket rejects a connection that lacks the `openai-insecure-api-key.<token>` subprotocol.
- Latency is configurable (`transcriptionMs`, `firstTokenMs`, `interTokenMs`, `jsonMs`, `webSearchMs`, `realtimeMs`) and every delay is abortable. Every request is recorded with its parsed body, classified `intent`, `stream`/`webSearch` flags and timestamps.

Test groups (copilot, realtime and controller groups switch on automatically once the API exists, see "Capability gates" below):

1. Script data and `RehearsalPlayer` behavior: serial playback, speed, stop, failure.
2. The fake's contract against real SDK parsers, including `WebFactChecker`.
3. Audio path → HTTP STT → answers through `HelixConversationClient` and `DirectConversationTransport`, for all scripts: completion, every question answered, speaker roles kept, key only in the header, latency against the fake's delays, a 401 that fails visibly.
4. `G2ConversationController` hold-to-talk for every line of every script: presentation feed, no failed status, history archived on the phone.
5. `injectTranscript` with the copilot lane: summary, CDTF and other concepts, conflicts, a lookup ask with sources, a propose ask done, AnswerMeta timing and cost > 0, and user `verify`.
6. Realtime STT over the fake socket: ephemeral token, 24 kHz session, one commit per turn, no HTTP uploads.
7. `controller.rehearse` and the presentation copilot snapshot.

With zero pauses, the test waits for each line's answers before it feeds the next line. In real speech, an answer streams while the next person is talking. Without the wait, a zero-gap next question would supersede the earlier answer. That is intended app behavior, and the live harness reports any such case as unanswered.

### Capability gates

Groups that depend on in-flight v0.7 APIs use `it` when the API exists and `it.todo` when it does not. Detection runs at runtime, so they switch on without any edit:

| Gate | Needs |
|---|---|
| `HAS_COPILOT_TRANSPORT` | `DirectConversationTransport.prototype.injectTranscript/verify/runCopilotNow`, plus options `copilot`, `onAnswerMeta`, `onUsage` |
| `HAS_REALTIME_STT` | `openai-realtime` in `TRANSCRIPTION_CATALOG` and a `webSocketFactory` option on the transport |
| `SdkCopilot` | `ConversationCopilot` exported from the SDK index |
| `HAS_REHEARSE && HAS_COPILOT_PRESENTATION` | `controller.rehearse(id, speed) → Promise<{completed, lines, durationMs}>`, `stopRehearsal()`, `verify(target, id?)`; presentation snapshot fields `summary, concepts, conflicts, suggestions, asks, verifications, answerMeta, usage` |

## 3. Live harness (your machine, your key)

The sandbox used for development blocks `api.openai.com` and YouTube, so run the harness on your own machine.

```bash
npm install && npm run build -w @helix/conversation-sdk
export OPENAI_API_KEY=sk-...          # environment only; never passed as an argument
node scripts/live-rehearsal.mjs --list
node scripts/live-rehearsal.mjs --script mock-interview-ml
node scripts/live-rehearsal.mjs --script hardware-planning --speed 3 --strict
node scripts/live-rehearsal.mjs --audio ~/Downloads/interview.m4a --max-seconds 600
node scripts/live-rehearsal.mjs --youtube 'https://www.youtube.com/watch?v=VIDEO_ID' --max-seconds 900
```

To download audio yourself:

```bash
yt-dlp -x --audio-format m4a -o interview.%(ext)s 'https://www.youtube.com/watch?v=VIDEO_ID'
node scripts/live-rehearsal.mjs --audio interview.m4a
```

`--youtube` needs `yt-dlp` and `ffmpeg` on PATH and prints an install hint if either is missing. Downloads go to `artifacts-v07/live/` and stay on your machine. Only use recordings you are allowed to process.

Behavior:

- **Key handling.** The key is read from `OPENAI_API_KEY` only. The harness refuses to run without it and rejects key-looking arguments. It never prints the key or writes it to disk, and it scrubs the key from the report as a defensive measure.
- **Preflight.** The harness calls `GET /v1/models` first. A DNS or connection failure, or a non-JSON block page from an egress proxy, ends with `api.openai.com unreachable — run outside the sandbox / allow the domain` (exit 3). A 401 is reported as a key problem.
- **`--script`.** Lines go through `transport.injectTranscript`, so there is no STT, with the script's pauses divided by `--speed`. After each line the harness waits up to `--settle-ms` for that line's answers.
- **`--audio` / `--youtube`.** ffmpeg decodes to 16 kHz mono s16le. Audio is sent in 100 ms frames through `client.sendAudio`, paced at wall-clock real time divided by `--speed`, so measured latency is meaningful. A commit is sent every 6 s and at the end. The default STT is `--stt openai-realtime` (ephemeral token, Node 22 global `WebSocket`, which the SDK also ends on 600 ms of silence). `--stt openai-transcribe` and `--stt openai-whisper` use HTTP upload instead.
- **Live log.** Transcripts with STT time, questions, answers with `endToEnd / firstToken / generation / queue / stt` and cost, concepts, conflicts, asks (pending, then done with sources), summary updates and the final verification.
- **Drain.** When the source ends, the harness waits for pending answers, runs a final copilot pass (`runCopilotNow`), waits for its asks, and verifies the first summary bullet.
- **Report.** Written to `artifacts-v07/live/<timestamp>.json`:
  - counts
  - cost (total, by usage kind, unpriced calls)
  - latency p50/p95/max: answer end-to-end, first token, generation and queue; STT as reported by the SDK (`transcript.final.context.latencyMs.transcriptionMs`) and STT from harness commit to final
  - unanswered questions
  - expectation hits (script mode)
  - errors
  - the final summary, concepts, conflicts, asks, verifications and answers with their meta
- **Exit codes.**
  - 0: ok
  - 1: the conversation did not finish (fatal provider error, ffmpeg failure, Ctrl-C)
  - 2: at least one question went unanswered
  - 3: setup error (key, build, network, tools)
  - 4: unmet script expectations, only with `--strict`

Options: `--model` (default `DEFAULT_ANSWER_MODEL`), `--copilot-model` (default `DEFAULT_COPILOT_MODEL`), `--mode`, `--no-copilot`, `--no-web`, `--drain-ms`.

## What is and is not verified

Verified by the E2E test (deterministic, no network):

- Real SDK code from audio frames or injected text through question detection, streaming answers, the copilot lane, asks, verification, the usage/cost math and AnswerMeta timing.
- The controller's gesture, presentation and history wiring.
- The realtime socket protocol as the fake implements it, which is the documented shape.

Not verified by the E2E test:

- Model quality. The fake's answers are templated.
- Real OpenAI request validation. A body field the real API rejects only fails in the live harness.
- Real network latency, real STT accuracy and real web-search results.

Verified by the live harness: real models, STT, web search, latency and cost on a laptop with Node 22.

Verified by neither:

- The physical Even Realities G2: microphone capture, BLE audio transport, glasses rendering, gestures, battery or thermal behavior.
- The phone WebView runtime: its `fetch` and `WebSocket` behavior and its backgrounding.

The simulator and the fake are not the device. Confirm on hardware with the in-app rehearsal, and with a real conversation, before relying on Helix in an interview or meeting.
