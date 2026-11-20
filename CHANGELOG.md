# Changelog

Newest first. Entries are engineering notes written at release time; measurements name the harness they came from.

## v0.12.1 — cooler phone during long sessions

Even's docs state no CPU, heat, memory or update-rate limits (Display, Device APIs, Networking, Background & Lifecycle, App Submission checked 2026-11-19). Measured in `qa/perf.html`, Helix's own JavaScript uses about 4 % of one core while listening, so the load that heats the phone is mostly radio and native work that Helix triggers. Reduced:

- **Idle gate on the audio uplink:** realtime transcription streamed ~64 KB/s (24 kHz PCM, base64) for as long as the mic was open, silence included. After 3 s of silence with no words the uplink now pauses; a sound slightly above the noise floor resumes it and the previous 0.8 s is sent first (`idleGate`, `onUplink`).
- **Glasses writes:** captions at most once a second (was 500 ms): 137 → 85, 128 → 77, 123 → 61 writes per minute over the first three minutes of the same simulated conversation.
- **History saves:** live-session saves every 10 s (was 3 s); still flushed on pause, stop, hide and page close.
- **Phone UI:** at most 4 renders a second during a session; the listening dot, mic bars and live caret no longer animate forever.
- **Diagnostics:** the heartbeat (every 10 s) is its own ~300-byte key instead of rewriting the whole log; the log adds per-10 s counters (`audio`, `render`, `uplink-pause`, `timer-late`) to show what the phone was doing before a freeze.

## v0.12.0 — one page scroller, OpenAI knowledge base

- **Phone layout:** the whole page scrolls (status, mode bar and the glasses mirror scroll away); the tab bar sticks to the top and the Answers composer to the bottom. Before, only the tab panel scrolled, in the space left under the open mirror.
- **Knowledge base for answers** (Knowledge → Memory): *On this phone* (the existing BM25 lookup over saved sessions, default) or *OpenAI knowledge base*: saved sessions are uploaded as Markdown files to a vector store in the user's own OpenAI project (`packages/conversation-sdk/src/openai-knowledge.ts`: Files API, `POST /v1/vector_stores`, `/vector_stores/{id}/files` with 300-token chunks, `/vector_stores/{id}/search`). Each answer searches the store with the question (1.5 s budget) and quotes the passages to the model exactly like local memories (`[M1]` citations); on no match, error or timeout it falls back to the phone lookup. Sync is manual and incremental (new / changed / deleted sessions), resumable, and the phone stores ids only (`helix.openai.knowledge.v1`). "Delete from OpenAI" removes the files and the store.
- Uploading is opt-in: nothing is sent until the user selects the OpenAI option and taps Sync.

## v0.11.4 — paced glasses writes (Even docs + community advice)

Even docs (Display & UI System): an `updateImageRawData` result of `success` means the update was accepted, not displayed; no concurrent image sends; 100 ms is the floor between image sends; a full-screen image takes about 800 ms. So awaiting the bridge promise is not an acknowledgement from the glasses.

- Every glasses write is followed by a pause before the next one: 80 ms by default, at least 300 ms after a page create / rebuild, and after an image 100 ms + 800 ms x (image area / 288x144) (splash ~810 ms, mascot ~130 ms).
- Setup → Diagnostics → "Pause between glasses updates": 80 / 250 / 500 / 1000 ms, applied live and saved on the phone, to test on hardware whether slower writes stop a freeze. The log records the setting at every start.
- Private builds: per Even docs (Private Testing) they survive backgrounding only briefly and can vanish after the phone locks; lock survival is validated in Beta Testing.

## v0.11.3 — glasses images only on a switch

The mascot no longer follows each answer (thinking / speaking). Images are sent when the page is drawn and on a switch: connect / disconnect, listen / pause, mode, error; mascot at most once per 8 s. Measured in `qa/perf.html` over 2 min of simulated conversation: 0 image writes per minute while listening (6 at startup), text writes unchanged at ~138 per minute. `mascotAnimation: true` restores the old behaviour (QA scenes only).

## v0.11.2 — glasses link discipline (from the first on-device freeze log)

The 0.11.1 log of a freeze showed no main-thread stall: one minute into listening a `textContainerUpgrade` took 3.5 s, a `rebuildPageContainer` was still pending, and the page was gone within 10 s. The slowdown was on the Even bridge / glasses link side, not in Helix's JavaScript.

- **One glasses write at a time.** Text, image and page writes share one queue (text and image writes used to overlap).
- **Back-off.** A write slower than 1.2 s pauses images and slows captions for 30 s; two slow image writes turn pixel art off for the session (`glasses-backoff` in the log).
- **Setup → Diagnostics → "Pixel art on the glasses"** switch (text-only HUD when off; saved on the phone).
- **Log:** glasses write counts and slowest answer per 5 s heartbeat, every page rebuild with its reason, re-push reasons, glasses link status changes (connected / worn / in case), bridge-slow from 1.5 s, and "last alive N s before this launch".

