# Helix G2 QA report

## v0.5.0 answer-first display — 2026-09-10

See [ANSWER_FIRST_QA.md](ANSWER_FIRST_QA.md) for current release evidence: answer-only blank-idle glasses, full-width paged answers, phone transcripts, local/global controls and latest-request replacement. The official simulator deterministic scenario passes; final package and upload status are recorded there. The v0.4 live-provider result below is historical, not a new v0.5 live-provider test.

## v0.4.0 phone-only Whisper — 2026-09-08 Pacific

See [PHONE_ONLY_QA.md](PHONE_ONLY_QA.md): 223 automated checks passed and real direct OpenAI Whisper → question → GPT answer → automatic session note passed in the official simulator. No Helix gateway. Physical phone/G2 acceptance and Whisper latency tuning remain open. Reports below describe historical gateway releases.

## v0.3.2 pixel HUD and gestures — 2026-09-07

Pixel header, gesture footer and click/hold/release/exit behaviors implemented.
See [PIXEL_GESTURES.md](PIXEL_GESTURES.md) for mapping and reproduction.

Final `bash scripts/run_gate.sh`: **206 tests passed** (SDK 41, gateway 104,
plugin 61), build and secret checks passed. Package version **0.3.2** is
**825,282 bytes**, SDK 0.0.14, minimum Even App 2.2.9. SHA-256:
`9a6da0525274e00f95a5200d66e6c4fe9d9a3e059ca475a6bc702208c2ad68e5`.

`node scripts/qa_gestures.mjs` passed in a fresh official simulator: actual SDK
touch events drove the production controller through two synthetic-audio mock
responses and microphone teardown/exit. No live microphone/provider was used.
Native PNG upload succeeded; answer, holding and gesture footer frames were
visually inspected. Empty/duplicate release, transcript tail draining, image
fallback, mixed-event precedence and reply-feedback reset are regression-tested.

The three lifecycle follow-ups recorded below for v0.3.1 are now addressed:
new sessions reset the presentation, system exit disposes the renderer before
waiting on teardown, and lifecycle events take priority over click fallback.
Physical hardware and deployment gates remain open.

## v0.3.1 UI and pixel-dashboard verification — 2026-09-07

**DONE_WITH_CONCERNS: build, browser UI checks, clean official simulator runs
and EHPK packaging pass. Physical G2 acceptance remains unverified.**

- Reused the original Android G1 Warm Linen tokens, Fraunces/Inter fonts and
  assistant illustration. Provenance: [G1_UI_REUSE.md](G1_UI_REUSE.md).
- `bash scripts/run_gate.sh` passed: SDK 41, gateway 104, plugin 51; **196
  tests**. Renderer coverage includes panel geometry, sole event capture,
  four-line answer priority, live transcript preservation, Unicode overflow,
  serialization/debounce, rejected updates and initialization/disposal races.
- Source Helix-iOS gate also passed: 162 tests, one skipped, no failures.
  Its existing unrelated worktree edits were not changed.
- Real Chromium checked actual `CompanionUi` through the development-only
  synthetic fixture: API-key shortcut opens the panel and focuses the masked
  OpenAI field; all four provider fields are present; mode/strategy/Soniox
  selections update the summary; clear invokes the fixture callback; connect,
  start, pause/resume and manual question/composer-clear callbacks work.
  No real keys were entered, persisted or sent during this visual pass.
- Browser views inspected at 390 × 844 and 1440 × 1000; width 320 also checked
  with `scrollWidth === innerWidth`. Fonts/hero loaded and no browser console
  errors were observed after the final refresh.
- Official simulator 0.9.5 rendered the six native panels at 576 × 288 with a
  synthetic answer/question/note. A separate clean run loaded the **built
  production entry on port 5174** and displayed the actual ready companion and
  glasses state. Single-click reached the guard error; double-click requested
  exit. Both clean runs had no uncaught exceptions or failed fetches.
  An earlier Vite hot reload caused duplicate-page startup result 1; this was
  discarded and the simulator was restarted for the accepted evidence.
- Package `apps/g2-plugin/helix-g2.ehpk`: **823,752 bytes**, app version
  **0.3.1**, SDK 0.0.14, minimum Even App 2.2.9.
  SHA-256: `13b1ae39ae5552c8ca6b7467181a47bb0ce29180c79a82e976d7e6e54127487e`.
  The increase is the bundled original fonts/illustration, not a remote asset
  dependency. Production file inventory excludes the QA pages and fixtures;
  built output has no high-confidence credential patterns.

Evidence (local, Git-ignored): `artifacts/g1-dashboard/companion-ready.png`,
`companion-answer.png`, `setup-open.png`, `companion-desktop.png`,
`production-webview.png`, `glasses-answer.png`, `glasses-ready.png`,
`glasses-click.png` and their `-readable.png` views. Readable views simply
display the unmodified RGBA framebuffers over black in a browser.

### Independent review follow-ups outside the visual change

The introduced old-answer/new-transcript regression was fixed and covered by
a test. The review also identified pre-existing lifecycle issues not changed
by this visual pass:

