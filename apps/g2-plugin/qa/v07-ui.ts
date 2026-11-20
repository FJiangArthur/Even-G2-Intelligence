// Dev-only visual fixture for the v0.7 phone UI. No controller, bridge or network.
// Query: ?tab=answers|concepts|summary|qa|checks|setup|history&state=rich|empty&peek=1
import type { AnswerCompletedEvent, AnswerDeltaEvent, QuestionDetectedEvent, TranscriptFinalEvent, TranscriptPartialEvent, UsageRecord } from "@helix/conversation-sdk";
import { DEFAULT_CONFIG } from "../src/config";
import { ConversationPresentation, type CompanionTab } from "../src/presentation";
import { CompanionUi } from "../src/ui";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const root = document.querySelector<HTMLElement>("#app")!;
const presentation = new ConversationPresentation();
const ui = new CompanionUi(root, DEFAULT_CONFIG, { credentials: {}, saveApiKeysOnPhone: false }, {
  rehearsalScripts: [
    { id: "interview-ml", title: "ML systems interview (6 min)" },
    { id: "robotics-sync", title: "Robotics hardware sync (Jetson, RAM/SSD)" },
  ],
});
const log = (...args: unknown[]) => console.info("V07_QA", ...args);
ui.bind({
  onConnect: async () => presentation.setStatus("connected"), onStart: async () => presentation.setStatus("listening"),
  onTogglePause: async () => presentation.setStatus("paused"), onDisconnect: async () => presentation.setStatus("stopped"),
  onAsk: async q => log("ask", q), onAskLocal: async () => log("local"), onAskGlobal: async () => log("global"),
  onClearProviderKeys: async () => ({ ok: true, message: "Cleared" }), onShortcut: async id => log("shortcut", id),
  onAutoExplainTerms: async e => log("explain", e), onSettingsChange: form => log("settings", form.model, form.transcriptionProvider),
  onVerify: (target, id) => log("verify", target, id), onRehearse: (id, speed) => log("rehearse", id, speed),
  onStopRehearsal: () => log("stop rehearsal"), onRunCopilot: () => log("run copilot"),
  onTabSeen: tab => presentation.markSeen(tab),
});
presentation.subscribe(snapshot => ui.render(snapshot));
const sessions = [
  { id: "h1", source: "helix" as const, title: "Perception sync · Nov 6", startedAt: "2026-11-06T18:00:00Z", updatedAt: "2026-11-06T18:40:00Z" },
  { id: "h2", source: "omi" as const, title: "1:1 with Kan", startedAt: "2026-11-05T17:00:00Z", updatedAt: "2026-11-05T17:20:00Z" },
];
const fakeController = {
  subscribeHistory: (listener: (state: unknown) => void) => { listener({ sessions, status: "2 sessions on this phone", importing: false, useLocalMemory: true, liveWebFactCheck: false, autoExplainTerms: true }); return () => {}; },
  listHistorySessions: () => sessions, searchHistory: () => [], openHistorySession: () => undefined,
  setLocalMemoryEnabled: async () => {}, setLiveWebFactCheckEnabled: async () => {}, importOmi: async () => {}, cancelImport: () => {},
  dismissInsight: (id: string) => presentation.dismissInsight(id), deleteHistorySession: async () => {},
  // v0.8 knowledge/people surface (stubs; see qa/v08-ui.ts for the real controller fixture).
  historySnapshot: () => ({ sessions, status: "2 sessions on this phone", importing: false, useLocalMemory: true, liveWebFactCheck: false, autoExplainTerms: true }),
  omiExportSupport: () => ({ supported: true, reason: "" }), knowledgeStats: () => ({ helix: { sessions: 1, entries: 0 }, omi: { sessions: 1, entries: 0 }, obsidian: { sessions: 0, entries: 0 } }),
  listPeople: () => [], liveSessionId: () => undefined, vaultFiles: () => [], sessionMarkdown: () => "", sessionsForPerson: () => [],
  importMarkdownFiles: async () => ({ imported: 0, sessionIds: [], failed: [] }), exportSessionsToOmi: async () => ({ exported: 0, message: "" }),
};
ui.attachHistory(fakeController as unknown as Parameters<CompanionUi["attachHistory"]>[0]);

