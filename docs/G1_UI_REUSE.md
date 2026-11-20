# G1 companion reuse and G2 display design

## Scope

Version 0.3.1 ports the Android G1 app's visual system to the G2 companion.
Android Compose code remains in the G1 project; the G2 implementation is HTML
and CSS hosted by Even App, not an Android runtime or BLE port.

Source project: `Helix-iOS (separate private project)`.

| Android source | G2 reuse |
| --- | --- |
| `android/app/src/main/java/com/artjiang/helix/ui/HelixTokens.kt` | Warm Linen light/dark palette, terracotta actions, sage secondary states, warm borders |
| `android/app/src/main/java/com/artjiang/helix/ui/Type.kt` | Bundled Fraunces display and Inter reading fonts; no external font service |
| `android/app/src/main/java/com/artjiang/helix/ui/Shapes.kt` | Rounded controls and cards with consistent spacing |
| `android/app/src/main/java/com/artjiang/helix/ui/AssistantScreen.kt` | Conversation-first assistant, illustrated empty state, attributed chat cards and separate setup |
| `android/app/src/main/res/drawable-nodpi/helix_assistant_hero.webp` | Original G1 assistant illustration |

G2 retains its implemented feature scope. There are no decorative navigation
tabs for unavailable G1 features. API key setup remains accessible from the
assistant header, with masked OpenAI, Deepgram, Soniox and Omi fields and the
existing opt-in local persistence behavior.

## Glasses display

The phone palette is not sent to the glasses. The 576 × 288 display uses native
Even SDK containers, pixel-aligned geometry, a compact status header, a
priority content panel, secondary context and note-delivery status. Answer
reading takes priority over repeating the transcript and question together.
Long content is explicitly bounded; the complete conversation remains on the
phone. No battery, latency or connection telemetry is invented.

## Reproduce visual QA

Start `npm run dev:plugin` at the repository root, then open:

- `http://localhost:5173/qa/preview.html` for the empty assistant.
- `http://localhost:5173/qa/preview.html?scene=answer` for an attributed sample conversation.
- `http://localhost:5173/qa/preview.html?setup=1` for expanded configuration.
- Add `&glasses=1` to an answer fixture URL in the official simulator to render
  the same production renderer with synthetic content.

The QA fixture uses the real companion class and renderer, with local-only
synthetic actions. It sends no provider requests and saves no credentials.
It is not a Vite production entry and must not appear in `dist` or the EHPK.
The normal `index.html` remains the production entry and must also be checked
in the official simulator to validate startup and touch event routing.

Browser evidence validates DOM behavior and responsive layout. Simulator
framebuffers validate native container layout. Neither establishes physical
G2 legibility, Bluetooth/audio behavior, nor live-provider performance.
