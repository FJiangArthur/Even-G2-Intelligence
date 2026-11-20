# Even Realities G2 SDK research

Research date: 2026-09-06

## Conclusion

The requested product is feasible on the public Even Hub SDK with one architectural adjustment: the public G2 surface is a web plugin running in a phone WebView, not a native iOS SDK. The existing Swift Helix binaries cannot run inside it. We should preserve the current Helix behavior as contracts and golden tests, port the device-neutral orchestration to TypeScript, and keep a server-side gateway for transcription, model access, prompt policy and synchronized notes.

The G2 gives us the inputs and outputs needed for conversation intelligence:

- four-microphone audio exposed as mono signed 16-bit little-endian PCM at 16 kHz;
- touchpad, optional R1 ring and IMU events;
- a high-level container display API;
- normal HTTPS and WebSocket networking from the phone WebView;
- persistent plugin-local storage.

## Verified public platform

| Area | Official finding | Design consequence |
|---|---|---|
| Runtime | Plugins are HTML/CSS/JavaScript or TypeScript hosted by the Even Realities app in Chromium WebView on Android and WKWebView on iOS. | Build a TypeScript SDK and plugin. Keep direct BLE out of this project. |
| Hardware role | The phone runs app logic. G2 renders containers, captures audio, and emits input. | Put state and networking on the phone/gateway, not the glasses. |
| Audio | `audioControl` selects G2 or phone microphone. Both deliver PCM16LE, 16 kHz, mono. | Stream G2 PCM to a server-side STT adapter; no resampling is needed for compatible providers. |
| Display | The SDK canvas is 576 x 288, monochrome green, with text, list and image containers. `textContainerUpgrade` supports up to 2,000 characters. | Render semantic text, debounce deltas, and keep pagination/layout in the G2 adapter. |
| Input | G2 and R1 support press, double press, swipe up/down, and tap then long press/release. | Map tap to pause/resume, double press to system exit, long press to manual commit, and swipes to answer navigation. |
| SDK | Current npm SDK is `@evenrealities/even_hub_sdk` 0.0.14, MIT licensed, with a minimum Even app version of 2.2.9. | Pin 0.0.14 and pack with `--sdk-ver 0.0.14` for a reproducible floor. |
| Tooling | Current registry versions are CLI 0.1.14 and simulator 0.9.5. | Pin both in the workspace and use the simulator HTTP API in CI. |
| Distribution | `evenhub pack` creates an `.ehpk`; private builds and QR sideload are supported before store submission. | Run simulator, private build, and physical G2 gates separately. |
| Network | Every origin must be listed in `app.json`, and the remote server must also return valid CORS headers. Wildcards are unsupported. | Use one stable Helix gateway origin. Arbitrary per-user upstream URLs live behind it. |
| Secrets | Released `.ehpk` contents can be extracted. Official guidance says API keys belong behind a server-side proxy. | Never ship OpenAI, Anthropic, STT, or custom provider keys in the plugin. |
| Lifecycle | Plugins are foreground-oriented. Android may reclaim the WebView; audio and sockets need to be rearmed. | Persist state eagerly and treat every resume as a possible cold start. |
| Storage | Plugin local storage survives suspension/kill/update but is sandboxed by package ID. There is no general filesystem or clipboard access. | “Automatic Notes” means Helix Knowledge through our note sink, not direct Apple Notes or arbitrary native notes access. |

## Requirement fit

### Conversation on G2

Supported. The official microphone API exposes the G2 four-mic stream, and the official ASR template demonstrates the intended path: G2 PCM to a chosen STT provider, then debounced transcript rendering on the glasses.

The production implementation should use automatic utterance segmentation, with a manual long-press commit fallback. The plugin sends audio to the Helix gateway. The gateway emits transcript, detected-question, streaming-answer and note events.

### Own endpoint

