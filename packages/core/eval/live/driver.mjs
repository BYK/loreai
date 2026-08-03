// Live counterfactual agent-eval driver.
//
// Runs a real OpenCode agent through a multi-session coding task, either WITH
// Lore (routed through an ISOLATED gateway + DB) or WITHOUT (native compaction).
// The two arms are identical except for Lore, so the difference in outcome +
// efficiency (tokens/turns) is attributable to Lore.
//
// Why this design (vs the replay eval): replay freezes the agent's outputs,
// which is exactly what Lore changes. Here the agent acts live, so we measure
// Lore's real impact — including doing the same work with fewer tokens/turns.
//
// Isolation invariants (must never touch the user's real gateway/DB):
//   - Each arm/run gets its own XDG_{CONFIG,DATA,CACHE,STATE}_HOME + project dir.
//   - The Lore arm starts its OWN gateway on a unique port with its OWN
//     LORE_DB_PATH, and points OpenCode at it via LORE_GATEWAY_URL (which is
//     probed first, so it never falls through to the real defaults 3207/5673).
//
// Usage:
//   bun driver.mjs --task <task.json> --arm lore|nolore --model <prov/model> \
//     --out <dir> [--gw-dist <path>] [--keep]
//
// Emits <out>/result.json with per-session + total metrics.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { runVerifierProcess } from "./verifier.mjs";

// ---- args ----------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--"))
      acc.push([
        cur.slice(2),
        arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true",
      ]);
    return acc;
  }, []),
);
const TASK = JSON.parse(fs.readFileSync(args.task, "utf8"));
const ARM = args.arm; // "lore" | "nolore"
const MODEL = args.model; // e.g. "minimax-coding-plan/MiniMax-M3"
const OUT = path.resolve(args.out);
const AUTH_SRC =
  args["auth"] ||
  path.join(
    process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`,
    "opencode/auth.json",
  );
// Fresh trunk build (NOT the user's active installed plugin) — see #1211.
const LORE_BUILD =
  args["lore-build"] || "/home/byk/.local/share/lore-worktrees/eval-live";
const REAL_LORE_PLUGIN = args["lore-plugin"] || `${LORE_BUILD}/eval-plugin.ts`;
const GW_DIST =
  args["gw-dist"] || `${LORE_BUILD}/packages/gateway/dist/index.bun.js`;
// Map an answering model (opencode "provider/model") to a Lore worker model on
// the SAME provider. minimax-coding-plan maps to Lore's "minimax" route; every
// other provider reuses the answering model itself (same provider by construction).
function defaultWorkerFor(model) {
  const prov = String(model).split("/")[0];
  if (prov === "minimax-coding-plan" || prov === "minimax")
    return "minimax/MiniMax-M3";
  return model;
}
// The worker API key MUST match the worker model's provider. Hardcoding one key
// (e.g. minimax) silently auth-fails the worker for every other provider, so
// distillation never runs and Lore falls back to temporal-only recall (a
// confounded, under-credited result). Map the worker provider -> auth.json entry.
function workerKeyFor(workerModel, auth) {
  const prov = String(workerModel).split("/")[0];
  const authName = prov === "minimax" ? "minimax-coding-plan" : prov;
  const entry = auth[prov] || auth[authName];
  if (!entry) return ""; // anonymous provider (e.g. opencode/Zen) — no keyed worker
  return entry.key || entry.access || entry.apiKey || "";
}
// Lore's background worker (distillation/knowledge extraction) MUST use the same
// PROVIDER as the answering model — otherwise a test can silently route worker
// traffic to an unrelated (and possibly exhausted/rate-limited) provider. E.g.
// answering on opencode/deepseek but worker on minimax/MiniMax-M3 sends all
// distillation to the M3 coding plan; if that plan is throttled the worker 429s,
// distillation never completes, and Lore captures 0 knowledge → unfair 0/N.
// Default the worker to the SAME provider as --model; override with --worker-model.
const WORKER_MODEL = args["worker-model"] || defaultWorkerFor(MODEL);
{
  const wp = WORKER_MODEL.split("/")[0];
  const mp = MODEL.split("/")[0];
  if (wp !== mp && !args["worker-model"]) {
    console.error(
      `[warn] worker provider '${wp}' != answering provider '${mp}' — pass --worker-model to keep them on one provider`,
    );
  }
}
const OPENCODE = args["opencode"] || "opencode";
const SESSION_TIMEOUT = Number(args["session-timeout"] || "900"); // seconds per session

function redactAuth(auth) {
  return Object.fromEntries(
    Object.keys(auth)
      .sort()
      .map((provider) => [provider, { present: true }]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateTask(task) {
  if (!task || typeof task !== "object" || !Array.isArray(task.sessions)) {
    throw new Error("task must contain a sessions array");
  }
  const seen = new Set();
  for (const session of task.sessions) {
    for (const turn of session.turns || []) {
      if (!turn.checkpoint) continue;
      if (typeof turn.checkpoint !== "string" || seen.has(turn.checkpoint)) {
        throw new Error(`checkpoint ids must be unique: ${turn.checkpoint}`);
      }
      seen.add(turn.checkpoint);
    }
  }
  if (task.verifier && (!task.id || seen.size === 0)) {
    throw new Error(
      "iterative tasks require an id and at least one checkpoint",
    );
  }
}

function factsForTask(task, seed) {
  if (!task.facts) return {};
  if (!seed) {
    throw new Error(
      "iterative tasks require --fact-seed so paired arms share facts",
    );
  }
  const facts = {};
  for (const [name, spec] of Object.entries(task.facts)) {
    const digest = sha256(`${seed}:${name}`);
    if (Array.isArray(spec) && spec.length > 0) {
      facts[name] = spec[parseInt(digest.slice(0, 8), 16) % spec.length];
    } else if (
      spec &&
      typeof spec === "object" &&
      typeof spec.prefix === "string"
    ) {
      facts[name] = `${spec.prefix}${digest.slice(0, 8).toUpperCase()}`;
    } else {
      throw new Error(
        `task fact '${name}' must be a non-empty list or token prefix`,
      );
    }
  }
  return facts;
}

validateTask(TASK);
const FACT_SEED = args["fact-seed"] || "";
const FACTS = factsForTask(TASK, FACT_SEED);

// Which agent runtime drives the task: "opencode" (default) or "pi"
// (@mariozechner/pi-coding-agent). Pi is a second driver so we can compare how a
// different agent's transcript/compaction discipline behaves under the same
// forced-context pressure, and whether the same Lore gateway cache fixes hold on
// Pi's wire. Lore routes Pi's traffic through the SAME isolated gateway via
// LORE_GATEWAY_URL (the @loreai/pi extension reads it), so only the spawn +
// JSONL parse + fairness knob differ.
const AGENT = (args["agent-runtime"] || "opencode").toLowerCase();
const PI = args["pi"] || "pi";
// Pi's `pi` bin is a Volta shim that fails ("Node is not available") unless a
// node is resolvable on PATH. Resolve a node bin dir once so runPi() can prepend
// it. Prefer an explicit --pi-node, else the newest ~/.volta/tools/image/node/*.
function resolvePiNodeBin() {
  if (args["pi-node"]) return path.dirname(path.resolve(args["pi-node"]));
  try {
    const base = path.join(process.env.HOME, ".volta/tools/image/node");
    const vers = fs
      .readdirSync(base)
      .filter((v) => /^\d+\./.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vers) {
      const bin = path.join(base, v, "bin");
      if (fs.existsSync(path.join(bin, "node"))) return bin;
    }
  } catch {
    /* no volta node dir */
  }
  return null;
}
const PI_NODE_BIN = AGENT === "pi" ? resolvePiNodeBin() : null;
// Lore's built @loreai/pi extension (loaded for the lore arm so Pi routes through
// our gateway build, not npm:@loreai/pi@latest).
const PI_LORE_EXT = args["pi-ext"] || `${LORE_BUILD}/packages/pi/dist/index.js`;

if (!ARM || !MODEL || !args.task || !args.out) {
  console.error("required: --task --arm --model --out");
  process.exit(2);
}

// ---- helpers -------------------------------------------------------------
const sh = (cmd, cwd) =>
  new Promise((res) => {
    const p = spawn("bash", ["-c", cmd], { cwd, stdio: "ignore" });
    p.on("exit", (code) => res(code ?? 1));
  });

async function freePort() {
  return await new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function probeHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Parse an `opencode run --format json` event stream into metrics.
function parseSession(jsonlPath) {
  const m = {
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    toolCalls: 0,
    toolsByName: {},
    text: "",
    peakContext: 0,
    errors: [],
  };
  const raw = fs.existsSync(jsonlPath)
    ? fs.readFileSync(jsonlPath, "utf8")
    : "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const part = o.part || {};
    if (o.type === "error") {
      m.errors.push(
        o.error?.data?.message ||
          o.error?.message ||
          "OpenCode emitted an error event",
      );
    } else if (o.type === "step_finish") {
      m.steps++;
      const t = part.tokens || {};
      m.tokensIn += t.input || 0;
      m.tokensOut += t.output || 0;
      m.cacheRead += (t.cache && t.cache.read) || 0;
      m.cacheWrite += (t.cache && t.cache.write) || 0;
      m.cost += part.cost || 0;
      // peak context = largest single-step input footprint (input + cache that
      // turn). On a non-compacting model this ~= how big the session grew, which
      // is how we calibrate task size to force compaction on a 200K model.
      const ctx =
        (t.input || 0) +
        ((t.cache && t.cache.read) || 0) +
        ((t.cache && t.cache.write) || 0);
      if (ctx > m.peakContext) m.peakContext = ctx;
    } else if (o.type === "tool_use") {
      m.toolCalls++;
      const name = part.tool || part.name || "?";
      m.toolsByName[name] = (m.toolsByName[name] || 0) + 1;
    } else if (o.type === "text") {
      m.text += part.text || "";
    }
  }
  m.tokensTotal = m.tokensIn + m.tokensOut + m.cacheRead + m.cacheWrite;
  return m;
}

// Count native compactions OpenCode performed, from its session DB. Compaction
// parts aren't emitted to the --format json stream, but a row is persisted.
function countCompactions(dbPath) {
  try {
    const out = execFileSync(
      "python3",
      [
        "-c",
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
n=c.execute("SELECT COUNT(*) FROM session_message WHERE type='compaction'").fetchone()[0]
n+=c.execute("SELECT COUNT(*) FROM part WHERE data LIKE '%\\\"type\\\":\\\"compaction\\\"%'").fetchone()[0]
print(n)`,
        dbPath,
      ],
      { encoding: "utf8" },
    );
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

