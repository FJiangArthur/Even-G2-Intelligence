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
| `interview-interviewer` | interview | Interview harness (section 4): you interview a backend candidate, mode `interviewer` |
| `interview-candidate` | interview | Interview harness (section 4): you are the candidate, mode `interviewee` |
| `talk-being-present` | talk | Talk scenario (section 5): you listen to a podcast on being present, mode `general` (Meeting). One other speaker for several minutes, garbled lines, Chinese and Korean fragments, rhetorical questions, three one-word wearer turns |

Each script has `expectations` (concepts, conflict, lookups, proposes, questions, implicitQuestions). The tests and the harness check results against them.

The two `interview-*` scripts and `talk-being-present` also state an outcome on every line (sections 4 and 5). They contain lines that must not be answered, so the suites of section 2, which expect every detected question to be answered, leave them out.

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

## 4. Interview harness (no key, no network)

The interview harness answers one question: in an interview, was each question answered once, in order, and could the wearer read the answer in time. It runs the real app on a fake G2 bridge and the fake provider of section 2, and it can make the provider fail.

| Part | File |
|---|---|
| Browser page | `apps/g2-plugin/qa/interview.html`, `qa/interview.ts` |
| Timeline, report, fake glasses, fake microphone and speech-to-text | `apps/g2-plugin/tests/interview-harness.ts` |
| The same scenarios under vitest | `apps/g2-plugin/tests/interview-scenario.test.ts`, `tests/interview-rig.ts` |
| Fault injection | `createFakeOpenAI().injectFault()` in `tests/fake-openai.ts` |

### Run it in a browser

```bash
npm run build -w @helix/conversation-sdk
npm run dev -w @helix/g2-plugin
# open http://localhost:5173/qa/interview.html
```

The page connects and starts listening by itself. The real app is on top, with its "On your glasses" mirror. The panel below it, in a dashed orange frame marked TEST HARNESS, has the script picker, speed, the fault buttons and the live report.

| URL flag | Meaning |
|---|---|
| `?script=interview-interviewer` | Script to select (any id from the table above) |
| `?mode=interviewee` | Mode to start in. Playing a script switches to the script's own mode |
| `?speed=4` | Pauses between lines divided by this |
| `?path=audio` | Speak the lines through the fake microphone and the fake speech-to-text socket instead of typing them |
| `?fault=http-500-once` | Faults to inject first, comma separated. `slow-first-token:2500`, `cut-off:4` and `burst:6:150` take numbers |
| `?autoplay=1` | Inject the faults, play the script, then log `INTERVIEW_DONE`. `window.__interviewResult` resolves with the report |
| `?writeMs=150` | Time one glasses write takes. Default 0 |

From the console:

```js
await __interview.play("interview-candidate", { speed: 2 })   // resolves with the report
await __interview.say("How do you test a migration?", "other") // speaker: self | other | unknown
await __interview.setMode("interviewer")
await __interview.fault("http-500-once")   // slow-first-token | http-500-once | http-500-always | http-401
                                           // malformed-event | cut-off | bad-copilot-json | burst | none
await __interview.burst(6, 150)            // 6 alternating lines, 150 ms apart
__interview.timeline()                     // ordered records { t, kind, text, id, data }
__interview.report()                       // per-question rows, violations, summary
```

### The two scripts

