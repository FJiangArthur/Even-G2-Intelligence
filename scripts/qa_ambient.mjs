// Ambient glasses display on the official simulator (simulator evidence only; not G2 hardware acceptance).
//   (cd apps/g2-plugin && npx vite --port 5174 --host 127.0.0.1)
//   evenhub-simulator "http://127.0.0.1:5174/qa/hud.html?scenario=ambient&display=ambient" --automation-port 9899
//   node scripts/qa_ambient.mjs   [HUD_QA_PORT=9899 HUD_QA_OUTPUT=artifacts/ambient]
// Production controller + GlassesHud with a fake provider fetch; only official automation inputs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const base = `http://127.0.0.1:${process.env.HUD_QA_PORT ?? "9899"}/api`;
const output = process.env.HUD_QA_OUTPUT ? pathToFileURL(resolve(process.env.HUD_QA_OUTPUT) + "/") : new URL("../artifacts/ambient/", import.meta.url);
await mkdir(output, { recursive: true });
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function request(path, options) {
  const response = await fetch(`${base}/${path}`, options);
  assert(response.ok, `Simulator HTTP ${response.status} for ${path}`);
  return response;
}
async function entries() { return (await (await request("console")).json()).entries; }
async function events() { return (await entries()).filter(entry => entry.message.startsWith("HUD_QA ")).map(entry => JSON.parse(entry.message.slice(7))); }
async function waitFor(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = (await events()).findLast(predicate);
    if (match) return match;
    await sleep(150);
  }
  throw new Error(`Missing ${description}`);
}
const input = action => request("input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
// The simulator suspends page timers a few seconds after the last input when its window is not visible
// (observed on macOS with the window occluded). An up-swipe changes nothing on the ambient display
// (blank: consumed; one-page pop-up: no previous page), so it serves as a keep-alive. AMBIENT_QA_KEEPALIVE=0 turns it off.
const keepAlive = process.env.AMBIENT_QA_KEEPALIVE === "0" ? undefined : setInterval(() => { void input("up").catch(() => undefined); }, 2000);
const results = [];
/** Saves the framebuffer (+ a black-composited copy) and returns its lit pixel count. */
async function capture(name, note) {
  await sleep(400);
  const file = fileURLToPath(new URL(`${name}.png`, output));
  await writeFile(file, Buffer.from(await (await request("screenshot/glasses")).arrayBuffer()));
  const lit = Number(execFileSync("python3", ["-c", `from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert("RGBA"); bg = Image.new("RGBA", im.size, (0, 0, 0, 255)); bg.alpha_composite(im)
bg.convert("RGB").save(${JSON.stringify(file.replace(/\.png$/u, ".view.png"))})
print(im.size[0] * im.size[1] - im.getchannel("A").histogram()[0])`]).toString().trim());
  results.push({ name, note, lit });
  console.log(`AMBIENT_QA ${name.padEnd(22)} lit=${String(lit).padStart(6)}  ${note}`);
  return lit;
}
const lastRebuild = async () => (await events()).findLast(event => event.event === "rebuild" && event.ok);

assert.equal(await (await request("ping")).text(), "pong");
await waitFor(event => event.event === "initialized", "initialized");
assert((await capture("01-not-connected", "start screen before the session")) > 200, "the start screen is visible while not connected");

await waitFor(event => event.event === "connected", "connected");
await waitFor(event => event.event === "rebuild" && event.ok && !event.text.includes("hud-frame"), "ambient page");
const ambientPage = await lastRebuild();
assert.deepEqual(ambientPage.capture, ["hud-body"], "exactly one event-capture container on the blank page");

// A sentence was spoken; nothing may show.
await waitFor(event => event.event === "ambient-talked", "talk", 60000);
assert.equal(await capture("02-blank-while-talking", "a sentence was spoken: no caption, no HUD"), 0, "blank while people talk");

await waitFor(event => event.event === "ambient-answer-shown", "answer pop-up", 60000);
assert.match((await waitFor(event => event.event === "ambient-answer-shown", "answer")).header, /THEY ASKED 1\/1/u);
assert((await capture("03-answer-pop", "a question was asked: the answer popped up")) > 300, "the answer is visible");

const expired = await waitFor(event => event.event === "ambient-answer-expired", "answer expiry", 60000);
assert.equal(expired.body.trim(), "");
assert.equal(await capture("04-blank-after-answer", "the answer expired by itself"), 0, "blank after the answer");

await waitFor(event => event.event === "ambient-verdict-shown", "verdict cue", 60000);
assert((await capture("05-verdict-cue", "a fact verdict popped up")) > 300, "the verdict is visible");
await waitFor(event => event.event === "ambient-verdict-expired", "verdict expiry", 60000);
assert.equal(await capture("06-blank-after-verdict", "the verdict expired by itself"), 0, "blank after the verdict");
assert.equal((await lastRebuild()).at, ambientPage.at, "pop-ups and expiry used text writes only (no page swap)");

// Gestures are captured on the blank page: a swipe is consumed, double-tap wakes the HUD with the menu.
await input("down");
await waitFor(event => event.event === "input" && event.text !== null, "swipe reached the app on the blank page");
await input("double_click");
await waitFor(event => event.event === "rebuild" && event.ok && event.list.length > 0, "menu page");
assert.deepEqual((await lastRebuild()).capture, ["hud-menu"]);
await sleep(1200);
assert((await capture("07-woken-menu", "double-tap: full HUD with the menu")) > 1000, "the HUD is visible");

await input("double_click");
await waitFor(event => event.event === "rebuild" && event.ok && !event.text.includes("hud-frame") && event.at > ambientPage.at, "ambient page after hide");
assert.deepEqual((await lastRebuild()).capture, ["hud-body"]);
await sleep(1800);
assert.equal(await capture("08-hidden-again", "double-tap on the menu: blank again"), 0, "blank after hiding");

const errors = (await entries()).filter(entry => entry.level === "error" || /^\[(uncaught|unhandledrejection)\]/u.test(entry.message));
assert.equal(errors.length, 0, `console errors: ${JSON.stringify(errors.slice(0, 3))}`);
await writeFile(new URL("ambient-report.json", output), JSON.stringify({ at: new Date().toISOString(), simulator: "evenhub-simulator 0.9.5", results }, null, 2));
clearInterval(keepAlive);
console.log("G2_AMBIENT_SMOKE_PASSED (simulator only)");
