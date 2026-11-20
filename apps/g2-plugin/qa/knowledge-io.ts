// Dev-only fixture for the v0.13 Knowledge tab (import, export, Omi auto-import, PDFs); never imported by main.ts.
// Desktop browser: fake bridge on window.localStorage. `?embedded=1` pretends to be the Even app WebView
// (no browser download). This is NOT Even app or G2 acceptance.
import { StartUpPageCreateResult } from "@evenrealities/even_hub_sdk";
import { bootstrap } from "../src/app";
import type { G2BridgePort } from "../src/controller";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
if (params.get("embedded") === "1") (window as unknown as Record<string, unknown>).flutter_inappwebview = { fixture: true };
const prefix = "helix.qa.knowledge-io.";
const port: G2BridgePort = {
  getLocalStorage: async key => localStorage.getItem(prefix + key) ?? "",
  setLocalStorage: async (key, value) => { localStorage.setItem(prefix + key, value); return true; },
  createStartUpPageContainer: async () => StartUpPageCreateResult.success,
  textContainerUpgrade: async () => true,
  shutDownPageContainer: async () => true,
  audioControl: async () => true,
  onEvenHubEvent: () => () => undefined,
};
await bootstrap(document.querySelector<HTMLElement>("#app")!, port, { search: "?glasses=answers-only" });
document.querySelector("#qa-mode")!.textContent = `BROWSER FAKE BRIDGE${params.get("embedded") === "1" ? " · pretending to be the embedded WebView" : ""} — NOT NATIVE ACCEPTANCE`;
