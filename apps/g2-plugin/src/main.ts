import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { bootstrap } from "./app";
import { attachDiagnosticsStore, monitorBridge, recordDiagnostic } from "./diagnostics";
import "./styles.css";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app mount point");

root.innerHTML = `
  <main class="shell">
    <section class="setup-card">
      <p class="eyebrow">EVEN REALITIES G2</p>
      <h1>Connecting to Even App…</h1>
    </section>
  </main>
`;

// After Android restores a reclaimed WebView the bridge handshake can stall; never leave the user on a
// dead "Connecting…" screen: offer a reload after 8 s while still waiting.
const bridgeStarted = Date.now();
const watchdog = setTimeout(() => {
  recordDiagnostic("bridge-slow", "no Even bridge after 8 s");
  const card = root.querySelector(".setup-card");
  if (!card || card.querySelector(".reload-button")) return;
  const note = document.createElement("p");
  note.textContent = "The Even app has not answered yet. If this persists, reload Helix.";
  const reload = document.createElement("button");
  reload.type = "button"; reload.className = "button reload-button"; reload.textContent = "Reload Helix";
  reload.addEventListener("click", () => location.reload());
  card.append(note, reload);
}, 8000);

try {
  const bridge = monitorBridge(await waitForEvenAppBridge());
  clearTimeout(watchdog);
  // Load the persisted diagnostics (previous run's events + heartbeat) before anything reads them.
  await attachDiagnosticsStore(bridge);
  recordDiagnostic("bridge-ready", `${Date.now() - bridgeStarted} ms`);
  await bootstrap(root, bridge);
} catch (error) {
  clearTimeout(watchdog);
  const message = error instanceof Error ? error.message : String(error);
  recordDiagnostic("startup-failed", message);
  root.replaceChildren();
  const shell = document.createElement("main");
  shell.className = "shell";
  const card = document.createElement("section");
  card.className = "setup-card";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "G2 STARTUP FAILED";
  const heading = document.createElement("h1");
  heading.textContent = "Helix could not start";
  const detail = document.createElement("p");
  detail.textContent = message;
  detail.className = "startup-error";
  const retry = document.createElement("button");
  retry.type = "button"; retry.className = "button"; retry.textContent = "Retry";
  retry.addEventListener("click", () => location.reload());
  card.append(eyebrow, heading, detail, retry);
  shell.append(card);
  root.append(shell);
}
