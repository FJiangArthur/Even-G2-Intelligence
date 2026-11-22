# Changelog

Newest first. Entries are engineering notes written at release time; measurements name the harness they came from.

## v0.13.2 — microphone: foreground overload guard, per-event probe, non-blocking knowledge search

Report (real iPhone, screen on or locked): 20–60 s after listening starts, captions stop, the phone page stops responding and the phone heats up. A USB system log showed each microphone call going from 0.5–1 ms to 36–47 ms after one long call at the first answer request, with about 25 calls a second served against 42 arriving. **The root cause is not confirmed and nothing in this release was run on a phone.** Evidence: `npm run check` (conversation-sdk 435 tests, gateway 104, g2-plugin 357), Node and JavaScriptCore timings on a Mac, and a desktop-browser simulation (`qa/mic-guard.html`).

- **Saved-knowledge search no longer blocks the page.** It ran in one task at every answer, re-tokenized the whole archive and deep-copied every match: 462–654 ms on a 5 MB synthetic archive (Node on a Mac). It now uses a cached token index (`history-retrieval.ts`) and runs in ~5 ms slices (`retrieveAsync`, `warmRetrieval`): 10–16 ms total for the same query, index built once in about 190 ms of slices, longest slice 7.6 ms. Results are byte-identical to the old search on 470 random queries, including after history changes. An answer waits at most 2.5 s for the search (`knowledgeSearchDeadlineMs`); after that it goes out without saved knowledge and `memory-search-timeout` is counted. The index retains about 12 MiB for that archive (Node heap figure). On the phone, turning "Use saved knowledge in answers" off had stopped the freeze, which is why this is the first suspect for the long call. Diagnostics: `memory-search`, `memory-search-timeout`, `memory-index`, `memory-block`.
- **Overload guard on screen.** The 0.13.1 pause only worked on a hidden page. Now, when audio arrives below 72 % of this phone's normal rate in steady 2 s windows and a second signal confirms a backlog (a bridge ping unanswered for 1.5 s, a bridge call pending 3 s, or a late timer), Helix commits the current turn, closes the microphone, waits until audio events stop (at least 1 s closed, 0.5 s quiet, 10 s at most) and re-opens it. The third flush within a minute becomes a 30 s pause (doubling to 4 minutes) with a message on the glasses and the phone. A slow stream with no second signal gets one flush after 16 s and is then accepted as this phone's normal rate. Pause, stop and hold always win. Log lines: `audio-overload`, `audio-flush`, `audio-resume`.
- **The Even SDK's per-frame console line is skipped by default.** SDK 0.0.14 calls `console.log("[EvenAppBridge] EvenHub event:", event)` for every event, audio frames included (pinned by a test that loads the installed bundle). If the host forwards console output to the native side, that is about 42 messages a second carrying the audio. The diagnostics say so if the host replaces the console afterwards (`SDK audio log NOT skipped`). Whether this is the 40 ms is not known; Setup → Diagnostics → "Let the Even SDK log every audio frame" turns it back on for a comparison run.
- **Per-event probe** (`mic-probe.ts`, aggregates only, no audio or text): every 10 s the diagnostics gain a `mic` line (rate, gap between events, time in our handler, payload bytes, dropped frames, event-loop lag) and a `mic-sdk` line (which host entry point was seen, time inside the SDK before our handler, time in the SDK console line, raw payload size). A 2–3 minute run shows whether the time is in Helix, in the SDK, or outside the JavaScript call.
- **Microphone source** in Setup → Diagnostics: Glasses (default) or Phone. Untested on hardware; `app.json` gains the `phone-microphone` permission.
- Host entry point, read from the SDK bundle: the host calls `window._listenEvenAppMessage`; 0.0.14 has no window `message` listener.

Not verified on a phone: that the freeze is gone; that the WebView runs queued microphone calls between search slices; that closing the microphone drains the host queue; that bridge replies queue behind audio (the basis of the ping); the Phone source; false flushes on a weak BLE link or in a quiet room. Known and unchanged: each archived line still copies and sorts the whole session list twice (about 5 ms per line on a Mac with a 4.6 MB archive).

## v0.13.1 — lock screen: no replay of queued audio

Report: after locking the phone, captions stop within a minute; on unlock the page is frozen or white and the phone is hot.