const ctx = (label: string) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "gpt-6.1-terra" },
  speaker: { label, role: "unknown" as const }, latencyMs: { totalMs: 2400 },
});
const base = { protocolVersion: "2.1" as const, sessionId: "s1", occurredAt: "2026-11-07T18:00:00.000Z" };
const at = (min: number) => new Date(Date.UTC(2026, 10, 7, 18, min)).toISOString();
const transcript = (id: string, speaker: string, text: string): TranscriptFinalEvent => ({ ...base, type: "transcript.final", eventId: `e-${id}`, transcriptId: id, text, context: ctx(speaker) } as TranscriptFinalEvent);
const question = (id: string, text: string): QuestionDetectedEvent => ({ ...base, type: "question.detected", eventId: `e-${id}`, questionId: id, text, confidence: 0.94, context: { ...ctx("Priya"), trigger: "question" } } as QuestionDetectedEvent);
const done = (id: string, qid: string, text: string): AnswerCompletedEvent => ({ ...base, type: "answer.completed", eventId: `e-${id}`, answerId: id, questionId: qid, text, context: { ...ctx("Helix"), trigger: "question" } } as AnswerCompletedEvent);
const usage = (id: string, kind: UsageRecord["kind"], model: string, input: number, output: number, cost?: number): UsageRecord => ({
  id, kind, model, inputTokens: input, cachedInputTokens: 0, outputTokens: output, reasoningTokens: 0, webSearchCalls: kind === "lookup" ? 1 : 0, audioSeconds: 0,
  ...(cost === undefined ? {} : { costUsd: cost }), measured: true, at: at(5),
});

