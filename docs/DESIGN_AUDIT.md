# Helix G2 companion design audit

## Current revision: v0.3.1

The Android G1 Warm Linen visual system replaces the earlier dark-green
companion direction below. The glasses renderer is now a structured native
dashboard rather than one full-screen text container. See
[G1_UI_REUSE.md](G1_UI_REUSE.md) for provenance, scope and reproducible visual
fixtures. Runtime API keys are supported with opt-in local storage; the older
audit's no-client-key policy below describes the historical baseline only.

## Historical baseline and v0.2 audit

Audit date: 2026-09-06

## Evidence boundary

The baseline was captured from the official Even Hub simulator 0.9.5 at the
simulator's 1200 x 1538 companion viewport and 576 x 288 glasses framebuffer.
The local evidence is intentionally ignored by Git:

- `artifacts/design-audit-before/webview.png`
- `artifacts/design-audit-before/glasses.jpg`

The audit covers the companion's ready state and the glasses startup state. It
does not claim physical G2 legibility, touch ergonomics, or live-provider
latency.

## Baseline findings

| Area | Health | Observed issue | Design response |
|---|---|---|---|
| Task hierarchy | Needs work | Connection and prompt forms occupy the full first viewport; the live conversation is below the fold. | Make the conversation workspace primary and place setup in a compact, collapsible rail. |
| Conversation clarity | Mixed | Semantic message components exist, but they are not visible in the first-screen ready state. | Keep attributed chat cards in the main pane with an intentional empty state and always-visible composer. |
| Configuration | Needs work | Provider and model are free-text identity fields, so switching supported backends is unclear and error-prone. | Use labeled selectors for server-configured transcription and answer profiles; keep secrets off the client. |
| Modes and automation | Missing | The interface exposes three low-level checkboxes but no interview/social/office mode or proactive/reactive strategy. | Add a compact mode selector, response-strategy control, and plain-language explanations. |
| Memory | Missing | Automatic notes have no visible Omi context/read or sync destination control. | Expose separate Omi context and Omi note-sync toggles, with a server-side credential reminder. |
| Visual rhythm | Needs work | Large cards, inputs, and headings make setup feel like an administration form rather than a live assistant. | Tighten density, establish a workspace/sidebar grid, and reserve strongest emphasis for listening and asking. |
| Accessibility | Mixed | Contrast and focus treatment are generally strong, but several controls are below a dependable 44 px target and status is encoded partly by color. | Use 44 px minimum interactive height, visible focus rings, text status, and reduced-motion support. |
| Glasses startup | Needs work | The ready screen shows only `HELIX · READY`, leaving the next action unclear. | Add a short connection/listening cue while preserving the 576 x 288 text budget. |

## Target experience

The user should be able to identify the active mode, response strategy, STT
provider, answer backend, and Omi state at a glance, then connect and start
listening without scanning a long form. The fixed gateway URL and response
guidance remain available; server-owned provider/model and prompt-reference
identity fields are no longer presented as editable upstream controls. No
provider API key is accepted, persisted, or packaged by the plugin.

## Post-change verification

A clean official simulator run was captured at the same 1200 x 1538 companion
viewport and 576 x 288 glasses framebuffer:

- `artifacts/design-audit-after/webview.png`
- `artifacts/design-audit-after/glasses.png`
- `artifacts/design-audit-after/before-after.png`

The combined before/after image was reviewed as one comparison surface. The
result changes the first-screen task from gateway administration to an explicit
conversation workspace: connect/listen controls, G2 state, semantic empty/feed
region, composer, and gesture help are visible before configuration. Session
setup is collapsed but still summarizes the active mode, strategy, STT, and
answer selections.

The revised glasses ready state now says what to do next instead of stopping at
`HELIX · READY`. Streaming events remain attributed and byte-bounded. The
companion preserves the existing dark green visual direction while tightening
type scale, spacing, and card hierarchy. Interactive controls meet a 44 px
minimum, focus is visible, reduced motion is respected, and status remains
textual rather than color-only.

The live feed now reconciles message cards by ID, updates streaming content in
place, and scrolls only when the user was already near the bottom. This avoids
recreating/re-announcing the entire log on every answer delta and keeps the
composer reachable during a long session.

Verdict: **simulator design target met**. Physical G2 readability, phone touch
ergonomics, real provider latency, and app-resume behavior remain unverified.
