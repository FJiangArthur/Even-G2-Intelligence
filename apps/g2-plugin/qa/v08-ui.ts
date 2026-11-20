// Dev-only visual fixture for the v0.8 phone UI: real controller + history store on an in-memory
// bridge (no glasses, no network), a rich live presentation, and seeded Helix/Omi/Obsidian history.
// Query: ?tab=answers|qa|checks|people|history|knowledge|setup&session=<id>&mirror=open&state=rich|empty
import type {
  AnswerCompletedEvent, CopilotClaim, CopilotPerson, HistoryEntry, HistorySession, QuestionDetectedEvent,
  Speaker, TranscriptFinalEvent, TranscriptPartialEvent, UsageRecord,
} from "@helix/conversation-sdk";
import { DEFAULT_CONFIG } from "../src/config";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import type { GlassesSurface } from "../src/glasses-hud";
import { ConversationPresentation, type CompanionTab } from "../src/presentation";
import { CompanionUi } from "../src/ui";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const root = document.querySelector<HTMLElement>("#app")!;
const log = (...args: unknown[]) => console.info("V08_QA", ...args);
const day = (offsetDays: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 8 - offsetDays, hour, minute)).toISOString();

/* ---------------------------------------------------------------- seeded history */
type Seed = { session: HistorySession; entries: HistoryEntry[] };
const line = (sessionId: string, index: number, at: string, speaker: string, text: string, kind: HistoryEntry["kind"] = "transcript", metadata?: Record<string, string>): HistoryEntry =>
  ({ id: `${sessionId}:e${index}`, sessionId, kind, text, occurredAt: new Date(Date.parse(at) + index * 20_000).toISOString(), speaker, ...(metadata ? { metadata } : {}) });