// ---- Pi (@mariozechner/pi-coding-agent) parsing --------------------------
// Pi's `--mode json` emits a JSONL event stream. Assistant metrics live on
// `message_end`/`turn_end` events under `message.usage.{input,output,cacheRead,
// cacheWrite}` and `message.usage.cost.{...,total}` (cost is pre-broken-out per
// tier, richer than OpenCode's stream). We count one "step" per assistant
// message_end. Tool calls are content parts of type "tool_call"; text is
// type "text". peakContext mirrors the OpenCode definition: the largest
// single-request footprint (uncached input + cache read + cache write).
function parsePiSession(jsonlPath) {
  const m = {
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    toolCalls: 0,
    toolsByName: {},
    text: "",
    peakContext: 0,
    errors: [],
    // Pi-native cache accounting: count "significant misses" the way the
    // Earendil post frames them — a request that re-billed a large uncached
    // prefix. We flag any assistant request whose uncached `input` exceeds
    // PI_MISS_TOKENS and estimate the re-billed tokens/$ from it.
    reBilledTokens: 0,
    reBilledCost: 0,
    misses: 0,
  };
  const PI_MISS_TOKENS = 50000; // same >50K threshold used for OpenCode spike checks
  const raw = fs.existsSync(jsonlPath)
    ? fs.readFileSync(jsonlPath, "utf8")
    : "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    // One assistant response == one message_end with role assistant.
    if (
      o.type === "message_end" &&
      o.message &&
      o.message.role === "assistant"
    ) {
      const msg = o.message;
      if (msg.stopReason === "error") {
        m.errors.push(msg.errorMessage || "Pi assistant response failed");
        continue;
      }
      const u = msg.usage || {};
      m.steps++;
      const input = u.input || 0;
      const cr = u.cacheRead || 0;
      const cw = u.cacheWrite || 0;
      m.tokensIn += input;
      m.tokensOut += u.output || 0;
      m.cacheRead += cr;
      m.cacheWrite += cw;
      m.cost += (u.cost && u.cost.total) || 0;
      const ctx = input + cr + cw;
      if (ctx > m.peakContext) m.peakContext = ctx;
      // A big uncached-input request after the prefix is warm == a re-billed
      // cache miss. Bill it at the request's own input price when available.
      if (input > PI_MISS_TOKENS) {
        m.misses++;
        m.reBilledTokens += input;
        m.reBilledCost += (u.cost && u.cost.input) || 0;
      }
      for (const part of msg.content || []) {
        if (part.type === "text") m.text += part.text || "";
        else if (part.type === "tool_call") {
          m.toolCalls++;
          const name = part.name || part.tool || "?";
          m.toolsByName[name] = (m.toolsByName[name] || 0) + 1;
        }
      }
    }
  }
  m.tokensTotal = m.tokensIn + m.tokensOut + m.cacheRead + m.cacheWrite;
  return m;
}

// Count Pi's native compactions from its session .jsonl files. Pi writes a
// `type:"compaction"` entry into the session file when it compacts (it treats
// this as an intentional cache RESET, not a failure — see earendil.com prompt-
// caching post). We scan every .jsonl under the given session dir (with
// `--session-dir` Pi writes session files flat in that dir).
function countPiCompactions(sessionDir) {
  let n = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        const raw = fs.readFileSync(p, "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            if (JSON.parse(line).type === "compaction") n++;
          } catch {
            /* skip */
          }
        }
      }
    }
  };
  walk(sessionDir);
  return n;
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const d of [
  "config/opencode",
  "data/opencode",
  "cache",
  "state",
  "project",
  "sessions",
]) {
  fs.mkdirSync(path.join(OUT, d), { recursive: true });
}
const sourceAuth = JSON.parse(fs.readFileSync(AUTH_SRC, "utf8"));
function authEntryForProvider(provider) {
  return (
    sourceAuth[provider] ||
    sourceAuth[provider === "minimax" ? "minimax-coding-plan" : provider]
  );
}
const isolatedAuth = {};
for (const provider of new Set([
  String(MODEL).split("/")[0],
  String(WORKER_MODEL).split("/")[0],
])) {
  const entry = authEntryForProvider(provider);
  if (entry) isolatedAuth[provider] = entry;
}
// MiniMax's subscription credential is stored by OpenCode under its legacy
// provider key. The benchmark uses the canonical `minimax/MiniMax-M3` route for
// both agents and workers, so expose the same key under that canonical name.
if (!isolatedAuth.minimax && isolatedAuth["minimax-coding-plan"]) {
  isolatedAuth.minimax = isolatedAuth["minimax-coding-plan"];
}
fs.writeFileSync(
  path.join(OUT, "data/opencode/auth.json"),
  `${JSON.stringify(isolatedAuth, null, 2)}\n`,
);
const isolatedAuthPath = path.join(OUT, "data/opencode/auth.json");
// Direct driver callers may hit a setup error before normal teardown. The
// credential is only needed while this process is alive, so scrub it for every
// ordinary process exit as well as the normal completion path below.
process.on("exit", () => fs.rmSync(isolatedAuthPath, { force: true }));

