# Original Android G1 UI assets

Reused from `Helix-iOS/android/app/src/main` on 2026-09-07. Source checkout
HEAD was `0b0bd514009199a3169618f6108efb9d772c9f1f`.

- `fonts/inter_variable.ttf`: unchanged `res/font/inter_variable.ttf`.
- `fonts/fraunces_variable.ttf`: unchanged `res/font/fraunces_variable.ttf`.
- `helix_assistant_hero.webp`: unchanged `res/drawable-nodpi/helix_assistant_hero.webp`.
- `licenses/OFL-Inter.txt` and `licenses/OFL-Fraunces.txt`: original bundled font licenses from `assets/licenses`.

The G2 companion CSS ports both palettes from `ui/HelixTokens.kt`, system
theme selection from `ui/Theme.kt`, Fraunces/Inter typography and variation
axes from `ui/Type.kt`, shape/spacing/motion tokens from `ui/Shapes.kt`, and
hairline cards with colored left rules from `ui/Components.kt`.

The companion structure adapts `ui/AssistantScreen.kt`: compact assistant
header, real listening controls, illustrated empty feed, bounded author-aligned
conversation bubbles, and a composer outside the scrolling history. Settings
use an accessible disclosure with a persistent top-level API key shortcut.
`ui/HelixApp.kt` was inspected for the app scaffold; its device, sessions and
knowledge navigation was not copied because those screens are not implemented
in this G2 plugin. Native Compose code cannot execute inside the WebView.

The light primary button uses the original dark ink on terracotta for readable
contrast. Existing G2 provider key setup, opt-in local saving, clear action,
conversation profiles and controller bindings are retained.
