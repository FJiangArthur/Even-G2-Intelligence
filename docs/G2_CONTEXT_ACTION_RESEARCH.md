# G2 contextual explanations, actions and shortcuts

Research checked 2026-09-12 against installed SDK 0.0.14, published 0.0.15 declarations, and current official documentation. Implementation and device acceptance are separate from this research.

## What is supported

The native contextual menu opens on **tap then long press**. Helix can register `menuObject.menuItems` on page creation; selected actions arrive as `menuItemClickEvent.itemID`. The OS owns this gesture, so Helix should not invent its own timer-based tap/hold recognizer. Normal tap/local answer, double tap/global answer, and plain hold/release voice input remain unchanged. The phone needs equivalent visible controls because firmware/gesture delivery still needs real-device acceptance.

Keep menu IDs non-zero and unique, names under 32 UTF-8 bytes, and carry menu declarations through any page rebuild. Menu foreground enter/exit is overlay lifecycle, not app shutdown. Sources: [Contextual Menu](https://hub.evenrealities.com/docs/build/contextual-menu), [Device APIs](https://hub.evenrealities.com/docs/build/device-apis).

## Explanation cards

Use the existing full-width text display for short, temporary term explanations; do not display raw transcription on glasses. Phone cards retain expandable details and the originating transcript. New explicit answer requests take priority and invalidate stale automatic explanations. Automatic explanations should be separately switchable, deduplicated, rate limited, and labeled AI-generated rather than web-verified. The app cannot know with certainty which terms the wearer understands.

A community implementation renders its own cue card with details and older cues; this is an example of plugin UI, not access to Even's native Conversate UI. Its backend architecture is not suitable for Helix's phone-only requirement. [Community source](https://github.com/Tej-Sharma/even-reality-memory-system).

## Native QuickList boundary

Even documents creating/editing tasks in the Even app and creating them by voice through Even AI. The installed SDK and inspected 0.0.15 declarations expose no public QuickList create/update method. This is a statement about the inspected public interface, not proof that no private interface exists. Do not call guessed native methods, automate hidden credentials, use reverse-engineered BLE, or label a local save as native sync.

[Official QuickList guide](https://support.evenrealities.com/hc/en-us/articles/14269247458319-Dashboard).

The community `even-todoist` app uses phone WebView → Todoist API → its own HUD task list. It is serverless, but it adds Todoist and does not establish native QuickList access. [Project source and architecture](https://github.com/howyi/even-todoist).

Pending user choice: capture action items locally with an explicit copy handoff, or keep native QuickList integration pending. Neither fallback can honestly promise automatic native QuickList creation. No extra task service is added by default.

## Implemented controls (Task 5)

Startup page `menuObject` uses installed SDK 0.0.14 `MenuContainerProperty` and `MenuItemProperty`; every startup creation includes the same five nonzero IDs. Helix currently has no page rebuild call.

| ID | Native menu / phone shortcut | Result |
| --- | --- | --- |
| 1 | Explain term | Ordinary latest-wins manual query using the existing whole captured conversation context; explain one recent technical term or say none is clear. |
| 2 | Local answer | Existing local-context query. |
| 3 | Global answer | Existing whole-session context query. |
| 4 | Dismiss cue | Clear the current automatic glasses cue; phone cards remain available. |
| 5 | Pause / resume | Existing microphone pause/resume control. |

The phone's visible **Shortcuts** button expands ordinary buttons. It does not open the OS menu. On glasses the OS owns tap then long press. System exit has priority; a menu selection is handled before omitted-zero click fallback. Unknown IDs dispatch no action and cancel any pending tap. Foreground enter/exit cancels pending taps without disposing the conversation. Existing audio, plain hold/release, local tap and global double tap remain supported.

**Explain technical terms automatically** defaults on and applies immediately. Copy explicitly discloses use of the selected answer model, provider charges and AI-generated/not-web-verified status. Turning it off cancels pending analysis and clears cues before preference persistence. A save failure remains visible and does not turn the feature back on.

Only final live speech triggers optional analysis. It uses the current OpenAI answer profile/model and runtime key through the existing direct streaming decoder, with no web search, memory lookup, endpoint, provider, or task service added. Quoted recent speech is bounded to 4,000 characters. Work is limited to one active and latest pending, a 10-second cooldown, 15-second timeout, 2,000 output characters, one source-present term of at most 80 characters and explanation of at most 500 characters. Normalized-term dedupe retains 200 terms per session. Manual queries cancel background work; failures remain nonfatal.

Phone cards show the term, an expandable explanation, original transcript control and dismiss button. Source text uses safe DOM text; only an explicit source click changes focus. The original opens in the live feed or saved history when available. Cards are live-feed items, not a new persisted history kind. Glasses show only the first display-sized page of a fresh eligible cue for eight seconds; full detail stays on the phone. Visible/streaming answers and pending manual requests win, and busy or expired cues never queue for later replay. Disconnect, disposal, explicit asks and disabling explanations clear the cue/timer lifecycle.

Automated fixture tests establish these implementation contracts. Task 4 must still exercise the fresh native simulator runtime for automatic explanations, native menu selection and the phone Shortcuts button. Firmware gesture delivery and physical glasses remain separate acceptance gates. No QuickList writer or fallback service was implemented.