## v0.11.1 — freeze fix and diagnostics that survive a relaunch

- **Freeze with History open during a live session.** Every saved line re-rendered History by cloning the whole archive once per session (quadratic). Measured in `qa/perf.html?per=12&tab=history` (626 short sessions, 2 MB, Chrome 4x CPU throttle): main thread blocked 49.3 s of 60 s with single blocks up to 11.7 s before; 5.6 s of 60 s, longest 0.6 s (startup) after. History now renders at most once a second, only the view on screen, with cached keyed rows; `LocalHistoryStore.getSession / entryCount / sessionIdOfEntry` answer for one session without cloning.
- **Diagnostics persisted through the Even bridge** (`helix.diagnostics.v2`): on iOS the WebView's own localStorage was empty on the next launch, so the previous run left no trace. The log now also records main-thread stalls (>= 1.5 s late 1 s tick while on screen), the last controls tapped (ids only), and Even bridge calls that are slow (>= 3 s) or never return (>= 8 s). Heartbeat every 10 s. The report header carries the app version.
- **Not connected after a reload:** an action without a session now raises a "tap to connect" banner (phone) / prompt (glasses) instead of only failing.

## What's new in v0.11
- Glasses: one BODY box with the view text on the left and, inside the same box on the right (142 px), the current mode (bright) and the view list (LIVE / ANSWER / ASK / CONCEPTS / SUMMARY / CHECKS) with ▶ on the current view and unseen counts (①–⑨, ● for a changed summary). Double-tap turns that list into the menu (Answer, Verify, views, Mode ▶, Pause/Resume, Stop, Close); while not connected the menu offers Connect and Mode.
- Phone: Connect / Listen / Pause / Stop fold away (Controls chip, remembered); the glasses mirror shows the new layout.
- History: one row per session; a session opens to four tabs: Summary (with Generate summary for sessions without one), AI cues (answers with their question, checks, concepts), Transcript, Mindmap.
- Modes: each mode's system prompt is editable in Setup (Save prompt / Reset to built-in).
- New pixel logo (helix strands): `docs/assets/helix-logo-512.png`.

## What's new in v0.10 (modes + vibrant glasses)
**Conversation modes**, switchable live from the phone (mode chips under the controls) or the glasses (double-tap → Mode ▶). A switch applies the mode's presets and keeps the session running.

| Mode | What Helix does |
|---|---|
| Meeting | Decisions, owners, numbers; answers questions others ask; ASK THEM prompts |
| Technical | Precise engineering answers (numbers, assumptions, trade-offs); concepts, claims, look-ups; PROBE prompts (failure modes, limits, test evidence) |
| Interviewer | You run the interview: your own questions get an **answer key** on the glasses (§ ANSWER KEY: strong answer / probe / red flag); PROBE follow-ups; candidate claims to verify; summary of evidence. Only job-relevant evidence, never protected characteristics |
| Partner | Personal talks: CHECK IN prompts (listening, gentle questions), what matters to them in the summary; no fact-checks, concepts, web look-ups or auto-answers |
| Negotiation | Terms, offers and concessions on the table; questions that uncover interests; position changes flagged |
| Learning | Concepts (up to 5 per pass), study-note summary, clarifying questions |
| Social | Light follow-ups, quick look-ups, no claim checks or auto-answers |
| Quiet | Captions and a running summary only; ask when you want help |

**Glasses HUD redesign** (simulator-verified, 576×288, 16 green levels):
- Pixel-art images: Hex the owl-bot in the header shows idle / listening / thinking / speaking / error; a mode badge on the right; a splash (owl + HELIX wordmark + mode) while not connected. Images are 8-bit greyscale PNGs sent only when they change (~6 per minute in the perf harness; mascot at most every 2.5 s). Image containers are opaque, so the splash lives on its own page.
- Brightness hierarchy: bright title, dim right-aligned status, rounded 2 px body card, mid-bright caption.
- Glyphs verified on the G2 font: circled numbers ①–⑤ for prompts, § for answer keys, ♥ ★ ■ □ ▁–█ and more available.
- If the host rejects images 3 times, the HUD falls back to text-only with a mode tag (e.g. "· TECH").
- v0.10.1 phone: "On your glasses" is open by default and draws the same display as the glasses (mascot, mode badge, splash, bright title + dim status, rounded card, caption); collapsing it is remembered.

