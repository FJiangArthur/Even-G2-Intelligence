import { StartUpPageCreateResult, type CreateStartUpPageContainer, type RebuildPageContainer, type TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { MODE_PROFILES, modeSystemPrompt, summarizeSession, type HistoryEntry, type HistorySession } from "@helix/conversation-sdk";
import { describe, expect, it } from "vitest";
import { cleanModePrompts } from "../src/config";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesHud, HUD_LINE_WIDTH, HUD_PANELS, HUD_RAIL_WIDTH, hudTextWidth } from "../src/glasses-hud";
import { glassesMirrorModel } from "../src/glasses-mirror";
import type { GlassesRenderBridge } from "../src/glasses-renderer";
import { sessionCues, sessionMindmap } from "../src/history-panel";
import { ConversationPresentation } from "../src/presentation";

class Bridge implements GlassesRenderBridge {
  creates: CreateStartUpPageContainer[] = []; rebuilds: RebuildPageContainer[] = []; updates: TextContainerUpgrade[] = [];
  async createStartUpPageContainer(c: CreateStartUpPageContainer) { this.creates.push(c); return StartUpPageCreateResult.success; }
  async rebuildPageContainer(c: RebuildPageContainer) { this.rebuilds.push(c); return true; }
  async textContainerUpgrade(c: TextContainerUpgrade) { this.updates.push(c); return true; }
}
const at = "2026-11-17T18:00:00.000Z";
async function mount() {
  const bridge = new Bridge(), hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0 }), presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation };
}

describe("v0.11 glasses rail (mode + views inside the box)", () => {
  it("shows the mode, marks the current view and counts unseen items per view; opening a view clears its count", async () => {
    const { hud, presentation } = await mount();
    presentation.setMode("technical");
    expect(hud.frame.mode).toBe("TECHNICAL");
    expect(hud.frame.views.trim()).toBe(""); // not connected: no view list
    presentation.setStatus("listening");
    expect(hud.frame.views.split("\n")).toEqual(["▶ LIVE", "ANSWER", "PROBE", "CONCEPTS", "SUMMARY", "CHECKS"]);
    presentation.applyConcept({ id: "c1", term: "CDTF", explanation: "Camera data transfer framework.", createdAt: at, origin: "copilot" });
    presentation.applyConcept({ id: "c2", term: "NVMe", explanation: "Storage protocol.", createdAt: at, origin: "copilot" });
    presentation.applyClaim({ id: "cl1", text: "Lead time is twelve weeks.", speaker: "Other speaker", scope: "public", createdAt: at });
    presentation.setSuggestions([{ id: "s1", question: "What broke first?", why: "", createdAt: at }]);
    presentation.applySummary({ bullets: ["Chose x86."], keyFacts: [], updatedAt: at } as never);
    expect(hud.frame.views.split("\n")).toEqual(["▶ LIVE", "ANSWER", "PROBE ①", "CONCEPTS ②", "SUMMARY ●", "CHECKS ①"]);
    expect(hud.unseenCounts).toMatchObject({ qa: 1, concepts: 2, checks: 1, summary: 1 });
    for (const row of hud.frame.views.split("\n")) expect(hudTextWidth(row)).toBeLessThanOrEqual(HUD_RAIL_WIDTH);
    hud.setView("concepts");
    expect(hud.frame.views.split("\n")[3]).toBe("▶ CONCEPTS");
    hud.setView("claims"); // claims live under CHECKS
    expect(hud.frame.views.split("\n")).toEqual(["LIVE", "ANSWER", "PROBE ①", "CONCEPTS", "SUMMARY ●", "▶ CHECKS"]);
    // More than nine: capped at ⑨.
    for (let i = 0; i < 12; i++) presentation.applyConcept({ id: `n${i}`, term: `T${i}`, explanation: "x", createdAt: at, origin: "copilot" });
    expect(hud.frame.views.split("\n")[3]).toBe("CONCEPTS ⑨");
    // The phone mirror carries the rail.
    const model = glassesMirrorModel(hud.mirror);
    expect(model.lines.some(line => line.text === "TECHNICAL" && line.level === 4)).toBe(true);
    expect(model.lines.some(line => line.text === "▶ CHECKS" && line.level === 4)).toBe(true);
    // Body and rail share the box without overlapping.
    expect(HUD_PANELS.body.xPosition + HUD_PANELS.body.width).toBeLessThanOrEqual(HUD_PANELS.views.xPosition);
    expect(HUD_LINE_WIDTH.body).toBeLessThan(HUD_PANELS.body.width);
    hud.dispose();
  });
});

