// HISTORICAL v0.3 dashboard/tap-to-pause evidence only; not a current release gate.
// For v0.5 answer-only controls use scripts/qa_answer_first.mjs and its fixture.
throw new Error("Historical gesture script. Run node scripts/qa_answer_first.mjs for v0.5 QA.");
// Previously run after starting the mock gateway, Vite and official simulator at
// http://localhost:5173/qa/gestures.html --automation-port 9898.
// The fixture uses synthetic PCM and never opens a real microphone.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const base = "http://127.0.0.1:9898/api";
const output = new URL("../artifacts/pixel-gestures/", import.meta.url);
await mkdir(output, { recursive: true });
async function request(path, options) {
  const response = await fetch(`${base}/${path}`, options);
  assert(response.ok, `Simulator HTTP ${response.status}`);
  return response;
}
async function waitFor(message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { entries } = await (await request("console")).json();
    if (entries.some((entry) => entry.message.includes(message))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Missing simulator state: ${message}`);
}
async function gesture(action) {
  await request("input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
}
async function screenshot(name) {
  await writeFile(new URL(`${name}.png`, output), Buffer.from(await (await request("screenshot/glasses")).arrayBuffer()));
}
await waitFor("QA_STATE connected");
await screenshot("ready");
await gesture("click");
await waitFor("MIC ON / TAP TO PAUSE");
await new Promise((resolve) => setTimeout(resolve, 400));
await gesture("click");
await waitFor("PAUSED / TAP TO RESUME answers=1");
await gesture("long_press");
await waitFor("[ HOLDING ] RELEASE TO SUBMIT");
await new Promise((resolve) => setTimeout(resolve, 400));
await screenshot("hold");
await gesture("long_press_release");
await waitFor("QA_STATE paused  answers=2");
await new Promise((resolve) => setTimeout(resolve, 200));
await screenshot("answer");
await gesture("click");
await waitFor("MIC ON / TAP TO PAUSE answers=2");
await gesture("double_click");
await waitFor("QA_STATE exited");
const { entries } = await (await request("console")).json();
assert(!entries.some((entry) => entry.level === "error"), "Simulator reported an error");
const microphone = entries.filter((entry) => entry.message.startsWith("QA_MIC")).map((entry) => entry.message);
assert.deepEqual(microphone, ["QA_MIC ON", "QA_MIC OFF", "QA_MIC ON", "QA_MIC OFF", "QA_MIC ON", "QA_MIC OFF"]);
await writeFile(new URL("gesture-events.json", output), JSON.stringify(entries.filter((entry) => entry.message.startsWith("QA_")), null, 2));
console.log("G2_GESTURE_SMOKE_PASSED: tap, hold/release, mock answers, mic teardown and exit");
