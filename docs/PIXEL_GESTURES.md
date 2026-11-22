# Glasses display and touch behavior

## Ambient display (current default)

The glasses HUD (`apps/g2-plugin/src/glasses-hud.ts`) has two display settings:

| Setting | Behavior |
| --- | --- |
| `ambient` (default) | During a session the glasses are blank. Answers and cues pop up, page by themselves and disappear. The full HUD appears only after the menu gesture. |
| `always-on` | The previous HUD: header, views, status, caption and mode are on screen for the whole session. |

Where it is set: phone → Setup → G2 controls → **Always show the glasses HUD** (off = ambient).
It is saved on the phone through the Even bridge under `helix.glasses.display.v1`
(`"ambient"` or `"always-on"`; anything else means ambient) and applies at once.
In code: `GlassesHudOptions.display`, `GlassesHud.setDisplay()`, `resolveGlassesDisplay()`;
the idle time is `GlassesHudOptions.ambientIdleMs` (default `AMBIENT_IDLE_MS`, 20 s).

### What shows on the ambient display

| Moment | On the glasses |
| --- | --- |
| Not connected, connecting, session ended, "tap to resume" | The normal start screen (so the wearer sees that Helix is running). |
| Session starts, mic turns on or off | Blank; `● listening`, `○ paused` or `○ mic off` in the status corner for 4 s. |
| People talk | Nothing. No caption, no LIVE view, no clock, no images. |
| A question is answered (THEY ASKED, a requested ANSWER, ANSWER KEY) | Title and answer in the HUD text style. Long answers turn pages by themselves (3–10 s per page by length). Gone 8 s after the last page of a finished answer. |
| A requested answer is on its way | `◆ ANSWER` / `Thinking…` until the answer arrives. |
| A cue of the current mode: concept, finished lookup, conflict, verification or fact-check verdict, or a to-do change in Notes mode (`TODO + Send the quote - Mei, Fri`) | Title (`CONCEPT`, `LOOKUP`, `CHECK`, `FACT CHECK`, `TO-DO`) and text, up to 3 pages (6 with Answer length "Detailed"), then gone (last page at least 5 s). A verdict from a news-biased check reads `news check` and ends with its newest dated source (`Src: site · YYYY-MM-DD · +n`). |
| Hold to talk, mode switch and other gesture feedback | Short text in the status corner (`● HOLD · release to send`, 4 s for the others). |
| Session failed | The full HUD with the problem (it needs attention). |

Rules:

- An answer has the display first. A cue that arrives during an answer waits and shows after it;
  at most 3 cues wait, and one that waited more than 45 s is dropped.
- Suggestions (ASK THEM), summaries, key facts, pending or failed lookups and claims do not pop up.
  They are in the woken HUD and on the phone, with the usual unseen counts.
- Nothing pops up over the woken HUD; new items appear in its views.
- Expiry follows the clock. Timers only ask for a redraw, so a late or stale timer cannot bring
  back an answer or cue that already expired, and a re-sent snapshot does not show it again.

### Gestures

| Gesture | Blank display or pop-up | Woken HUD |
| --- | --- | --- |
| Double-tap | Wake: full HUD with the MENU open | On a view: open the MENU. On the MENU: hide the HUD (back to blank). |
| Tap | Pop-up: next page, or close on the last page. Blank: ask about the last few sentences (the answer pops up; a billed request). | As before (context action, or select the MENU item). |
| Swipe ↑ / ↓ | Pop-up: previous / next page; ↓ on the last page closes it. Blank: nothing. | As before (views, pages, MENU highlight). |
| Hold | Push to talk, as before. | As before. |

The woken HUD returns to blank 20 s after the last glasses gesture, also with the MENU open.
MENU ▶ Close closes only the menu and keeps the HUD until then. Selecting a phone tab moves the
HUD view but does not wake the glasses and does not count as a gesture.

### Pages and writes

- The blank display is its own page (`rebuildPageContainer`): the six HUD text containers, no frame
  border, no image containers. `hud-body` is the one event-capture container, so gestures are
  captured while blank. The OS shortcut menu stays.
- Wake and hide are one page swap each (to the MENU page and back). Pop-ups and their expiry are
  `textContainerUpgrade` writes only, with the same 120 ms debounce and write pacing as the HUD.
- A rejected page swap is retried at most once a second. On a host that cannot rebuild pages the
  texts are blanked on the HUD page (the frame stays) and the MENU uses the text fallback.
- With `always-on` none of this runs.

### Verification

- Unit tests: `apps/g2-plugin/tests/glasses-hud-ambient.test.ts` (blank idle, pop on answer, paging,
  expiry, cues, wake by menu, return to ambient, stale timers, always-on, real controller events).
  The older HUD tests run with `display: "always-on"`.
- Simulator (evenhub-simulator 0.9.5), fake provider, no keys:
  1. `(cd apps/g2-plugin && npx vite --port 5174 --host 127.0.0.1)`
  2. `evenhub-simulator "http://127.0.0.1:5174/qa/hud.html?scenario=ambient&display=ambient" --automation-port 9899`
  3. `node scripts/qa_ambient.mjs` → `G2_AMBIENT_SMOKE_PASSED`, framebuffers under `artifacts/ambient/`.
- Not verified on G2 hardware. Device-only gates: readability of pop-ups without the frame border,
  how visible the page swap is on wake and hide, whether double-tap is delivered reliably on the
  blank page from the temple and the R1 ring, the 20 s idle time and reading times in real use,
  and battery and link load compared with the always-on HUD.

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