describe("v0.11 mode prompts", () => {
  it("a custom prompt replaces the built-in mode instruction; resets and unknown modes are dropped", async () => {
    expect(modeSystemPrompt("Base.", "technical", "reactive", "Answer like a staff SRE.")).toContain("Protected conversation mode: technical. Answer like a staff SRE.");
    expect(modeSystemPrompt("Base.", "technical", "reactive", "  ")).toContain(MODE_PROFILES.technical.answer);
    expect(cleanModePrompts({ technical: "  Mine  ", partner: MODE_PROFILES.partner.answer, bogus: "x", general: "" })).toEqual({ technical: "Mine" });
    const storage = new Map<string, string>();
    const bridge = { getLocalStorage: async (k: string) => storage.get(k) ?? "", setLocalStorage: async (k: string, v: string) => { storage.set(k, v); return true; },
      createStartUpPageContainer: async () => StartUpPageCreateResult.success, textContainerUpgrade: async () => true, rebuildPageContainer: async () => true,
      audioControl: async () => true, onEvenHubEvent: () => () => undefined } as unknown as G2BridgePort;
    const controller = new G2ConversationController(bridge, new GlassesHud(bridge as never, { display: "always-on", tickMs: 0 }), new ConversationPresentation());
    await controller.initialize();
    expect(controller.modePrompt("interviewer")).toEqual({ text: MODE_PROFILES.interviewer.answer, custom: false });
    await controller.setModePrompt("interviewer", "Focus on system design depth.");
    expect(controller.modePrompt("interviewer")).toEqual({ text: "Focus on system design depth.", custom: true });
    await controller.setMode("partner"); // a mode switch keeps the prompts
    expect(JSON.parse(storage.get("helix.g2.plugin.config.v1")!).modePrompts).toEqual({ interviewer: "Focus on system design depth." });
    await controller.setModePrompt("interviewer", "");
    expect(controller.modePrompt("interviewer").custom).toBe(false);
    await controller.dispose();
  });
});

describe("v0.11 history: AI cues, mindmap, generated summary", () => {
  const session: HistorySession = { id: "s1", source: "helix", title: "Compute planning", startedAt: at, updatedAt: at, summary: ["Chose the x86 box."], keyFacts: ["Budget $25,000"],
    people: [{ name: "Elaine", role: "Robotics" }], concepts: ["CDTF: Camera data transfer framework."] };
  const entry = (id: string, kind: HistoryEntry["kind"], text: string, speaker?: string): HistoryEntry => ({ id, sessionId: "s1", kind, text, occurredAt: at, ...(speaker ? { speaker } : {}) });
  const entries = [entry("t1", "transcript", "Is 16 GB enough?", "Other speaker"), entry("q1", "question", "Is 16 GB enough?", "Other speaker"), entry("a1", "answer", "Usually yes."),
    entry("q2", "question", "ignored", "Whole conversation"), entry("a2", "answer", "Recap: x86 now."), entry("f1", "fact-check", "Lead time is 2 weeks\nDistributors list 12.")];
  it("pairs answers with their question and builds a two-level mindmap", () => {
    expect(sessionCues(entries)).toEqual([
      { kind: "answer", text: "Usually yes.", question: "Is 16 GB enough?" },
      { kind: "answer", text: "Recap: x86 now.", question: "You asked about the whole conversation" },
      { kind: "check", text: "Lead time is 2 weeks: Distributors list 12." }]);
    const map = sessionMindmap(session, entries);
    expect(map.label).toBe("Compute planning");
    expect(map.children.map(branch => [branch.kind, branch.children])).toEqual([["summary", ["Chose the x86 box."]], ["facts", ["Budget $25,000"]],
      ["people", ["Elaine · Robotics"]], ["concepts", ["CDTF"]], ["questions", ["Is 16 GB enough?"]]]);
    expect(sessionMindmap({ ...session, summary: [], keyFacts: [], people: [], concepts: [] }, []).children).toEqual([]);
  });
  it("summarizeSession sends the transcript once and returns bounded knowledge", async () => {
    const bodies: string[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => { bodies.push(String(init?.body));
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: ["A", " "], keyFacts: ["$25k"], concepts: [{ term: "CDTF", explanation: "Framework." }] }) }] }] }); };
    const digest = await summarizeSession(fetcher, "k", "gpt-6-luna", { title: "T", lines: [{ speaker: "Them", text: "Budget is 25k." }] });
    expect(digest).toEqual({ summary: ["A"], keyFacts: ["$25k"], concepts: [{ term: "CDTF", explanation: "Framework." }] });
    expect(bodies).toHaveLength(1); expect(bodies[0]).toContain("Them: Budget is 25k.");
    await expect(summarizeSession(fetcher, "", "m", { title: "T", lines: [] })).rejects.toThrow(/OpenAI key/u);
    await expect(summarizeSession(fetcher, "k", "m", { title: "T", lines: [] })).rejects.toThrow(/no transcript/u);
  });
});