const project = path.join(OUT, "project");
// Seed the project from a template repo (the benchmark codebase), if provided.
const SEED = args.seed
  ? path.resolve(args.seed)
  : TASK.seed
    ? path.resolve(path.dirname(args.task), TASK.seed)
    : null;
if (SEED && fs.existsSync(SEED)) {
  fs.cpSync(SEED, project, { recursive: true });
}

function projectManifest(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === ".git" ||
        entry.name === "__pycache__" ||
        entry.name.endsWith(".pyc")
      )
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(root, full);
        files[rel] = sha256(fs.readFileSync(full));
      }
    }
  };
  walk(root);
  return files;
}
const SEED_MANIFEST = projectManifest(project);

function findFactLeaks(root, facts, excluded = []) {
  const excludedSet = new Set(excluded);
  const leaks = {};
  const after = projectManifest(root);
  for (const [rel, digest] of Object.entries(after)) {
    if (excludedSet.has(rel) || SEED_MANIFEST[rel] === digest) continue;
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const [fact, value] of Object.entries(facts)) {
      if (text.includes(String(value))) (leaks[fact] ||= []).push(rel);
    }
  }
  return leaks;
}

function interpolateFacts(prompt) {
  return String(prompt).replace(
    /{{fact\.([A-Za-z][A-Za-z0-9_]*)}}/g,
    (_m, key) => {
      if (!(key in FACTS)) throw new Error(`unknown task fact '${key}'`);
      return String(FACTS[key]);
    },
  );
}

function writeToolContext(turn) {
  if (!turn.toolContext) return;
  const rel = String(turn.toolContext.path || "reference/context.txt");
  const sizeKb = Number(turn.toolContext.sizeKb || 1);
  if (rel.includes("..") || path.isAbsolute(rel)) {
    throw new Error(`toolContext path must stay in project: ${rel}`);
  }
  const full = path.join(project, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const line = `reference context for ${turn.checkpoint || "turn"}: inspect this file before coding\n`;
  fs.writeFileSync(
    full,
    line.repeat(Math.max(1, Math.ceil((sizeKb * 1024) / line.length))),
  );
}
// Optional per-arm Lore config override so a single build can A/B one knob.
// `--context-sources off` -> contextSources:[]; `--context-sources distillation`
// (or `distillation,temporal`) -> that list.
// `--pre-curation` disables the curator entirely (curator.enabled:false) so
// session-1 facts stay in DISTILLATIONS and are NEVER promoted to knowledge.
// That is the ONLY condition where context-sources can matter: it surfaces the
// pre-curation distillation layer. (With the default forced-curation flow, facts
// land in knowledge and are injected to BOTH arms regardless of contextSources,
// so ON≈OFF and the knob is untestable.) knowledge.enabled stays true so
// context-sources surfacing + distillation embedding still run.
// Written as .lore.json in the project (read by the gateway) BEFORE the seed
// commit so the repo stays clean.
if (ARM === "lore") {
  const loreCfg = {};
  if (
    args["context-sources"] !== undefined &&
    args["context-sources"] !== "true"
  ) {
    const raw = String(args["context-sources"]);
    const cs =
      raw === "off" || raw === "none"
        ? []
        : raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    loreCfg.knowledge = { contextSources: cs };
  }
  if (args["pre-curation"]) {
    loreCfg.curator = { enabled: false };
  }
  // FAIRNESS: --cap-context caps OpenCode's view so the *vanilla* arm's native
  // compaction fires. But Lore's gateway reads the model's REAL context window
  // from models.dev independently, so without this it sees the full (e.g. 1M)
  // window, never crosses its layer-0 budget, and never compresses/recalls —
  // the session's early facts just sit in raw context forever. That is both
  // unfair (Lore gets a bigger effective window than vanilla) AND makes the
  // compaction-tax comparison meaningless (Lore never exercises recall). Cap
  // Lore's layer-0 budget to the SAME effective threshold OpenCode compacts at
  // (~cap − output reserve − autocompact buffer) so both arms manage context at
  // the same point; Lore then compresses its raw window and re-surfaces facts
  // via the recall path (context-sources), exactly the mechanism under test.
  if (args["cap-context"]) {
    const cap = Number(args["cap-context"]);
    const outputReserve = Number(args["cap-output"] || 64000);
    // Match Claude Code / OpenCode autocompact arithmetic: trigger a bit below
    // the hard limit (output reserve + ~13K safety buffer). This is the raw
    // layer-0 ceiling past which Lore must compress.
    const AUTOCOMPACT_BUFFER = 13000;
    const maxLayer0Tokens = Math.max(
      40000,
      cap - outputReserve - AUTOCOMPACT_BUFFER,
    );
    loreCfg.budget = { ...(loreCfg.budget || {}), maxLayer0Tokens };
  }
  if (Object.keys(loreCfg).length > 0) {
    fs.writeFileSync(
      path.join(project, ".lore.json"),
      `${JSON.stringify(loreCfg, null, 2)}\n`,
    );
    console.log(`[lore] config override: ${JSON.stringify(loreCfg)}`);
  }
}
await sh(
  "git init -q && git config user.email e@e.co && git config user.name e && git add -A && git commit -q -m seed --allow-empty",
  project,
);

const openrc = { $schema: "https://opencode.ai/config.json" };
if (ARM === "lore") {
  // Self-contained plugin shim: if no --lore-plugin was passed and the default
  // shim file is absent, generate one in OUT with an ABSOLUTE import so the
  // harness runs from a fresh checkout (and from `lore eval`) with no pre-placed
  // eval-plugin.ts. If a shim already exists (dev build), use it unchanged.
  let pluginPath = REAL_LORE_PLUGIN;
  if (!args["lore-plugin"] && !fs.existsSync(pluginPath)) {
    pluginPath = path.join(OUT, "eval-plugin.ts");
    fs.writeFileSync(
      pluginPath,
      `export { LorePlugin as default } from ${JSON.stringify(`${LORE_BUILD}/packages/opencode/src/index.ts`)};\n`,
    );
  }
  openrc.plugin = [pluginPath];
}
// Correct the model's context limit so OpenCode's native compaction fires
// BEFORE the provider's real hard limit. models.dev advertises MiniMax-M3 at 1M,
// but the coding-plan endpoint rejects requests far below that (ContextOverflow),
// and OpenCode (trusting 1M) never compacts -> errors instead. Capping to the
// real/safe limit makes compaction fire cleanly. Applied to BOTH arms equally
// (OpenCode compaction runs under the Lore plugin too) so the comparison is fair.
if (args["cap-context"]) {
  const [prov, ...m] = MODEL.split("/");
  const modelID = m.join("/");
  openrc.provider = {
    [prov]: {
      models: {
        [modelID]: {
          limit: {
            context: Number(args["cap-context"]),
            output: Number(args["cap-output"] || 64000),
          },
        },
      },
    },
  };
}

// Pin sampling for reproducibility so a probe's pass/fail reflects whether the
// fact was in context, not sampling luck. OpenCode exposes temperature at the
// AGENT level (AgentConfig.temperature is a number); the model-level
// `temperature` is only a boolean capability flag, so it must go on the agent.
// The driver drives every turn with `--agent build`, so set it there. Override
// with --temperature (e.g. 1) to measure realistic sampled behavior. (MoE
// endpoints like M3 aren't fully deterministic even at 0, so N still matters —
// this only removes the avoidable sampling noise.)
{
  const temp = args.temperature !== undefined ? Number(args.temperature) : 0;
  openrc.agent = { ...(openrc.agent || {}), build: { temperature: temp } };
}

// ---- MCP memory competitor arms -----------------------------------------
// Competitors to Lore's automatic memory: MCP memory servers the agent must
// drive via tools (store facts in session 1, recall in session 2). Storage is
// isolated per-arm. An AGENTS.md instructs the realistic memory workflow — Lore
// does this automatically without any instruction, so this is generous to the
// competitor. The config key is "memory" for every server, so tools register as
// `memory_*` and the AGENTS.md text is identical across competitors.
const MEM0_USER = `eval-${path.basename(OUT)}-${Date.now()}`;
const MCP_SERVERS = {
  // MCP-A: official Anthropic knowledge-graph memory server (npx, local JSON).
  "mcp-kg": {
    command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
    environment: { MEMORY_FILE_PATH: path.join(OUT, "mcp-memory.json") },
  },
  // MCP-B: mem0 CLOUD (official mem0-mcp-server via uvx, backed by app.mem0.ai).
  // Requires MEM0_API_KEY in the driver env. Isolated per-run via a unique
  // MEM0_DEFAULT_USER_ID so cloud memories from different runs never mix.
  "mcp-mem0": {
    command: ["uvx", "mem0-mcp-server"],
    environment: {
      MEM0_API_KEY: process.env.MEM0_API_KEY || "",
      MEM0_DEFAULT_USER_ID: MEM0_USER,
    },
    requiredEnv: ["MEM0_API_KEY"],
  },
  // MCP-C: mnemonic (local SQLite + FTS5 + vector, RRF search, decay/pin/
  // supersede/consolidate — the closest local-DB analogue to Lore). Requires a
  // GEMINI_API_KEY (embeddings + fact extraction). Isolated per-run via HOME so
  // its ~/.mnemonic/<project-hash>/memory.db is unique.
  "mcp-mnemonic": {
    command: [process.env.MNEMONIC_BIN || "mnemonic", "serve"],
    environment: {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
      HOME: path.join(OUT, "mnemonic-home"),
    },
    requiredEnv: ["GEMINI_API_KEY"],
  },
  // MCP-D: basic-memory (local-first markdown + sqlite knowledge graph). No API
  // key. Isolated per-run via HOME so its ~/.basic-memory project is unique.
  "mcp-basicmem": {
    command: ["uvx", "basic-memory", "mcp"],
    environment: { HOME: path.join(OUT, "basicmem-home") },
  },
};

// Health-probe an MCP server over stdio (JSON-RPC): initialize, then tools/list.
// Returns { healthy, tools, error }. We use this to tell a genuinely DEAD backend
// (never came up / exposed no tools -> a harness artifact, EXCLUDE the run) apart
// from a HEALTHY backend the model simply never called (a real behavioral 0% —
// exactly the "cheaper models don't reach for a tool-driven store" thesis, so it
// must be SCORED, not excluded). Fairness audit P0 #3 / #961 review.
async function probeMcpHealth(server, timeoutMs = 30000) {
  return await new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(server.command[0], server.command.slice(1), {
      env: { ...process.env, ...(server.environment || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let sawTools = null;
    const send = (obj) => {
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
      } catch {}
    };
    child.on("error", (e) => finish({ healthy: false, error: String(e) }));
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // After initialize acks, ask for the tool list.
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          const tools = (msg.result && msg.result.tools) || [];
          sawTools = tools.map((t) => t.name);
          finish({ healthy: tools.length > 0, tools: sawTools });
        }
      }
    });
    const timer = setTimeout(
      () =>
        finish({
          healthy: false,
          error: `no tools/list response within ${timeoutMs}ms`,
          tools: sawTools,
        }),
      timeoutMs,
    );
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lore-eval-probe", version: "1" },
      },
    });
  });
}