const provenance = { model: "gpt-6.1-terra", provider: "openai", endpoint: "https://api.openai.com/v1/responses", promptVersion: "1", latencyMs: "2412" };
const h1 = "session_qa_h1", o1 = "omi:qa-kan", b1 = "obsidian:edge-logger-design", h2 = "session_qa_h2";
const seeds: Seed[] = [
  {
    session: { id: h1, source: "helix", title: "We're moving the perception stack to CDTF for the online mapping head", startedAt: day(0, 17, 2), updatedAt: day(0, 17, 41),
      summary: ["Online-mapping head moves to CDTF fusion before BEV pooling.", "Jetson Thor lead time quoted at eight weeks; Orin stays for Q1.", "Edge logger: 16 GB RAM + 1 TB SSD, compressed keyframes."],
      keyFacts: ["Lead time: 8 weeks (procurement)", "Edge box: 16 GB RAM / 1 TB SSD", "Owner for Thor order: Kan"],
      people: [{ name: "Priya Raman", role: "Perception lead", mentions: 6 }, { name: "Kan", role: "Procurement", mentions: 3 }],
      concepts: ["CDTF: Camera-lidar fusion in a depth-aware frustum before BEV pooling.", "BEV pooling: Projects image features onto a top-down grid."], tags: ["perception"] },
    entries: [
      line(h1, 0, day(0, 17, 2), "Other speaker", "We're moving the perception stack to CDTF"),
      line(h1, 1, day(0, 17, 2), "Other speaker", "We're moving the perception stack to CDTF for the online mapping head."),
      line(h1, 2, day(0, 17, 2), "Other speaker", "That way the fusion runs before BEV pooling."),
      line(h1, 3, day(0, 17, 2), "You", "Makes sense. What's the lead time on Jetson Thor right now?"),
      line(h1, 4, day(0, 17, 2), "Whole conversation", "Using the whole captured conversation, answer the most recent open question. Context: {\"scope\":\"global\",\"maxChars\":12000}", "question", provenance),
      line(h1, 5, day(0, 17, 2), "Helix", "Distributors list Jetson AGX Thor dev kits at 6–10 weeks (https://www.arrow.com/en/products/search?q=jetson) model: gpt-6.1-terra latencyMs: 2412", "answer", provenance),
      line(h1, 6, day(0, 17, 2), "Other speaker", "Procurement said eight weeks, Kan is chasing it. See https://confluence.example.com/thor for the PO."),
      line(h1, 7, day(0, 17, 2), "You", "For the edge box I'd go 16 GB RAM with a 1 TB SSD."),
    ],
  },
  {
    session: { id: o1, source: "omi", title: "1:1 with Kan about the Thor order", startedAt: day(1, 18, 0), updatedAt: day(1, 18, 22),
      summary: ["Kan confirmed the Thor purchase order is approved.", "Delivery expected in eight weeks; two dev kits first."], keyFacts: ["PO approved", "2 dev kits first"],
      people: [{ name: "Kan", role: "Procurement" }], tags: ["procurement"] },
    entries: [
      line(o1, 0, day(1, 18, 0), "Omi summary", "Kan confirmed the Thor purchase order is approved. Delivery expected in eight weeks.", "answer", { origin: "omi-summary" }),
      line(o1, 1, day(1, 18, 0), "Kan", "The PO for Thor went through this morning.", "transcript", { origin: "omi-transcript" }),
      line(o1, 2, day(1, 18, 0), "Speaker 0", "Great, can we get two dev kits first?", "transcript", { origin: "omi-transcript" }),
      line(o1, 3, day(1, 18, 0), "Kan", "Yes, two kits ship first, the rest in eight weeks.", "transcript", { origin: "omi-transcript" }),
    ],
  },
  {
    session: { id: b1, source: "obsidian", title: "Edge logger design notes", startedAt: day(2, 16, 0), updatedAt: day(2, 16, 0),
      summary: ["Log compressed keyframes and rotate to the NAS at each depot stop.", "Raw 6-camera logging needs 4 TB."], keyFacts: ["Ring buffer on NVMe", "10 GbE offload at depot"],
      people: [{ name: "Marco Ruiz", role: "Platform" }, { name: "Priya Raman", role: "Perception lead" }],
      concepts: ["NVMe ring buffer: Fixed-size circular log that overwrites the oldest data first."], tags: ["logging"] },
    entries: [
      line(b1, 0, day(2, 16, 0), "Marco", "Ring buffer on the NVMe, offload over 10 GbE at the depot.", "transcript", { origin: "obsidian" }),
      line(b1, 1, day(2, 16, 0), "Priya", "Raw six-camera logging would need about 4 TB.", "transcript", { origin: "obsidian" }),
    ],
  },
  {
    session: { id: h2, source: "helix", title: "Helix · 2026-11-05T19:00:00.000Z", startedAt: day(3, 19, 0), updatedAt: day(3, 19, 12) },
    entries: [
      line(h2, 0, day(3, 19, 0), "Other speaker", "Let's sync on the robot arm calibration tomorrow."),
      line(h2, 1, day(3, 19, 0), "You", "Sure, I'll bring the checkerboard."),
    ],
  },
];