- **Cause reproduced in `qa/perf.html` (`window.__burst`)**: while the WebView is suspended the microphone events queue up, and on resume they arrive at once. Helix processed all of them: after a 5 minute pause it uploaded 21 MB of stale audio in a burst (3,393 socket sends) with the main thread blocked for 4.7 s (Chrome, 4x CPU throttle, measured on the 0.12 line). With the fix the same resume uploads only live audio and the longest block is 0.4 s.
- **Audio intake** (`controller.audioRealtimeGuard`, on in the app): microphone audio is accepted only at its real-time rate (2 s burst allowance); a queued backlog is dropped before the PCM is converted and logged as `audio-backlog`. At most 3 s may wait for the session.
- **Batching:** 20 ms frames are handed to the session in ~100 ms batches (one hand-off instead of five promise chains).
- **Suspension detected without a visibility event:** 15 s without a timer runs the resume path (glasses re-push, microphone re-open, stale socket check) and logs `suspended`.
- Private builds are still stopped by the Even app shortly after the phone locks (Even docs, Private Testing); staying alive while locked needs a Beta or published build.
- **Overload pause** (from a system log of a real iPhone running 0.11.3 Beta, 2026-11-21): 17 s after the screen locked, every microphone event took 41–47 ms in the backgrounded WebView (0.5–0.8 ms in the foreground), back to back at 100 %, while events kept arriving faster; after unlock the page stayed frozen and blank for 35 s behind that queue. No process was killed. Helix now learns the phone's normal audio delivery rate on screen; on a hidden page, audio below 72 % of it for 6 s stops the glasses microphone ("MIC PAUSED · PHONE BUSY · UNLOCK TO RESUME", `audio-overload` in the log). It comes back when the page is visible, or on a retry after 30 s (doubling to 4 minutes).
- Not verified on a phone: the resume burst is a simulation, and the overload pause is tested against the measured rates only.

## v0.13.0 — ambient glasses display, more answer providers, news-backed checks, PDFs, Notes mode, History

Nothing in this release was run on G2 glasses or inside the Even Realities app, and no live request was made to DeepSeek, Qwen, Zhipu, Moonshot, OpenAI or Omi. Evidence: `npm run check` (conversation-sdk 425 tests, gateway 104, g2-plugin 333, all with fake providers and a fake bridge), one simulator smoke run of the ambient display, and a desktop browser with a fake bridge for the knowledge transfers. The device-only gates are listed in `docs/PIXEL_GESTURES.md`, `docs/PROVIDERS_AND_SEARCH.md` and `docs/MEMORY_GUIDE.md`.

**Review fixes (after the first 0.13.0 cut).**

- PDF save is all-or-nothing (`LocalHistoryStore.replaceSession`): a PDF that does not fit the 5 MiB phone archive fails whole. Before, an empty `pdf:` document stayed in History (and was synced to the OpenAI knowledge base), and a re-import that failed had already deleted the working copy. The PDF card and the docs now state the shared 5 MiB cap.
- Ambient HUD: a wake left over from an ended session no longer closes the Connect/Mode menu opened afterwards; a MENU click that arrives after the woken menu closed itself (idle or hide) is dropped instead of becoming a tap on the blank display, which asked a billed question.
- Answer length now also sizes automatically explained terms (Brief: one short sentence, up to 200 characters; Standard unchanged, 500; Detailed: two to four sentences, 900).
- Copy and docs corrected: "Detailed" raises the sentence limit to at least 6 (it is not a minimum); the tap on the blank display asks about the last few sentences (6), not "the last minute"; "via <provider>" appears only with a non-OpenAI answer provider; on DeepSeek, search results stand in as sources when the answer carries no citation; an entered OpenAI key is available to every session; Quiet-mode captions are on the phone and in the woken HUD; `docs/MEMORY_GUIDE.md` rewritten for provider-routed search, the ambient display and current gestures.

**Glasses: ambient display (new default).** Details: `docs/PIXEL_GESTURES.md`.

- During a session the glasses are blank: no caption, views, clock or images. The start screen still shows when not connected, connecting, ended or waiting for "tap to resume"; a failed session shows the full HUD.
- Answers pop up (THEY ASKED, a requested ANSWER with "Thinking…" while pending, ANSWER KEY), page by themselves and disappear 8 s after they finish. Cues pop up as `CONCEPT` / `LOOKUP` / `CHECK` / `FACT CHECK` / `TO-DO` (concept, finished lookup, conflict, verification and fact-check verdicts, and to-do changes in Notes mode), last page at least 5 s. An answer has the display first; up to 3 cues wait and one that waited more than 45 s is dropped. Suggestions, summaries, key facts, claims and pending or failed lookups do not pop up.
- Double-tap wakes the full HUD with the menu open; double-tap on the menu, or 20 s without a glasses gesture, returns to blank. While blank: tap pages or closes a pop-up, or asks about the last few sentences when nothing is showing; swipes page a pop-up; hold is unchanged. Selecting a phone tab does not wake the glasses.
- `● listening` / `○ paused` / `○ mic off` shows in the status corner for 4 s on a mic change.
- Pop-ups and their expiry are text writes only, under the existing debounce and write pacing; wake and hide are one page swap each.
- Setup → G2 controls → "Always show the glasses HUD" restores the previous HUD (stored as `helix.glasses.display.v1`, applies live).
- Simulator (evenhub-simulator 0.9.5, `scripts/qa_ambient.mjs`, fake provider): the blank frames had 0 lit pixels; the run printed `G2_AMBIENT_SMOKE_PASSED`. Simulator only, not hardware acceptance.