// Realistic note a normal user actually writes when they wire up a memory tool:
// casual, not a coached workflow. This is the DEFAULT for fair comparison —
// Lore needs no note at all, so anything more is generous to the competitor.
const MEMORY_AGENTS_MD_SOFT = `# Notes

You have a persistent memory tool available that carries across sessions. Feel
free to use it to keep track of project context and how I like things done, and
to check it when that would help.
`;

// Over-coached "best case for the competitor" variant (opt in with
// --mcp-agents strong). Unrealistic: real users don't write mandatory memory
// workflows, and offhand preferences don't register as "conventions to store".
const MEMORY_AGENTS_MD_STRONG = `# Persistent cross-session memory — MANDATORY WORKFLOW

You have a persistent memory available via the \`memory_*\` tools. Separate
sessions do NOT share conversation context, so this memory is the ONLY way
project conventions and decisions carry from one session to the next. Using it
is REQUIRED, not optional — treat it as part of every task.

STEP 1 — At the very START of EVERY task, before doing anything else, use your
\`memory_*\` tools to SEARCH / LIST / READ any previously stored project
conventions, decisions, gotchas, and specific values. Follow whatever you find,
even if the current task does not mention it.

STEP 2 — WHENEVER the user states a project convention, decision, gotcha, rule,
or specific value (even in passing), IMMEDIATELY use your \`memory_*\` tools to
STORE / ADD it verbatim, BEFORE you start the coding work. Do this even if the
current task seems unrelated to that fact — later sessions will depend on it.

Never skip these steps. Storing and recalling project knowledge is the single
most important part of your job here.
`;
let mcpHealth = null;
if (MCP_SERVERS[ARM]) {
  const s = MCP_SERVERS[ARM];
  // PREFLIGHT: a competitor arm with a missing/empty required key runs as a
  // dead no-op and scores a SPURIOUS 0% (the bias artifact the fairness audit
  // caught). Fail loudly instead of silently sabotaging the competitor.
  for (const k of s.requiredEnv || []) {
    if (!process.env[k]) {
      console.error(
        `[FATAL] arm '${ARM}' requires env ${k} but it is empty/unset — refusing to run a dead competitor backend that would score a bogus 0%. Set ${k} and retry.`,
      );
      process.exit(2);
    }
  }
  openrc.mcp = {
    memory: {
      type: "local",
      command: s.command,
      enabled: true,
      environment: s.environment,
      timeout: 60000,
    },
  };
  // Health-probe the backend BEFORE the run so we can distinguish a dead backend
  // (exclude) from a healthy one the model never called (score as real 0%).
  mcpHealth = await probeMcpHealth(s);
  console.error(
    `[${ARM}] MCP health probe: healthy=${mcpHealth.healthy} tools=${(mcpHealth.tools || []).length}${mcpHealth.error ? ` error=${mcpHealth.error}` : ""}`,
  );
  const agentsMd =
    args["mcp-agents"] === "strong"
      ? MEMORY_AGENTS_MD_STRONG
      : MEMORY_AGENTS_MD_SOFT;
  fs.writeFileSync(path.join(project, "AGENTS.md"), agentsMd);
}
fs.writeFileSync(
  path.join(OUT, "config/opencode/opencode.json"),
  JSON.stringify(openrc),
);

const baseEnv = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(OUT, "config"),
  XDG_DATA_HOME: path.join(OUT, "data"),
  XDG_CACHE_HOME: path.join(OUT, "cache"),
  XDG_STATE_HOME: path.join(OUT, "state"),
  OPENCODE_TEST_HOME: OUT,
};