// v0.13 fixtures (?legacy=1): what History looked like before — records with nothing in them (one per
// Connect / resume), sessions titled with their first utterance, a long 中文 title — plus ?many=<n> filler
// sessions for long-list scrolling.
if (params.get("legacy") === "1") {
  const legacy = (id: string, offsetDays: number, hour: number, minute: number, lines: readonly (readonly [string, string, HistoryEntry["kind"]?])[]): Seed => {
    const start = day(offsetDays, hour, minute);
    const entries = lines.map(([speaker, text, kind], index) => line(id, index, start, speaker, text, kind ?? "transcript", kind === "answer" ? provenance : undefined));
    return { session: { id, source: "helix", title: lines[0]?.[1].slice(0, 100) ?? `Helix · ${start}`, startedAt: start, updatedAt: entries.at(-1)?.occurredAt ?? start }, entries };
  };
  seeds.push(
    legacy("session_qa_l1", 0, 20, 0, [["Other speaker", "So"], ["Other speaker", "So the Orin order slipped again and Orin stock is the blocker."], ["You", "Can Kan escalate the Orin order?"], ["Helix", "Yes: ask Kan to escalate with the distributor.", "answer"]]),
    legacy("session_qa_e1", 0, 17, 42, []), legacy("session_qa_e2", 0, 17, 21, []), legacy("session_qa_e3", 1, 5, 30, []),
    legacy("session_qa_l2", 0, 14, 20, [["Other speaker", "And what's up"], ["You", "Not much, heading out."]]),
    legacy("session_qa_l3", 1, 3, 10, [["Other speaker", "我们下周把感知模块迁移到新的融合框架上，然后在夜间数据集上重新跑一遍评测，看看车道线的指标有没有回退。"], ["You", "好的，我来准备数据。"]]),
  );
}
for (let index = 0; index < Number(params.get("many") ?? 0); index++) {
  const id = `session_qa_m${index}`, start = day(4 + Math.floor(index / 3), 15 + (index % 3), 5);
  seeds.push({ session: { id, source: "helix", title: `Weekly sync ${index + 1}`, startedAt: start, updatedAt: start, summary: [`Sync ${index + 1}: reviewed the open items and assigned owners.`],
    recap: { origin: "fallback", generatedAt: start } }, entries: [line(id, 0, start, "Other speaker", `Item ${index + 1} is on track for the review.`)] });
}

const storage = new Map<string, string>();
if (params.get("state") !== "empty") {
  storage.set("helix.g2.history.v1", JSON.stringify({ version: 1, sessions: seeds.map(seed => seed.session), entries: seeds.flatMap(seed => seed.entries) }));
}
const bridge = {
  getLocalStorage: async (key: string) => storage.get(key) ?? "",
  setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
  audioControl: async () => true, shutDownPageContainer: async () => true, onEvenHubEvent: () => () => {},
  createStartUpPageContainer: async () => 0, textContainerUpgrade: async () => true, rebuildPageContainer: async () => true,
} as unknown as G2BridgePort;
const surface: GlassesSurface = { initialize: async () => {}, render: () => {}, flush: async () => {}, dispose: () => {} };

const presentation = new ConversationPresentation();
const controller = new G2ConversationController(bridge, surface, presentation);
const ui = new CompanionUi(root, DEFAULT_CONFIG, { credentials: {}, saveApiKeysOnPhone: false }, {
  rehearsalScripts: [{ id: "hardware-planning", title: "Robotics hardware sync (Jetson, RAM/SSD)" }],
});
ui.bind({
  onConnect: async () => presentation.setStatus("connected"), onStart: async () => presentation.setStatus("listening"),
  onTogglePause: async () => presentation.setStatus("paused"), onDisconnect: async () => presentation.setStatus("stopped"),
  onAsk: async q => log("ask", q), onAskLocal: async () => log("local"), onAskGlobal: async () => log("global"),
  onClearProviderKeys: async () => ({ ok: true, message: "Cleared" }), onShortcut: async id => log("shortcut", id),
  onAutoExplainTerms: async e => log("explain", e), onSettingsChange: form => log("settings", form.model),
  onVerify: (target, id) => log("verify", target, id), onVerifyClaim: id => { log("verify-claim", id); presentation.beginVerification(id); },
  onRehearse: (id, speed) => log("rehearse", id, speed), onStopRehearsal: () => log("stop rehearsal"), onRunCopilot: () => log("run copilot"),
  onTabSeen: tab => presentation.markSeen(tab),
});
ui.attachHistory(controller);
presentation.subscribe(snapshot => ui.render(snapshot));

/* ---------------------------------------------------------------- live session */
const at = (min: number, sec = 0) => new Date(Date.UTC(2026, 10, 8, 21, min, sec)).toISOString();
const ctx = (label: string, role: Speaker["role"]) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "gpt-6.1-terra" },
  speaker: { label, role }, latencyMs: { totalMs: 2400 },
});
const THEM = ["Other speaker", "other"] as const, YOU = ["You", "self"] as const;
const base = { protocolVersion: "2.1" as const, sessionId: "live" };
let clock = 0;
const final = (id: string, who: readonly [string, Speaker["role"]], text: string): TranscriptFinalEvent =>
  ({ ...base, occurredAt: at(2, clock++ * 6), type: "transcript.final", eventId: `e-${id}`, transcriptId: id, text, context: ctx(who[0], who[1]) } as TranscriptFinalEvent);
