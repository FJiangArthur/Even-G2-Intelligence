#!/usr/bin/env node
// Helix v0.7 live rehearsal harness. Runs a full conversation through the real
// SDK pipeline against live OpenAI, on YOUR machine, with YOUR key.
//
//   npm run build -w @helix/conversation-sdk
//   export OPENAI_API_KEY=...            # env only; never pass keys as arguments
//   node scripts/live-rehearsal.mjs --script mock-interview-ml
//   node scripts/live-rehearsal.mjs --audio ~/Downloads/interview.m4a --max-seconds 300
//   node scripts/live-rehearsal.mjs --youtube 'https://www.youtube.com/watch?v=...'
//
// See docs/REHEARSAL.md. The key is read from OPENAI_API_KEY only, never printed,
// never written to disk; the report is scrubbed of it defensively.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIST = join(ROOT, "packages/conversation-sdk/dist/index.js");
const SCRIPTS_JSON = join(ROOT, "apps/g2-plugin/src/rehearsal-scripts.json");
const OUT_DIR = join(ROOT, "artifacts-v07/live");

const EXIT = { ok: 0, notFinished: 1, unanswered: 2, setup: 3, expectations: 4 };

/* ------------------------------------------------------------------ args */
const { values: args } = parseArgs({
  options: {
    script: { type: "string" },
    audio: { type: "string" },
    youtube: { type: "string" },
    model: { type: "string" },
    "copilot-model": { type: "string" },
    stt: { type: "string" },
    speed: { type: "string", default: "1" },
    "max-seconds": { type: "string" },
    "settle-ms": { type: "string", default: "20000" },
    "drain-ms": { type: "string", default: "30000" },
    mode: { type: "string" },
    "no-copilot": { type: "boolean", default: false },
    "no-web": { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = code => text => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const c = { dim: paint("2"), bold: paint("1"), red: paint("31"), green: paint("32"), yellow: paint("33"), blue: paint("34"), magenta: paint("35"), cyan: paint("36"), gray: paint("90") };

function usage() {
  console.log(`Usage: node scripts/live-rehearsal.mjs (--script <id> | --audio <file> | --youtube <url>) [options]

Sources
  --script <id>         Scripted conversation (text injected, no STT): ${listScriptIds().join(", ")}
  --audio <file>        Any ffmpeg-readable file; streamed as 16 kHz mono PCM through the real STT path
  --youtube <url>       Download audio with yt-dlp, then run as --audio

Options
  --model <id>          Answer model (default: SDK DEFAULT_ANSWER_MODEL)
  --copilot-model <id>  Copilot lane model (default: SDK DEFAULT_COPILOT_MODEL)
  --stt <profile>       openai-realtime (default for audio) | openai-transcribe | openai-whisper
  --speed <n>           Playback speed (script pauses / audio pacing). Default 1 = real time
  --max-seconds <n>     Only use the first n seconds of audio
  --mode <mode>         Conversation mode (default from script kind; audio: general)
  --settle-ms <n>       Max wait for a line's answers before moving on (script mode). Default 20000
  --drain-ms <n>        Max wait at the end for answers/asks/copilot. Default 30000
  --no-copilot          Disable the copilot lane     --no-web   Disable web grounding/lookups
  --strict              Also exit non-zero when script expectations (concepts/conflict/asks) are unmet
  --list                List scripts

Key: export OPENAI_API_KEY in your shell. It is never accepted as an argument.
Exit: 0 ok, 1 conversation did not finish, 2 unanswered questions, 3 setup error, 4 unmet expectations (--strict)`);
}
function listScriptIds() { try { return JSON.parse(readFileSync(SCRIPTS_JSON, "utf8")).map(s => s.id); } catch { return []; } }
function die(message, code = EXIT.setup) { console.error(c.red(`✖ ${message}`)); process.exit(code); }

if (args.help) { usage(); process.exit(EXIT.ok); }
if (args.list) { for (const s of JSON.parse(readFileSync(SCRIPTS_JSON, "utf8"))) console.log(`${s.id.padEnd(20)} ${s.kind.padEnd(10)} ${s.lines.length} lines  ${s.title}`); process.exit(EXIT.ok); }
const sources = ["script", "audio", "youtube"].filter(k => args[k]);
if (sources.length !== 1) { usage(); die("Choose exactly one of --script, --audio, --youtube."); }
if (process.argv.some(a => /^sk-[A-Za-z0-9_-]{10,}/.test(a) || /api[-_]?key/i.test(a))) die("Do not pass API keys on the command line. Use the OPENAI_API_KEY environment variable.");
const KEY = process.env.OPENAI_API_KEY?.trim();
if (!KEY) die("OPENAI_API_KEY is not set. Run: export OPENAI_API_KEY=... (the key is read from the environment only).");
const speed = Number(args.speed);
if (!Number.isFinite(speed) || speed <= 0) die("--speed must be a positive number.");
const settleMs = Number(args["settle-ms"]), drainMs = Number(args["drain-ms"]);
const maxSeconds = args["max-seconds"] ? Number(args["max-seconds"]) : undefined;

/* ------------------------------------------------------------------ SDK */
if (!existsSync(SDK_DIST)) die("SDK build not found. Run: npm run build -w @helix/conversation-sdk");
const sdk = await import(pathToFileURL(SDK_DIST).href);
const { DirectConversationTransport, HelixConversationClient } = sdk;
if (!DirectConversationTransport || !HelixConversationClient) die("SDK build is missing DirectConversationTransport/HelixConversationClient. Rebuild the SDK.");
const MODEL = args.model ?? sdk.DEFAULT_ANSWER_MODEL ?? "gpt-6.1-terra";
const COPILOT_MODEL = args["copilot-model"] ?? sdk.DEFAULT_COPILOT_MODEL ?? "gpt-6-luna";
const STT = args.stt ?? (args.script ? "none (injected text)" : "openai-realtime");
const STT_PROFILES = ["openai-realtime", "openai-transcribe", "openai-whisper"];
if (!args.script && !STT_PROFILES.includes(STT)) die(`--stt must be one of ${STT_PROFILES.join(", ")}.`);
const hasInject = typeof DirectConversationTransport.prototype.injectTranscript === "function";
if (args.script && !hasInject) die("This SDK build has no transport.injectTranscript (v0.7). Rebuild the SDK or use --audio.");

const scripts = JSON.parse(readFileSync(SCRIPTS_JSON, "utf8"));
const script = args.script ? scripts.find(s => s.id === args.script) : undefined;
if (args.script && !script) die(`Unknown script "${args.script}". Available: ${scripts.map(s => s.id).join(", ")}`);

/* ------------------------------------------------------------------ preflight */
const UNREACHABLE = "api.openai.com unreachable — run outside the sandbox / allow the domain";
async function preflight() {
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(10_000), redirect: "error" });
  } catch (error) {
    die(`${UNREACHABLE} (${error?.cause?.code ?? error?.name ?? "network error"}).`);
  }
  const type = response.headers.get("content-type") ?? "";
  // An egress proxy that blocks the host answers with its own non-JSON page.
  if (!type.includes("json") && !response.ok) die(`${UNREACHABLE} (HTTP ${response.status} from an intermediary).`);
  if (response.status === 401) die("OpenAI rejected the key (401). Check OPENAI_API_KEY.");
  if (response.status === 429) die("OpenAI rate/quota limit (429). Check billing.");
  if (!response.ok) die(`OpenAI preflight failed (HTTP ${response.status}).`);
}
await preflight();

/* ------------------------------------------------------------------ youtube / audio */
const which = bin => spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let audioPath = args.audio ? resolve(args.audio) : undefined;
if (args.youtube) {
  if (!which("yt-dlp")) die("yt-dlp not found. Install: brew install yt-dlp  (or: pipx install yt-dlp)");
  if (!which("ffmpeg")) die("ffmpeg not found. Install: brew install ffmpeg  (or: apt install ffmpeg)");
  console.log(c.gray(`Downloading audio with yt-dlp…`));
  const template = join(OUT_DIR, `yt-${stamp}.%(ext)s`);
  const result = spawnSync("yt-dlp", ["-x", "--audio-format", "m4a", "--no-playlist", "-o", template, args.youtube], { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) die("yt-dlp failed. If the network blocks YouTube, download elsewhere and use --audio <file>.");
  const file = readdirSync(OUT_DIR).find(name => name.startsWith(`yt-${stamp}.`));
  if (!file) die("yt-dlp finished but no audio file was found.");
  audioPath = join(OUT_DIR, file);
}
if (audioPath) {
  if (!existsSync(audioPath)) die(`Audio file not found: ${audioPath}`);
  if (!which("ffmpeg")) die("ffmpeg not found. Install: brew install ffmpeg  (or: apt install ffmpeg)");
}

/* ------------------------------------------------------------------ state + logging */
const startedWall = Date.now();
const t = () => c.gray(`[${((Date.now() - startedWall) / 1000).toFixed(1).padStart(6)}s]`);
const log = (...parts) => console.log(t(), ...parts);
const state = {
  events: [], transcripts: [], questions: new Map(), answers: new Map(), metas: [], usage: [], errors: [],
  summaries: [], concepts: [], conflicts: [], suggestions: [], asks: new Map(), verifications: [], sttMs: [], commitToFinal: [],
};
const commitTimes = [];
const fmtUsd = v => (sdk.formatUsd ? sdk.formatUsd(v) : v === undefined ? "price n/a" : `$${v.toFixed(4)}`);
const fmtMs = v => (sdk.formatMs ? sdk.formatMs(v) : v === undefined ? "–" : `${Math.round(v)} ms`);
const scrub = text => String(text).split(KEY).join("[redacted]");

const copilotSettings = { ...(sdk.DEFAULT_COPILOT_SETTINGS ?? {}), copilotModel: COPILOT_MODEL, ...(args["no-web"] ? { webGrounding: false } : {}) };
const copilot = args["no-copilot"] ? undefined : {
  enabled: () => true,
  settings: () => copilotSettings,
  onSummary: s => { state.summaries.push(s); log(c.blue("SUMMARY"), s.bullets.map(b => `\n          • ${b}`).join(""), s.keyFacts.length ? c.gray(`\n          facts: ${s.keyFacts.join(" | ")}`) : ""); },
  onConcept: k => { state.concepts.push(k); log(c.magenta("CONCEPT"), c.bold(k.term), "—", k.explanation); },
  onConflict: k => { state.conflicts.push(k); log(c.red("CONFLICT"), `"${k.earlier}" ⟷ "${k.later}"`, c.gray(k.explanation)); },
  onSuggestions: items => { state.suggestions = [...items]; log(c.gray("SUGGEST"), items.map(s => s.question).join(" | ")); },
  onAsk: a => {
    state.asks.set(a.id, a);
    if (a.status === "pending") log(c.yellow(`ASK ${a.kind}`), a.topic, c.gray(`← "${a.trigger}"`));
    else log(c.yellow(`ASK ${a.kind} ${a.status}`), a.answer ?? "", a.sources?.length ? c.gray(`\n          sources: ${a.sources.map(s => s.url).join(" ")}`) : "");
  },
  onVerification: v => { state.verifications.push(v); log(c.cyan(`VERIFY ${v.status}`), v.summary); },
};

const transport = new DirectConversationTransport({
  fetch: (url, init) => globalThis.fetch(url, init),
  ...(copilot ? { copilot } : {}),
  onUsage: u => state.usage.push(u),
  onAnswerMeta: m => {
    state.metas.push(m);
    const tm = m.timing;
    log(c.gray(`  meta  e2e ${fmtMs(tm.endToEndMs)} · first token ${fmtMs(tm.firstTokenMs)} · gen ${fmtMs(tm.generationMs)} · queue ${fmtMs(tm.queueMs)}${tm.transcriptionMs !== undefined ? ` · stt ${fmtMs(tm.transcriptionMs)}` : ""} · ${fmtUsd(m.usage?.costUsd)} · ${m.grounded}${m.sources.length ? ` · ${m.sources.length} sources` : ""}`));
  },
  // Node 22 global WebSocket; the SDK supplies ["realtime", "openai-insecure-api-key.<ephemeral token>"].
  webSocketFactory: (url, protocols) => new WebSocket(url, protocols),
});
transport.subscribe(event => {
  state.events.push(event);
  switch (event.type) {
    case "transcript.final": {
      state.transcripts.push(event);
      const stt = event.context?.latencyMs?.transcriptionMs;
      if (typeof stt === "number" && !script) state.sttMs.push(stt); // injected text has no STT
      const pendingCommit = commitTimes.shift();
      if (pendingCommit !== undefined) state.commitToFinal.push(Date.now() - pendingCommit);
      log(c.green(`${event.context.speaker.label}:`), event.text, typeof stt === "number" ? c.gray(`(stt ${fmtMs(stt)})`) : "");
      break;
    }
    case "question.detected": state.questions.set(event.questionId, event); log(c.cyan(event.context?.speaker?.role === "self" ? "YOU ASKED" : "THEY ASKED"), event.text); break;
    case "answer.completed": {
      state.answers.set(event.questionId ?? event.answerId, event);
      log(c.bold(c.green("ANSWER")), event.text);
      break;
    }
    case "error": state.errors.push({ code: event.code, message: scrub(event.message), fatal: event.fatal }); log(c.red(`ERROR ${event.code}${event.fatal ? " (fatal)" : ""}`), scrub(event.message)); break;
    default: break;
  }
});

/* ------------------------------------------------------------------ session */
const modeForKind = kind => (kind === "interview" ? "interviewee" : kind === "meeting" ? "office-discussion" : "general");
const mode = args.mode ?? (script ? modeForKind(script.kind) : "general");
const sessionId = `live_${stamp}`;
const client = new HelixConversationClient(transport);
const transcriptionProvider = args.script ? "openai-transcribe" : STT;
console.log(c.bold(`Helix live rehearsal`), c.gray(`· ${script ? `script ${script.id}` : `audio ${audioPath}`} · answer ${MODEL} · copilot ${copilot ? COPILOT_MODEL : "off"} · stt ${STT} · speed ${speed}x · mode ${mode}`));
try {
  await client.start({
    sessionId,
    endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: MODEL },
    prompt: { id: "helix-direct", version: "1", system: "Answer the detected question directly and concisely. Preserve uncertainty and prefer useful next actions.", mode, maxResponseSentences: 3 },
    mode, responseStrategy: "reactive",
    providers: { transcriptionProvider, answerProvider: "openai-responses" },
    memory: { readOmiContext: false, syncNotes: false },
    audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    locale: "en", speaker: { label: script ? "Rehearsal" : "Recording", role: script ? "unknown" : "other" },
    automation: { detectQuestions: true, answerQuestions: true, saveNotes: false },
    client: { name: "helix-live-rehearsal", version: "0.7.0", device: "node" },
  }, { openai: KEY });
} catch (error) {
  const message = scrub(error?.message ?? error);
  if (/network|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message)) die(`${UNREACHABLE}.`);
  die(`Session start failed: ${message}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// v0.8: the wearer's own questions (role "self") are prompts for the other party, never auto-answered.
const unanswered = () => [...state.questions.values()].filter(q => q.context?.speaker?.role !== "self" && !state.answers.has(q.questionId));
const fatal = () => state.errors.some(e => e.fatal);
async function waitUntil(predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (predicate() || fatal()) return predicate(); await sleep(50); }
  return predicate();
}
let interrupted = false;
process.on("SIGINT", () => { if (interrupted) process.exit(EXIT.notFinished); interrupted = true; console.log(c.yellow("\nStopping… (Ctrl-C again to force)")); });

/* ------------------------------------------------------------------ run */
let fedLines = 0, audioSeconds = 0, sourceFinished = false;
const pauseFor = line => line.pauseMs ?? Math.round(line.text.trim().split(/\s+/u).length * 400 + 600);

if (script) {
  for (const [index, line] of script.lines.entries()) {
    if (interrupted || fatal()) break;
    const speaker = line.speaker === "self" ? { label: "You", role: "self" } : { label: "Other speaker", role: "other" };
    const before = state.transcripts.length;
    await transport.injectTranscript(line.text, speaker);
    fedLines++;
    // Give this line's answer time to stream, the way the next speaker's turn would.
    await waitUntil(() => state.transcripts.length > before && unanswered().length === 0, settleMs);
    if (index < script.lines.length - 1) await sleep(pauseFor(line) / speed);
  }
  sourceFinished = fedLines === script.lines.length;
} else {
  const ffArgs = ["-hide_banner", "-loglevel", "error", ...(maxSeconds ? ["-t", String(maxSeconds)] : []), "-i", audioPath, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000", "pipe:1"];
  const ff = spawn("ffmpeg", ffArgs, { stdio: ["ignore", "pipe", "inherit"] });
  const FRAME = 1600; // 100 ms at 16 kHz
  const CHUNK_SECONDS = 6;
  let pending = Buffer.alloc(0), sinceCommit = 0;
  const begin = Date.now();
  let sent = 0;
  for await (const data of ff.stdout) {
    if (interrupted || fatal()) { ff.kill(); break; }
    pending = Buffer.concat([pending, data]);
    while (pending.length >= FRAME * 2) {
      const bytes = pending.subarray(0, FRAME * 2); pending = pending.subarray(FRAME * 2);
      const samples = new Int16Array(FRAME);
      for (let i = 0; i < FRAME; i++) samples[i] = bytes.readInt16LE(i * 2);
      await client.sendAudio(samples, { source: "file" });
      sent += FRAME; sinceCommit += FRAME;
      // Uploaded-STT profiles get fixed 6 s segments. Realtime behaves like the glasses:
      // the transport's adaptive silence endpointing decides turns (no forced mid-sentence cuts).
      if (STT !== "openai-realtime" && sinceCommit >= 16000 * CHUNK_SECONDS) { sinceCommit = 0; commitTimes.push(Date.now()); await client.commitAudio("vad").catch(() => undefined); }
      // Real-time pacing (scaled by --speed) so measured latency matches live speech.
      const due = begin + (sent / 16000) * 1000 / speed;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
  audioSeconds = sent / 16000;
  if (!interrupted && !fatal()) { commitTimes.push(Date.now()); await client.commitAudio("manual").catch(() => undefined); }
  const code = await new Promise(resolve => (ff.exitCode !== null ? resolve(ff.exitCode) : ff.once("close", resolve)));
  if (code !== 0 && !interrupted) log(c.red(`ffmpeg exited with code ${code}`));
  sourceFinished = !interrupted && (code === 0 || code === null) && sent > 0;
}

/* ------------------------------------------------------------------ drain */
log(c.gray("Source finished; waiting for answers and copilot to drain…"));
await waitUntil(() => unanswered().length === 0, drainMs / 2);
if (copilot && typeof transport.runCopilotNow === "function") {
  // Final copilot pass over the tail of the conversation, then let its asks finish.
  const summaries = state.summaries.length, drainEnd = Date.now() + drainMs / 2;
  transport.runCopilotNow();
  await waitUntil(() => state.summaries.length > summaries, Math.max(0, drainEnd - Date.now()));
  await sleep(250); // asks are queued right after the copilot result
  await waitUntil(() => [...state.asks.values()].every(a => a.status !== "pending") && unanswered().length === 0, Math.max(1000, drainEnd - Date.now()));
}
if (copilot && typeof transport.verify === "function" && state.summaries.at(-1)?.bullets?.[0]) {
  transport.verify(state.summaries.at(-1).bullets[0], "summary-0");
  await waitUntil(() => state.verifications.length > 0, 20_000);
}
await client.stop("user").catch(() => undefined);

/* ------------------------------------------------------------------ report */
const pct = (values, p) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};
const dist = values => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length ? Math.max(...values) : undefined });
const cost = { totalUsd: 0, byKind: {}, unpricedCalls: 0 };
for (const u of state.usage) {
  if (u.costUsd === undefined) { cost.unpricedCalls++; continue; }
  cost.totalUsd += u.costUsd; cost.byKind[u.kind] = (cost.byKind[u.kind] ?? 0) + u.costUsd;
}
cost.totalUsd = Math.round(cost.totalUsd * 1e6) / 1e6;
const asks = [...state.asks.values()];
const missed = unanswered().map(q => q.text);
const e = script?.expectations ?? {};
const expectations = script ? {
  concepts: Object.fromEntries((e.concepts ?? []).map(term => [term, state.concepts.some(k => k.term.toLowerCase() === term.toLowerCase())])),
  conflict: e.conflict ? state.conflicts.length > 0 : undefined,
  lookups: Object.fromEntries((e.lookups ?? []).map(n => [n, asks.some(a => a.kind === "lookup" && a.status === "done" && a.trigger.includes(n))])),
  proposes: Object.fromEntries((e.proposes ?? []).map(n => [n, asks.some(a => a.kind === "propose" && a.status === "done" && a.trigger.includes(n))])),
  questions: Object.fromEntries((e.questions ?? []).map(n => [n, [...state.questions.values()].some(q => q.text.includes(n) && state.answers.has(q.questionId))])),
} : undefined;
const unmet = expectations ? Object.entries(expectations).flatMap(([k, v]) => v === undefined ? [] : typeof v === "boolean" ? (v ? [] : [k]) : Object.entries(v).filter(([, ok]) => !ok).map(([n]) => `${k}:${n}`)) : [];
const finished = sourceFinished && !fatal() && !interrupted;
const report = {
  version: "helix-live-rehearsal/1",
  startedAt: new Date(startedWall).toISOString(), durationMs: Date.now() - startedWall,
  source: script ? { type: "script", id: script.id, lines: script.lines.length, fedLines } : { type: args.youtube ? "youtube" : "audio", file: audioPath, url: args.youtube, audioSeconds },
  models: { answer: MODEL, copilot: copilot ? COPILOT_MODEL : null, stt: STT }, speed, mode, pricingCheckedAt: sdk.PRICING_CHECKED_AT,
  finished,
  counts: {
    transcripts: state.transcripts.length, questions: state.questions.size, answers: state.answers.size, unanswered: missed.length,
    concepts: state.concepts.length, conflicts: state.conflicts.length, summaries: state.summaries.length, suggestions: state.suggestions.length,
    asks: { total: asks.length, lookup: asks.filter(a => a.kind === "lookup").length, propose: asks.filter(a => a.kind === "propose").length, question: asks.filter(a => a.kind === "question").length,
      done: asks.filter(a => a.status === "done").length, failed: asks.filter(a => a.status === "failed").length, pending: asks.filter(a => a.status === "pending").length },
    verifications: state.verifications.length, errors: state.errors.length, providerCalls: state.usage.length,
  },
  cost,
  latencyMs: {
    answerEndToEnd: dist(state.metas.map(m => m.timing.endToEndMs)),
    answerFirstToken: dist(state.metas.map(m => m.timing.firstTokenMs).filter(v => typeof v === "number")),
    answerGeneration: dist(state.metas.map(m => m.timing.generationMs)),
    answerQueue: dist(state.metas.map(m => m.timing.queueMs)),
    sttReported: dist(state.sttMs),
    sttCommitToFinal: dist(state.commitToFinal),
  },
  unansweredQuestions: missed,
  expectations, unmetExpectations: unmet,
  errors: state.errors,
  summary: state.summaries.at(-1) ?? null,
  concepts: state.concepts.map(k => ({ term: k.term, explanation: k.explanation })),
  conflicts: state.conflicts.map(k => ({ earlier: k.earlier, later: k.later, explanation: k.explanation })),
  asks: asks.map(a => ({ kind: a.kind, status: a.status, topic: a.topic, trigger: a.trigger, answer: a.answer, sources: a.sources })),
  verifications: state.verifications,
  answers: [...state.answers.values()].map(a => ({ questionId: a.questionId, text: a.text, meta: state.metas.find(m => m.answerId === a.answerId) })),
};
const outFile = join(OUT_DIR, `${stamp}.json`);
writeFileSync(outFile, scrub(JSON.stringify(report, null, 2)) + "\n");

const L = report.latencyMs;
console.log(`\n${c.bold("Report")} ${c.gray(outFile)}`);
console.log(`  finished        ${finished ? c.green("yes") : c.red("no")}`);
console.log(`  transcripts     ${report.counts.transcripts}   questions ${report.counts.questions}   answers ${report.counts.answers}   unanswered ${missed.length ? c.red(missed.length) : c.green(0)}`);
console.log(`  copilot         concepts ${report.counts.concepts} · conflicts ${report.counts.conflicts} · asks ${report.counts.asks.done}/${report.counts.asks.total} done · summaries ${report.counts.summaries}`);
console.log(`  answer latency  p50 ${fmtMs(L.answerEndToEnd.p50)} · p95 ${fmtMs(L.answerEndToEnd.p95)} (end-to-end, n=${L.answerEndToEnd.n}) · first token p50 ${fmtMs(L.answerFirstToken.p50)}`);
console.log(`  stt latency     p50 ${fmtMs(L.sttReported.p50)} · p95 ${fmtMs(L.sttReported.p95)} (SDK-reported, n=${L.sttReported.n})${L.sttCommitToFinal.n ? ` · commit→final p50 ${fmtMs(L.sttCommitToFinal.p50)}` : ""}`);
console.log(`  cost            ${fmtUsd(cost.totalUsd)} total${cost.unpricedCalls ? c.yellow(` (+${cost.unpricedCalls} unpriced calls)`) : ""} · ${Object.entries(cost.byKind).map(([k, v]) => `${k} ${fmtUsd(v)}`).join(" · ")}`);
for (const q of missed) console.log(c.red(`  unanswered: ${q}`));
for (const u of unmet) console.log(c.yellow(`  unmet expectation: ${u}`));

if (!finished) process.exit(EXIT.notFinished);
if (missed.length) process.exit(EXIT.unanswered);
if (args.strict && unmet.length) process.exit(EXIT.expectations);
process.exit(EXIT.ok);