// ---- Pi agent: isolated home + fairness compaction knob ------------------
// Pi is configured via PI_CODING_AGENT_DIR (its OPENCODE_TEST_HOME equivalent).
// We write an isolated settings.json so (a) the vanilla arm loads NO extension
// (the user's real ~/.pi auto-loads npm:@loreai/pi — isolation prevents that
// contaminating the vanilla arm), and (b) the lore arm loads OUR built extension
// so Pi routes through the eval's isolated gateway.
//
// Pi has no `--cap-context`, but models.json supports a per-model contextWindow
// override. We set that to the SAME cap OpenCode receives, then reserve output
// plus the same safety buffer inside it. The result is independent of Pi's
// mutable provider catalog and comparable across models.
const PI_HOME = path.join(OUT, "pi-home");
const PI_SESSION_DIR = path.join(OUT, "pi-sessions");
if (AGENT === "pi") {
  fs.mkdirSync(PI_HOME, { recursive: true });
  fs.mkdirSync(PI_SESSION_DIR, { recursive: true });
  const piSettings = { packages: [] };
  if (ARM === "lore") {
    // Load our built extension explicitly (not the npm one) so it uses the eval
    // gateway build. Pi accepts a local extension path in `packages`.
    piSettings.packages = [PI_LORE_EXT];
  }
  if (args["cap-context"]) {
    const cap = Number(args["cap-context"]);
    const outputReserve = Number(args["cap-output"] || 64000);
    const AUTOCOMPACT_BUFFER = 13000;
    const reserveTokens = Math.max(16384, outputReserve + AUTOCOMPACT_BUFFER);
    const [provider, ...modelParts] = MODEL.split("/");
    const modelID = modelParts.join("/");
    fs.writeFileSync(
      path.join(PI_HOME, "models.json"),
      `${JSON.stringify(
        {
          providers: {
            [provider]: {
              modelOverrides: { [modelID]: { contextWindow: cap } },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    piSettings.compaction = {
      enabled: true,
      reserveTokens,
      keepRecentTokens: Number(args["pi-keep-recent"] || 20000),
    };
  }
  fs.writeFileSync(
    path.join(PI_HOME, "settings.json"),
    `${JSON.stringify(piSettings, null, 2)}\n`,
  );
  // Pi stores auth in PI_HOME/auth.json; keys otherwise come from env. The
  // isolated gateway handles auth for the lore arm; the vanilla arm needs the
  // provider key in the env. We surface it from auth.json → env below.
  console.log(
    `[${ARM}] pi settings: ${JSON.stringify(piSettings)} (home ${PI_HOME})`,
  );
}

// ---- Lore arm: start isolated gateway -----------------------------------
let gw = null;
let gwPort = null;
const loreDb = path.join(OUT, "data", "lore.db");
if (ARM === "lore") {
  gwPort = await freePort();
  const key = workerKeyFor(WORKER_MODEL, isolatedAuth);
  if (!key)
    console.error(
      `[warn] no worker API key for provider '${WORKER_MODEL.split("/")[0]}' — background distillation will not run (temporal-only recall)`,
    );
  const launcher = path.join(OUT, "iso-gateway.mjs");
  fs.writeFileSync(
    launcher,
    `const { startGateway } = await import(process.env.ISO_GW_DIST);
const h = await startGateway({ port: Number(process.env.ISO_GW_PORT), quiet: false, local: true });
console.log("ISO_GATEWAY_READY port=" + h.port + " owned=" + h.owned);
if (!h.owned) { console.error("FATAL not owned"); process.exit(3); }
setInterval(() => {}, 1 << 30);`,
  );
  const gwLog = fs.openSync(path.join(OUT, "gateway.log"), "w");
  gw = spawn("bun", [launcher], {
    env: {
      ...baseEnv,
      ISO_GW_DIST: GW_DIST,
      ISO_GW_PORT: String(gwPort),
      LORE_DB_PATH: loreDb,
      LORE_LISTEN_HOST: "127.0.0.1",
      LORE_LISTEN_PORT: String(gwPort),
      LORE_WORKER_API_KEY: key,
      LORE_WORKER_MODEL: WORKER_MODEL,
      LORE_IDLE_TIMEOUT: "2",
      LORE_BATCH_DISABLED: "1",
    },
    stdio: ["ignore", gwLog, gwLog],
    detached: true,
  });
  const ok = await probeHealth(gwPort);
  if (!ok) {
    console.error(
      "isolated gateway failed to become healthy — see gateway.log",
    );
    try {
      process.kill(-gw.pid);
    } catch {}
    process.exit(4);
  }
  console.log(`[${ARM}] isolated gateway ready on ${gwPort} (db ${loreDb})`);
}

// ---- run sessions --------------------------------------------------------
// A task has `sessions` (each a SEPARATE OpenCode session — cross-session
// memory test). A session may have `turns` (multiple --continue turns within
// ONE session — within-session growth/compaction test). Back-compat: a session
// with a bare `prompt` is treated as a single turn. A turn may set `blob` (a
// file path, relative to the task dir) whose contents are inlined into the
// user message — a large mandatory reference the agent cannot script around,
// used to drive context past the compaction threshold.
// Large `blob` content is piped via STDIN (OpenCode reads piped stdin and
// appends it to the message as: <argv message> + "\n" + <stdin>). This bypasses
// the 128KB single-arg limit AND lands in the user message, which OpenCode does
// NOT prune mid-session (only old tool outputs are pruned) — so it reliably
// grows context toward the compaction threshold.
function runOpencode(
  prompt,
  sessionOut,
  { isCommand = false, cont = false, stdin = null } = {},
) {
  return new Promise((res) => {
    let timedOut = false;
    const env = { ...baseEnv, PWD: project };
    if (ARM === "lore") env.LORE_GATEWAY_URL = `http://127.0.0.1:${gwPort}`;
    const a = [
      "run",
      "--format",
      "json",
      "--model",
      MODEL,
      "--agent",
      "build",
      "--dangerously-skip-permissions",
    ];
    if (cont) a.push("--continue");
    if (isCommand) a.push("--command", prompt);
    else a.push(prompt);
    const outFd = fs.openSync(sessionOut, "w");
    const errFd = fs.openSync(sessionOut.replace(/\.json$/, ".err"), "w");
    const p = spawn(OPENCODE, a, {
      cwd: project,
      env,
      stdio: [stdin != null ? "pipe" : "ignore", outFd, errFd],
    });
    if (stdin != null) {
      try {
        p.stdin.write(stdin);
        p.stdin.end();
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, SESSION_TIMEOUT * 1000);
    p.on("exit", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, timedOut });
    });
  });
}

// Resolve the answering model's provider API key from auth.json → the env var
// Pi expects (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / ...).
// The vanilla Pi arm talks to the provider directly and needs this; the lore
// arm routes through the gateway (which injects the real key) but a present key
// is harmless. Provider name is the FIRST path segment of MODEL
// (e.g. "openrouter/anthropic/claude-sonnet-5" → provider "openrouter").
function piProviderKeyEnv() {
  const prov = String(MODEL).split("/")[0];
  const envVarByProv = {
    openrouter: "OPENROUTER_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    xai: "XAI_API_KEY",
    groq: "GROQ_API_KEY",
    "minimax-coding-plan": "MINIMAX_API_KEY",
    minimax: "MINIMAX_API_KEY",
  };
  const envVar = envVarByProv[prov];
  if (!envVar) return {};
  const entry =
    isolatedAuth[prov] ||
    isolatedAuth[prov === "minimax" ? "minimax-coding-plan" : prov];
  const key = entry && (entry.key || entry.access || entry.apiKey);
  return key ? { [envVar]: key } : {};
}