function rich(): void {
  presentation.setStatus("listening");
  presentation.apply(transcript("t1", "Priya", "We're moving the perception stack to CDTF for the online mapping head, so the fusion runs before BEV pooling."));
  presentation.apply(transcript("t2", "Art", "Right, and the Orin dev kits — what's the lead time on Jetson Thor right now? Procurement said eight weeks."));
  presentation.apply(question("q1", "How does CDTF differ from late fusion for online mapping?"));
  presentation.apply(done("a1", "q1", "CDTF fuses camera and lidar features in a shared depth-aware frustum before BEV pooling, so map elements keep geometric consistency. Late fusion merges per-sensor outputs afterwards, which is simpler but loses cross-sensor depth cues at lane boundaries."));
  presentation.applyAnswerMeta({ answerId: "a1", questionId: "q1", grounded: "conversation", sources: [],
    timing: { speechMs: 3100, transcriptionMs: 1200, queueMs: 40, firstTokenMs: 800, generationMs: 1150, endToEndMs: 2400 },
    usage: usage("u1", "answer", "gpt-6.1-terra", 820, 96, 0.0012), retrieval: { searchedEntries: 214, matched: 0, webUsed: false } });
  presentation.apply(transcript("t3", "Priya", "For the edge box I'd go 16 GB RAM with a 1 TB SSD — does that architecture hold up for logging?"));
  presentation.apply(question("q2", "Is 16 GB RAM with 1 TB SSD enough for on-vehicle logging?"));
  presentation.apply(done("a2", "q2", "For 6 cameras at 10 Hz plus lidar, 1 TB fills in about 2.5 hours of raw logging. Keep 16 GB RAM, but log compressed keyframes and rotate to the NAS at each stop."));
  presentation.applyAnswerMeta({ answerId: "a2", questionId: "q2", grounded: "web",
    sources: [{ url: "https://developer.nvidia.com/embedded/jetson-modules", title: "NVIDIA Jetson modules" }, { url: "https://example.com/rosbag-sizing", title: "Rosbag sizing guide" }],
    timing: { speechMs: 4200, transcriptionMs: 1100, queueMs: 0, firstTokenMs: 950, generationMs: 1900, endToEndMs: 3050 },
    usage: usage("u2", "answer", "gpt-6.1-terra", 1450, 140, 0.0021), retrieval: { searchedEntries: 214, matched: 2, webUsed: true } });
  presentation.applyInsight({ id: "i1", sessionId: "s1", transcriptId: "t1", term: "BEV pooling", explanation: "Projects multi-camera image features onto a top-down bird's-eye-view grid so map heads can reason in vehicle coordinates.", createdAt: at(2) });
  presentation.applyConcept({ id: "c1", term: "CDTF", explanation: "Cross-modal depth-aware temporal fusion: camera and lidar features are aligned in a depth frustum and fused across frames before BEV pooling.", transcriptId: "t1", createdAt: at(2), origin: "copilot" });
  presentation.applyConcept({ id: "c2", term: "Jetson Thor", explanation: "NVIDIA's automotive/robotics SoC after Orin, aimed at centralized compute with transformer acceleration.", transcriptId: "t2", createdAt: at(3), origin: "copilot" });
  presentation.applySummary({ updatedAt: at(6), transcriptChars: 4820,
    bullets: ["Team is moving the online-mapping head to CDTF fusion before BEV pooling.", "Hardware: Orin dev kits now, evaluating Jetson Thor; procurement quoted eight weeks.", "Edge logger proposal: 16 GB RAM + 1 TB SSD, open question on logging duration."],
    keyFacts: ["Lead time quoted: 8 weeks", "Edge box: 16 GB RAM / 1 TB SSD", "Owner for procurement: Art"] });
  presentation.applyConflict({ id: "x1", earlier: "Priya: logging runs at 10 Hz on all six cameras.", later: "Priya: we only log the front three cameras.", explanation: "Camera count for logging changed from six to three; storage estimates differ by 2×.", createdAt: at(6) });
  presentation.setSuggestions([
    { id: "s1", question: "What's the fallback if Thor slips past Q1?", why: "Lead time is the schedule risk nobody owns yet.", createdAt: at(6) },
    { id: "s2", question: "Do we log raw or compressed lidar on the edge box?", why: "Decides whether 1 TB is enough.", createdAt: at(6) },
    { id: "s3", question: "Who validates CDTF against the late-fusion baseline?", why: "No owner mentioned.", createdAt: at(6) },
  ]);
  presentation.applyAsk({ id: "k1", kind: "lookup", topic: "Jetson Thor lead time", trigger: "what's the lead time on Jetson Thor right now", status: "pending", createdAt: at(4), transcriptId: "t2" });
  presentation.applyAsk({ id: "k1", kind: "lookup", topic: "Jetson Thor lead time", trigger: "what's the lead time on Jetson Thor right now", status: "done", createdAt: at(4), transcriptId: "t2",
    answer: "Distributors list Jetson AGX Thor dev kits at 6–10 weeks; production modules quoted 12+ weeks for volume orders.",
    sources: [{ url: "https://www.arrow.com/en/products/search?q=jetson%20thor", title: "Arrow · Jetson Thor stock" }, { url: "https://developer.nvidia.com/embedded/jetson-thor", title: "NVIDIA · Jetson Thor" }] });
  presentation.applyAsk({ id: "k2", kind: "lookup", topic: "Orin NX 16 GB availability", trigger: "the Orin dev kits", status: "pending", createdAt: at(5) });
  presentation.applyAsk({ id: "k3", kind: "propose", topic: "16 GB RAM + 1 TB SSD edge architecture", trigger: "I'd go 16 GB RAM with a 1 TB SSD", status: "done", createdAt: at(5),
    answer: "Viable for compressed logging (~9 h at 30 MB/s). Add a ring buffer and offload over 10 GbE at depot; raw 6-camera logging needs 4 TB." });
  presentation.applyVerification({ id: "v1", target: "1 TB fills in about 2.5 hours of raw logging", status: "uncertain", summary: "Depends on camera count and compression; at 6 raw cameras the estimate holds, at 3 it doubles.", sources: [{ url: "https://example.com/rosbag-sizing", title: "Rosbag sizing guide" }], checkedAt: at(7), requestedBy: "user" });
  presentation.applyVerification({ id: "v2", target: "Procurement quoted eight weeks for Thor", status: "supported", summary: "Matches distributor lead times of 6–10 weeks for dev kits.", sources: [{ url: "https://developer.nvidia.com/embedded/jetson-thor", title: "NVIDIA · Jetson Thor" }], checkedAt: at(7), requestedBy: "auto" });
  presentation.applyUsage(usage("u3", "copilot", "gpt-6-luna", 5200, 600, 0.0008));
  presentation.applyUsage(usage("u4", "lookup", "gpt-6-luna", 2100, 180, 0.0103));
  presentation.applyUsage(usage("u5", "transcription", "gpt-live-transcribe", 0, 0, 0.0071));
  presentation.apply({ ...base, type: "transcript.partial", eventId: "e-p", transcriptId: "tp", text: "So if Thor slips we could keep Orin for the", context: ctx("Priya") } as TranscriptPartialEvent);
  presentation.markSeen("answers");
}

if (params.get("state") !== "empty") rich();
else presentation.setStatus("ready");
const tab = params.get("tab") as CompanionTab | null;
if (tab) ui.selectTab(tab);
if (params.get("streaming") === "1") {
  presentation.apply(question("q9", "What's the fallback if Thor slips?"));
  presentation.apply({ ...base, type: "answer.delta", eventId: "e-d", answerId: "a9", questionId: "q9", delta: "Keep Orin AGX for the Q1 fleet and gate the", context: { ...ctx("Helix"), trigger: "question" } } as AnswerDeltaEvent);
}
if (params.get("peek") !== "1") (document.querySelector("#peek") as HTMLElement).hidden = true;
if (params.get("peek") === "1") {
  presentation.applyConcept({ id: "c9", term: "NVMe ring buffer", explanation: "Fixed-size circular log on SSD that overwrites oldest data first.", createdAt: at(8), origin: "copilot" });
}
(window as unknown as { __ready: boolean }).__ready = true;
