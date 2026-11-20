# Helix G2 plugin — v0.5

Even Hub phone WebView companion and G2 audio/display/gesture adapter. Production uses the SDK's `DirectConversationTransport`: **no Helix gateway or server address**.

Open **API keys & setup**, enter the OpenAI key, choose **OpenAI Whisper** and **OpenAI Responses**, then Connect and Start listening. GPT transcription, Deepgram and Soniox are separate selectable STT profiles. Provider keys are masked, memory-only by default, with explicit ordinary-local-storage opt-in and a clear-saved-keys action.

Commands from the workspace root:

```bash
npm run dev:plugin
npx evenhub-simulator http://localhost:5173 --automation-port 9898
bash scripts/run_gate.sh
npm run pack:g2
```

The pack command produces `apps/g2-plugin/helix-g2.ehpk`. Fixed provider origins are in `app.json`; no localhost or Helix gateway origin is needed in a release. Development files served by Vite are not a provider relay.

Single press asks using recent/local context; double press asks using the whole captured session. Separate phone buttons expose the same actions. Each manual request cancels/replaces previous answer work. Hold opens the microphone and release submits; phone Pause/Disconnect and system exit remain available. Double-tap no longer exits. Chat renders attributed transcript/question/answer/note cards rather than protocol JSON. Glasses are answer-only, blank when idle, with full-width native text and automatic page advancement instead of persistent dashboard panels.

Automatic notes say **Captured this session** unless a real Omi sync outcome is reported. Session notes/history are volatile. Omi read and sync are separate explicit opt-ins, off by default.

See [deployment](../../docs/G2_DEPLOYMENT.md), [architecture](../../docs/ARCHITECTURE.md) and [v0.5 QA](../../docs/ANSWER_FIRST_QA.md). Physical phone networking, real G2 microphone capture, screen pacing and background/resume remain separate acceptance gates.

## QA entrypoints

- `qa/phone-only.html`: real production main, direct providers, SDK and UI; substitutes only microphone fixture and storage. Requires an explicit `?audio=` URL to 16 kHz mono PCM16 data. No fixture or key is bundled into production.
- `qa/gestures.html`: legacy mock-protocol gesture regression only; explicitly injects a WebSocket test adapter. It does not represent the shipped connection architecture.

Do not put credentials in source, scripts, URLs, screenshots or recordings. QA key persistence is blocked. The optional one-shot loopback credential injector is test-only, shuts down after input and does not handle speech or AI traffic.
