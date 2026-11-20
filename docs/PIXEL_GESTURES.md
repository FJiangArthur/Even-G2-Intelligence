# Pixel HUD and touch behavior — v0.3.2

Historical record only. Since v0.5.0, glasses show full-screen answers and are blank when idle; single click asks local context and double click asks the whole conversation (it does not exit). Use [ANSWER_FIRST_QA.md](ANSWER_FIRST_QA.md) and `scripts/qa_answer_first.mjs` for current behavior and verification.

## Display

Original integer-pixel helix emblem and 5×7 wordmark, stepped details, square
2-pixel reading frame, bracketed status, command cursor and visible gesture
footer. The header is a locally generated 136×32 grayscale PNG, uploaded once
after page creation. Answers remain native text for reliable streaming and
readability; only changed text panels are sent, coalesced at 120 ms. If image
upload fails, the labelled text dashboard remains usable.

The display has seven non-overlapping text containers and one image container,
with only `1 / helix-main` capturing events. Four answer lines remain reserved.
The question/live transcript uses a compact one-line context row; note delivery
has its own row. Overflow is marked, and full content stays in the companion.
Native SDK API contract: pinned `@evenrealities/even_hub_sdk` 0.0.14 declarations
and [official SDK reference](https://www.npmjs.com/package/@evenrealities/even_hub_sdk).

## Gestures

| Gesture | Behavior | Feedback |
| --- | --- | --- |
| Single click, connected/paused | Start or resume G2 microphone | MIC ON / TAP TO PAUSE |
| Single click, listening | Stop microphone, drain accepted audio and commit pending utterance | PAUSED / TAP TO RESUME |
| Long press, paused/connected | Temporarily open microphone for push-to-talk | HOLDING / RELEASE TO SUBMIT |
| Long press, already listening | Keep continuous listening and mark a manual submission boundary | HOLDING / RELEASE TO SUBMIT |
| Release after hold | Drain queued audio, commit once; return to paused if hold opened the microphone | SENT, then RECEIVING, then normal gesture hints when the reply completes |
| Empty or duplicate release | Empty hold reports no new audio; duplicate/orphan release does not send again | NO NEW AUDIO / HOLD AND SPEAK |
| Double click | Reject queued gestures, stop microphone, end transport session, request host exit, dispose listeners/renderer | STOPPING / EXIT, then companion instructs reopening |

Before connection, the user must configure and connect on the phone. A gesture
does not invent credentials or establish an unknown endpoint. No auto-connect
was added to the production entry.

Explicit lifecycle/long-press events take priority over protobuf's omitted
zero-valued click. Repeated holds are idempotent, microphone gestures are
serialized, and already-accepted tail frames are not discarded on mic close.
System exits detach display/listeners before asynchronous cleanup. Starting a
new session clears previous session-only answers/notes and gesture feedback.

## Reproduce the simulator smoke test

1. Start the gateway in mock mode with mock transcription/answer allowlists.
2. Run `npm run dev:plugin`.
3. Run `node_modules/.bin/evenhub-simulator http://localhost:5173/qa/gestures.html --automation-port 9898`.
4. Run `node scripts/qa_gestures.mjs` against that fresh simulator instance.

The development fixture uses actual SDK touch/display calls, the production
controller/client and the local gateway. Only microphone PCM is synthetic.
It opens no real microphone, uses no keys, stores no settings and calls no live
AI provider. QA pages are excluded from the production Vite entry and EHPK.

Accepted result: `G2_GESTURE_SMOKE_PASSED`. It verifies two mock replies,
tap/start/pause/resume, press/release, exact ON/OFF ordering, clean double-click
exit, and no simulator console errors. Evidence is under
`artifacts/pixel-gestures/`, including `gesture-events.json` and ready/hold/answer
framebuffers. Physical G2 gesture timing, lens readability and audio still need
device acceptance; simulator success is not installation or deployment.
