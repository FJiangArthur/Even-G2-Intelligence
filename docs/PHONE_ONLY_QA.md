# Phone-only Whisper QA — v0.4.0

## Result and scope

**Passed: official Even Hub simulator + real direct OpenAI requests + production UI/controller/SDK, using synthetic speech at the microphone boundary.** No Helix gateway ran or handled the conversation. This is not a physical-phone/G2 or real-microphone acceptance result.

Run: 2026-09-09 06:10 UTC (2026-09-08 Pacific). Simulator 0.9.5, SDK 0.0.14. Default configuration: Whisper `whisper-1`, Responses `gpt-4.1-mini`, general mode, reactive responses, automatic questions/answers/notes enabled, Omi off.

The user's authorized key was injected into the masked runtime input and cleared after connect. No key was written to source, artifacts or storage. A one-shot loopback input helper terminated before speech; Vite served development files only. Actual speech/answer requests went directly from the simulator WebView to `api.openai.com`.

## Observed end-to-end flow

Fixture speech: “The team decided to launch on Friday. Alice owns the checklist. What is the next action?” PCM16 mono 16 kHz, delivered in 20 ms frames through the G2 bridge callback and production VAD. Sentence pauses produced two speech turns.

| Stage | Actual result |
| --- | --- |
| First Whisper upload | HTTP 200; “the team decided to launch on Friday. Alice owns the checklist.” |
| Automatic note | “the team decided to launch on Friday.”; transcript provenance; Captured this session |
| Second Whisper upload | HTTP 200; “What is the next action?” |
| Question pickup | Question detected, linked to the second transcript |
| GPT answer | HTTP 200; “The next action is for Alice to review and complete the checklist to ensure everything is ready for the Friday launch.” |
| Companion UI | Attributed chat cards and note, not code/JSON; visually inspected screenshot |
| Tap pause | Microphone off, no extra upload or silence error |
| Double-tap exit | Session ended, UI Exited, controls disabled |
| Network count | Exactly two transcription requests and one answer request; all direct OpenAI |

Measured first STT: 5,985 ms. Second STT: 2,013 ms service time; 5,968 ms including queue. First answer delta: 7,875 ms and completion: **8,231 ms** from second audio commit, including queue. This is one fixture run, not a latency benchmark. Whisper is usable here but does not meet a sub-two-second response goal; serial turn processing and provider latency remain tuning work.

Local, ignored evidence:

- `artifacts/live-provider-qa/phone-only-whisper-events.json` — sanitized event/request-status trace.
- `artifacts/live-provider-qa/phone-only-whisper-success.png` — visible answer and session note.
- `artifacts/live-provider-qa/phone-only-whisper-hud.png` — native glasses screenshot.
- `artifacts/live-provider-qa/phone-only-whisper-exited.png` — final exit state.

## Automated regression gate

`bash scripts/run_gate.sh`: **223 passed** (SDK 56, legacy gateway/shared policy 104, plugin 63). Builds and credential scans passed. New coverage includes Whisper/GPT profile separation, WAV encoding, direct endpoint/key routing, context across queued turns, silence suppression, cancellation, timeout, sanitized auth failures, microphone shutdown, no default gateway socket, migration of old defaults, SSE chunk boundaries and truncated/incomplete response rejection. Production dependency audit reports zero known vulnerabilities; two moderate development-tool advisories remain in the full audit.

## Reproduce a live test

Generate a non-sensitive synthetic fixture on macOS (ffmpeg required):

```bash
mkdir -p artifacts/live-provider-qa
say -v Samantha -o artifacts/live-provider-qa/decision.aiff 'The team decided to launch on Friday. Alice owns the checklist. What is the next action?'
ffmpeg -i artifacts/live-provider-qa/decision.aiff -ar 16000 -ac 1 -f s16le artifacts/live-provider-qa/decision.pcm
npm run dev:plugin
npx evenhub-simulator 'http://localhost:5173/qa/phone-only.html?audio=/@fs/ABSOLUTE/PATH/TO/REPO/artifacts/live-provider-qa/decision.pcm' --automation-port 9898
```

Adjust the fixture path to your checkout. Enter the key in the masked UI without persistence; Connect, then click the simulator touch control. Do not start `dev:gateway`. Inspect `PHONE_QA` console events, answer/note UI, pause and double-tap exit. The QA page is not an input in the production Vite bundle.

## Outstanding acceptance

Device check during this run: the user's physical iPhone was listed as unavailable by `devicectl`; `adb devices -l` returned no attached Android devices. No installation was attempted or claimed.

- Install this exact `.ehpk` through the user's Even Hub account onto the real phone and G2; verify provider CORS/network whitelist, microphone fidelity, gestures, disconnect and background/resume.
- Measure repeated real conversation latency and question accuracy. Tune serial-queue delays; compare Whisper with the separate GPT transcription option.
- Deepgram, Soniox and Omi direct adapters are not live-accepted by this run. Prior Soniox key testing encountered provider billing exhaustion; do not describe that as working transcription. No new Omi write was performed.
- Notes remain session-only without Omi; owner/deadline extraction beyond conservative matching and durable local storage remain product work.
- Arbitrary custom AI endpoints are not currently selectable in the phone-only release.

## Build artifact

Official `evenhub pack` produced `apps/g2-plugin/helix-g2.ehpk`, version 0.4.0, **832,386 bytes**, SHA-256 `26da3fd8146da255f8aebf0c75ec0282b4da714c693f3952a2a210ca2765c7bb`. EHPK magic verified; this is a stamped EHPK container, not a ZIP file. Built application files passed an additional scan for credential-shaped values, QA instrumentation and old gateway origins. The package has not yet been accepted by the user's Even Hub account or installed on hardware.