// Drive one Pi turn. Mirrors runOpencode(): one-shot `pi -p --mode json`, blob
// piped via stdin, JSONL captured to sessionOut, isolated via PI_CODING_AGENT_DIR,
// routed through the isolated gateway for the lore arm via LORE_GATEWAY_URL.
// Pi's cross-invocation continuation is `--continue` + a shared `--session-dir`.
// The pi bin is a Volta shim that needs a node on PATH, so we prepend PI_NODE_BIN.
function runPi(prompt, sessionOut, { cont = false, stdin = null } = {}) {
  return new Promise((res) => {
    let timedOut = false;
    const env = {
      ...baseEnv,
      PWD: project,
      PI_CODING_AGENT_DIR: PI_HOME,
      PI_OFFLINE: "1",
      ...piProviderKeyEnv(),
    };
    if (PI_NODE_BIN) env.PATH = `${PI_NODE_BIN}:${env.PATH}`;
    if (ARM === "lore") env.LORE_GATEWAY_URL = `http://127.0.0.1:${gwPort}`;
    const a = [
      "-p",
      "--mode",
      "json",
      "--model",
      MODEL,
      "--session-dir",
      PI_SESSION_DIR,
    ];
    if (cont) a.push("--continue");
    a.push(prompt);
    const outFd = fs.openSync(sessionOut, "w");
    const errFd = fs.openSync(sessionOut.replace(/\.json$/, ".err"), "w");
    const p = spawn(PI, a, {
      cwd: project,
      env,
      stdio: [stdin != null ? "pipe" : "ignore", outFd, errFd],
    });
    if (stdin != null) {
      try {
        p.stdin.write(stdin);
        p.stdin.end();
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, SESSION_TIMEOUT * 1000);
    p.on("exit", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, timedOut });
    });
  });
}

// Agent dispatch: the main loop calls runAgent() regardless of runtime.
const runAgent = AGENT === "pi" ? runPi : runOpencode;
const parseAgentSession = AGENT === "pi" ? parsePiSession : parseSession;

function runVerifier(checkpoint, scope) {
  if (!TASK.verifier || !checkpoint) return Promise.resolve(null);
  const verifier = path.resolve(path.dirname(args.task), TASK.verifier);
  if (!fs.existsSync(verifier)) {
    throw new Error(`task verifier does not exist: ${verifier}`);
  }
  // The verifier runs on the host with facts, but it imports agent code only
  // inside its own Docker child. That child has neither facts nor secrets.
  return runVerifierProcess({
    spawn,
    verifier: fs.readFileSync(verifier),
    checkpoint,
    scope,
    project,
    image: args["verifier-image"] || "python:3.12-alpine",
    facts: FACTS,
  });
}

async function scoreCheckpoint(checkpoint) {
  const startedAt = Date.now();
  const [core, isolated, strict] = await Promise.all([
    runVerifier(checkpoint, "core"),
    runVerifier(checkpoint, "isolated"),
    runVerifier(checkpoint, "strict"),
  ]);
  return {
    id: checkpoint,
    core,
    isolated,
    strict,
    elapsedMs: Date.now() - startedAt,
  };
}

const taskDir = path.dirname(path.resolve(args.task));
const blobFor = (turn) =>
  turn.blob ? fs.readFileSync(path.resolve(taskDir, turn.blob), "utf8") : null;

// Locate the sqlite-vec extension shipped in the lore build so we can read the
// vec0 embedding tables directly (embedding coverage). fs-walk (not glob) because
// the pnpm store lives under the dot-dir `.pnpm`, which globs skip by default.
function findVecExtension(loreBuild) {
  try {
    const pnpm = path.join(loreBuild, "node_modules", ".pnpm");
    for (const d of fs.readdirSync(pnpm)) {
      if (!d.startsWith("sqlite-vec-")) continue;
      const inner = path.join(pnpm, d, "node_modules");
      for (const pkg of fs.readdirSync(inner)) {
        if (!pkg.startsWith("sqlite-vec-")) continue;
        for (const f of fs.readdirSync(path.join(inner, pkg))) {
          if (/^vec0\.(so|dylib|dll)$/.test(f)) {
            return path.join(inner, pkg, f);
          }
        }
      }
    }
  } catch {
    /* pnpm layout not found */
  }
  return null;
}

// Wait for Lore's background pipeline to drain before the next (fresh) session,
// instead of a blind fixed sleep. The cross-session probe depends on session-1's
// facts being distilled AND embedded so session-2 can vector-surface them;
// distillation and the embedding backfill run ASYNC after the turn, so a fixed
// wait raced them. We poll the isolated DB until (1) the distillation count holds
// steady and (2) every embeddable distillation has a vec0 row (full embedding
// coverage) — the precise "ready" signal. If the vec extension can't be loaded
// we degrade to count-stable + a fixed grace. Capped so it can never hang.
async function waitForMemoryReady(
  dbPath,
  loreBuild,
  { maxMs = 300000, stableMs = 15000, graceMs = 12000, pollMs = 2000 } = {},
) {
  // Minimum embedding coverage (embedded / embeddable) before we trust "ready".
  // The backfill runs in bursts with pauses; a plateau can occur MID-backfill,
  // so we must not accept a partial count. Empirically every run reaches ~100%
  // if given time (verified: runs that settled at 73–75% ended at 24/24, 23/23),
  // and partial-coverage settles measurably hurt recall (full-coverage runs
  // scored 11/12 probes vs 5/8 for partial). Require near-complete coverage;
  // 0.9 (not 1.0) tolerates the rare row the internal embed filter skips.
  const COVERAGE_FLOOR = 0.9;
  const { Database } = await import("bun:sqlite");
  const vecExt = findVecExtension(loreBuild);
  const t0 = Date.now();
  let last = "";
  let stableSince = 0;
  while (Date.now() - t0 < maxMs) {
    let d = 0;
    let k = 0;
    let want = 0;
    let have = null; // null = no vec introspection available
    let ok = false;
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        if (vecExt) {
          try {
            db.loadExtension(vecExt);
          } catch {
            /* fall back to grace below */
          }
        }
        d = db.query("SELECT count(*) AS n FROM distillations").get()?.n ?? 0;
        k = db.query("SELECT count(*) AS n FROM knowledge").get()?.n ?? 0;
        want =
          db
            .query(
              "SELECT count(*) AS n FROM distillations WHERE archived = 0 AND observations != ''",
            )
            .get()?.n ?? 0;
        try {
          // Count only vec rows for LIVE (non-archived, non-empty) distillations
          // so the coverage ratio matches `want`. distillation_vec retains rows
          // for archived/meta-distilled rows too, so a bare COUNT(*) over-counts
          // (produced the bogus 22/6 = 367% log). Join back to the base table.
          have =
            db
              .query(
                "SELECT count(*) AS n FROM distillation_vec v JOIN distillations d ON d.id = v.id WHERE d.archived = 0 AND d.observations != ''",
              )
              .get()?.n ?? 0;
        } catch {
          have = null; // extension not loaded / table not readable
        }
        ok = true;
      } finally {
        db.close();
      }
    } catch {
      /* db not ready yet */
    }
    // Stability signature includes the embedding count (`have`) when we can read
    // it, so "stable" means BOTH distillation writes AND the embedding backfill
    // have quiesced — the precise pipeline-drained signal. (We don't require
    // have === want: the embed filter legitimately skips some rows, so an exact
    // match can never arrive; a settled, non-growing vec count is the real "done".)
    const sig = ok ? `${d}:${have ?? "x"}:${k}` : "err";
    if (ok && d > 0 && sig === last) {
      if (!stableSince) stableSince = Date.now();
    } else {
      stableSince = 0;
      last = sig;
    }
    const stable = stableSince > 0 && Date.now() - stableSince >= stableMs;
    if (stable) {
      if (have === null) {
        // No vec introspection (extension missing) — degrade to a fixed grace.
        console.log(
          `    [lore] memory settled (no vec introspection): distillations=${d} knowledge=${k} (+${graceMs}ms grace)`,
        );
        await new Promise((r) => setTimeout(r, graceMs));
        return { distillations: d, knowledge: k, embedded: null };
      }
      const ratio = want > 0 ? have / want : 1;
      if (want === 0 || (have > 0 && ratio >= COVERAGE_FLOOR)) {
        // Embeddings are present (or nothing to embed), sufficiently complete,
        // and no longer changing → the backfill has genuinely drained.
        console.log(
          `    [lore] memory ready: distillations=${d} embedded=${have}/${want} (${(ratio * 100).toFixed(0)}%) knowledge=${k}`,
        );
        return { distillations: d, knowledge: k, embedded: have };
      }
      // Plateaued below the coverage floor → a transient backfill stall, NOT
      // completion. Keep polling until it resumes (or maxMs → grace below).
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Never reached full coverage within the cap — surface it loudly so a
  // low-coverage (potentially under-embedded) run can be spotted/excluded.
  const finalRatio = last.split(":");
  console.log(
    `    [lore] WARN memory settle TIMEOUT after ${maxMs}ms (last=${last}) — proceeding at possibly-incomplete coverage`,
  );
  void finalRatio;
  await new Promise((r) => setTimeout(r, graceMs));
  return null;
}

