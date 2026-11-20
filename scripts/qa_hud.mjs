// Glasses HUD acceptance on the official simulator. Start a fresh instance:
//   (cd apps/g2-plugin && npx vite --port 5174 --host 127.0.0.1)
//   evenhub-simulator http://127.0.0.1:5174/qa/hud.html --automation-port 9899
//   node scripts/qa_hud.mjs   [HUD_QA_PORT=9899 HUD_QA_OUTPUT=artifacts/v08/hud/rehearsal]
// v0.8 flow (continuous caption, THEY ASKED, claims + verify, menu, phone mirror, re-push):
//   evenhub-simulator "http://127.0.0.1:5174/qa/hud.html?scenario=v08" --automation-port 9899
//   HUD_QA_SCENARIO=v08 node scripts/qa_hud.mjs   [HUD_QA_OUTPUT=artifacts/v08/hud]
// Uses the production controller + GlassesHud with a fake provider fetch and the
// hardware-planning rehearsal; drives only official automation inputs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const base = `http://127.0.0.1:${process.env.HUD_QA_PORT ?? "9899"}/api`;
const scenario = process.env.HUD_QA_SCENARIO ?? "rehearsal";
const output = process.env.HUD_QA_OUTPUT ? pathToFileURL(resolve(process.env.HUD_QA_OUTPUT) + "/")
  : new URL(scenario === "v08" ? "../artifacts/v08/hud/" : "../artifacts/v08/hud/rehearsal/", import.meta.url);
