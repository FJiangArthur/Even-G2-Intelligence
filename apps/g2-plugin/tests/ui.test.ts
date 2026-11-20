import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANSWER_MODELS, type AnswerMeta } from "@helix/conversation-sdk";
import {
  answerMetaLine,
  answerModelOptionsMarkup,
  companionMarkup,
  gestureHelpLines,
  mascotStateFor,
  retrievalNote,
  shouldAutoScrollConversationFeed,
  statusDetail,
  transcriptionCatalog,
  transcriptionNote,
} from "../src/ui";
import { ICONS, MASCOT_FRAMES, pixelText, textBitmap } from "../src/pixel-art";
import { TAB_DEFINITIONS, tabFromKey } from "../src/tabs";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const uiSource = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");
const historySource = readFileSync(new URL("../src/history-panel.ts", import.meta.url), "utf8");
const knowledgeSource = readFileSync(new URL("../src/knowledge-panel.ts", import.meta.url), "utf8");

describe("companion UI structure", () => {
  it("uses the compact checkbox toggle with a clickable wrapping label for automatic explanations", () => {
    const markup = companionMarkup();
    expect(markup).toMatch(/<label class="toggle" for="auto-explain-terms"><input id="auto-explain-terms" type="checkbox">\s*<span>Explain technical terms automatically<\/span><\/label>/u);
  });
  it("offers an accessible visible Shortcuts expander, ordinary action buttons and live explanation cost toggle", () => {
    const markup = companionMarkup();
    expect(markup).toContain('id="open-shortcuts-button"');
    expect(markup).toContain('aria-controls="shortcut-panel" aria-expanded="false"');
    expect(markup).toContain('id="shortcut-panel"');
    for (let id = 1; id <= 5; id++) expect(markup).toContain(`id="shortcut-${id}"`);
    expect(markup).toContain('id="auto-explain-terms"');
    expect(markup).toContain("Uses your selected answer model and incurs provider charges");
  });
  it("offers local and whole-conversation actions with accurate gesture and answer-only copy", () => {
    const markup = companionMarkup();
    expect(markup).toContain('id="ask-local-button"');
    expect(markup).toContain('id="ask-global-button"');
    expect(markup).toContain("Ask local context");
    expect(markup).toContain("Ask whole conversation");
    // v0.8: gesture help comes from glasses-hud GESTURE_HELP (double press opens the glasses menu).
    for (const line of gestureHelpLines()) expect(markup).toContain(line.slice(line.indexOf(":") + 1).trim().replace(/&/gu, "&amp;").slice(0, 20));
    expect(markup).toContain('id="gesture-strip"');
    expect(markup).toMatch(/class="gesture-list gesture-help"/u);
    expect(markup).not.toContain("double-tap to stop");
    expect(uiSource).not.toContain("Live transcript on");
  });
  it("exposes Setup and History as tabs before the live feed and keeps binding targets unique", () => {
    // v0.7: the old "API keys & setup" / "History" header links became tabs.
    const markup = companionMarkup();
    expect(markup.indexOf('id="tab-history"')).toBeLessThan(markup.indexOf('id="conversation-feed"'));
    expect(markup.indexOf('id="tab-setup"')).toBeLessThan(markup.indexOf('id="conversation-feed"'));
    expect(markup).toContain('aria-controls="panel-history"');
    expect(markup).toContain('aria-controls="panel-setup"');
    expect(uiSource).toContain('this.selectTab("setup")');
    const ids = [...markup.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts the semantic live conversation before progressive setup", () => {
    const markup = companionMarkup();

    expect(markup.indexOf('id="conversation-title"')).toBeGreaterThan(-1);
    expect(markup.indexOf('id="conversation-title"')).toBeLessThan(
      markup.indexOf('id="configuration-panel"'),
    );
    expect(markup).toContain('role="log"');
    expect(markup).toContain('aria-atomic="false"');
    expect(markup).toContain('aria-label="Live conversation messages"');
    expect(markup).toContain('id="configuration-panel"');
    expect(markup).not.toMatch(/<(?:pre|code)\b/u);
  });

  it("offers bounded profiles and visible, masked BYOK controls", () => {
    const markup = companionMarkup();

    for (const id of [
      "conversation-mode",
      "response-strategy",
      "transcription-provider",
      "answer-provider",
      "history-mount",
    ]) {
      expect(markup).toContain(`id="${id}"`);
    }

    for (const value of [
      "openai-whisper",
      // v0.10 picker modes (legacy interviewee / office-discussion are no longer offered)
      "general",
      "technical",
      "interviewer",
      "partner",
      "negotiation",
      "learning",
      "social",
      "passive",
      "reactive",
      "proactive",
      "both",
      "deepgram",
      "soniox",
      "openai-responses",
      "openai-compatible",
    ]) {
      expect(markup).toContain(`value="${value}"`);
    }

    expect(markup).not.toContain('id="access-token"');
    expect(markup).not.toContain('id="gateway-url"');
    expect(markup).toContain('id="answer-model"');
    for (const id of ["openai-api-key", "deepgram-api-key", "soniox-api-key", "omi-api-key"]) {
      expect(markup).toContain(`id="${id}" type="password"`);
      expect(markup).toContain(`for="${id}"`);
    }
    expect(markup).toContain('id="save-api-keys" type="checkbox"');
    expect(markup).toContain('id="clear-provider-keys"');
    expect(markup).toContain("Even App plugin local storage");
    expect(markup).toContain("not described as Keychain or encrypted secure storage");
    expect(markup).toContain("directly from your phone");
    expect(markup).not.toContain("Advanced gateway identity");
    expect(markup).not.toMatch(/id="(?:endpoint-id|provider|model|prompt-id|prompt-version)"/u);
  });

  it("labels primary controls and memory choices for assistive technology", () => {
    const markup = companionMarkup();

    expect(markup).toContain('aria-label="Conversation controls"');
    expect(markup).toContain('for="manual-question"');
    expect(markup).toContain('id="history-mount"');
    // v0.8: memory toggles and imports moved from History to Knowledge.
    expect(knowledgeSource).toContain("Use saved knowledge in answers");
    expect(knowledgeSource).toContain("Live web fact check");
    expect(knowledgeSource).toContain("Search incurs provider charges");
    expect(knowledgeSource).toContain('this.local.id = "use-local-memory"; this.web.id = "live-web-fact-check"');
    expect(historySource).toContain("window.confirm");
    expect(historySource).toContain("if (signature === this.detailSignature) return");
    expect(historySource).toContain("this.selectedEntry = entryId");
    expect(styles).toMatch(/\.history-detail \.is-selected\s*\{[^}]*background: var\(--support-tint\)/su);
    expect(markup).toContain("No server setup required");
  });

  it("keeps long conversation history scrollable without pushing away the composer", () => {
    expect(styles).toMatch(/\.conversation-card\s*\{[^}]*height:/su);
    expect(styles).toMatch(
      /\.conversation-feed\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/su,
    );
  });

  it("updates streaming messages in place and respects a reader scrolled up in history", () => {
    expect(uiSource).not.toContain("feed.replaceChildren");
    expect(uiSource).toContain("this.feedElements.get(item.id)");
    expect(shouldAutoScrollConversationFeed({
      scrollHeight: 1_000,
      clientHeight: 400,
      scrollTop: 570,
    })).toBe(true);
    expect(shouldAutoScrollConversationFeed({
      scrollHeight: 1_000,
      clientHeight: 400,
      scrollTop: 250,
    })).toBe(false);
  });

  it("prefers an exact asynchronous error over generic status copy", () => {
    expect(statusDetail("failed", "Deepgram rejected the configured API key")).toBe(
      "Deepgram rejected the configured API key",
    );
    expect(statusDetail("authorizing")).toBe("Starting the conversation session");
    expect(uiSource).toContain("statusDetail(snapshot.status, snapshot.error)");
  });
});

describe("v0.7 tabbed pixel HUD", () => {
  const markup = companionMarkup();
  it("uses WAI-ARIA tabs with one selected tab and a labelled panel per tab", () => {
    expect(markup).toContain('role="tablist"');
    const tabs = [...markup.matchAll(/role="tab" aria-selected="(true|false)" aria-controls="panel-([a-z]+)"/gu)];
    expect(tabs.map(match => match[2])).toEqual(["answers", "concepts", "summary", "qa", "checks", "people", "history", "knowledge", "setup"]);
    expect(tabs.filter(match => match[1] === "true")).toHaveLength(1);
    for (const tab of TAB_DEFINITIONS) {
      expect(markup).toMatch(new RegExp(`id="panel-${tab.id}"[^>]*role="tabpanel" aria-labelledby="tab-${tab.id}"`, "u"));
      expect(markup).toContain(`id="badge-${tab.id}"`);
    }
    expect(tabFromKey("answers", "ArrowLeft")).toBe("setup");
    expect(tabFromKey("setup", "ArrowRight")).toBe("answers");
    expect(tabFromKey("qa", "Home")).toBe("answers");
    expect(tabFromKey("qa", "Enter")).toBeUndefined();
  });

  it("shows a sticky HUD with mascot, mic, G2, cost, tokens and latency plus the four primary controls", () => {
    for (const id of ["mascot", "mic-state", "glasses-state", "cost-value", "token-value", "latency-value", "connect-button", "start-button", "pause-button", "disconnect-button"]) {
      expect(markup).toContain(`id="${id}"`);
    }
    expect(markup.indexOf('id="connect-button"')).toBeLessThan(markup.indexOf('role="tablist"'));
    expect(styles).toMatch(/\.shell\s*\{[^}]*height:\s*100dvh/su);
  });

  it("lists current and legacy answer models, a custom id option, the copilot model and the transcription catalog", () => {
    const options = answerModelOptionsMarkup();
    expect(options).toMatch(/<optgroup label="Current">.*gpt-6\.1-terra.*<\/optgroup><optgroup label="Legacy">.*gpt-4\.1-mini.*<\/optgroup>/su);
    for (const model of ANSWER_MODELS) expect(options).toContain(`value="${model.id}"`);
    expect(options).toContain("Custom model id…");
    expect(markup).toContain('id="answer-model-custom"');
    expect(markup).toContain('id="copilot-model"');
    expect(markup).toMatch(/<select id="transcription-provider"><option value="openai-realtime"/u);
    expect(markup).toContain('value="openai-transcribe"');
    expect(uiSource).not.toContain('"gpt-4.1-mini"');
    const realtime = transcriptionCatalog().find(item => item.profileId === "openai-realtime")!;
    expect(transcriptionNote(realtime)).toContain("streaming · lowest latency");
    const whisper = transcriptionCatalog().find(item => item.profileId === "openai-whisper")!;
    expect(transcriptionNote(whisper)).toContain("2027-02-26");
    for (const id of ["copilot-summarize", "copilot-concepts", "copilot-conflicts", "copilot-suggestions", "copilot-implicit-asks", "copilot-web-grounding"]) {
      expect(markup).toContain(`id="${id}" type="checkbox"`);
    }
  });

  it("never sends API keys through the debounced settings path", () => {
    expect(uiSource).toMatch(/readSettings\(\): SessionFormState \{\s*return \{ \.\.\.this\.readForm\(\), openaiApiKey: "", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", deepseekApiKey: "", dashscopeApiKey: "", zhipuApiKey: "", moonshotApiKey: "", accessToken: "" \};/u);
    expect(uiSource).toContain("save(this.readSettings())");
    expect(markup).toMatch(/class="config-group provider-key-group"[^>]*data-no-persist/u);
  });

  it("hides rehearsal unless scripts are supplied and escapes their titles", () => {
    expect(markup).toMatch(/id="rehearsal-group"[^>]*hidden/u);
    const withScripts = companionMarkup([{ id: "jetson", title: "Jetson <sync>" }]);
    expect(withScripts).not.toMatch(/id="rehearsal-group"[^>]*hidden/u);
    expect(withScripts).toContain('<option value="jetson">Jetson &lt;sync&gt;</option>');
    for (const id of ["rehearsal-speed", "rehearse-play", "rehearse-stop"]) expect(withScripts).toContain(`id="${id}"`);
    expect(withScripts).toMatch(/<option value="4">4×<\/option>/u);
  });

  it("builds the answer meta line and retrieval diagnostics from AnswerMeta", () => {
    const meta: AnswerMeta = {
      answerId: "a", grounded: "conversation", sources: [],
      timing: { speechMs: 3000, transcriptionMs: 1200, queueMs: 0, firstTokenMs: 800, generationMs: 1000, endToEndMs: 2400 },
      usage: { id: "u", kind: "answer", model: "gpt-6.1-terra", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, webSearchCalls: 0, audioSeconds: 0, costUsd: 0.0012, measured: true, at: "" },
      retrieval: { searchedEntries: 42, matched: 0, webUsed: false },
    };
    expect(answerMetaLine(meta)).toBe("speech→text 1.2 s · first word 800 ms · total 2.4 s · $0.0012 · gpt-6.1-terra");
    expect(retrievalNote(meta)).toBe("no memory match (searched 42)");
    expect(answerMetaLine(undefined, "12 ms")).toBe("12 ms");
    expect(answerMetaLine({ ...meta, usage: { ...meta.usage!, costUsd: undefined, model: "gpt-4o-mini" } })).toContain("price n/a · gpt-4o-mini");
    expect(uiSource).toContain('verifyButton(item.body, item.id, "answer")');
    expect(uiSource).toContain('verifyButton(bullet, `summary-${index}`, "point")');
  });

  it("derives the mascot state from the session", () => {
    const base = { status: "listening", feed: [], asks: [] } as const;
    expect(mascotStateFor(base)).toBe("listening");
    expect(mascotStateFor({ ...base, status: "ready" })).toBe("idle");
    expect(mascotStateFor({ ...base, status: "failed" })).toBe("error");
    expect(mascotStateFor({ ...base, feed: [{ id: "q", kind: "question", label: "", body: "" }] })).toBe("thinking");
    expect(mascotStateFor({ ...base, feed: [{ id: "a", kind: "answer", label: "", body: "", streaming: true }] })).toBe("speaking");
  });

  it("draws original crisp pixel art from consistent bitmaps and respects reduced motion", () => {
    for (const [name, rows] of Object.entries(ICONS)) {
      expect(rows, name).toHaveLength(12);
      expect(new Set(rows.map(row => row.length)), name).toEqual(new Set([12]));
    }
    for (const frames of Object.values(MASCOT_FRAMES)) for (const frame of frames) {
      expect(frame).toHaveLength(16);
      expect(new Set(frame.map(row => row.length))).toEqual(new Set([16]));
    }
    expect(textBitmap("HELIX")[0]).toBe("k...k.kkkkk.k.....kkkkk.k...k");
    expect(pixelText("Q&A")).toContain('<span class="sr-only">Q&amp;A</span>');
    expect(markup).toContain('shape-rendering="crispEdges"');
    expect(markup).not.toMatch(/(?:src|href)="https?:/u);
    expect(styles).not.toMatch(/@import|fonts\.googleapis/u);
    expect(styles).toMatch(/steps\(var\(--frames\)\)/u);
    expect(styles).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{ animation: none !important/u);
    expect(styles).toMatch(/prefers-color-scheme: light/u);
    expect(styles).toMatch(/\.is-partial > p::after/u);
  });
});
