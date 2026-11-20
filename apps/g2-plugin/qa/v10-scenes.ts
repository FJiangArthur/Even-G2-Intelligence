// Vite-only QA fixture (not in the EHPK): drives the production GlassesHud on the official simulator
// through v0.10 scenes; scripts screenshot the glasses after each "[scene]" console line.
import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { GatewayEvent } from "@helix/conversation-sdk";
import { GlassesHud } from "../src/glasses-hud";
import { ConversationPresentation } from "../src/presentation";

const bridge = await waitForEvenAppBridge();
const hud = new GlassesHud(bridge as never, { tickMs: 0, mascotIntervalMs: 300, mascotAnimation: true });
const presentation = new ConversationPresentation();
presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
await hud.initialize();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const at = new Date().toISOString();
let seq = 0;
const ctx = (label: string, role: string, trigger?: string) => ({ prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "m" }, speaker: { label, role }, latencyMs: { totalMs: 900 }, ...(trigger ? { trigger } : {}) });
const ev = (event: object) => ({ protocolVersion: "2.1", sessionId: "s", occurredAt: at, eventId: `e${++seq}`, ...event }) as unknown as GatewayEvent;
const final = (id: string, text: string, label = "Other speaker", role = "other") => presentation.apply(ev({ type: "transcript.final", transcriptId: id, text, context: ctx(label, role) }));
const scene = async (name: string) => { await sleep(2600); await hud.flush(); await sleep(400); console.log(`[scene] ${name}`); await sleep(2500); };

presentation.setMode("technical");
await scene("splash");
presentation.setStatus("listening");
final("t1", "The perception stack runs ROS 2 Jazzy with the CDTF camera nodes on an Orin.");
final("t2", "Lead times for Orin modules are about twelve weeks right now, so we need a fallback.");
presentation.applyConcept({ id: "c1", term: "CDTF", explanation: "Camera data transfer framework: syncs and timestamps multi-camera frames for the perception stack.", createdAt: at, origin: "copilot" });
presentation.applyClaim({ id: "cl1", text: "Orin modules have about twelve weeks of lead time.", speaker: "Other speaker", scope: "public", createdAt: at });
presentation.apply(ev({ type: "transcript.partial", transcriptId: "tp", revision: 1, text: "and the x86 box with a discrete GPU could ship", context: ctx("Other speaker", "other") }));
await scene("live-technical");
presentation.apply(ev({ type: "question.detected", questionId: "q1", text: "Is 16 GB of RAM enough while recording rosbags?", confidence: 0.9, context: ctx("Other speaker", "other", "question") }));
presentation.apply(ev({ type: "answer.completed", answerId: "a1", questionId: "q1", text: "Usually yes for one 4K camera at 30 fps; budget about 6 GB for ROS nodes and write bags to a separate NVMe partition so the page cache does not starve the detector.", context: ctx("Helix", "unknown", "question") }));
await scene("answer-they");
presentation.setMode("interviewer");
presentation.setSuggestions([
  { id: "s1", question: "What did you personally own in that migration?", why: "", createdAt: at },
  { id: "s2", question: "What broke first when traffic doubled?", why: "", createdAt: at },
  { id: "s3", question: "How did you measure the latency win?", why: "", createdAt: at },
]);
hud.setView("qa");
await scene("qa-probe");
presentation.apply(ev({ type: "question.detected", questionId: "q2", text: "How did you scale the ingestion pipeline to ten billion events a day?", confidence: 0.9, context: ctx("You", "self", "question") }));
presentation.apply(ev({ type: "answer.completed", answerId: "a2", questionId: "q2", text: "Strong answer: partitioned topics; backpressure and batching; concrete throughput numbers. Probe: what broke first at peak? Flag: only describes the team's work, never their own.", context: ctx("Helix", "unknown", "question") }));
await scene("answer-key");
presentation.applyConflict({ id: "x1", earlier: "The budget is $40,000.", later: "The budget is $25,000 including sensors.", explanation: "Budget dropped from $40k to $25k.", createdAt: at } as never, true);
hud.setView("checks");
await scene("checks");
hud.handleGesture("double");
await scene("menu");
const modeIndex = hud.menuItems.findIndex(item => item.action === "mode");
hud.selectListItem(modeIndex);
await scene("mode-menu");
hud.selectListItem(3); // Partner
await scene("after-mode");
presentation.setStatus("stopped");
await scene("stopped");
hud.handleGesture("double");
await scene("idle-menu");
hud.handleGesture("double");
presentation.setStatus("listening");
presentation.setMode("partner");
presentation.setSuggestions([
  { id: "p1", question: "That sounds exhausting. What was the hardest part?", why: "", createdAt: at },
  { id: "p2", question: "Do you want to talk it through, or just vent?", why: "", createdAt: at },
]);
hud.setView("qa");
await scene("partner-checkin");
console.log("[scene] done");
