import type { DirectConversationOptions, ConversationTransport } from "@helix/conversation-sdk";
import type { G2BridgePort } from "./controller";
import {
  clearPersistedProviderCredentials,
  loadPersistedConfig,
  loadPersistedProviderCredentials,
  persistProviderCredentials,
  providerCredentialsFromForm,
  type SessionFormState,
} from "./config";
import { G2ConversationController, LIVE_HISTORY_WRITE_DELAY_MS } from "./controller";
import { GlassesRenderer } from "./glasses-renderer";
import { GlassesHud, hudViewForTab, resolveGlassesLayout } from "./glasses-hud";
import { ConversationPresentation } from "./presentation";
import { CompanionUi } from "./ui";
import { RESUME_PROMPT } from "./controller";
import { REHEARSAL_SCRIPTS } from "./rehearsal";
import { countDiagnostic, recordDiagnostic, watchLifecycle } from "./diagnostics";


export interface BootstrapOptions {
  /** Test/QA seam: production uses the default phone transport. */
  readonly transportFactory?: (options?: DirectConversationOptions) => ConversationTransport;
  /** URL query string (default location.search). */
  readonly search?: string;
}

/** Production app wiring, shared by main.ts (real Even bridge) and the QA/perf harnesses. */
/** "off" = text-only glasses HUD. Stored through the Even bridge. */
/** Minimum gap between two phone UI renders during a session. */
export const PHONE_RENDER_MS = 250;
export const GLASSES_IMAGES_KEY = "helix.glasses.images.v1";
/** Pause between glasses writes in ms (80 | 250 | 500 | 1000). Stored through the Even bridge. */
export const GLASSES_WRITE_GAP_KEY = "helix.glasses.write-gap.v1";
export async function bootstrap(root: HTMLElement, bridge: G2BridgePort & { rebuildPageContainer?: unknown }, options: BootstrapOptions = {}) {
  const [config, providerCredentials] = await Promise.all([
    loadPersistedConfig(bridge),
    loadPersistedProviderCredentials(bridge),
  ]);
  const presentation = new ConversationPresentation();
  // Glasses UI: the interactive HUD by default; `?glasses=answers-only` keeps the
  // v0.5 answer-only renderer until a config field selects it.
  const onGlassesError = (error: Error) => presentation.setStatus("failed", error.message);
  const savedGap = Number(await Promise.race([bridge.getLocalStorage(GLASSES_WRITE_GAP_KEY).catch(() => ""), new Promise<string>(done => setTimeout(() => done(""), 1500))]));
  const writeGap = [80, 250, 500, 1000].includes(savedGap) ? savedGap : 80;
  // v0.11.2: Setup → Diagnostics switch for a text-only glasses display (saved on this phone).
  const pixelArt = await Promise.race([bridge.getLocalStorage(GLASSES_IMAGES_KEY).catch(() => ""), new Promise<string>(done => setTimeout(() => done(""), 1500))]) !== "off";
  const renderer = resolveGlassesLayout(new URLSearchParams(options.search ?? location.search).get("glasses")) === "hud"
    ? new GlassesHud(bridge, { onError: onGlassesError, images: pixelArt, writeGapMs: writeGap })
    : new GlassesRenderer(bridge, { debounceMs: 120, onError: onGlassesError });
  const controller = new G2ConversationController(bridge, renderer, presentation, ...(options.transportFactory ? [options.transportFactory] as const : []));
  // Battery: batch live-session history saves (one shard + one index write per ~3 s, flushed on hide/stop).
  controller.liveHistoryWriteDelayMs = LIVE_HISTORY_WRITE_DELAY_MS;
  const ui = new CompanionUi(root, config, providerCredentials, {
    rehearsalScripts: REHEARSAL_SCRIPTS.map(script => ({ id: script.id, title: script.title })),
  });
  ui.attachHistory(controller);
  const pixelArtToggle = root.querySelector<HTMLInputElement>("#glasses-pixel-art");
  if (pixelArtToggle) {
    pixelArtToggle.checked = pixelArt;
    pixelArtToggle.addEventListener("change", () => {
      const on = pixelArtToggle.checked;
      recordDiagnostic("glasses-pixel-art", on ? "on" : "off");
      (renderer as { setImagesEnabled?: (enabled: boolean) => void }).setImagesEnabled?.(on);
      void bridge.setLocalStorage(GLASSES_IMAGES_KEY, on ? "on" : "off").catch(() => false);
    });
  }
  const gapSelect = root.querySelector<HTMLSelectElement>("#glasses-write-gap");
  if (gapSelect) {
    gapSelect.value = String(writeGap);
    gapSelect.addEventListener("change", () => {
      const ms = Number(gapSelect.value);
      recordDiagnostic("glasses-write-gap", `${ms} ms`);
      (renderer as { setWriteGap?: (ms: number) => void }).setWriteGap?.(ms);
      void bridge.setLocalStorage(GLASSES_WRITE_GAP_KEY, String(ms)).catch(() => false);
    });
  }
  recordDiagnostic("glasses-settings", `pixel art ${pixelArt ? "on" : "off"} · pause ${writeGap} ms`);
  // Glasses link changes (connected / disconnected, worn, in case): the usual companions of a slow bridge.
  let lastDevice = "";
  const stopDevice = (bridge as { onDeviceStatusChanged?: (callback: (status: { connectType?: string; isWearing?: boolean; isInCase?: boolean; batteryLevel?: number }) => void) => () => void })
    .onDeviceStatusChanged?.(status => {
      const text = `${status.connectType ?? "?"}${status.isWearing === undefined ? "" : status.isWearing ? " · worn" : " · not worn"}${status.isInCase ? " · in case" : ""}`;
      if (text === lastDevice) return;
      lastDevice = text;
      recordDiagnostic("glasses", `${text}${typeof status.batteryLevel === "number" ? ` · battery ${status.batteryLevel}%` : ""}`);
    });
  controller.subscribeModelAccess(access => ui.setModelAccess(access.accessible, access));
  controller.subscribeMode(config => ui.applyModeConfig(config)); // v0.10: glasses-menu switches update Setup too
  // Battery: at most one phone render per display frame (partials arrive several times a second),
  // and none while the page is hidden — the latest snapshot paints as soon as Helix is visible again.
  let pendingSnapshot: Parameters<typeof ui.render>[0] | undefined, renderFrame = 0, lastStatus = "", statusSince = Date.now(), lastRenderAt = 0, renderedStatus = "";
  const flushRender = () => { renderFrame = 0; const snapshot = pendingSnapshot; pendingSnapshot = undefined; if (snapshot) ui.render(snapshot); };
  const unsubscribeUi = presentation.subscribe((snapshot) => {
    pendingSnapshot = snapshot;
    if (snapshot.status !== lastStatus) { lastStatus = snapshot.status; statusSince = Date.now(); recordDiagnostic(`status:${snapshot.status}`, snapshot.error); }
    if (renderFrame) return;
    // v0.12.1 heat: at most PHONE_RENDER_MS between phone renders (live partials arrive many times a second;
    // each render is DOM work plus the glasses mirror). Status changes paint on the next frame.
    const wait = snapshot.status !== renderedStatus ? 0 : Math.max(0, lastRenderAt + PHONE_RENDER_MS - Date.now());
    const paint = () => { lastRenderAt = Date.now(); countDiagnostic("render"); renderedStatus = pendingSnapshot?.status ?? renderedStatus; flushRender(); };
    renderFrame = setTimeout(() => { if (typeof requestAnimationFrame === "function") requestAnimationFrame(paint); else paint(); }, wait) as unknown as number;
  });

  const connect = async (form: SessionFormState) => {
    await controller.connect(form);
    const persistence = await persistProviderCredentials(
      bridge,
      providerCredentialsFromForm(form),
      form.saveApiKeysOnPhone,
    );
    ui.setProviderKeyNotice(persistence.message, !persistence.ok);
    ui.clearToken();
    if (!form.saveApiKeysOnPhone) ui.clearProviderKeys(true);
  };

  ui.bind({
    onConnect: connect,
    onStart: () => controller.startListening(),
    onTogglePause: () => controller.togglePause(),
    onDisconnect: () => controller.disconnect(),
    onAsk: (question) => controller.ask(question),
    onAskLocal: () => controller.askContext("local"),
    onAskGlobal: () => controller.askContext("global"),
    onShortcut: id => controller.runShortcut(id),
    onAutoExplainTerms: enabled => controller.setAutoExplainTermsEnabled(enabled),
    onClearProviderKeys: () => clearPersistedProviderCredentials(bridge),
    onSettingsChange: form => controller.saveSettings(form),
    onTestKey: (key, model) => controller.testKey(key, model),
    onVerify: (target, id) => controller.verify(target, id),
    onVerifyClaim: id => controller.verifyClaim(id), // phone agent: Checks → Claims → Verify
    onRunCopilot: () => controller.runCopilot(),
    onTabSeen: tab => presentation.markSeen(tab),
    onTabSelect: tab => { const view = hudViewForTab(tab); if (view) controller.setHudView(view); },
    onModeChange: mode => controller.setMode(mode),
    getModePrompt: mode => controller.modePrompt(mode),
    onModePromptChange: (mode, prompt) => controller.setModePrompt(mode, prompt),
    onStopRehearsal: () => controller.stopRehearsal(),
    onRehearse: async (scriptId, speed) => {
      const title = REHEARSAL_SCRIPTS.find(script => script.id === scriptId)?.title ?? scriptId;
      try {
        // Rehearsal used to fail silently when not connected: connect with the current setup first.
        if (!controller.connected) {
          ui.setRehearsalState({ playing: true, label: "Connecting…" });
          await connect(ui.readForm());
        }
        ui.setRehearsalState({ playing: true, label: `Playing · ${title}` });
        ui.selectTab("answers"); // Watch it live on the phone; the glasses HUD shows it too.
        const result = await controller.rehearse(scriptId, speed);
        ui.setRehearsalState({ playing: false, label: result.completed
          ? `Finished · ${result.lines}/${result.total} lines in ${(result.durationMs / 1000).toFixed(1)} s`
          : `Stopped · ${result.lines}/${result.total} lines${result.error ? ` · ${result.error}` : ""}` });
      } catch (error) {
        ui.setRehearsalState({ playing: false, label: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  });

  // ---- lifecycle (glasses agent) ----
  // Cold start after the phone reclaimed the WebView (iOS terminates a backgrounded web content process
  // under memory pressure; Android discards it): "tap to resume" on the phone and the glasses (ring click).
  // Reconnects only through the normal connect path with keys already in the form (typed this
  // session or saved on this phone); never sends keys anywhere else, never auto-connects.
  controller.setResumeHandler(async flag => {
    const form = ui.readForm();
    if (!form.openaiApiKey.trim()) {
      presentation.setResumePrompt("Add your OpenAI key in Setup, then tap Connect to resume");
      ui.selectTab("setup");
      return;
    }
    await connect(form);
    if (flag.listening) await controller.startListening();
  });
  const resumeBanner = mountResumeBanner(root, () => void controller.requestResume().catch(error => presentation.setStatus("failed", error instanceof Error ? error.message : String(error))),
    () => controller.dismissResume());
  const unsubscribeResume = presentation.subscribe(snapshot => resumeBanner(snapshot.glasses.resumePrompt));
  // The phone may suspend the WebView (mic stops, sockets drop): re-push the glasses page and
  // re-open the mic when the page becomes visible again. iOS: visibilitychange/pagehide; Chromium
  // also has freeze/resume. Flush local history whenever the page may be suspended or reclaimed next.
  // Events and a 10 s heartbeat (state below, no transcript) are logged to Setup → Diagnostics.
  const stopWatching = watchLifecycle({
    describe: () => `${lastStatus || "starting"} ${Math.round((Date.now() - statusSince) / 60_000)}m · dom ${document.getElementsByTagName("*").length}`,
    onResume: reason => { void controller.resumeFromBackground(reason); },
    onHide: () => {
      const flush = (controller as { flushHistory?: () => Promise<void> }).flushHistory;
      if (flush) void flush.call(controller).catch(error => recordDiagnostic("history-flush-failed", error instanceof Error ? error.message : String(error)));
    },
  });
  // ---- end lifecycle ----

  await controller.initialize();
  // Mark the models this key can use before Connect, so Connect never waits on it.
  const keyInput = root.querySelector<HTMLInputElement>("#openai-api-key");
  const precheck = () => { if (keyInput?.value.trim()) void controller.checkModelAccess(keyInput.value).catch(() => undefined); };
  precheck();

  window.addEventListener("beforeunload", () => {
    stopWatching();
    try { stopDevice?.(); } catch { /* optional */ }
    unsubscribeResume();
    ui.clearToken();
    ui.clearProviderKeys();
    unsubscribeUi();
    ui.dispose();
    void controller.dispose();
  }, { once: true });
  return { controller, presentation, ui, renderer };
}

/**
 * Minimal phone prompt for an interrupted session (lifecycle). Self-contained so it works before
 * the phone UI renders its own; ui.ts may show snapshot.glasses.resumePrompt instead.
 */
function mountResumeBanner(host: HTMLElement, onResume: () => void, onDismiss: () => void): (text?: string) => void {
  const banner = document.createElement("div");
  banner.className = "resume-banner";
  banner.setAttribute("role", "status");
  banner.hidden = true;
  banner.style.cssText = "position:sticky;top:0;z-index:50;display:flex;gap:8px;align-items:center;padding:10px 12px;margin:0 0 8px;"
    + "background:#10261a;color:#c9ffd8;border:1px solid #2fae4a;border-radius:10px;font:600 14px/1.3 system-ui,sans-serif";
  const resume = document.createElement("button");
  resume.type = "button";
  resume.style.cssText = "flex:1;text-align:left;background:none;border:0;color:inherit;font:inherit;padding:0;cursor:pointer";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.style.cssText = "background:none;border:1px solid #2fae4a;border-radius:8px;color:inherit;font:inherit;padding:4px 8px;cursor:pointer";
  resume.addEventListener("click", onResume);
  dismiss.addEventListener("click", onDismiss);
  banner.append(resume, dismiss);
  host.prepend(banner);
  return text => {
    if (!banner.isConnected) host.prepend(banner);
    banner.hidden = !text;
    resume.textContent = text ?? RESUME_PROMPT;
    // v0.13 one page scroller: the banner floats at the top of the page; the sticky tab bar sits under it.
    host.style.setProperty("--banner-h", text ? `${banner.offsetHeight}px` : "0px");
  };
}