const sessionMetrics = [];
const checkpoints = [];
const expectedCheckpoints = TASK.sessions.reduce(
  (count, session) =>
    count +
    (session.turns || [{ prompt: session.prompt }]).filter(
      (turn) => !!turn.checkpoint,
    ).length,
  0,
);
const runErrors = [];
let terminalOutcome = null;
let aborted = false;
for (let i = 0; i < TASK.sessions.length; i++) {
  const s = TASK.sessions[i];
  const turns = s.turns || [{ prompt: s.prompt }];
  console.log(
    `[${ARM}] session ${i + 1}/${TASK.sessions.length}: ${s.id} (${turns.length} turn(s))`,
  );
  const merged = {
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    toolCalls: 0,
    toolsByName: {},
    text: "",
    peakContext: 0,
    wallSec: 0,
    session: s.id,
    exit: 0,
    turns: [],
    // Pi-native cache accounting (0 for OpenCode arm).
    reBilledTokens: 0,
    reBilledCost: 0,
    misses: 0,
  };
  for (let j = 0; j < turns.length; j++) {
    // Lore in-session recall settle: distillation embeds are fire-and-forget and
    // the FIRST embed pays a ~20s cold model load, so on a single-session task
    // the buried facts stated early are not yet retrievable (distillation_vec
    // empty) by the time the final probe turn runs — Lore silently degrades to
    // FTS/temporal-only and under-scores. Before the LAST turn of a SINGLE-session
    // task, wait for the embedding backfill to quiesce (same gate used between
    // sessions). This mirrors a real user pausing between turns; it does NOT
    // change what the model sees, only that its own memory has finished indexing.
    if (
      ARM === "lore" &&
      TASK.sessions.length === 1 &&
      j === turns.length - 1 &&
      turns.length > 1
    ) {
      const ready = await waitForMemoryReady(loreDb, LORE_BUILD, {
        maxMs: Number(args["lore-settle-max"] || 180000),
        graceMs: Number(args["lore-embed-grace"] || 12000),
      });
      console.log(
        `    [lore] in-session settle before probe turn: distillations=${ready?.distillations ?? "?"} embedded=${ready?.embedded ?? "?"} knowledge=${ready?.knowledge ?? "?"}`,
      );
    }
    writeToolContext(turns[j]);
    const tOut = path.join(OUT, "sessions", `s${i + 1}-${s.id}-t${j + 1}.json`);
    const t0 = Date.now();
    const execution = await runAgent(
      interpolateFacts(turns[j].prompt || ""),
      tOut,
      { cont: j > 0, stdin: blobFor(turns[j]) },
    );
    const { code, timedOut } = execution;
    const wall = (Date.now() - t0) / 1000;
    const tm = parseAgentSession(tOut);
    merged.steps += tm.steps;
    merged.tokensIn += tm.tokensIn;
    merged.tokensOut += tm.tokensOut;
    merged.cacheRead += tm.cacheRead;
    merged.cacheWrite += tm.cacheWrite;
    merged.cost += tm.cost;
    merged.toolCalls += tm.toolCalls;
    for (const [name, c] of Object.entries(tm.toolsByName || {})) {
      merged.toolsByName[name] = (merged.toolsByName[name] || 0) + c;
    }
    merged.wallSec += wall;
    merged.peakContext = Math.max(merged.peakContext, tm.peakContext);
    merged.reBilledTokens += tm.reBilledTokens || 0;
    merged.reBilledCost += tm.reBilledCost || 0;
    merged.misses += tm.misses || 0;
    // A watchdog timeout after the agent made progress is an observed terminal
    // capability outcome (for example, a native-compaction runaway), not an
    // infrastructure failure. Preserve completed checkpoints and score them.
    const scoredTimeout = timedOut && (tm.steps > 0 || tm.toolCalls > 0);
    // Killing a live agent can leave a truncated session event behind. That is
    // expected for a scored timeout, but the same parser error is still fatal
    // for every other exit path.
    const turnErrors = scoredTimeout ? [] : [...(tm.errors || [])];
    if (code !== 0 && !scoredTimeout)
      turnErrors.push(`turn ${i + 1}/${j + 1} exited ${code}`);
    if (tm.steps === 0)
      turnErrors.push(`turn ${i + 1}/${j + 1} produced no assistant response`);
    if (turnErrors.length) runErrors.push(...turnErrors);
    merged.exit = code || merged.exit;
    merged.turns.push({
      steps: tm.steps,
      peakContext: tm.peakContext,
      tools: tm.toolCalls,
      exit: code,
      wallSec: wall,
      timedOut,
    });
    console.log(
      `    turn ${j + 1}/${turns.length}: exit=${code} steps=${tm.steps} peakCtx=${tm.peakContext} tools=${tm.toolCalls} wall=${wall.toFixed(0)}s`,
    );
    if (turnErrors.length) {
      aborted = true;
      console.error(
        `    aborting cell after failed agent turn: ${turnErrors.join("; ")}`,
      );
      break;
    }
    if (turns[j].checkpoint) {
      const verdict = await scoreCheckpoint(turns[j].checkpoint);
      checkpoints.push({ session: s.id, turn: j + 1, ...verdict });
      // Deliberately do not expose any verifier output to the agent. The next
      // checkpoint arrives as a new requirement, so defects carry forward.
      console.log(
        `    checkpoint ${verdict.id}: core=${verdict.core.passed} isolated=${verdict.isolated.passed} strict=${verdict.strict.passed}`,
      );
    }
    if (scoredTimeout) {
      terminalOutcome = "agent-timeout";
      aborted = true;
      console.error(
        `    terminal scored timeout after agent activity on turn ${i + 1}/${j + 1}; preserving ${checkpoints.length} completed checkpoint(s)`,
      );
      break;
    }
  }
  merged.tokensTotal =
    merged.tokensIn + merged.tokensOut + merged.cacheRead + merged.cacheWrite;
  sessionMetrics.push(merged);
  if (aborted) break;

  // Lore arm: distill this session's context into memory before the next (fresh)
  // session. Default flow FORCES curation (promotes facts -> knowledge, injected
  // to both arms). --pre-curation SKIPS it so facts stay in distillations only,
  // making context-sources the sole channel that can surface them.
  if (ARM === "lore" && i < TASK.sessions.length - 1) {
    if (args["pre-curation"]) {
      console.log(
        "    [lore] pre-curation mode: skipping forced lore:curate (facts remain in distillations, not knowledge)",
      );
    } else {
      // `/lore:curate` is a GATEWAY-intercepted message (matched on the user
      // text), NOT an OpenCode-registered command. Sending it via `--command`
      // makes OpenCode reject it as an unknown command (UnknownError) BEFORE it
      // ever reaches the gateway — so the forced distill+curate silently never
      // ran and cross-session facts were only ever captured by incidental
      // natural distillation. Send it as a normal message with the leading slash
      // so it flows through to the gateway's handleCurateSlashCommand.
      const cOut = path.join(OUT, "sessions", `s${i + 1}-curate.json`);
      await runAgent("/lore:curate", cOut, { cont: true }).catch(() => {});
      // Surface a curate failure loudly instead of letting it settle on an
      // under-distilled DB (the bug this replaced did exactly that). The output
      // is JSONL (one event per line, like parseSession reads), so scan line by
      // line for an error event rather than JSON.parse-ing the whole file, which
      // always throws on multi-line output and silently hid every failure (Seer #961).
      try {
        const raw = fs.existsSync(cOut) ? fs.readFileSync(cOut, "utf8") : "";
        for (const line of raw.split("\n")) {
          const s = line.trim();
          if (!s) continue;
          let ev;
          try {
            ev = JSON.parse(s);
          } catch {
            continue;
          }
          if (ev?.type === "error") {
            console.log(
              `    [lore] WARN /lore:curate returned error: ${ev?.error?.data?.message || ev?.part?.error || "unknown"}`,
            );
            break;
          }
        }
      } catch {
        /* best effort — never let curate-log parsing abort the run */
      }
    }
    const ready = await waitForMemoryReady(loreDb, LORE_BUILD, {
      maxMs: Number(args["lore-settle-max"] || 180000),
      graceMs: Number(args["lore-embed-grace"] || 12000),
    });
    // In pre-curation mode knowledge MUST stay empty; if the curator somehow
    // promoted facts anyway, the arm is contaminated (facts would reach OFF via
    // knowledge) — surface it loudly so the run can be discarded.
    if (args["pre-curation"] && ready && ready.knowledge > 0) {
      console.log(
        `    [lore] WARN pre-curation CONTAMINATION: knowledge=${ready.knowledge} (expected 0 — curator should be disabled)`,
      );
    }
  }
  // MCP arms: give async/cloud memory backends time to index before the next
  // (fresh) session searches. mem0 processes `add_memory` server-side
  // ASYNCHRONOUSLY, so an immediate search in session 2 can return empty. This
  // wait is the MCP analogue of Lore's curate+idle step above (fair to both).
  if (MCP_SERVERS[ARM] && i < TASK.sessions.length - 1) {
    await new Promise((r) =>
      setTimeout(r, Number(args["mcp-settle-ms"] || 30000)),
    );
  }
}

