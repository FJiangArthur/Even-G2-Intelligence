// Start a fresh official simulator at http://localhost:5173/qa/answer-first.html
// with --automation-port9898. No gateway, real microphone, or provider keys.
// Root/native acceptance separately checks system exit; unit integration covers
// both SYSTEM_EXIT_EVENT and ABNORMAL_EXIT_EVENT cleanup.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const base = `http://127.0.0.1:${process.env.AF_QA_PORT ?? "9898"}/api`;
const output = process.env.AF_QA_OUTPUT ? pathToFileURL(resolve(process.env.AF_QA_OUTPUT) + "/") : new URL("../artifacts/answer-first/", import.meta.url);
await mkdir(output, { recursive: true });
async function request(path, options) {
  const response = await fetch(`${base}/${path}`, options);
  assert(response.ok, `Simulator HTTP ${response.status}`);
  return response;
}
async function entries() { return (await (await request("console")).json()).entries; }
async function events() {
  return (await entries()).filter(entry => entry.message.startsWith("AF_QA "))
    .map(entry => ({ ...JSON.parse(entry.message.slice(6)), consoleId: entry.id }));
}
async function waitFor(predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = (await events()).find(predicate);
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Missing ${description}`);
}
async function gesture(action) {
  await request("input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
}
async function capture(name) {
  // Allow the accepted bridge write to reach the next native paint.
  await new Promise(resolve => setTimeout(resolve, 180));
  await writeFile(new URL(`${name}.png`, output), Buffer.from(await (await request("screenshot/glasses")).arrayBuffer()));
}
async function capturePages(answer, prefix) {
  for (const [index, page] of answer.pages.entries()) {
    await waitFor(event => event.event === "display" && event.at >= answer.at && event.text.trim() === page.trim(), `${prefix} page ${index + 1}`, 15000);
    await capture(`${prefix}-page-${index + 1}`);
    console.log(`AF_QA ${prefix}: page ${index + 1}/${answer.pages.length} reached`);
  }
  const blank = await waitFor(event => event.event === "display" && event.at >= answer.at && !event.text.trim(), `${prefix} auto-hide`, 10000);
  await capture(`${prefix}-hidden`);
  return blank;
}

await waitFor(event => event.event === "state" && event.transcripts === 1, "seeded phone transcript");
assert(!(await events()).some(event => event.event === "request"), "Start a fresh answer-first fixture before this harness");
assert((await events()).filter(event => event.event === "display").every(event => !event.text.trim()), "Transcript-only display must stay blank");
await capture("transcript-only-blank");
await writeFile(new URL("phone-transcript.png", output), Buffer.from(await (await request("screenshot/webview")).arrayBuffer()));

await gesture("click");
const long = await waitFor(event => event.event === "request" && event.scene === "long", "single-click local request");
assert.equal(long.scope, "local");
assert(long.pages.length > 1);
assert(long.pages.join("").includes("LOCAL_TRAILING_TEXT"));
// A completed answer is still being read. New speech/question detection must
// update the phone without blanking or restarting its remaining native pages.
await waitFor(event => event.event === "provider-completed" && event.id === long.id, "long provider completion");
await waitFor(event => event.event === "state" && event.at >= long.at && event.answerId && event.streaming === false, "completed answer presentation");
await gesture("long_press");
await new Promise(resolve => setTimeout(resolve, 250));
await gesture("long_press_release");
const duringReading = await waitFor(event => event.event === "state" && event.transcripts === 2 && event.requests.filter(label => label === "Question detected").length === 2, "new question while reading");
assert(duringReading.answerId && duringReading.streaming === false, "Question detection interrupted completed answer reading");
await capturePages(long, "english");

// Let local start, then replace the pending stream with a whole-session ask.
await gesture("click");
const pending = await waitFor(event => event.event === "request" && event.id > long.id, "pending replacement target");
await gesture("double_click");
const global = await waitFor(event => event.event === "request" && event.id > pending.id, "double-click global request");
assert.equal(global.scope, "global");
await waitFor(event => event.event === "aborted" && event.id === pending.id, "old provider cancellation");
await capturePages(global, "global");
const afterGlobal = (await events()).filter(event => event.event === "display" && event.at >= global.at);
assert(afterGlobal.filter(event => event.text.trim()).every(event => event.text.startsWith("GLOBAL_REPLACEMENT")), "Cancelled local text resurfaced");
assert(!(await events()).some(event => event.event === "shutdown"), "Double click must not exit");

// Host click-before-double sequence must issue just one global request.
const requestsBefore = (await events()).filter(event => event.event === "request").length;
await gesture("click");
await gesture("double_click");
const discriminated = await waitFor(event => event.event === "request" && event.id > global.id, "discriminated double click");
await new Promise(resolve => setTimeout(resolve, 350));
assert.equal((await events()).filter(event => event.event === "request").length, requestsBefore + 1);
assert.equal(discriminated.scope, "global");
await capturePages(discriminated, "discriminator");

await gesture("click");
const cjk = await waitFor(event => event.event === "request" && event.id > discriminated.id, "CJK request");
assert.equal(cjk.scene, "cjk");
assert(cjk.pages.length > 1);
assert(cjk.pages.join("").includes("中文结尾"));
await capturePages(cjk, "cjk");

const beforeHold = Date.now();
await gesture("long_press");
await waitFor(event => event.event === "microphone" && event.open && event.at >= beforeHold, "hold microphone open");
await new Promise(resolve => setTimeout(resolve, 250));
await gesture("long_press_release");
await waitFor(event => event.event === "state" && event.transcripts === 3, "hold/release phone transcript");
await waitFor(event => event.event === "microphone" && !event.open && event.at >= beforeHold, "release microphone close");
assert((await events()).filter(event => event.event === "display" && event.at >= beforeHold).every(event => !event.text.trim()), "Transcript revived an answer");
await capture("hold-release-blank");
const allEntries = await entries();
assert(!allEntries.some(entry => entry.level === "error" || /\[uncaught\]|\[unhandledrejection\]/u.test(entry.message)), "Simulator reported errors");
await writeFile(new URL("answer-first-events.json", output), JSON.stringify(await events(), null, 2));
await writeFile(new URL("answer-first-result.json", output), JSON.stringify({
  passed: true, englishPages: long.pages.length, cjkPages: cjk.pages.length,
  scopes: (await events()).filter(event => event.event === "request").map(event => event.scope),
  checks: ["blank startup/transcript", "new question does not interrupt completed answer reading", "full English/CJK pagination and tail", "final auto-hide", "local/global replacement and abort", "250ms click discrimination", "hold/release without revival"],
  separateAcceptance: ["system-exit native action", "physical G2 font, legibility and gesture timing"],
}, null, 2));
console.log("G2_ANSWER_FIRST_QA_PASSED: blank, paging, replacement, click discrimination, CJK, hold/release");