await mkdir(output, { recursive: true });
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function request(path, options) {
  const response = await fetch(`${base}/${path}`, options);
  assert(response.ok, `Simulator HTTP ${response.status} for ${path}`);
  return response;
}
async function entries() { return (await (await request("console")).json()).entries; }
async function events() {
  return (await entries()).filter(entry => entry.message.startsWith("HUD_QA ")).map(entry => JSON.parse(entry.message.slice(7)));
}
async function waitFor(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = (await events()).find(predicate);
    if (match) return match;
    await sleep(120);
  }
  throw new Error(`Missing ${description}`);
}
/** Latest content per container plus the HUD view at the last write. */
async function screen() {
  const state = { header: "", body: "", caption: "", view: "?" };
  for (const event of await events()) {
    if (event.event === "rebuild" && event.ok) {
      // A page rebuild redraws every text container it carries.
      for (const [name, content] of Object.entries(event.content ?? {})) state[name.replace("hud-", "")] = content;
      state.view = event.view; if (event.content?.["hud-header"]) state.header = event.content["hud-header"];
      continue;
    }
    if (event.event !== "write") continue;
    state[event.container.replace("hud-", "")] = event.content;
    state.view = event.view; state.header = event.header;
  }
  return state;
}
const shots = [];
async function capture(name, note = "", { webview = false, scrollbars = true } = {}) {
  await sleep(250); // let the accepted write reach the next native paint
  const png = Buffer.from(await (await request("screenshot/glasses")).arrayBuffer());
  const file = new URL(`${name}.png`, output);
  await writeFile(file, png);
  // Raw captures are RGBA on transparent; a black-composited copy is for viewing.
  execFileSync("python3", ["-c", `from PIL import Image
im = Image.open(${JSON.stringify(fileURLToPath(file))}).convert("RGBA"); bg = Image.new("RGBA", im.size, (0, 0, 0, 255)); bg.alpha_composite(im)
bg.convert("RGB").save(${JSON.stringify(fileURLToPath(file).replace(/\.png$/u, ".view.png"))})`]);
  if (webview) await writeFile(new URL(`${name}.webview.png`, output), Buffer.from(await (await request("screenshot/webview")).arrayBuffer()));
  const scroll = scrollbars ? scrollbarCheck(fileURLToPath(file)) : "";
  const state = await screen();
  shots.push({ name, note, view: state.view, header: state.header, scrollbar: scroll, webview });
  console.log(`HUD_QA shot ${name.padEnd(28)} [${state.view}] ${state.header}${scroll ? `  !! ${scroll}` : ""}`);
  assert(!scroll, `${name}: ${scroll}`);
}
/** Any overflowing container shows a native scrollbar near its right edge. */
function scrollbarCheck(path) {
  const script = `
from PIL import Image
im = Image.open(${JSON.stringify(path)}).convert("RGBA"); px = im.load()
bad = []
for name, (y0, y1) in {"header": (0, 28), "body": (32, 226), "caption": (232, 288)}.items():
    for x in range(558, 573):
        run = best = 0
        for y in range(y0, y1):
            run = run + 1 if px[x, y][3] > 60 else 0
            best = max(best, run)
        if best >= (14 if name != "body" else 30): bad.append(f"{name}@x{x}:{best}px"); break
print(";".join(bad))`;
  return execFileSync("python3", ["-c", script], { encoding: "utf8" }).trim();
}
async function gesture(action, settle = 700) {
  await request("input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
  await sleep(settle);
}
/** Final gate shared by both scenarios. */
async function finish(extra = {}) {
  const all = await entries();
  const problems = all.filter(entry => entry.level === "error" || /\[uncaught\]|\[unhandledrejection\]|HUD render error|hud-error/u.test(entry.message));
  const writes = (await events()).filter(event => event.event === "write");
  assert(writes.every(event => event.accepted), "every container write accepted");
  const lineCount = { "hud-header": 1, "hud-body": 6, "hud-caption": 2 };
  assert(writes.every(event => event.content.split("\n").length <= lineCount[event.container]), "hard line budget per container");
  assert(writes.every(event => event.content.length > 0), "never an empty write");
  assert(writes.every(event => !/[✓✗⚠►▸]/u.test(event.content)), "only glyphs that render on G2");
  await writeFile(new URL("hud-events.json", output), JSON.stringify(await events(), null, 2));
  await writeFile(new URL("hud-result.json", output), JSON.stringify({
    scenario, passed: problems.length === 0, problems: problems.map(entry => entry.message.slice(0, 300)),
    writes: { total: writes.length, byContainer: Object.fromEntries(Object.keys(lineCount).map(key => [key, writes.filter(event => event.container === key).length])) },
    shots, ...extra,
  }, null, 2));
  assert.equal(problems.length, 0, `Simulator console errors: ${problems.map(entry => entry.message).join(" | ")}`);
}
const latest = async (container) => [...(await events())].reverse().find(event => event.event === "write" && event.container === container)?.content ?? "";

if (scenario === "v08") {
  await runV08();
  process.exit(0);
}

// 1. Startup and idle states.
await waitFor(event => event.event === "startup" && event.result === 0, "startup page");
const startup = (await events()).find(event => event.event === "startup");
assert.deepEqual(startup.capture, ["hud-body"], "exactly one event-capture container");
await capture("01-not-connected", "before Connect: setup hint and gesture legend");
await waitFor(event => event.event === "write" && event.container === "hud-body" && event.content.startsWith("Listening"), "listening idle body");
await capture("02-live-listening-idle", "connected, mic on, nothing yet");

// 2. Rehearsal: captions, copilot items, auto-switch to ANSWER and back.
const started = await waitFor(event => event.event === "rehearsal-start", "rehearsal start");
await waitFor(event => event.event === "write" && event.container === "hud-caption" && /^(Them|You): \S+ \S+ \S+/u.test(event.content), "partial caption");
await capture("03-caption-streaming", "word-by-word partial caption");
await waitFor(event => event.event === "write" && event.container === "hud-body" && event.view === "live" && event.at > started.at && !event.content.startsWith("Listening"), "first copilot item on LIVE", 60000);
await capture("04-live-first-item", "newest copilot item on LIVE");
// v0.8: questions the other speaker asks are auto-answered under "◆ THEY ASKED" (self questions never are).
const autoAnswer = await waitFor(event => event.event === "write" && event.container === "hud-header" && /^◆ (ANSWER|THEY ASKED)/u.test(event.content) && event.at > started.at, "auto-switch to ANSWER", 90000);
await capture("05-answer-auto", "answer auto-switch during rehearsal");
await waitFor(event => event.event === "write" && event.container === "hud-header" && !event.content.startsWith("◆") && event.at > autoAnswer.at, "auto-return after the answer", 60000);
await capture("06-auto-return", "returned to previous view after the answer expired");
await waitFor(event => event.event === "rehearsal-done", "rehearsal completion", 240000);
await sleep(12000); // final copilot run (runCopilotNow) + answers settle
const settled = await screen();
if (settled.header.startsWith("◆")) await sleep(20000);
await capture("07-live-after-rehearsal", "LIVE after the full rehearsal");

// 3. Walk the ring forward with swipe down; every view/page once.
const ring = [];
for (let step = 1; step <= 40; step += 1) {
  await gesture("down");
  const state = await screen();
  const label = state.header.split(" · ")[0].replace(/[◆ ]+/gu, " ").trim().replace(/\s+/gu, "-").replace(/[^A-Za-z0-9&/-]/gu, "").replace(/[/&]/gu, "_");
  await capture(`10-down-${String(step).padStart(2, "0")}-${label}`, "swipe down");
  ring.push(state.view);
  if (state.view === "live") break;
}
assert.equal(ring.at(-1), "live", "swipe down wraps back to LIVE");
for (const view of ["answer", "qa", "concepts", "summary", "checks"]) assert(ring.includes(view), `ring visits ${view}`);
await gesture("up");
await capture("11-up-from-live", "swipe up from LIVE enters CHECKS at its last item (undo)");
assert.equal((await screen()).view, "checks");
await gesture("down");
assert.equal((await screen()).view, "live");

// 4. Q&A: move the highlight and tap to ask it.
for (let step = 0; step < 12 && (await screen()).view !== "qa"; step += 1) await gesture("down", 400);
assert.equal((await screen()).view, "qa");
await capture("20-qa-first", "Q&A, first suggestion highlighted");
await gesture("down");
await capture("21-qa-second", "swipe moves the highlight");
const qaAsk = Date.now();
await gesture("click", 450);
await capture("22-qa-tap-thinking", "tap asks the highlighted question");
await waitFor(event => event.event === "write" && event.container === "hud-body" && event.view === "answer" && event.at > qaAsk && !event.content.startsWith("Thinking"), "Q&A answer text", 20000);
await sleep(1500);
await capture("23-qa-answer", "answer to the tapped suggestion");
await gesture("click");
await capture("24-qa-answer-closed", "tap on the last page closes and returns to Q&A");
assert.equal((await screen()).view, "qa");
assert.match((await screen()).header, /^ASK THEM 2\//u, "the ASK THEM highlight is restored after the answer");

// 5. Double tap opens the glasses MENU; "Answer whole conversation" is item 2, paged with swipes.
await gesture("double_click", 900);
await waitFor(event => event.event === "rebuild" && event.list.length === 1 && event.ok, "menu list page");
await capture("29-menu-open", "double tap opens the native list menu", { scrollbars: false });
await gesture("down", 500);
const globalAt = Date.now();
await gesture("click", 600);
await capture("30-menu-whole-conversation-thinking", "menu: Answer whole conversation");
await waitFor(event => event.event === "write" && event.container === "hud-header" && /^◆ ANSWER 1\/\d/u.test(event.content) && event.at > globalAt, "global answer page 1", 20000);
await sleep(3500);
await capture("31-global-page-1", "streamed recap, page 1");
await gesture("down");
await capture("32-global-page-2", "swipe down: next page");
await gesture("up");
await capture("33-global-back", "swipe up: previous page");
await gesture("down"); await gesture("down");
await capture("34-global-past-last-page", "swipe down past the last page returns to the view it interrupted");
assert.equal((await screen()).view, "qa");
for (let step = 0; step < 4 && (await screen()).view !== "answer"; step += 1) await gesture("up", 500);
await capture("35-global-recall", "swiping up past Q&A re-opens the last answer (recall) at its last page");
assert.equal((await screen()).view, "answer");
for (let step = 0; step < 6 && (await screen()).view === "answer"; step += 1) await gesture("click", 600);
await capture("36-global-closed", "tap on the last recall page closes it");
assert.notEqual((await screen()).view, "answer");

// 6. Push-to-talk and the native context menu.
await gesture("long_press", 600);
await capture("40-hold", "long press: push-to-talk feedback in the header");
await gesture("long_press_release", 900);
await capture("41-released", "release: submitted");
await gesture("context_menu", 900);
await capture("42-context-menu", "native shortcut menu stays available");

await finish({ ring });
console.log(`G2_HUD_QA_PASSED: ${shots.length} screenshots, ring ${ring.join(" > ")}`);

/* ------------------------------------------------------------------ */
/* v0.8 scenario                                                       */
/* ------------------------------------------------------------------ */
async function runV08() {
  await waitFor(event => event.event === "startup", "startup page");
  await waitFor(event => event.event === "connected", "connected");
  // 1. Continuous caption: sentence 1 stays while sentence 2 streams; a speaker change is inline.
  const flowing = await waitFor(event => event.event === "write" && event.container === "hud-caption"
    && /back ordered\./u.test(event.content.replace(/\n/gu, " ")) && /The quote from/u.test(event.content.replace(/\n/gu, " ")), "caption across sentences", 30000);
  await capture("v08-01-caption-across-sentences", "previous final + live partial of the next sentence", { webview: true });
  assert.match(flowing.content.replace(/\n/gu, " "), /^Them: …?.*back ordered\. The quote from/u);
  await waitFor(event => event.event === "write" && event.container === "hud-caption" && /Thursday\. You: Okay/u.test(event.content.replace(/\n/gu, " ")), "speaker change inline", 30000);
  await capture("v08-02-caption-speaker-change", "Them … You: inline, no reset");
  const done = await waitFor(event => event.event === "v08-caption-done", "last sentence final");
  const start = (await events()).find(event => event.event === "v08-caption-start");
  const captions = (await events()).filter(event => event.event === "write" && event.container === "hud-caption" && event.at > start.at && event.at <= done.at);
  assert(captions.length >= 5, "the caption streamed");
  assert(captions.slice(1).every(event => /^(Them|You): /u.test(event.content)), `never blank or hints between sentences: ${captions.map(event => event.content).join(" | ")}`);
  // 2. A question someone else asked -> auto answer under THEY ASKED.
  const asked = await waitFor(event => event.event === "write" && event.container === "hud-header" && event.content.startsWith("◆ THEY ASKED"), "THEY ASKED header", 30000);
  await waitFor(event => event.event === "v08-they-asked-answered", "auto answer completed", 30000);
  await sleep(900);
  await capture("v08-03-they-asked", "auto answer to the other speaker's question, question on top");
  assert.match(await latest("hud-body"), /^Q: How long is the Jetson Orin lead time right now\?/u);
  assert(asked.at > 0);
  await waitFor(event => event.event === "v08-seeded", "claims + suggestions seeded", 30000);
  // The answer hides itself after its reading time and the HUD returns to LIVE (no tap needed).
  await waitFor(event => event.event === "write" && event.container === "hud-header" && event.content.startsWith("LIVE") && event.at > asked.at, "auto-return to LIVE", 30000);
  // 3. MENU: double press -> native list page; scroll; select "Verify latest claim".
  await gesture("double_click", 1000);
  const menuPage = await waitFor(event => event.event === "rebuild" && event.list.length === 1 && event.ok, "menu list page");
  assert.deepEqual(menuPage.capture, ["hud-menu"], "the list captures events");
  assert(menuPage.menu === 5, "OS context menu re-sent with the rebuild");
  assert(menuPage.list[0].length <= 20 && menuPage.list[0].every(item => item.length <= 64), "list limits");
  await capture("v08-04-menu-open", "native list menu, header + caption kept", { webview: true, scrollbars: false });
  await gesture("down", 500); await gesture("down", 600);
  await capture("v08-05-menu-scrolled", "firmware highlight on Verify latest claim", { scrollbars: false });
  const verifyAt = Date.now();
  await gesture("click", 900);
  const select = await waitFor(event => event.event === "input" && event.list && event.at >= verifyAt - 50, "listEvent click");
  assert.equal(select.list.index, 2, "list click reports the highlighted index");
  await waitFor(event => event.event === "rebuild" && event.list.length === 0 && event.text.length === 3 && event.at >= verifyAt - 50, "HUD page restored");
  const shows = (event, container, pattern) => (event.event === "write" && event.container === container && pattern.test(event.content))
    || (event.event === "rebuild" && event.ok && pattern.test(event.content?.[container] ?? ""));
  await waitFor(event => shows(event, "hud-body", /Verifying…/u) && event.at >= verifyAt - 50, "Verifying… in place", 10000);
  await capture("v08-06-claim-verifying", "CLAIMS: Verifying… while the web check runs", { webview: true });
  await waitFor(event => event.event === "write" && event.container === "hud-body" && /▲ FALSE · contradicted · 2 sources/u.test(event.content), "verdict in place", 20000);
  await capture("v08-07-claim-verdict", "CLAIMS: FALSE + summary in place", { webview: true });
  // 4. Second claim: swipe + tap verifies it (fake web check: supported).
  await gesture("down", 600);
  await capture("v08-08-claim-2", "next claim: click: verify against the talk");
  await gesture("click", 900);
  await waitFor(event => event.event === "write" && event.container === "hud-body" && /● OK · supported|◆ UNSURE|· N\/A/u.test(event.content), "second verdict", 20000);
  await capture("v08-09-claim-2-verdict", "second claim verified in place");
  // 5. Menu -> Ask them (suggestions).
  await gesture("double_click", 1000);
  for (let step = 0; step < 3; step += 1) await gesture("down", 450);
  await gesture("click", 1000);
  await waitFor(event => shows(event, "hud-header", /^ASK THEM/u), "ASK THEM view");
  await capture("v08-10-ask-them", "questions the wearer could ask them", { webview: true });
  // 6. Menu -> Checks: the verdict is listed.
  await gesture("double_click", 1000);
  for (let step = 0; step < 7; step += 1) await gesture("down", 450);
  await gesture("click", 1000);
  await waitFor(event => shows(event, "hud-header", /^CHECKS/u), "CHECKS view");
  await capture("v08-11-checks", "verdicts in CHECKS");
  // 7. Menu -> Concepts; tap verifies the highlighted concept when there is one.
  await gesture("double_click", 1000);
  for (let step = 0; step < 4; step += 1) await gesture("down", 450);
  await gesture("click", 1000);
  await waitFor(event => shows(event, "hud-header", /^CONCEPTS/u), "CONCEPTS view");
  await capture("v08-12-concepts", "CONCEPTS with click: verify");
  // 8. Double press inside the menu closes it.
  await gesture("double_click", 1000);
  await gesture("double_click", 1000);
  const closed = await screen();
  assert.equal(closed.view, "concepts", "double press closes the menu back to the same view");
  await capture("v08-13-menu-closed", "menu closed by double press");
  // 9. Lifecycle: the OS context menu sends FOREGROUND_ENTER (simulator) -> re-push + mic re-enable.
  await sleep(2000); // outside the own-rebuild echo window
  const before = Date.now();
  await gesture("context_menu", 1500);
  await waitFor(event => event.event === "input" && event.sys === 4 && event.at >= before - 50, "FOREGROUND_ENTER");
  const repush = await waitFor(event => event.event === "rebuild" && event.text.length === 3 && event.at >= before - 50, "re-push on foreground enter", 5000);
  assert(repush.menu === 5, "re-push re-sends the OS menu");
  await waitFor(event => event.event === "microphone" && event.open && event.at >= before - 50, "mic re-enabled", 5000);
  await capture("v08-14-os-menu-open", "OS context menu over the re-pushed page", { scrollbars: false });
  await gesture("down", 400); await gesture("down", 400); await gesture("down", 400);
  await gesture("click", 1500); // "Dismiss cue"
  await capture("v08-15-after-os-menu", "HUD intact after the OS menu closes", { webview: true });
  await finish({ repushAt: repush.at });
  console.log(`G2_HUD_QA_V08_PASSED: ${shots.length} screenshots`);
}
