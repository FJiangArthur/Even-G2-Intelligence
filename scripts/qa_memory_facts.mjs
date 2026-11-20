// Official simulator HTTP API only. Start a fresh memory-facts.html?autorun=1.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = `http://127.0.0.1:${process.env.MF_QA_PORT ?? "9898"}/api`;
const output = new URL("../artifacts/memory-facts/", import.meta.url);
await mkdir(output, { recursive: true });
async function request(path, options) { const response = await fetch(`${base}/${path}`, options); assert(response.ok, `${path}: ${response.status}`); return response; }
async function entries() { return (await (await request("console")).json()).entries; }
async function events() { return (await entries()).filter(e => e.message.startsWith("MF_QA ")).map(e => JSON.parse(e.message.slice(6))); }
async function waitFor(predicate, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const all = await events(); const failure = all.find(e => e.event === "failure"); assert(!failure, failure?.message);
    const found = all.find(predicate); if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Missing ${label}`);
}
async function capture(name) {
  await new Promise(resolve => setTimeout(resolve, 150));
  for (const target of ["glasses", "webview"]) await writeFile(new URL(`${name}-${target}.png`, output), Buffer.from(await (await request(`screenshot/${target}`)).arrayBuffer()));
}
async function gesture(action) { await request("input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); }
for (const name of ["partial-answer", "sourced-correction", "automatic-explanation", "expanded-explanation", "busy-answer-priority", "phone-shortcuts"]) {
  await waitFor(e => e.event === "stage" && e.name === name, name); await capture(name); console.log(`MF_QA captured ${name}`);
}
const result = await waitFor(e => e.event === "result", "fixture result");
assert.equal(result.browser, false); assert.equal(result.fixtureOnly, true);
assert(result.partialBeforeCompletion && result.ragIncluded && result.historyAfterReload >= 1);
assert.equal(result.webCallsWhenDisabled, 0); assert.equal(result.omiCallsDuringAnswer, 0);
const beforeMenu = Date.now();
await gesture("context_menu"); await capture("native-context-menu");
// Exercise the OS selector; return to first item (Explain term) before click.
await gesture("down"); await gesture("up"); await gesture("click");
await waitFor(e => e.event === "native-event" && e.at >= beforeMenu && e.nativeEvent?.menuItemClickEvent?.itemID === 1, "Explain term native selection", 5000);
await waitFor(e => e.event === "answer-request" && e.at >= beforeMenu && e.explainTerm, "native Explain term provider request"); await capture("native-explain-term");
const allEntries = await entries();
assert(!allEntries.some(e => e.level === "error" || /\[uncaught\]|\[unhandledrejection\]/u.test(e.message)), "Native console error");
await writeFile(new URL("memory-facts-events.json", output), JSON.stringify(await events(), null, 2));
await writeFile(new URL("memory-facts-result.json", output), JSON.stringify({ ...result, passed: true, nativeMenu: true, nativeSource: "Even simulator 0.9.5 official automation API", scope: "fixture provider + PCM; real controller/UI/storage bridge; store reconstruction, not phone process restart" }, null, 2));
console.log("G2_MEMORY_FACTS_QA_PASSED");
