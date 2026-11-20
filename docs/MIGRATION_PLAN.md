# Helix G2 migration and acceptance plan

Historical roadmap below. v0.4 supersedes server-authorized profiles with phone-only direct providers; see ARCHITECTURE.md and PHONE_ONLY_QA.md for current scope and remaining hardware/latency acceptance.

## Goal

Deliver a G2 conversation product that captures G2 microphone audio, identifies questions quickly, streams direct answers from a user-selected, server-authorized provider profile and prompt, renders readable attributed text on the glasses, and automatically stores only useful and safe notes.

## Baseline

Current Helix already proves important product behavior in Swift:

- three conversation modes;
- final-transcript question detection, including multiple questions;
- concurrent answer work with source-order commit;
- fast and deep model roles;
- direct speakable prompts;
- headless automatic Knowledge capture with dedupe and undo;
- semantic answer delivery followed by wearable presentation.

It is not a drop-in G2 SDK. `HelixConversation` and `HelixRuntime` still expose G1-specific types, custom provider identity is closed, endpoint configuration is not user-facing, network “streaming” buffers a complete response, and most question detection waits for a final transcript.

The committed native baseline is Helix-iOS `0b0bd514009199a3169618f6108efb9d772c9f1f`, version `2.2.98+202608312013`. The live checkout also contains unrelated user changes, so migration must use committed source and explicit fixtures rather than copying the working directory.

## Phase plan

### Current 0.3 implementation slice

Status: implemented locally and simulator-testable; live providers and physical G2 remain acceptance gates.

Delivered in this slice:

- wire protocol `2.1`, WebSocket subprotocol `helix.v2`, and `/v2/conversations`, including a strict one-shot session credential envelope;
- independent, allowlisted transcription and answer profile selection;
- **Gateway default** UI selections that omit the respective provider preference so the server default resolves it, while acceptance reports the actual profile;
- Deepgram raw PCM16 transcription and Soniox real-time WebSocket transcription adapters, with live G2 frames forwarded as they arrive and a paced 3,840-byte/120 ms buffered fallback;
- OpenAI Responses and OpenAI-compatible streaming answer adapters;
- visible OpenAI, Deepgram, Soniox, and Omi BYOK fields, opt-in dedicated Even
  local storage, WSS-only transmission, immutable per-session server binding,
  and optional environment-key fallback;
- `general`, `interviewee`, `interviewer`, `social`, `office-discussion`, and `passive` modes;
- distinct `reactive`, `proactive`, and `both` behavior, with manual questions always available;
- bounded Omi context retrieval and opt-in, truthfully reported Omi note sync;
- a conservative useful-memory gate that requires a decision, commitment, action, deadline, requirement, preference, risk, blocker, priority, or explicit plan before safety and deduplication checks can accept an automatic note;
- a conversation-first companion UI with semantic chat cards and progressive-disclosure setup;
- exact provider/mode/response-strategy/memory/automation acknowledgement instead of silent fallback.

This does not complete the recorded-corpus, private-build, reconnect, phone-lifecycle, or physical-G2 exit criteria below.

### Phase 0: platform spike and compileable scaffold

Status: in this workspace

Deliverables:

- official SDK/tooling versions pinned;
- TypeScript monorepo and reusable conversation SDK;
- G2 plugin with bridge, mic, gesture and display adapters;
- self-hosted gateway with explicit mock mode;
- OpenAI-compatible STT and true streaming chat adapter;
- first-pass question detector and note policy;
- unit/contract tests and official simulator smoke path;
- architecture and protocol documents.

Exit criteria:

- `npm run check` passes;
- plugin packs into `.ehpk` with SDK 0.0.14;
- no provider secret appears in `dist`, `.ehpk`, source defaults, events, or server persistence; any local key storage is explicit opt-in and independently clearable;
- simulator boots a nonblank 576 x 288 screen, accepts input, and dispatches double-click through the host-controlled foreground-exit path.

### Phase 1: behavior parity with native Helix

Deliverables:

- export native question, ordering, prompt and Knowledge cases into language-neutral JSON fixtures;
- port hybrid question classification and multilingual coverage;
- port max-three parallel question handling and source-order commits;
- port fast/deep role selection and generation cancellation;
- port Knowledge category, sensitivity, uncertainty, dedupe, grace and undo semantics;
- persist provider/model/prompt provenance without a closed provider enum.

Exit criteria:

- both Swift and TypeScript runners pass the same golden fixtures;
- no G1 display type exists in a device-neutral event;
- automatic capture works for live, manual and deep answers without a mounted UI.

### Phase 2: latency and true streaming

Deliverables:

- provisional partial-transcript question detection;
- confidence-based fast path that skips classifier calls for explicit questions;
- optional classifier endpoint for implicit or multilingual questions;
- real SSE/WebSocket response deltas and cancellation;
- display coalescing that preserves first useful content without flooding BLE;
- structured timeouts, retries, 429 handling and sanitized provider errors.

Target service levels, measured from the gateway clock:

| Metric | Target |
|---|---:|
| Final utterance to committed question | p50 under 150 ms, p95 under 400 ms |
| Explicit question to first answer delta | p50 under 1.2 s, p95 under 2.5 s |
| Useful answer visible after first delta | under 250 ms additional display delay |
| False automatic question pickup | under 5% on the agreed corpus |
| Missed explicit questions | under 2% on the agreed corpus |

Exit criteria:

- recorded corpus produces a latency/precision report;
- first display delta arrives before response completion;
- cancelling or starting a new generation suppresses all late deltas;
- retry behavior is deterministic under injected 401, 408, 429 and 5xx faults.

### Phase 3: own endpoint and prompt productization

Deliverables:

- gateway account/pairing flow with short-lived plugin tokens;
- per-user ownership and account management for the server-side STT, classifier, fast answer and deep answer profiles (single-operator profile selection is available now);
- OpenAI-compatible path/header/model configuration;
- versioned prompt editor with preview and rollback;
- endpoint health/capability test before saving;
- fixed production gateway origin and correct CORS;
- prompt and endpoint provenance in session archive and notes.

Exit criteria:

- a user can switch between two authorized endpoint profiles without repacking the plugin or editing gateway environment;
- wrong credentials and incompatible models produce actionable typed errors;
- no upstream credential reaches the `.ehpk`; browser storage occurs only after the user's explicit local-save opt-in;
- prompt version used by every answer can be reconstructed later.

### Phase 4: automatic Knowledge and integrations

Deliverables:

- runtime-owned note proposal for every answer path;
- server-side durable note store;
- grace period, undo, dedupe and source trace;
- configurable sinks beyond the implemented Omi Developer API path, including Helix Knowledge and user-owned note APIs;
- sensitive-content redaction and audit log;
- explicit opt-in and session pause controls.

Exit criteria:

- useful decisions/actions/facts are captured without a manual send action and remain durable across gateway restart;
- questions, credentials, JWTs, uncertainty and failures are rejected;
- duplicate replays create one note;
- every saved note links to its source turn, endpoint, model and prompt version;
- undo is verified across restart.

### Phase 5: private G2 validation and release

Deliverables:

- private `.ehpk` installed through Even Hub;
- real G2 four-mic sessions in quiet, office, restaurant and remote-call audio;
- G2 and R1 gesture matrix;
- iOS and Android phone lifecycle matrix;
- readability and scroll tests on hardware;
- privacy copy, microphone rationale and store submission evidence.

Exit criteria:

- 30-minute conversation completes without socket/audio deadlock;
- app recovers from phone lock, app switch, network loss and provider reconnect;
- tap, double press, long press and swipe behavior match the interaction spec;
- answer rendering is legible and never exposes raw JSON or provider errors;
- battery/thermal impact is measured;
- all hardware-only gates have captured evidence.

## Acceptance matrix

| Capability | Unit | Gateway integration | Simulator | Private build | Real G2 |
|---|---:|---:|---:|---:|---:|
| Prompt/endpoint config | required | required | smoke | required | required |
| PCM VAD and commit | required | required | limited | required | required |
| Question pickup | required | required | text fixture | required | corpus replay |
| True streaming deltas | required | required | render smoke | required | latency proof |
| Proper attributed UI | snapshot | event journey | required | required | legibility proof |
| Automatic notes | required | required | status smoke | required | session review |
| G2/R1 gestures | router test | n/a | partial | required | required |
| Background recovery | state test | reconnect fault | unavailable | required | required |
| BLE/display timing | coalescer test | n/a | unavailable | unavailable | required |

## First private test script

1. Configure a fixed HTTPS/WSS gateway origin and pack with `--sdk-ver 0.0.14`.
2. Install privately on one iPhone, one Android phone and one G2.
3. Start a general conversation using G2 microphones.
4. Read ten explicit, ten implicit and ten non-question statements from the recorded corpus.
5. Capture transcript, question commit, first delta, final answer, first display and note decision timestamps.
6. Use tap to pause/resume, long press to commit manually, swipes to navigate and double press to exit.
7. Lock the phone for five minutes, resume, and repeat one question.
8. Drop the network during an answer, restore it, and confirm no duplicate answer or note.
9. Inspect the session archive and every automatically captured note for provenance and sensitivity.
10. Record a pass/fail row for every acceptance criterion. Do not infer hardware success from simulator output.

## Work ownership

- **Conversation SDK**: device-neutral contracts, VAD, ordering, client state and note interfaces.
- **G2 adapter**: Even bridge, microphone, gestures, layout, render throttling and companion settings.
- **Gateway**: auth, upstream providers, true streaming, question policy, errors and durable notes.
- **Parity harness**: shared fixtures executed by both Swift and TypeScript.
- **QA**: simulator automation, private builds, G2/R1 hardware and latency corpus.

## Decision checkpoints

No new decision is needed to build the scaffold. Before Phase 3, choose:

- the production Helix gateway domain;
- whether endpoint profiles are single-user or team-managed;
- the first durable note destination;
- the initial STT and answer endpoint dialects beyond OpenAI compatibility;
- whether enterprise SDK access is worth pursuing for deeper native integration.