Supported through the gateway. Direct runtime entry of any URL is not compatible with Even Hub’s static network whitelist. Two safe operating modes are:

1. Recommended: one allowlisted Helix gateway origin, with authenticated per-user upstream routing on the server.
2. Private deployment: create a distinct `.ehpk` whose manifest allowlists the customer’s fixed endpoint.

The first mode scales, avoids repackaging, and keeps secrets out of the client.

### Own prompt and response behavior

Supported. Session configuration carries a prompt profile ID, prompt version, user instructions, response-length policy and conversation mode. The gateway combines them with a versioned safety/system layer and records prompt provenance on every response and note.

The endpoint adapter starts with OpenAI-compatible transcription and chat APIs. Additional codecs should implement the same `ConversationEndpoint` contract rather than leak provider JSON into the plugin.

### Intelligent automatic notes

Supported within Helix. The note policy rejects uncertain, sensitive, question-like, canned and duplicate material, then emits typed proposals with source turn, question, answer, provider, model and prompt version. A durable `NoteSink` can store them in the Helix gateway or forward them to a user-owned notes endpoint.

The public SDK does not expose a general phone filesystem, clipboard, Apple Notes, or other apps’ data. Native notes integrations therefore belong behind a server-side connector or a future enterprise SDK agreement.

## Differences from G1

| G1 implementation today | G2 public SDK target |
|---|---|
| Native Swift runtime and direct CoreBluetooth | TypeScript plugin inside Even app WebView |
| Raw dual-lens packet, ACK and HUD pagination logic | High-level container/audio/input bridge |
| `G1HudPage` appears in conversation outputs | Device-neutral semantic presentation events |
| Keychain and SwiftData adapters | Web local storage plus server persistence |
| Native provider clients | Gateway-managed providers and streaming protocol |

The reusable assets are the Helix domain behavior, prompt semantics, question tests, ordering rules, knowledge safety policy and evaluation fixtures. The raw G1 transport is intentionally not reused.

## Official-source inconsistencies to isolate

- The consumer product page lists a physical resolution of 640 x 350 and BLE 5.4. Developer documentation lists a 576 x 288 SDK canvas and BLE 5.2. Use the SDK’s 576 x 288 coordinate system and let the Even app own transport details.
- The simulator documentation text still names 0.9.3 while the npm registry currently serves 0.9.5. Pin the registry version and verify behavior locally.
- The lifecycle page says iOS WebView state can survive backgrounding, while the FAQ defines plugins as foreground-only and says background network calls do not run. Treat foreground-only as the supported contract and recovery as mandatory.

## Primary sources

- [Even Hub overview](https://hub.evenrealities.com/docs/get-started/overview)
- [Even Hub architecture](https://hub.evenrealities.com/docs/get-started/architecture)
- [Device APIs, including G2 audio](https://hub.evenrealities.com/docs/build/device-apis)
- [Display and UI system](https://hub.evenrealities.com/docs/build/display)
- [Networking and whitelist rules](https://hub.evenrealities.com/docs/build/networking)
- [Background and lifecycle](https://hub.evenrealities.com/docs/build/background-lifecycle)
- [Packaging, permissions and secret guidance](https://hub.evenrealities.com/docs/ship/packaging)
- [Simulator and automation API](https://hub.evenrealities.com/docs/test/simulator)
- [Even Hub FAQ](https://hub.evenrealities.com/docs/reference/faq)
- [Official Even Hub starter templates](https://github.com/even-realities/evenhub-templates)
- [SDK 0.0.14 registry metadata](https://registry.npmjs.org/@evenrealities%2Feven_hub_sdk/latest)
- [CLI registry metadata](https://registry.npmjs.org/@evenrealities%2Fevenhub-cli/latest)
- [Simulator registry metadata](https://registry.npmjs.org/@evenrealities%2Fevenhub-simulator/latest)
- [Even G2 product specifications](https://www.evenrealities.com/smart-glasses)