## What's new in v0.9.1 (iOS: long meetings + lock screen)
- History chunks: a session is stored in chunks of 100 entries; a live save rewrites only the last chunk. 90-minute meeting benchmark (simulated 12 lines/min + answers, 3 s save batches): v0.9.0 wrote 469 KB/min by minute 90 (20.8 MB total) because each save rewrote the whole growing session; v0.9.1 stays under ~80 KB/min (5.2 MB total). v0.9.0 single-shard sessions are read as is and split on their next save.
- iOS page-kill detection: a 30 s heartbeat (status, minutes, DOM size; no transcript) tells a normal close apart from iOS terminating the backgrounded WKWebView. Setup → Diagnostics shows "Last run: ended unexpectedly · … after N min in the background" when that happened.
- After such a reload the glasses still offer the interrupted session (as in v0.8): a ring click resumes it with the keys saved on the phone.

## What's new in v0.9 (battery + background)
Measured with `apps/g2-plugin/qa/perf.html` (production bootstrap, simulated G2 + realtime STT, 2 MB archive, Chrome 4x CPU throttle, 60 s live session):

| | v0.8 | v0.9 |
|---|---|---|
| Main thread busy | 34.4% | 15.8% |
| History written | 60.8 MB/min (whole archive per utterance) | 0.1 MB/min (per-session shards, 3 s batches) |
| Layouts / style recalcs | 35 / 67 per s | 7 / 16 per s |
| Glasses BLE writes | 3.8 per s | 2.1 per s |

- History storage v2: one key per session + small index; migration from v1 runs in the background on first launch.
- Animations stop when idle (transform-only equalizer, mascot plays briefly on state change, viewport-sized scanline layer).
- Phone renders are batched to one per frame and skipped while hidden; glasses clock shows minutes; caption writes every 500 ms.
- Background/lock: history is flushed when the page hides or freezes; on return the glasses page is redrawn, the mic re-armed and a stale realtime socket replaced. Setup → Diagnostics keeps a copyable lifecycle log (no keys or transcripts).

## v0.8 notes