**Answer providers: DeepSeek, Qwen, Zhipu GLM, Moonshot Kimi.** Details: `docs/PROVIDERS_AND_SEARCH.md`.

- Six new profiles for answers and copilot through Chat Completions: `deepseek`, `qwen` (Beijing), `qwen-intl` (Singapore), `zhipu` (bigmodel.cn), `zai` (Z.ai), `moonshot`. Base URLs are fixed; all six origins are in the `app.json` whitelist. Per-provider differences (thinking switch, token-limit parameter, streaming usage, JSON mode) are explicit in `provider-registry.ts`.
- A DeepSeek, Qwen, Zhipu or Moonshot key joins a session only when that provider is selected for answers; an entered OpenAI key is available to every session for OpenAI-only features (search fallback, knowledge base, OpenAI transcription). No key is written to the settings record, and each is sent only to its own provider's URL. Setup → API keys → "Test provider key" sends one small request.
- A session no longer needs an OpenAI key (for example DeepSeek with Deepgram or Soniox). Connect names the missing key; Setup lists what is reduced without OpenAI (Responses API, model-list check, vector store, OpenAI transcription). History → Generate summary and OpenAI PDF parsing stay on an OpenAI model. A model id from another provider is replaced with a visible "Model switched" notice. Tap-to-resume accepts any key the selected session can use.
- Provenance (endpoint id, URL, provider, model) names the real provider, e.g. `deepseek-direct`.
- Cost estimates: DeepSeek uses its published peak rate (an upper bound); Qwen, GLM and Kimi show "price n/a".
- Built from provider documentation read on 2026-11-19 and tested with mocked responses only. Not added: Doubao and SiliconFlow (parameters could not be verified) and the mainland Moonshot host.

**News-backed fact checks.**

- Setup → Copilot → "Prefer latest news in fact checks" (`newsSearch`, on by default). The check lanes themselves are still opt-in. The prompt carries today's date, and time-sensitive claims (English and Chinese keywords) are marked `recency: "news"`. With the lane enabled, statements about current events also qualify, so it runs somewhat more checks.
- Citations carry `publishedAt` with `dateSource: "search"` (DeepSeek, Zhipu) or `"model"` (OpenAI, only for a URL that is a real citation). A verdict without a real source is still "uncertain".
- Search route: DeepSeek `deepseek_web_search`, Zhipu Web Search API (`oneMonth` for time-sensitive claims, widened once), OpenAI Responses `web_search` (no recency parameter, so prompt-only). Qwen, Z.ai and Kimi fall back to OpenAI search when an OpenAI key is entered; otherwise the automatic lane stays silent and Verify says no web search is available. Setup shows which applies.
- Phone: Checks cards show "latest news" and source chips with site and date, plus "via <provider>" when a non-OpenAI answer provider is selected. Glasses: a news verdict reads `news check` and its pop-up ends with `Src: site · date · +n` for the newest dated source.

**Answer length.** Setup → How Helix should help → Answer length: Brief / Standard / Detailed (`answerLength`, default `standard`). It drives live answers (sentence cap, wording, output tokens), copilot lookups and proposals, web-check verdicts and concept explanations. Standard sends the same prompts and limits as before (tested). Detailed lets an ambient cue use 6 pages instead of 3. Not covered: the legacy insight lane's explanation cap and the summary bullet counts.

**Knowledge: transfers fixed, Omi automatic import, PDFs.** Details: `docs/MEMORY_GUIDE.md`.

- **Export fix:** export clicked a hidden download link and always reported "Prepared …", although the Even bridge has no file-save API. It now tries a browser download (outside the embedded WebView), the share sheet, the clipboard, then an in-page Markdown view, and says which one happened.
- **Note import fix:** one unreadable file used to reject the whole batch without a message, and notes past 200 were dropped silently. Each file is now read on its own and gets a result row; the picker no longer filters by type; paste and `https://` link import are fallbacks (link import is expected to fail inside the Even app, where only whitelisted origins are reachable).
- **Omi automatic import** (new, off by default): at startup, on return to the foreground and every 30 min while open; retry 5 min after a failure. The switch and last outcome are stored under `helix.omi.auto-import.v1`; the key is not. An unreadable Omi conversation is skipped and counted instead of failing the import.
- **PDF → Helix** (new): up to 20 PDFs per batch, 30 MB each, 400,000 characters kept per PDF, per-file progress and Cancel. Parser choice: on the phone (pdf.js 4.10.38, lazy-loaded, text layer only, first 500 pages, no OCR) or with OpenAI (Files API upload with `purpose=user_data`, Responses `input_file`, upload deleted afterwards; "Add a PDF by link" passes the URL to OpenAI). Parsed text is saved as a history session tagged `pdf` with page numbers, found by the existing keyword retrieval, and synced to the OpenAI knowledge base when that is in use.
- **Package size:** pdf.js adds about 1.8 MB of lazily loaded chunks to the build, so the `.ehpk` grows: `npm run pack:g2` on 2026-11-19 produced a 1,534,915-byte `helix-g2.ehpk` (not committed).

