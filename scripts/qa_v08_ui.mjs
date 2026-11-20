// v0.8 phone UI screenshots (390x844, dark + light) from apps/g2-plugin/qa/v08-ui.html.
//   (cd apps/g2-plugin && npx vite --port 5175 --host 127.0.0.1)
//   node scripts/qa_v08_ui.mjs   [V08_UI_URL=http://127.0.0.1:5175 V08_UI_OUT=artifacts/v08/ui PLAYWRIGHT_CORE=/path]
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core", "/opt/node-tools/node_modules/playwright-core", "/opt/npm-tools/node_modules/playwright-core"].filter(Boolean);
let chromium;
for (const name of candidates) { try { ({ chromium } = require(name)); break; } catch { /* next */ } }
if (!chromium) throw new Error("playwright-core not found; set PLAYWRIGHT_CORE");

const base = process.env.V08_UI_URL ?? "http://127.0.0.1:5175";
const out = resolve(process.env.V08_UI_OUT ?? "artifacts/v08/ui");
await mkdir(out, { recursive: true });
const shots = [
  ["answers", "tab=answers"],
  ["answers-top", "tab=answers&scroll=feedtop"],
  ["answers-questions", "tab=answers&scroll=question"],
  ["answers-mirror", "tab=answers&mirror=open"],
  ["qa", "tab=qa"],
  ["checks", "tab=checks"],
  ["history-list", "tab=history"],
  ["history-detail", "tab=history&session=session_qa_h1"],
  ["history-transcript", "tab=history&session=session_qa_h1&scroll=transcript"],
  ["history-detail-omi", "tab=history&session=omi%3Aqa-kan"],
  ["knowledge", "tab=knowledge"],
  ["knowledge-map", "tab=knowledge&scroll=map"],
  ["knowledge-transfers", "tab=knowledge&scroll=transfers&paste=1"],
  ["knowledge-omi", "tab=knowledge&scroll=omi"],
  ["people", "tab=people&people=focus"],
  ["setup-gestures", "tab=setup&scroll=gestures"],
  ["answers-empty", "tab=answers&state=empty"],
];
const only = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] });
const errors = [];
for (const scheme of ["dark", "light"]) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
  for (const [name, query] of shots) {
    if (only.length && !only.includes(name)) continue;
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(`${name}/${scheme}: ${error.message}`));
    page.on("console", message => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`${name}/${scheme}: ${message.text()}`); });
    await page.goto(`${base}/qa/v08-ui.html?${query}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
    const scroll = new URLSearchParams(query).get("scroll");
    if (scroll === "transfers") await page.evaluate(() => document.querySelector(".route-card")?.scrollIntoView({ block: "start" }));
    if (scroll === "feedtop") await page.evaluate(() => { const feed = document.querySelector("#conversation-feed"); if (feed) feed.scrollTop = 0; });
    if (scroll === "transcript") await page.evaluate(() => [...document.querySelectorAll(".detail-section")].at(-1)?.scrollIntoView({ block: "start" }));
    if (scroll === "map") await page.evaluate(() => document.querySelector(".knowledge-map-wrap")?.closest("section")?.scrollIntoView({ block: "start" }));
    if (scroll === "question") await page.evaluate(() => { const feed = document.querySelector("#conversation-feed"); const card = document.querySelector(".question-you"); if (feed && card) feed.scrollTop = card.offsetTop - feed.offsetTop - 140; });
    if (scroll === "omi") await page.evaluate(() => document.querySelector(".route-omi-helix")?.scrollIntoView({ block: "start" }));
    if (scroll === "gestures") await page.evaluate(() => document.querySelector("#gesture-title")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/${name}-${scheme}.png` });
    await page.close();
    console.log(`V08_UI ${name}-${scheme}.png`);
  }
  await context.close();
}
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