`interview-interviewer` (21 lines) and `interview-candidate` (22 lines) are ordinary interview talk with awkward lines in it. Each line has `expect`: `answer`, `answer-key` (the wearer's own question in Interviewer mode) or `none`. `questions` lists the questions that should each get one answer. `case` names the awkward line:

| case | Line | Expected |
|---|---|---|
| `no-question-mark` | "I'd like to hear about…" | answered once |
| `two-questions` | Two questions in one line | both answered, in order |
| `rhetorical` | A rhetorical question from the other side right after the wearer's question | not answered |
| `repeat` | The same question again a few lines later | answered once more |
| `topic-change` | "Let's move on to system design." | not answered |
| `fragment` | "And then?" | not answered |
| `long-question` | Three sentences of context, then the question | answered once |
| `own-question` (candidate script) | The wearer asks the interviewer something | no answer key |

### Reading the report

One row per expected question, plus one row for every other question the app detected.

| Column | Meaning |
|---|---|
| `expect` | `answer`, `answer-key`, `none`, or `unspecified` for a line typed with `say()` |
| `timesAnswered` | Answers that finished for this question. `attempts` counts answers that produced at least one token |
| `via` | `answer`, or `copilot-ask` when the line was not detected as a question and the copilot's implicit-ask lane answered it later |
| `msToFirstToken` | Line heard to first answer token |
| `msToVisible` | Line heard to answer text in the glasses BODY container |
| `msTokenToVisible` | First token to answer text on the glasses. More than 1500 ms is a violation |
| `finalState` | `answered`, `partial` (cut off, kept), `failed` (error), `superseded` (a later answer replaced it before it finished), `not-answered` (detected, never started), `not-detected`, `ignored` (nothing was expected and nothing happened), `streaming` |
| `faults` | Injected faults that hit a provider request for this question |
| `ok` | Expected one answer and got exactly one complete answer, or expected none and no answer was started |

`violations` lists every row that is not ok and, across rows: answers out of order, an answer never shown or shown late, an answer that an error cleared from the glasses, a line that was never heard, and, in Interviewer mode, no suggested question popping up on the glasses. `summary` counts them: `answeredOnce`, `missed`, `answeredTwice`, `unexpectedAnswers`, `lostToFault`, `answersClearedByError`, the medians, and the suggestion counts.

The timeline has these kinds: `line.heard`, `question.detected`, `answer.first-token`, `answer.completed`, `answer.partial`, `answer.failed`, `glasses.answer-visible`, `glasses.answer-hidden` (reason `replaced`, `expired`, `error` or `cleared`), `suggestions.changed`, `glasses.suggestion-shown` (with `ambient`: the HUD was not woken), `notice.shown` (phone or glasses), `ask.answered`, `fault.injected`, `mode.changed`. "On the glasses" means the text is in what the fake bridge last received for the BODY container.

### Vitest

```bash
cd apps/g2-plugin && npx vitest run tests/interview-scenario.test.ts
INTERVIEW_BASELINE_DIR=/tmp/interview npx vitest run tests/interview-scenario.test.ts -t baseline   # report + timeline JSON per run
```

The tests use fake timers, so a two-minute script takes about 100 ms and gives the same numbers every time. A plain `it` is behaviour that works. An `it.fails` is behaviour that is still being built; its name says what it waits for and which weakness it pins. When the behaviour arrives, the test starts passing, vitest reports it as failed, and you change `it.fails` to `it`.

### What the interview harness cannot show

- Typed lines skip speech-to-text, turn detection and speaker attribution. `?path=audio` runs turn detection and speaker roles on synthetic noise, with a transcript that is always exact: it says nothing about recognition errors or real voices.
- The fake provider's answers are templates. Nothing here measures whether an answer is correct or useful, or how a real model reacts to the prompts. First-token time is the fake's configured 400 ms.
- There are no glasses. A write is "visible" when the fake bridge accepted it; Bluetooth latency, the real font and wrapping, and gestures on hardware are not covered. `?writeMs=` only delays each write.
- The copilot is the fake's keyword analysis, so suggested questions are canned.

## 5. Talk scenario: a podcast you listen to (no key, no network)

`talk-being-present` models a session where the wearer is not in a conversation at all: a podcast host talks for about three and a half minutes about being present, meditation, sensory awareness and thinking less. The lines are original, written in that spirit; they are not taken from a real broadcast. It uses the per-line format of the interview scripts (`expect`, `case`) and runs on the same rig (`tests/interview-rig.ts`, `tests/interview-harness.ts`, `tests/fake-openai.ts`).

| case | Line | Expected |
|---|---|---|
| `wearer-turn` | "Yeah.", "And", "Yeah" | not a question; each one starts the other side's floor again |
| `self-answered` | "So what does that mean? It means…" | not answered: the speaker answers it in the same line (on-device filter) |
| `audience-question` | "You might be wondering whether…" | not answered (on-device filter) |
| `rhetorical-guarded` | "Is there anything we can do in this moment?", "So why do we keep leaving the present?" | detected as questions, listed on the phone, not answered: the other side has held the floor for 60 s (monologue guard) |
| `garbled`, `cut-off` | Wrong words, a repeated word, a sentence that stops | no answer, and no output about the transcript |
| `mixed-language` | 当下, 지금 여기, 只管打坐, 그냥 앉아 있는 거예요 inside English sentences | no answer |

The script's `expectations` block is different from the other scripts: `sayLines` (the suggestions are lines to say), `unanswered` (the two guarded questions) and `forbiddenLabels` ("Strong answer", "Probe:", "Flag:").

```bash
cd apps/g2-plugin && npx vitest run tests/v16-talk-scenario.test.ts
```

What the test asserts:

- With tagged roles (`self` / `other`): every line is heard with its speaker, no answer request reaches the provider, and the two guarded questions are detected but not answered. The script test also checks, from the script's own pauses, that each guarded question comes at least 60 s into the host's floor and that the on-device detector finds no question in any other line, so it is the guard that is tested and not the filter.
- The phone gets at most three suggestions, all of kind `say`, and the Q&A tab heads them "Say next".
- With the wearer's three turns left out (every line tagged `other`, the wearer only listens): still no answer request. The guard does not need a turn from the wearer.
- Without speaker tags (every line `unknown`) the same two questions are answered once each. The guard needs tagged roles, and a turn of unknown role between the host's turns starts the host's floor again.
- The copilot request and every answer request carry the speech-recognition rule (`SPEECH_RECOGNITION_RULE`).
- A manual tap ("last few sentences") after the talk sends the "say next" request (`lineRequest("local")`) with no answer-key instruction, and the phone feed labels the reply "Helix · say next". The same holds for a manual tap in Interviewer mode, where the wearer's own spoken question still gets its answer key.
- No provider output, event, feed item, suggestion or glasses text of the run contains "Strong answer", "Probe:" or "Flag:".

In the app, pick the script under Rehearsal with Meeting mode selected. In-app rehearsal does not switch the mode, and it plays in real time: the guard counts 60 s of wall clock, so at speed 2 or 4 the guarded questions arrive before the guard applies and are answered. The same is true of `scripts/live-rehearsal.mjs --script talk-being-present --speed 1`.

### What the talk scenario does and does not prove

It proves plumbing: which lines lead to an answer request, which kind of suggestion reaches the phone, what the requests say, and that the interviewer answer-key format is not asked for outside its place.

It does not prove:

- The quality of a real model's lines. The fake provider's suggestion is a canned sentence ("What is the next concrete step and who owns it?") and its answer a template. Whether a real model offers a line worth saying about presence, stays quiet about the transcript, or follows Chinese and Korean speech is only seen in a billed live run with your key.
- That a real model obeys the speech-recognition rule. The test shows the rule is in the request, not that the reply follows it. The fake never writes "transcript", "cuts off" or "clarify", so their absence from its output says nothing.
- Speech recognition. The garbled and mixed-language lines are typed in; no audio is recognised. The "Mixed languages" speech setting is not exercised by this script.
- Speaker tags on the glasses. The run tags every line; whether a real G2 session tags the podcast as `other` and the wearer as `self` is a device check. Untagged, the guard does not apply and the questions are answered.
- The glasses pop-up layout for a line to say.
- Phrasing the on-device detector gets wrong. While writing the script, three statements were answered as questions within a minute of a wearer turn: "Today I want to stay with one simple idea, which is being present, and what it takes…", "When attention rests in the senses, the stream of thinking slows down on its own." and "Do only that, and see what changes." So was "You might be wondering, is this just zoning out?" (the comma splits off the question). The script was reworded around them; the detector was not changed.

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