// ---- totals + emit -------------------------------------------------------
const totals = sessionMetrics.reduce(
  (a, m) => {
    a.steps += m.steps;
    a.tokensIn += m.tokensIn;
    a.tokensOut += m.tokensOut;
    a.cacheRead += m.cacheRead;
    a.cacheWrite += m.cacheWrite;
    a.tokensTotal += m.tokensTotal;
    a.toolCalls += m.toolCalls;
    a.cost += m.cost;
    a.wallSec += m.wallSec;
    a.peakContext = Math.max(a.peakContext, m.peakContext);
    a.reBilledTokens += m.reBilledTokens || 0;
    a.reBilledCost += m.reBilledCost || 0;
    a.misses += m.misses || 0;
    return a;
  },
  {
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokensTotal: 0,
    toolCalls: 0,
    cost: 0,
    wallSec: 0,
    peakContext: 0,
    reBilledTokens: 0,
    reBilledCost: 0,
    misses: 0,
  },
);
const compactions =
  AGENT === "pi"
    ? countPiCompactions(PI_SESSION_DIR)
    : countCompactions(path.join(OUT, "data/opencode/opencode.db"));

// Validity gate (fairness audit P0 #3): a competitor MCP arm that made ZERO
// memory_* tool calls never stored/retrieved anything — its 0/N is a dead-
// backend ARTIFACT, not a genuine result. Flag it so scoring/aggregation can
// exclude it instead of publishing a bogus 0%.
const memoryToolCalls = sessionMetrics.reduce((n, m) => {
  for (const [name, c] of Object.entries(m.toolsByName || {})) {
    if (/memory|mnemonic|mem0/i.test(name)) n += c;
  }
  return n;
}, 0);
let valid = true;
let invalidReason = null;
if (runErrors.length) {
  valid = false;
  invalidReason = `agent execution failed: ${[...new Set(runErrors)].join("; ")}`;
  console.error(
    `[${ARM}] WARN INVALID RUN: ${invalidReason} — this run must be EXCLUDED, not scored as 0.`,
  );
}
if (MCP_SERVERS[ARM] && memoryToolCalls === 0) {
  // Zero memory calls has TWO very different causes, and only one is an artifact:
  //   (a) DEAD backend — the MCP server never came up / exposed no tools. The
  //       model COULDN'T call it. That's a harness failure -> EXCLUDE the run.
  //   (b) HEALTHY backend, model just never reached for it. The tools were there;
  //       the model (typically a cheaper one) chose not to save/recall. That is a
  //       GENUINE behavioral 0% — and is precisely the thesis of the benchmark, so
  //       it MUST be scored, not excluded (excluding it hides the competitor's
  //       most on-thesis failure). We distinguish via the pre-run health probe.
  if (valid && mcpHealth && mcpHealth.healthy) {
    // (b) real 0%: keep the run valid and let the scorer record 0/N.
    invalidReason = null;
    console.error(
      `[${ARM}] NOTE: backend healthy (${(mcpHealth.tools || []).length} tools exposed) but the model made ZERO memory_* calls — scoring as a GENUINE 0%, not excluding.`,
    );
  } else if (valid) {
    // (a) dead backend artifact: exclude.
    valid = false;
    invalidReason = `competitor arm made zero memory_* tool calls AND backend probe failed (dead backend: ${mcpHealth ? mcpHealth.error || "no tools exposed" : "not probed"})`;
    console.error(
      `[${ARM}] WARN INVALID RUN: ${invalidReason} — this run must be EXCLUDED, not scored as 0.`,
    );
  }
}

fs.writeFileSync(
  path.join(OUT, "result.json"),
  JSON.stringify(
    {
      arm: ARM,
      agent: AGENT,
      model: MODEL,
      task: TASK.id,
      taskSha256: sha256(fs.readFileSync(args.task)),
      factMapId: FACT_SEED
        ? sha256(`${TASK.id}:${FACT_SEED}`).slice(0, 16)
        : null,
      repetition: args.repetition ? Number(args.repetition) : null,
      factMap: FACTS,
      seedManifest: SEED_MANIFEST,
      authProviders: redactAuth(isolatedAuth),
      factLeaks: findFactLeaks(project, FACTS, [
        "src/orders.py",
        "src/orders_v2.py",
      ]),
      gwPort,
      compactions,
      memoryToolCalls,
      mcpHealthy: mcpHealth ? !!mcpHealth.healthy : null,
      mcpTools: mcpHealth ? mcpHealth.tools || [] : null,
      valid,
      invalidReason,
      terminalOutcome,
      sessions: sessionMetrics,
      checkpoints,
      expectedCheckpoints,
      totals,
    },
    null,
    2,
  ),
);
console.log(
  `[${ARM}] DONE totals: steps=${totals.steps} tokens=${totals.tokensTotal} peakCtx=${totals.peakContext} compactions=${compactions} tools=${totals.toolCalls} wall=${totals.wallSec.toFixed(0)}s`,
);
if (AGENT === "pi") {
  console.log(
    `[${ARM}] pi cache: reBilledTokens=${totals.reBilledTokens} reBilledCost=$${totals.reBilledCost.toFixed(4)} significantMisses=${totals.misses} cacheRead=${totals.cacheRead} cacheWrite=${totals.cacheWrite}`,
  );
}

// ---- teardown ------------------------------------------------------------
if (gw) {
  try {
    process.kill(-gw.pid);
  } catch {
    try {
      gw.kill("SIGKILL");
    } catch {}
  }
}
if (args.keep !== "true") {
  // keep project + sessions + result; drop bulky caches
  fs.rmSync(path.join(OUT, "cache"), { recursive: true, force: true });
}
// Never leave provider credentials in retained benchmark artifacts. The runtime
// has finished before this point; result.json carries provider names only.
fs.rmSync(isolatedAuthPath, { force: true });
process.exit(0);