const question = (id: string, who: readonly [string, Speaker["role"]], text: string, sourceTranscriptId?: string): QuestionDetectedEvent =>
  ({ ...base, occurredAt: at(2, clock++ * 6), type: "question.detected", eventId: `e-${id}`, questionId: id, text, confidence: 0.93, ...(sourceTranscriptId ? { sourceTranscriptId } : {}), context: { ...ctx(who[0], who[1]), trigger: "question" } } as QuestionDetectedEvent);
const answer = (id: string, qid: string, text: string): AnswerCompletedEvent =>
  ({ ...base, occurredAt: at(2, clock++ * 6), type: "answer.completed", eventId: `e-${id}`, answerId: id, questionId: qid, text, context: { ...ctx("Helix", "unknown"), trigger: "question" } } as AnswerCompletedEvent);
const usage = (id: string, kind: UsageRecord["kind"], input: number, output: number, cost: number): UsageRecord => ({
  id, kind, model: "gpt-6.1-terra", inputTokens: input, cachedInputTokens: 0, outputTokens: output, reasoningTokens: 0, webSearchCalls: 0, audioSeconds: 0, costUsd: cost, measured: true, at: at(5),
});
const person = (id: string, name: string, role: string, context: string, mentions: number): CopilotPerson => ({ id, name, role, context, mentions, firstSeen: at(2), lastSeen: at(6) });
const claim = (id: string, text: string, scope: CopilotClaim["scope"], speaker?: string): CopilotClaim => ({ id, text, scope, createdAt: at(4), ...(speaker ? { speaker } : {}) });