1. Reconnect preserves previous presentation content, including notes labelled
   “THIS SESSION”; session-boundary reset needs a separate behavior decision.
2. Controller disposal waits for audio/client teardown before stopping the
   renderer, so a delayed teardown can permit intervening display updates.
3. A mixed system-exit envelope plus default text-click envelope can prioritize
   the click over exit; lifecycle event precedence needs a targeted fix.

Live provider latency, phone storage/relaunch, private-build installation,
physical lens legibility and the existing deployment-origin gate remain open.

## Historical v0.3.0 verification

QA date: 2026-09-07

## Verdict

**Integrated build: PASS. Mock end-to-end replay: PASS. Official simulator automation: PASS. Live providers, private build, and physical G2: NOT RUN.**

The workspace is a working v0.3 implementation, not a hardware-release claim.
The reusable SDK, G2 adapter, profile gateway, G1-style modes,
proactive/reactive policies, semantic chat presentation, question path, and
automatic note/Omi outcome path compile and run together. Real G2 audio, phone
lifecycle recovery, live Deepgram/Soniox/OpenAI/Omi behavior, and production
latency remain explicit acceptance gates.

## Reproducible checks

| Check | Observed result |
|---|---|
| Existing Helix-iOS gate | `bash scripts/run_gate.sh` passed on baseline `0b0bd514009199a3169618f6108efb9d772c9f1f`: 162 tests, 1 skipped, 0 failures. The original dirty checkout was not copied or changed. |
| Clean dependency install | `npm ci` installed/audited 127 packages with 0 reported vulnerabilities. |
| G2 build and test gate | Final VAS rerun passed: SDK 41/41, gateway 104/104, plugin 40/40; 185 tests total. Weighted line coverage is 80.23%; `services/gateway/src/protocol.ts` line coverage is 85.41%. |
| Provider contract tests | Mock transports verify the Deepgram raw PCM/auth/query shape; Soniox v5 config, final-token flow, malformed-payload handling, live-session interface, and 3,840-byte/120 ms fallback cadence; OpenAI Responses request/SSE flow; cancellation; redirect rejection; URL safety; reserved IDs; and profile allowlists. No live key was used. |
| Mode and question tests | Reactive, proactive, both, passive suppression, manual override, negated/irrelevant proactive suppression, multilingual deterministic question fixtures, and named-person/month/object/exclamation false-positive regressions pass. |
| Omi tests | Mock Developer API tests cover bounded/category GET, local relevance ranking, answer deadline, 500-character POST cap, impossible-capability rejection, pending-to-synced/failed outcomes, and abort-without-false-status at session end. |
| Cross-package conversation | The built SDK connected to the running mock gateway, sent PCM, received final transcript and detected question, received 13 incremental answer deltas plus completion, accepted exact provider/mode/memory acknowledgement, and automatically captured one safe session note. |
| SDK packaging | `npm pack --dry-run -w @helix/conversation-sdk` produced a 30-file, 41.2 kB tarball plan (197.9 kB unpacked) including the package README. It was not published. |
| Even package | `evenhub pack` produced a 66,227-byte `.ehpk`, stamped for SDK 0.0.14 and minimum Even App 2.2.9. SHA-256: `c0bef072eea2846771ce6fc17cf6c077ad6677d9106ff9b3f712ef6a7f41e39f`. |
| Even package ID check | `evenhub pack --check` reached the account boundary and stopped with `Not authenticated. Please log in first.` The existing `.ehpk` remained byte-identical; package-ID availability is not yet verified or reserved. |
| Dependency audit | `npm audit --omit=dev` reported 0 vulnerabilities. |
| Secret boundary | Built SDK/gateway/plugin output, manifest, and printable `.ehpk` strings were scanned for high-confidence key/private-key patterns and conspicuous test values; none were found. Provider keys are optional runtime-only inputs and are never compiled into the package. |
| Recorded replay cleanup | The simulator, Vite, and gateway processes were stopped after final validation. A fresh handoff check found no listeners on ports 9898, 5173, or 8787. |

The cross-package replay is permanently covered in
`services/gateway/test/mock-flow.test.ts`. During independent replay it also
found and fixed a real SDK defect: callers that omitted `protocols` opened a
socket without the gateway-required `helix.v2` subprotocol. The transport now
negotiates `helix.v2` by default, with a regression test.

## Official simulator evidence

Pinned simulator: `@evenrealities/evenhub-simulator` 0.9.5.

- `/api/ping` returned `pong`.
- The companion WebView rendered at 1200 x 1538 with the live conversation,
  transport controls, semantic feed, composer, and G2 status in the first
  screen. Provider, mode, memory, prompt, and automation settings remain in a
  collapsed setup panel rather than displacing the conversation.
- The collapsed setup summary rendered the new non-secret defaults as
  `Gateway default to Gateway default` and exposes a visible `Configure · API
  keys` affordance. DOM/UI tests verify that expanding it renders separately
  labelled masked OpenAI, Deepgram, Soniox, and Omi inputs, the unchecked local
  save option, the clear action, and the local-storage warning.
