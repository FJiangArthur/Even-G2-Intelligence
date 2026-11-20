# Helix G2 v0.8 — glasses-first interaction, knowledge base, people

Contract additions: `packages/conversation-sdk/src/copilot-types.ts` (QuestionKind, CopilotClaim, CopilotPerson,
CopilotCallbacks.onClaim/onPerson, CopilotSettings.claims/people, KnowledgeSource, HudMirror). Additive changes only.

## User feedback driving this release (2026-11-08, tested on real G2)
1. Captions break between sentences instead of flowing (phone feed + glasses caption reset at each final).
2. Three question kinds: (a) questions OTHERS ask the wearer -> direct answer on glasses; (b) questions the wearer
   could ASK the other party -> shown on glasses as a prompt; (c) implicit info needs in statements (lookup/propose).
3. Claims and concepts get a Verify action directly on the glasses.
4. Glasses MENU driven by the R1 ring/temple: scroll, click (short), double, long press/release.
5. Glasses UI mirrors the phone UI and is interactive; glasses operations are reflected on the phone.
6. History = sessions; Knowledgebase tab with Omi / Obsidian / local Helix context, transferable among the three.
7. History overview cleaned up: no URLs/metadata in transcript lines; per-session summary, key facts, people;
   knowledge-base overview + a diagram.
8. People tab (P2): people mentioned/speaking, linked to sessions.
9. Bug: switch to another app and back -> UI gone. Even docs: Android may suspend/reclaim the WebView (cold start,
   mic + WebSocket dropped); createStartUpPageContainer is "called exactly once at startup".

## Even platform facts (hub.evenrealities.com docs, read 2026-11-08)
- Temple and R1 ring share gestures: press CLICK_EVENT 0, SCROLL_TOP_EVENT 1 (swipe up), SCROLL_BOTTOM_EVENT 2
  (swipe down), DOUBLE_CLICK_EVENT 3 on textEvent/listEvent of the single isEventCapture container; LONG_PRESS_EVENT 9 and
  LONG_PRESS_RELEASE_EVENT 10 always on sysEvent. OS claims "tap then long press" for the native context menu
  (menuObject <= 10 items, itemName <= 32 UTF-8 bytes, ids from 1; opening/closing sends FOREGROUND_ENTER/EXIT).
- List containers: firmware-scrolled lists with highlight, <= 20 items x 64 chars, events on listEvent; changing a list
  requires rebuildPageContainer (full redraw, brief flicker; re-send menuObject or it is cleared).
- <= 8 text/list + 4 image containers. Text: create/rebuild 1000 chars, textContainerUpgrade 2000 chars.
- Android WebView may be suspended (mic stops, WebSocket drops) or reclaimed (cold start). Re-enable mic on foreground
  with the same AudioInputSource. localStorage survives.
- Simulator 0.9.5: line pitch 27 px; ✓ ✗ ⚠ ► ▸ do not render; ● ◆ ▶ ▲ ▼ → ↑ ↓ · … • do.

## Ownership
- SDK agent: packages/conversation-sdk/** only.
- Glasses agent: apps/g2-plugin/src/{glasses-hud,glasses-renderer,answer-pager,even-event-router,shortcut-actions,
  glasses-mirror(new)}.ts, the "Glasses HUD" + lifecycle regions of controller.ts, lifecycle wiring in main.ts,
  presentation.ts additions for `hud` mirror + `claims`.
- Phone agent: apps/g2-plugin/src/{ui,history-panel,knowledge-panel(new),people-panel(new),config}.ts, styles.css,
  presentation.ts additions for `people` + continuous transcript, controller.ts history/knowledge/people region.
- Integrator: final wiring, gate, simulator E2E with real key, package.
