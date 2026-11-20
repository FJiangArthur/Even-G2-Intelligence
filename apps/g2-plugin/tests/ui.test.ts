import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANSWER_MODELS, type AnswerMeta } from "@helix/conversation-sdk";
import {
  answerMetaLine,
  answerModelOptionsMarkup,
  companionMarkup,
  FEED_FOLLOW_SLACK_PX,
  feedFollowDelta,
  panelScrollTop,
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
    // v0.13: removal is confirmed in the page (a native dialog can block the Even WebView), and the same
    // memory switch is offered in History as "Let the knowledge base read history".
    expect(historySource).not.toMatch(/window\.confirm\(|\balert\(|\bprompt\(/u);
    expect(historySource).toContain('role", "alertdialog"');
    expect(historySource).toContain("Let the knowledge base read history");
    expect(historySource).toContain("controller.setLocalMemoryEnabled(this.knowledgeToggle.checked)");
    expect(historySource).not.toMatch(/Clear history|Delete all/iu);
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
    expect(styles).toMatch(/\.shell\s*\{[^}]*min-height:\s*100dvh/su);
  });

  it("v0.13: the document is the only vertical scroller (no fixed-height shell, no scrolling tab panel)", () => {
    const rules = [...styles.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}@;]+)\{([^{}]*)\}/gu)].map(match => ({ selector: match[1]!.trim(), body: match[2]! }));
    // Cascade for one plain selector, in source order: the last height and vertical overflow win.
    const effective = (selector: string) => {
      let height = "auto", overflowY = "visible";
      for (const rule of rules) {
        if (!rule.selector.split(",").map(item => item.trim()).includes(selector)) continue;
        for (const declaration of rule.body.split(";")) {
          const [property, value] = declaration.split(":").map(part => part.trim());
          if (!property || !value) continue;
          if (property === "height") height = value;
          if (property === "overflow-y") overflowY = value;
          if (property === "overflow") overflowY = value.split(/\s+/u).at(-1)!;
        }
      }
      return { height, overflowY };
    };
    // Nothing between the document and the tab content is height-limited or scrolls on its own.
    for (const selector of ["html", "body", "#app", ".shell", ".panels", ".tabpanel", ".conversation-card", ".conversation-feed", ".history-panel", ".history-detail", ".session-list"]) {
      expect(effective(selector), selector).toEqual({ height: selector === "html" ? "100%" : "auto", overflowY: "visible" });
    }
    expect(styles).toMatch(/html, body, #app \{ margin: 0; min-height: 100%; \}/u);
    // The tab bar sticks under the floating resume banner; the composer sticks to the bottom of the page.
    expect(styles).toMatch(/\.tabbar-wrap \{ position: sticky; top: var\(--banner-h, 0px\);/u);
    expect(styles).toMatch(/\.composer \{ position: sticky; bottom: 0;/u);
    // The scroll code drives the document, not an inner element.
    expect(uiSource).toContain("doc?.scrollingElement");
    expect(uiSource).not.toMatch(/scroller\(\)[^\n]*querySelector<HTMLElement>\("\.shell"\)/u);
  });

  it("v0.13: follows new messages only when the end of the feed is in view, and aligns a new tab under the stuck tab bar", () => {
    // End of feed visible above the composer: no scroll needed. Pushed below it: scroll by the overflow.
    expect(feedFollowDelta({ endBottom: 500, viewportHeight: 844, composerHeight: 120 })).toBeLessThanOrEqual(0);
    expect(feedFollowDelta({ endBottom: 760, viewportHeight: 844, composerHeight: 120 })).toBe(44);
    // The reader scrolled up (end far below the fold) or nothing is laid out: do not follow.
    expect(feedFollowDelta({ endBottom: 2400, viewportHeight: 844, composerHeight: 120 })).toBeGreaterThan(FEED_FOLLOW_SLACK_PX);
    expect(feedFollowDelta({ endBottom: undefined, viewportHeight: 844, composerHeight: 120 })).toBe(Number.POSITIVE_INFINITY);
    // Tab bar not stuck (panels start right under it): the header stays where it is.
    expect(panelScrollTop({ scrollTop: 120, panelsTop: 362, pinnedBottom: 362 })).toBeUndefined();
    // Scrolled 900px into a long panel: the next panel starts at its top, right under the stuck bar.
    expect(panelScrollTop({ scrollTop: 1200, panelsTop: -838, pinnedBottom: 62 })).toBe(300);
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
    expect(uiSource).toMatch(/readSettings\(\): SessionFormState \{\s*return \{ \.\.\.this\.readForm\(\), openaiApiKey: "", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", accessToken: "" \};/u);
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
