# Historical v0.3 G2 plugin README

Superseded by the phone-only v0.4 plugin. See apps/g2-plugin/README.md and docs/G2_DEPLOYMENT.md. All gateway deployment directions below are historical, and relative links reflect the old file location.

Even Hub WebView plugin for running a Helix conversation session on Even Realities G2. It captures 16 kHz mono PCM from the glasses, streams it through the local `@helix/conversation-sdk`, and presents attributed transcripts, detected questions, streamed answers, and useful notes in both the companion UI and the glasses text container.

## Pinned Even Hub toolchain

- `@evenrealities/even_hub_sdk` `0.0.14`
- `@evenrealities/evenhub-cli` `0.1.14`
- `@evenrealities/evenhub-simulator` `0.9.5`
- Even App `2.2.9` or later, required by SDK `0.0.14`

The plugin also consumes the repository workspace package `@helix/conversation-sdk` at the matching local version `0.3.0`. npm links the workspace package; it is not fetched as a separate Helix implementation.

## What the plugin does

- Awaits the Even App bridge and creates one full-screen `576 x 288` text container before opening the G2 microphone.
- Opens `AudioInputSource.Glasses` only when the user selects **Start listening**.
- Preserves each frame's source, raw signed-int16 direction tag, and app-classified `self` / `other` / `unknown` speaker role. These are per-frame hints, not stable speaker identity.
- Uses device-neutral VAD in `@helix/conversation-sdk` to commit completed utterances. Long-press release also commits pending audio.
- Makes the live conversation the primary phone workspace. Gateway, profile, prompt, and memory settings live in a compact progressive-disclosure panel below it on phones and in a side rail on wide screens. Internal protocol identity labels are not presented as upstream-provider controls.
- Sends questions, automation choices, endpoint identity, prompt identity/version, conversation mode, response strategy, provider profile IDs, Omi memory choices, and user instructions through Helix protocol `2.1` over `/v2/conversations` with WebSocket subprotocol `helix.v2`.
- Supports `general`, `interviewee`, `interviewer`, `social`, `office-discussion`, and `passive` modes plus `reactive`, `proactive`, and `both` response strategies. New and migrated sessions default to `reactive`; proactive behavior requires explicit selection.
- Defaults both profile selectors to **Gateway default**. That sentinel is never sent as a profile ID: the plugin omits the corresponding `session.providers` member so the gateway can apply `HELIX_TRANSCRIPTION_PROVIDER` or `HELIX_ANSWER_PROVIDER`. Explicit transcription choices are `mock`, `openai-compatible`, `deepgram`, and `soniox`; explicit answer choices are `mock`, `openai-responses`, and `openai-compatible`. All are non-secret gateway profile IDs, not provider connections or credentials.
- Requires `session.started.accepted` to echo every explicitly requested mode, response strategy, provider profile, Omi setting, and all three automation booleans exactly. A missing or substituted acknowledgement fails startup instead of silently changing behavior; the accepted event always reveals the gateway's resolved providers, including when the UI used **Gateway default**.
- Debounces glasses `textContainerUpgrade` calls at no less than 120 ms.
- Treats `CLICK_EVENT = 0` as a click only when a system or text event envelope really exists, and handles explicit double-click before that fallback.
- Calls `shutDownPageContainer(1)` on double-click, then tears down audio, WebSocket state, subscriptions, and timers after the host reports system/abnormal exit.
- Displays conversation state as labeled text and chat cards. It never prints protocol JSON into the product UI.

## Security model

The plugin contains no built-in STT, LLM, or Omi credential. Session setup provides separate masked OpenAI, Deepgram, Soniox, and Omi key fields. On connect, relevant keys are sent once in the command-level `session.start.credentials` envelope over WSS to the user's self-hosted Helix server. They are never put in the gateway URL, WebSocket subprotocol, `SessionConfig`, events, or `.ehpk`.

The gateway access token is entered in the companion UI. It is encoded into the `helix-auth.*` WebSocket subprotocol for the handshake, kept only in runtime memory, cleared from the input after connect, and excluded from Even App local storage. Do not put tokens in the gateway URL, `.env` files, `app.json`, or Vite variables. Treat it as short-lived only when a trusted edge actually issues and expires it.

Phase 0 validates one operator-configured gateway token; it does not issue, expire, or refresh tokens. A deployment may supply a genuinely short-lived token only when a trusted edge implements that lifecycle. Expiry enforcement remains Phase 3 work.

Ordinary settings and provider credentials use separate stores. Saving API keys is off by default; enabling **Save API keys on this phone** writes only the four recognized keys to a dedicated versioned Even App plugin-local record. This is convenience storage, not documented Keychain or encrypted secure storage. **Clear saved API keys** overwrites that record with an empty value. Gateway access tokens, transcripts, notes, and chat history are never included. The self-hosted server holds a submitted key only for the active session and does not persist it.