function rich(): void {
  presentation.setStatus("listening");
  presentation.apply(final("t1", THEM, "We're moving the perception stack to CDTF for the online mapping head."));
  presentation.applyInsight({ id: "i1", sessionId: "live", transcriptId: "t1", term: "CDTF", explanation: "Camera-lidar fusion in a depth-aware frustum, before BEV pooling.", createdAt: at(2) });
  presentation.apply(final("t2", THEM, "That way the fusion runs before BEV pooling,"));
  presentation.apply(final("t3", THEM, "and lane boundaries stay consistent across sensors."));
  presentation.apply(final("t4", YOU, "Makes sense. What's the lead time on Jetson Thor right now?"));
  presentation.apply(question("q0", YOU, "What's the lead time on Jetson Thor right now?", "t4"));
  presentation.apply(final("t5", THEM, "Procurement said eight weeks, Kan is chasing it."));
  presentation.apply(final("t6", THEM, "How would you validate CDTF against the late-fusion baseline?"));
  presentation.apply(question("q1", THEM, "How would you validate CDTF against the late-fusion baseline?", "t6"));
  presentation.apply(answer("a1", "q1", "Run both heads on the same held-out drives and compare lane-boundary mAP and Chamfer distance per range bin. CDTF should win at 30–60 m where depth cues matter; check the night split for regressions."));
  presentation.applyAnswerMeta({ answerId: "a1", questionId: "q1", grounded: "conversation", sources: [],
    timing: { speechMs: 3100, transcriptionMs: 900, queueMs: 0, firstTokenMs: 700, generationMs: 1150, endToEndMs: 2100 },
    usage: usage("u1", "answer", 820, 96, 0.0012), retrieval: { searchedEntries: 214, matched: 2, webUsed: false } });
  presentation.apply(final("t7", THEM, "For the edge box I'd go 16 GB RAM with a 1 TB SSD."));
  presentation.apply({ ...base, occurredAt: at(3), type: "transcript.partial", eventId: "e-p", transcriptId: "tp", text: "and log compressed keyframes so we", context: ctx(...THEM) } as TranscriptPartialEvent);
  presentation.applySummary({ updatedAt: at(6), transcriptChars: 3820,
    bullets: ["Online-mapping head moves to CDTF before BEV pooling.", "Thor lead time quoted at eight weeks; Kan owns the order."], keyFacts: ["Lead time: 8 weeks", "Edge box: 16 GB / 1 TB"] });
  presentation.applyConcept({ id: "c1", term: "CDTF", explanation: "Cross-modal depth-aware temporal fusion before BEV pooling.", transcriptId: "t1", createdAt: at(2), origin: "copilot" });
  presentation.setSuggestions([
    { id: "s1", question: "What's the fallback if Thor slips past Q1?", why: "Lead time is the schedule risk nobody owns yet.", createdAt: at(6) },
    { id: "s2", question: "Do we log raw or compressed lidar on the edge box?", why: "Decides whether 1 TB is enough.", createdAt: at(6) },
    { id: "s3", question: "Who signs off on the CDTF eval?", why: "No owner mentioned.", createdAt: at(6) },
  ]);
  presentation.applyAsk({ id: "k1", kind: "lookup", topic: "Jetson Thor lead time", trigger: "what's the lead time on Jetson Thor right now", status: "done", createdAt: at(4), transcriptId: "t4",
    answer: "Distributors list Jetson AGX Thor dev kits at 6–10 weeks.", sources: [{ url: "https://developer.nvidia.com/embedded/jetson-thor", title: "NVIDIA · Jetson Thor" }] });
  presentation.applyPerson(person("p1", "Priya Raman", "Perception lead", "Driving the CDTF migration for the online mapping head.", 4));
  presentation.applyPerson(person("p2", "Kan", "Procurement", "Chasing the Jetson Thor order; quoted eight weeks.", 2));
  presentation.applyPerson(person("p3", "Marco Ruiz", "Platform", "Owns the edge logger hardware.", 1));
  presentation.applyClaim(claim("cl1", "Procurement quoted eight weeks for Jetson Thor.", "public", "Them"));
  presentation.applyClaim(claim("cl2", "1 TB fills in about 2.5 hours of raw six-camera logging.", "public", "Them"));
  presentation.applyClaim(claim("cl3", "We agreed to log only the front three cameras.", "conversation", "You"));
  presentation.applyVerification({ id: "cl1", target: "Procurement quoted eight weeks for Jetson Thor.", status: "supported", summary: "Matches distributor lead times of 6–10 weeks for dev kits.",
    sources: [{ url: "https://developer.nvidia.com/embedded/jetson-thor", title: "NVIDIA · Jetson Thor" }], checkedAt: at(7), requestedBy: "user" });
  presentation.beginVerification("cl2");
  presentation.applyUsage(usage("u3", "copilot", 5200, 600, 0.0008));
  presentation.setHud({ view: "answer", header: "ANSWER 1/2 · Helix", body: "Run both heads on the same held-out\ndrives and compare lane-boundary mAP\nand Chamfer distance per range bin.\nCDTF should win at 30–60 m where", caption: "Them: and log compressed keyframes so we", menuOpen: false, updatedAt: Date.now() });
  presentation.markSeen("answers");
}

await controller.initialize();
if (params.get("state") !== "empty") rich();
else presentation.setStatus("ready");
const tab = params.get("tab") as CompanionTab | null;
if (tab) ui.selectTab(tab);
const session = params.get("session");
if (session) (ui as unknown as { historyPanel?: { open(id: string): void } }).historyPanel?.open(session);
if (params.get("mirror") === "open") root.querySelector<HTMLButtonElement>("#mirror-toggle")?.click();
if (params.get("people") === "focus") root.querySelector<HTMLButtonElement>(".person-card [aria-expanded]")?.click();
if (params.get("paste") === "1") root.querySelector<HTMLDetailsElement>(".paste-markdown")?.setAttribute("open", "");
(document.querySelector("#peek") as HTMLElement).hidden = true;
(window as unknown as { __qa: unknown }).__qa = { controller, presentation, ui, storage, final, answer, question, THEM, YOU };
(window as unknown as { __ready: boolean }).__ready = true;
