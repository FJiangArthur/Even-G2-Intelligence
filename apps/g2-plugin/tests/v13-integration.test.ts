import { StartUpPageCreateResult, type CreateStartUpPageContainer, type RebuildPageContainer, type TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { ANSWER_PROVIDER_CATALOG, answerLengthProfile, providerOrigins } from "@helix/conversation-sdk";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, providerCredentialsForSession, type SessionFormState } from "../src/config";
import { GlassesHud, verdictSourceLine } from "../src/glasses-hud";
import type { GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";

/** v0.13 merge: news verdicts and the answer-length setting reach the ambient pop-ups; Setup holds every new setting once. */
class Bridge implements GlassesRenderBridge {
  public async createStartUpPageContainer(_: CreateStartUpPageContainer) { return StartUpPageCreateResult.success; }
  public async rebuildPageContainer(_: RebuildPageContainer) { return true; }
  public async textContainerUpgrade(_: TextContainerUpgrade) { return true; }
}
const at = "2026-11-19T18:00:00.000Z";
async function listening(options: ConstructorParameters<typeof GlassesHud>[1] = {}) {
  const hud = new GlassesHud(new Bridge(), { tickMs: 0, writeGapMs: 0, ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  presentation.setStatus("listening");
  await vi.advanceTimersByTimeAsync(6000);
  return { hud, presentation };
}
/** v0.16: the pop-up on the hidden display as its non-blank lines, without the centring spaces. */
const pop = (hud: GlassesHud) => hud.frame.body.split("\n").map(line => line.trim()).filter(Boolean);
const LONG = "Distributors currently list twelve to sixteen week lead times for the module, developer kits ship sooner but are allocation limited, and the fallback needs a larger supply. ";

afterEach(() => { vi.useRealTimers(); });

describe("v0.13 integration: ambient pop-ups, news verdicts and answer length", () => {
  it("names the newest dated source of a verdict", () => {
    expect(verdictSourceLine([])).toBeUndefined();
    expect(verdictSourceLine([{ url: "https://www.example.com/a", title: "A" }])).toBe("Src: example.com");
    expect(verdictSourceLine([
      { url: "https://old.example.com/a", title: "A", publishedAt: "2026-10-01" },
      { url: "https://news.example.org/b", title: "B", publishedAt: "2026-11-18", site: "Example News" },
      { url: "https://x.example.net/c", title: "C" },
    ])).toBe("Src: Example News · 2026-11-18 · +2");
  });

  it("a news fact verdict pops up as a correction with its dated source", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.applyFactCheck({ id: "f1", sessionId: "s", transcriptId: "t1", claim: "The rate was cut this week", status: "contradicted",
      summary: "The bank held rates on Tuesday.", checkedAt: at, recency: "news", via: "DeepSeek",
      sources: [{ url: "https://news.example.org/rates", title: "Rates held", publishedAt: "2026-11-17", dateSource: "search" }] });
    // v0.16: no title and no kind heading; the dated source line shows how fresh the evidence is.
    expect(hud.frame.title.trim()).toBe("");
    expect(pop(hud)).toEqual(["Correction: The bank held rates on Tuesday.", "Src: news.example.org · 2026-11-17"]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(hud.frame.body.trim()).toBe("");
    // A general (not time-sensitive) check reads the same way, with no kind heading.
    presentation.applyFactCheck({ id: "f2", sessionId: "s", transcriptId: "t2", claim: "Water boils at 90 C", status: "contradicted",
      summary: "It boils at 100 C at sea level.", checkedAt: at, recency: "general", sources: [] });
    expect(pop(hud)).toEqual(["Correction: It boils at 100 C at sea level."]);
    hud.dispose();
  });

  it("Detailed answer length gives a cue more pages; the setting applies live", async () => {
    vi.useFakeTimers();
    const detailed = answerLengthProfile("detailed");
    const answer = LONG.repeat(12).slice(0, detailed.lookupChars);
    const ask = (id: string) => ({ id, kind: "lookup" as const, topic: "Lead time?", trigger: "lead time", status: "done" as const, answer, createdAt: at });
    const standard = await listening();
    standard.presentation.applyAsk(ask("k1"));
    expect(pop(standard.hud).at(-1)).toBe("1/3 · swipe ↓ more"); // v0.16: the page marker is the last line of the pop-up
    standard.hud.setAnswerLength("detailed");
    standard.presentation.applyAsk(ask("k2"));
    standard.hud.handleGesture("up"); // stay on the display
    await vi.advanceTimersByTimeAsync(0);
    standard.hud.dispose();
    const long = await listening({ answerLength: "detailed" });
    long.presentation.applyAsk(ask("k1"));
    expect(pop(long.hud).at(-1)).toMatch(/^1\/[456] · swipe ↓ more$/u);
    long.hud.dispose();
  });

  it("a session on a Chinese provider with Deepgram has credentials without an OpenAI key (resume path)", () => {
    const form = { ...DEFAULT_CONFIG, accessToken: "", openaiApiKey: "", deepgramApiKey: "dg", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false,
      transcriptionProvider: "deepgram", answerProvider: "deepseek", deepseekApiKey: "sk-ds" } as SessionFormState;
    expect(providerCredentialsForSession(form)).toEqual({ deepgram: "dg", deepseek: "sk-ds" });
    expect(providerCredentialsForSession({ ...form, deepgramApiKey: "", deepseekApiKey: "" })).toBeUndefined();
  });

  it("Setup defines every new setting exactly once and the whitelist covers every provider origin", () => {
    const ui = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");
    for (const id of ["answer-length", "news-search", "glasses-always-on", "deepseek-api-key", "dashscope-api-key", "zhipu-api-key", "moonshot-api-key", "test-provider-key"]) {
      expect(ui.split(`id="${id}"`).length - 1 + ui.split(`toggle("${id}"`).length - 1, id).toBe(1);
    }
    const knowledge = readFileSync(new URL("../src/knowledge-panel.ts", import.meta.url), "utf8");
    for (const id of ["omi-auto-import", "pdf-import-files", "pdf-import-url", "obsidian-import-url"]) expect(knowledge, id).toContain(id);
    const whitelist: string[] = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")).permissions.find((item: { name: string }) => item.name === "network").whitelist;
    for (const origin of providerOrigins()) expect(whitelist, origin).toContain(origin);
    expect(new Set(whitelist).size).toBe(whitelist.length);
    expect(ANSWER_PROVIDER_CATALOG.length).toBeGreaterThan(1);
  });
});
