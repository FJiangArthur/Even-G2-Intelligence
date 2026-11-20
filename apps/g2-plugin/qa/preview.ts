// Development-only visual fixture. Vite's production entry is index.html;
// this file is not imported by the application or included in the EHPK.
import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DEFAULT_CONFIG } from "../src/config";
import { GlassesRenderer } from "../src/glasses-renderer";
import { CompanionUi } from "../src/ui";
import type { PresentationSnapshot } from "../src/presentation";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const root = document.querySelector<HTMLElement>("#app")!;
const ui = new CompanionUi(root, DEFAULT_CONFIG);
let renderer: GlassesRenderer | undefined;
let current: PresentationSnapshot = { status: "ready", feed: [], glasses: { status: "ready" } };
function render(snapshot: PresentationSnapshot): void {
  current = snapshot;
  ui.render(snapshot);
  renderer?.render(snapshot.glasses);
}
function status(value: string): void {
  render({ ...current, status: value, glasses: { ...current.glasses, status: value } });
}
const question = "How should we launch the pilot?";
const answer = "Start with a small team and one clear workflow. Measure time saved, then expand after a week of feedback.";
function conversation(): void {
  render({
    status: "listening",
    feed: [
      { id: "t1", kind: "transcript", label: "Alex · transcript", body: question },
      { id: "q1", kind: "question", label: "Question detected", body: question, meta: "97% confidence" },
      { id: "a1", kind: "answer", label: "Helix · answer", body: answer, meta: "420 ms · simulated" },
      { id: "n1", kind: "note", label: "Captured this session · Pilot plan", body: "Run a one-week pilot with a small team.", noteDelivery: "session" },
    ],
    glasses: {
      status: "listening",
      question: { text: question, speaker: "Alex" },
      answer: { text: answer, streaming: false },
      note: { id: "n1", text: "One-week pilot with a small team.", delivery: "session" },
    },
  });
}
ui.bind({
  onAskLocal: async () => { conversation(); },
  onAskGlobal: async () => { conversation(); },
  onConnect: async () => { status("connected"); ui.setProviderKeyNotice("Local QA only: no keys saved or sent.", false); },
  onStart: async () => { conversation(); },
  onTogglePause: async () => { status(current.status === "paused" ? "listening" : "paused"); },
  onDisconnect: async () => { status("stopped"); },
  onAsk: async (text) => {
    render({ ...current, feed: [...current.feed, { id: crypto.randomUUID(), kind: "question", label: "You · manual question", body: text }] });
  },
  onClearProviderKeys: async () => ({ ok: true, message: "Local QA: key fields cleared; no storage was used." }),
});
render(current);
if (params.has("glasses")) {
  renderer = new GlassesRenderer(await waitForEvenAppBridge());
  await renderer.initialize();
}
if (params.get("scene") === "answer") conversation();
else if (params.get("scene") === "error") {
  render({ status: "failed", error: "Connection lost. Reconnect on your phone.", feed: [], glasses: { status: "failed", error: "Connection lost. Reconnect on your phone." } });
} else render(current);
if (params.has("setup")) {
  const panel = document.querySelector<HTMLDetailsElement>("#configuration-panel");
  if (panel) panel.open = true;
}