## What's new in v0.8
- **Glasses-first HUD:** header · body · rolling caption that flows across sentences. Views: Live, Answer, Ask them, Concepts, Claims, Summary, Checks.
- **Ring/temple gestures:** single press = context action (verify highlighted claim/concept, ask highlighted question, next page); double press = native list **Menu** (scroll to move, press to select); long press = push-to-talk; swipe = views/pages.
- **Three question kinds:** questions others ask you get a direct answer ("THEY ASKED"); questions you could ask them appear as prompts ("ASK THEM"); info needs hidden in statements get a lookup/proposal. Your own questions are not auto-answered (uses the Even app's per-frame speaker role).
- **Verify on glasses** for claims and concepts, with sourced verdicts mirrored to Checks on the phone.
- **Phone ↔ glasses sync:** "On your glasses" mirror strip; the phone follows ring navigation, and phone tab taps move the glasses view.
- **History as sessions** (summary, key facts, people, concepts; clean transcripts), **Knowledge** tab (Omi · Obsidian · Helix with transfers and a knowledge map; Obsidian Markdown with Mermaid diagrams; export to Omi via its developer API), **People** tab.
- **Background/resume:** the glasses page is redrawn and the mic re-armed when you return to Helix; after an Android cold start you get a "tap to resume" prompt instead of a blank app.

## v0.7 notes

## What's new in v0.7
- **Models:** current OpenAI lineup (GPT-6.1 Terra default, GPT-6 Luna, GPT-6.1 Sol, GPT-6 Astra) plus legacy GPT-4.1/4o, or a custom ID. Selections save immediately and survive sessions. Reasoning models send `reasoning.effort` (`none` for Terra/Luna).
- **Transcription:** OpenAI Realtime `gpt-live-transcribe` streams audio while you speak (default, lowest latency). `gpt-transcribe`, whisper-1 and gpt-4o-mini-transcribe remain; whisper-1 and gpt-4o*-transcribe shut down 2027-02-26.
- **Timing and cost:** each answer shows speech→text, first word, end-to-end and cost from provider `usage` at list prices (checked 2026-11-07, `model-catalog.ts`). The header totals session cost. Unpublished prices show "price n/a", never a guess.
- **Grounding:** time-sensitive asks (lead times, prices, availability) use OpenAI web search with clickable citations. Local memory uses BM25 with stemming and reports "N matches of M searched".
- **Copilot lane** (phone only, default model GPT-6 Luna): rolling summary, Concepts tab (e.g. CDTF), conflict detection, suggested questions across the whole conversation, and implicit asks found in statements (e.g. "Jetson lead time is long" → web lookup; "16 GB RAM + 1 TB SSD" → proposed answer). Verify any answer, bullet or point on demand.
- **Rehearsal:** play scripted interview, hardware-planning or stand-up conversations through the live pipeline (Setup → Rehearsal). Live harness: `scripts/live-rehearsal.mjs` (see [docs/REHEARSAL.md](docs/REHEARSAL.md)).
- **UI:** pixel-art redesign with tabs: Answers / Concepts / Summary / Q&A / Checks / Setup / History.

## v0.6 notes

Conversation intelligence for Even Realities G2. The plugin runs inside the Even Realities phone app. Helix orchestration, question detection, conversation history and note selection run on the phone; the phone connects directly to selected cloud AI providers. **No Helix server, gateway, WSS address, proxy or cloud function is required.** This is not offline AI.

## v0.6 usage notes (historical)

Open **API keys & setup**, enter your OpenAI key, select **OpenAI Whisper** and **OpenAI Responses**, then Connect and Start listening. One OpenAI key supports transcription and answers. Single press asks for help with recent context; double press asks using the whole captured conversation. The phone also has separate local/global buttons. A new request replaces old answer work. Hold/release remains push-to-talk; start/pause/disconnect are on the phone and system exit remains available.

The glasses are blank when idle, with a full-width 576 × 288 text area while responding, automatic page advancement, and automatic hiding after the final page. Optional automatic explanations and sourced corrections appear temporarily only when the display is idle. Transcripts, source details and diagnostics stay on the phone. Long answers are paged instead of cut off with an ellipsis.

Local context focuses on the last six sentences and relevant earlier background. Global context uses the current session's captured transcript, stored independently from the last 50 phone feed items. Ordinary typed follow-ups retain bounded chat history. The session transcript has an explicit 96,000 UTF-8-byte limit: Helix reports when a new session is needed instead of silently discarding the beginning. Automatic/proactive responses consider both recent focus and global background.

Every answer request also has an aggregate model budget: serialized request UTF-8 bytes plus 600 output tokens and 1,024 framing tokens must fit 128,000 for GPT-4o mini or 1,047,576 for GPT-4.1 mini. This conservative byte bound is not an exact tokenizer. Oldest manual question/answer exchanges are omitted first if needed; the current transcript request, custom instructions and included local transcript memories remain intact. If those mandatory inputs alone exceed the budget, Helix reports an actionable limit before sending an answer request. Shorten the custom prompt, disable local memory, choose a larger supported model and reconnect, or start a new session. Provider context-overflow errors receive the same safe guidance without exposing upstream details. The captured transcript is never silently trimmed to fit. Responses explicitly disables automatic truncation.

The SDK preserves model IDs supplied through its freeform configuration. Verified budgets cover GPT-4o/mini (128,000) and GPT-4.1/mini/nano (1,047,576), with their documented dated snapshots. Other IDs use a provisional 4,096-token budget including the same reserves; this is a local policy, not a claim about their actual capacity or tokenizer. Small requests remain usable; oversized ones explain the provisional limit before dispatch. Helix never substitutes a different model, and provider context-overflow guidance remains the fallback for unverified models. The phone retains its existing two mini-model choices. Window sizes: [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini), [GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o), [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [GPT-4.1 nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano).

Whisper (`whisper-1`) and GPT transcription (`gpt-4o-mini-transcribe`) are separate choices. Deepgram and Soniox have their own selectable transcription/key fields. GPT answer choices are Responses or Chat Completions with GPT-4.1 mini or GPT-4o mini. Conversation modes, response strategy and system prompt are configurable.

History saves completed Helix transcripts and answers on this phone. Enter an Omi Developer API key and explicitly import conversations in History; answering never calls Omi. Search English or Chinese, open original passages, and follow answer source chips. Local memory starts ON and uses bounded lexical retrieval of original transcript passages, with recorded speaker/session/source attribution and current context taking priority. It may miss paraphrases. Web fact checking starts OFF; enabling it sends candidate speech claims directly to OpenAI web search and incurs provider charges. Corrections require executed search and clickable citations. Turning it OFF aborts pending checks and suppresses late results. See the [memory and import guide](docs/MEMORY_GUIDE.md).

Automatic term explanations start ON and use the selected answer model and runtime key, with provider charges. Cards are labeled AI-generated and not web-verified; expand, open the original transcript, or dismiss on the phone. The native tap-then-hold contextual menu offers Explain term, Local answer, Global answer, Dismiss cue, and Pause / resume. The phone Shortcuts panel exposes the same actions. QuickList writing is unsupported by the inspected SDK; no fallback service is implemented and the destination choice remains pending.

Keys are memory-only by default. Explicit **save on phone** uses ordinary Even App plugin local storage, not a documented encrypted credential vault. Never embed keys in source, environment build variables, the manifest or `.ehpk`. Only each matching provider receives its key. Automatic notes without Omi are session-only, not durable storage.
