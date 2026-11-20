# Historical Helix G2 v0.3 gateway README

Archived reference only. The v0.4 G2 app requires no Helix server; see the root README and G2_DEPLOYMENT.md. Commands and relative links below describe the old release.

Helix G2 is an SDK-first conversation assistant for Even Realities G2, derived from the existing native Helix engine.

The G2 public SDK runs TypeScript or JavaScript plugins inside the Even Realities phone app. It does not load the current Swift package. This workspace therefore keeps the G2 adapter thin, moves secrets and provider translation to a self-hosted gateway, and ports Helix behavior behind explicit device-neutral contracts and regression fixtures.

Version 0.3 adds visible OpenAI, Deepgram, Soniox, and Omi BYOK controls to the conversation UI. Keys are sent once over WSS to the user's self-hosted Helix server, which calls the selected provider directly. Saving on the phone is optional and uses ordinary Even App plugin local storage; keys are never compiled into the plugin or `.ehpk`, echoed by the server, or persisted server-side. Administrator-managed environment keys remain available as fallback.

## Workspace

```text
packages/conversation-sdk  Reusable browser SDK, wire protocol, VAD and note contracts
apps/g2-plugin             Even Hub plugin and phone companion UI
services/gateway           Self-hosted STT, question, answer and note gateway
docs                       Research, architecture, protocol and delivery plan
```

Start with:

- [G2 SDK research](docs/G2_SDK_RESEARCH.md)
- [target architecture](docs/ARCHITECTURE.md)
- [gateway protocol](docs/ENDPOINT_PROTOCOL.md)
- [migration and acceptance plan](docs/MIGRATION_PLAN.md)
- [v0.3 QA report](docs/QA_REPORT.md)
- [companion design audit](docs/DESIGN_AUDIT.md)
- [G2 deployment guide](docs/G2_DEPLOYMENT.md)

## Local setup

Requirements:

- Node.js 22
- npm
- Even Hub developer access for private-device testing
- Even G2 hardware for final audio, BLE pacing and resume acceptance

```bash
npm install
npm run check
```

Run the local mock gateway and plugin in separate terminals:

```bash
HELIX_MODE=mock npm run dev:gateway
npm run dev:plugin
```

Then launch the official simulator against the Vite URL printed by the plugin:

```bash
npx evenhub-simulator http://localhost:5173 --automation-port 9898
```

The mock path is for local contract and UI work. A real conversation requires an allowlisted server-side provider profile plus either a key entered in the companion or an administrator environment key described in `services/gateway/.env.example`. The companion never controls the provider endpoint, model, headers, or allowlist.

The browser/gateway wire contract uses `HELIX_PROTOCOL_VERSION` `2.1`, WebSocket subprotocol `helix.v2`, and route `/v2/conversations`. Protocol 2.1 adds the optional one-shot credential envelope; deploy the 0.3 client and server together when using BYOK.

Both provider selectors default to **Gateway default**. In that state the plugin omits the corresponding `session.providers` member, the gateway applies its server-configured default, and `session.started.accepted` reports the provider actually selected. It also acknowledges the exact requested automation settings so the client can reject silent policy changes. Automatic note capture is conservative: a completed answer must match a useful decision, commitment, action, deadline, requirement, preference, risk, blocker, priority, or explicit plan pattern in addition to passing the sensitive-content, uncertainty, question, error, and duplicate gates.

## Security boundary

Never place provider API keys in `VITE_*`, plugin source, `app.json`, or an `.ehpk`; released packages are extractable. The companion accepts keys in masked fields and can optionally remember them in a dedicated Even App local-storage record. That storage is convenience storage, not documented Keychain or encrypted secure storage. At connect, only keys relevant to the selected profiles are sent in one `session.start` over WSS and bound to immutable per-session provider adapters on the self-hosted server. The server writes no user-entered key. The separate Helix server access token remains memory-only and is used only during WebSocket authentication.

The Even Hub network whitelist is static and does not accept wildcards. For a production build, list one fixed Helix gateway origin in `apps/g2-plugin/app.json`. The current single-operator gateway routes each authenticated session only to server-configured, allowlisted provider profiles; per-user profile ownership remains future work.

## Status vocabulary

- **Scaffolded**: code and contracts exist locally.
- **Simulator-verified**: build and official simulator automation pass.
- **Private-build verified**: QR or `.ehpk` runs through the Even Realities app.
- **G2-verified**: real glasses microphone, display, gestures, latency and resume behavior pass.

Do not collapse these into one “done” state.
