# Agent Context — Helix-G2

## Purpose

Build a reusable, device-neutral Helix conversation SDK and an Even Hub plugin for Even Realities G2.

## Boundaries

- The G2 client is a TypeScript web plugin hosted by the Even Realities App. Do not add direct BLE code.
- Keep conversation orchestration in `packages/conversation-sdk`.
- Keep vendor display/audio/input adaptation in `apps/g2-plugin`.
- Phone-only architecture: orchestration and direct provider calls belong in `packages/conversation-sdk`. No Helix server or gateway is required by the G2 app. `services/gateway` is legacy development compatibility only.
- Runtime user API keys stay on the phone and are sent only to their matching provider. Persistence is explicit opt-in; never bundle keys into the plugin or `.ehpk`.
- Treat the SDK render canvas as 576 x 288 and debounce frequent glasses text updates.
- Preserve endpoint, model, prompt-version, speaker, latency, and note provenance in protocol events.
- Run `npm run check` before completing code changes.
- Simulator success is not G2 hardware acceptance. Record device-only gates separately.

## Layout

```text
packages/conversation-sdk  Device-neutral client, protocol, VAD, state and note contracts
apps/g2-plugin             Even Hub SDK adapter and companion WebView
services/gateway           Legacy gateway and mock protocol regression tests only
docs                       Research, architecture, endpoint contract and migration plan
```