**Notes mode (new, ninth picker mode).** Details: `docs/MODES.md` → Notes.

- Mode id `notes`, tag `NOTES`. Preset: summary, people and web search on; concept cards, conflicts, suggestions, "answer things people mention", claims and automatic answers off; plus `noteTaking`, a preset flag without a Setup switch.
- The copilot lane returns `todoOps` (add / update / complete / remove, each with a verbatim quote) and `notes`. An item whose quote is not found in the recent speech is dropped; at most 4 to-do changes and 3 notes per pass; a session holds up to 60 to-dos and 80 notes. A repeated or reworded item updates the existing one. Provenance per to-do: transcript id, quote, speaker, model, prompt version `notes-1`.
- Spoken commands on the wearer's own lines are applied on the phone without a model call: add (with owner and due date), complete, reopen, change owner, change due date, rename, remove; basic Chinese forms for add, complete and remove.
- Phone: Summary tab leads with the editable list (check, edit text / owner / due, reorder, delete, where each item came from) and the notes. History shows and edits the saved list; Markdown export writes `## To-dos` as task checkboxes and `## Notes`, and import reads the to-dos back.
- Glasses: one line per change (`TODO + …`, `TODO ~ …`, `TODO done: …`, `TODO open: …`, `TODO removed: …`). On the ambient display it pops up under `TO-DO` and expires like the other cues; in the woken HUD the SUMMARY view is `TO-DO` (view list, header, menu item `To-do`).
- On DeepSeek, Qwen, Zhipu and Moonshot the schema, including `todoOps` and `notes`, travels in the prompt (no strict JSON schema there); replies are validated the same way.
- Not run against a live model: the capture prompts were tested with mocked replies. Voice commands are pattern matches, so a mis-transcribed command is missed and an ordinary sentence that starts like one can change the list.

**History: summary after each conversation, cleaner list, one scroll.** Details: `README.md` → History.

- A session record is created with its first content (a saved line, summary item, to-do or note), not at Connect. Helix records with nothing in them, left by earlier versions (one per Connect or resume), are removed at startup. Tap-to-resume within 30 minutes continues the interrupted session: the parts are merged into one record, including one to-do list and one set of notes.
- When a session ends with at least 40 characters of speech and an OpenAI key in the session, one call (`session-digest-v2`) writes title, overview, summary, key facts and concepts; model, prompt version, endpoint, latency and time are stored as `session.recap` and shown in the session view. Otherwise the title is derived on the phone (never the first thing said) and Generate summary retries. With a DeepSeek, Qwen, Zhipu or Moonshot answer provider the call still goes to OpenAI with the default copilot model; imported sessions and PDFs keep their own title when a summary is generated for them.
- Cards are grouped by day and show title, time and duration, overview and labelled counts ("10 speaker turns · 2 Helix answers", plus to-dos and notes). PDF documents are listed last under Documents, described by page count and parser.
- Select → Remove for several sessions, Remove in the session view; both confirm in the page (no `window.confirm`, which can block the WebView), and so does Knowledge → Delete from OpenAI. Removal deletes the record, its shards, its to-dos and notes, and its file in the OpenAI knowledge base (immediately with a key, otherwise at the next Sync).
- History → "Let the knowledge base read history" is the existing `useLocalMemory` setting (Knowledge → "Use saved knowledge in answers"). Off: nothing saved is read for answers, and Sync to OpenAI is refused. It covers everything in the phone archive, imported Omi conversations, Obsidian notes and PDFs included; the note under the switch says so.
- Editing a saved session's to-dos does not touch `updatedAt`; the OpenAI sync stamp now includes a hash of the to-dos and notes, so an edit marks the session as changed. Sessions without a notebook keep their old stamp (no re-upload).
- The document is the only vertical scroller (tab bar sticky at the top, composer sticky at the bottom); the Setup fields, the PDF card and the notebook add no scroll container of their own (tested against the stylesheet).
- Not verified: the summary call with a live model, and the History page inside the Even app's WebView.

**Docs:** `docs/MODES.md` and `docs/MODES.zh-CN.md` (a guide to all nine modes), `docs/PROVIDERS_AND_SEARCH.md`, a rewritten `README.md` and a new `README.zh-CN.md`. The app UI is still English only, so `supported_languages` is unchanged.

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