- The G2 framebuffer rendered at exactly 576 x 288 and displayed
  `HELIX · READY` plus `NEXT · Connect in the phone companion`.
- A simulated click reached the active text container and produced the readable
  guarded state `Connect to the Helix gateway first` when no session existed.
- A simulated double-click emitted the G2 double-click event, invoked the
  host-controlled foreground-exit request, and cleared the custom page.
- The clean ready console contained bridge/Vite lifecycle logs and no uncaught,
  unhandled-rejection, or failed-fetch entries.

Local evidence (intentionally ignored by Git):

- `artifacts/phase2-final/webview-ready.png`
- `artifacts/phase2-final/glasses-ready-black.jpg`
- `artifacts/phase2-final/glasses-click-black.jpg`
- `artifacts/phase2-final/glasses-double-click-black.jpg`
- `artifacts/phase2-final/console-double-click.json`
- `artifacts/design-audit-after/before-after.png`
- `artifacts/simulator-final/question-detector-benchmark.json`

The simulator's glasses PNG is RGBA; the JPEG evidence flattens its alpha so
green glyphs remain visible in ordinary viewers.

The macOS session was locked, so the native simulator window could not be
manually clicked. The HTTP automation API, framebuffer, WebView screenshot,
console, bridge integration tests, and live SDK/gateway replay were used
instead. This is enough for the defined automation state, but not a claim that
a human completed the companion form in the native window.

## User concern assessment

### Question pickup and answer latency

The fast deterministic detector now covers multiple source-ordered questions,
unpunctuated English speech, explicit Chinese, Arabic, Spanish, and Japanese
forms, quoted or bracketed endings, duplicate suppression, and
declarative-statement rejection.
The gateway starts up to three answer streams concurrently while draining
completed answers in source order, and continues accepting audio while STT or a
manual answer is pending. Per-session history uses source-order turn slots, so
a faster later response cannot reorder or overwrite context before the next
request; an out-of-order completion regression test verifies the resulting
user/assistant history sequence.

A 100,000-call local CPU microbenchmark over twelve representative utterances
measured 1.916 microseconds p50, 3.042 microseconds p95, and 3.875 microseconds
p99 for deterministic extraction. This only proves the rules are not the
bottleneck; it excludes transcription, network, provider, and display latency.
Partial-transcript prediction, implicit multilingual classification, recorded
corpus precision/recall, and live endpoint first-delta SLAs remain Phase 2.

### Chat presentation

Gateway objects are converted into semantic transcript, detected-question,
answer, note, and error feed items. The companion uses separate message cards,
labels, metadata, and plain `textContent`; it does not render wire JSON or a code
blob. The glasses renderer separately emits concise attributed sections and
coalesces updates at a minimum 120 ms interval.

### Intelligent automatic notes

The automatic path is executable end to end. A completed answer produces a
typed note proposal; both gateway and SDK reject credentials, token-like data,
questions, uncertain claims, canned errors, non-useful social or ephemeral
output, unsafe controls, invalid provenance, and duplicates. The independent
replay captured exactly one accepted note with a
redacted provider URN and source provenance, without a manual “send” action.

The local sink remains bounded and volatile, and the UI says `Captured this
session`. With explicit opt-in plus server key/write enablement, Omi writes move
from pending to synced or failed using the same note ID. The SDK retains the
terminal outcome and rejects state regressions. No live Omi call was made.

### Own endpoint and prompt

One operator can configure and allowlist separate Deepgram, Soniox,
OpenAI-compatible, and OpenAI Responses profiles through gateway environment
settings. The companion now accepts the four visible provider keys and can
optionally remember them in a separate Even local-storage record. It sends only
the keys needed by the selected session once, outside `SessionConfig`, over
WSS. The self-hosted server constructs isolated per-session adapters, calls the
provider directly, prefers that session key, and falls back to its matching
environment key. Session start verifies
the exact accepted mode, strategy, explicitly requested provider IDs, Omi
settings, and question/answer/note automation rather than silently accepting a
fallback. Selecting **Gateway default** omits that provider preference and
surfaces the gateway's actual resolved profile in the acknowledgement.

Per-user profile ownership, endpoint health tests, token issuance/expiry,
prompt rollback, and switching arbitrary custom profile IDs without server
configuration remain Phase 3. The static Even Hub network whitelist permits
the companion to reach the single user-operated Helix server origin; the
server then connects directly to the selected provider.

## Remaining release gates

1. Install the `.ehpk` through a private Even Hub build and repeat on physical
   G2 hardware.
2. Replay the real recording corpus and report missed/false question rates plus
   STT-to-question and question-to-first-delta p50/p95.
3. Validate a real WSS deployment and user-owned provider, including CORS,
   401/408/429/5xx behavior, cancellation, reconnect, and backpressure.
4. Implement token pairing/expiry and a durable, undoable note sink.
5. Exercise iOS and Android phone lock, app switch, WebView reclamation, network
   loss, microphone continuity, display pacing, battery, and thermal behavior.