The local note sink is intentionally in-memory and volatile; the UI labels that outcome **Captured this session**. The gateway proposes a note only when the completed answer matches its conservative useful-memory gate (decisions, commitments, actions, deadlines, requirements, preferences, risks, blockers, priorities, or explicit plans) and also passes safety and deduplication checks. The UI displays **Omi sync pending**, **Omi synced**, or **Omi sync failed** only when the gateway includes that explicit persistence outcome. Enabling Omi sync is a preference request; the gateway remains responsible for authorization, consent, durable storage, and reporting the real result.

## Install and run

From `<repo>`:

```bash
npm install
npm run dev:gateway
npm run dev:plugin
```

In another terminal, launch the pinned simulator:

```bash
npm run simulate -w @helix/g2-plugin
```

The simulator accepts the plugin at `http://localhost:5173` and exposes its automation API at `http://127.0.0.1:9898`. Simulator audio is PCM s16le, 16 kHz, mono, in 100 ms frames. Simulator success is useful for layout and event routing, but it is not G2 hardware acceptance.

If Vite reloads the WebView after the startup page already exists, simulator `0.9.5` can reject the second startup-page creation with result `1`. Restart the simulator after rebuilding a workspace dependency; a clean simulator launch creates the page successfully. Do not treat an HMR duplicate-page failure as a physical-G2 result.

For a phone paired with G2:

```bash
npx evenhub qr --url http://<development-machine-ip>:5173
```

The phone cannot reach a gateway bound only to its own `127.0.0.1`; use a LAN address during local device development or an HTTPS/WSS deployment.

## Network whitelist

`app.json` is strict JSON, so its entries cannot contain inline comments. The checked-in network origins mean:

- `ws://127.0.0.1:8787` and `ws://localhost:8787`: simulator-only/local gateway development.
- `wss://gateway.example.com`: explicit non-secret placeholder showing the required production scheme.

Even Hub enforces this manifest whitelist. Before packing for a real gateway, replace the entire list with the real WebSocket origin:

```bash
npm run configure:gateway -w @helix/g2-plugin -- wss://helix.your-domain.example
```

The script accepts only `ws://` or `wss://`, strips paths by writing the URL origin, and rejects embedded credentials, query strings, and fragments. Production gateways should use `wss://`.

Then set the same endpoint path in the companion UI, for example `wss://helix.your-domain.example/v2/conversations`.

## Test, build, and pack

```bash
npm run test -w @helix/g2-plugin
npm run build -w @helix/g2-plugin
npm run pack -w @helix/g2-plugin
```

`pack` builds the Vite app and invokes Even Hub CLI with `--sdk-ver 0.0.14`, which stamps the matching Even App compatibility floor. It produces `helix-g2.ehpk` in this folder.

Focused tests cover:

- zero-value click handling and independent PCM routing;
- double-click precedence, manual commit, and host exit routing;
- PCM little-endian conversion, including unaligned byte views;
- the 120 ms minimum render interval and latest-state coalescing;
- the 16-byte-safe container name and exact `576 x 288` startup page;
- proper attributed glasses text and useful empty-state actions instead of raw JSON;
- non-secret config persistence, bounded profile controls, and token/key exclusion;
- exact mode, response strategy, provider-profile, and Omi-memory fields in the session payload;
- conversation-first semantic UI structure and labeled controls;
- keyed streaming-message updates and reader-respecting feed scroll behavior;
- truthful volatile session capture versus Omi pending/synced/failed presentation.

## Device acceptance checklist

Do not call the plugin hardware-verified until all of these pass on a physical G2:

1. Startup page renders before the microphone opens.
2. G2 audio reaches the gateway as 16 kHz mono PCM without gaps during normal conversation.
3. App-classified speaker role and raw direction metadata arrive without being treated as identity.
4. A temple tap pauses/resumes once; audio frames alone never trigger a tap.
5. Long-press release commits the current utterance.
6. Double-tap opens the foreground exit decision and confirmed exit releases audio/socket/subscriptions.
7. Attributed transcript, question, answer, and note text remains readable on the physical display.
8. Rapid transcript/answer deltas do not overflow the BLE display queue.
9. A real allowlisted WSS gateway accepts the memory-only token and rejects an incorrect token. Expired-token rejection is a Phase 3 acceptance item after issuance and expiry enforcement exist.
10. The packed `.ehpk` opens in the target Even App release.
11. Omi read/sync remains off without explicit selection, and each attempted sync reports pending, synced, or failed without being confused with local capture.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/controller.ts` | G2 bridge lifecycle, SDK session, mic control, ordered PCM forwarding, cleanup |
| `src/even-event-router.ts` | Protobuf-zero-aware input routing and PCM conversion |
| `src/glasses-renderer.ts` | Full-screen startup container, attributed text formatting, throttled updates |
| `src/presentation.ts` | Transcript/question/answer/note view state, never raw wire objects |
| `src/ui.ts` | Companion controls and chat-style event feed |
| `src/config.ts` | Safe config normalization, persistence, and gateway URL policy |
| `scripts/set-gateway-origin.mjs` | Replaces the package-time Even Hub network whitelist |
