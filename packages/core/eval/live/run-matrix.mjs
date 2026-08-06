// Reproducible matrix runner. It accepts only model IDs enumerated in a checked-in
// manifest; runtime catalog changes cannot silently swap the experiment model.

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  MATRIX_STATE_FILE,
  cellKey,
  createMatrixState,
  hasMatchingTerminalResult,
  readMatrixState,
  returnCellToPending,
  startCell,
  writeMatrixState,
} from "./matrix-state.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, value, index, values) => {
    if (value.startsWith("--")) {
      out.push([
        value.slice(2),
        values[index + 1] && !values[index + 1].startsWith("--")
          ? values[index + 1]
          : "true",
      ]);
    }
    return out;
  }, []),
);
const manifestPath = path.resolve(
  args.manifest || "matrix-iterative-orders.json",
);
const root = path.resolve(args.out || "./runs");
const DRY_RUN = args["dry-run"] === "true";
const RESUME = args.resume === "true";
const shardCount = Number(args["shard-count"] || 1);
const shardIndex = Number(args["shard-index"] || 0);
if (
  !Number.isInteger(shardCount) ||
  shardCount < 1 ||
  !Number.isInteger(shardIndex) ||
  shardIndex < 0 ||
  shardIndex >= shardCount
) {
  throw new Error("shard index must be a zero-based integer below shard count");
}
const shard = { index: shardIndex, count: shardCount };
const manifestSnapshotPath = path.join(root, "manifest.json");
if (RESUME && !fs.existsSync(manifestSnapshotPath)) {
  throw new Error(`matrix manifest snapshot is required to resume: ${root}`);
}
const manifestSourcePath = RESUME ? manifestSnapshotPath : manifestPath;
const manifest = JSON.parse(fs.readFileSync(manifestSourcePath, "utf8"));
const REQUIRED_MODELS = new Set([
  "sonnet-5",
  "deepseek-v4-flash",
  "m3-minimax-subscription",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
]);
const REQUIRED_RUNTIMES = new Set(["opencode", "pi"]);
const REQUIRED_ARMS = new Set(["lore", "nolore"]);
const REQUIRED_ROUTES = {
  "sonnet-5": {
    model: "openrouter/anthropic/claude-sonnet-5",
    workerModel: "openrouter/anthropic/claude-sonnet-5",
    authProvider: "openrouter",
  },
  "deepseek-v4-flash": {
    model: "openrouter/deepseek/deepseek-v4-flash",
    workerModel: "openrouter/deepseek/deepseek-v4-flash",
    authProvider: "openrouter",
  },
  "m3-minimax-subscription": {
    model: "minimax/MiniMax-M3",
    workerModel: "minimax/MiniMax-M3",
    authProvider: "minimax-coding-plan",
  },
  "gpt-5.6-luna": {
    model: "openrouter/openai/gpt-5.6-luna",
    workerModel: "openrouter/openai/gpt-5.6-luna",
    authProvider: "openrouter",
  },
  "gpt-5.6-terra": {
    model: "openrouter/openai/gpt-5.6-terra",
    workerModel: "openrouter/openai/gpt-5.6-terra",
    authProvider: "openrouter",
  },
};
const authPath =
  args.auth ||
  path.join(
    process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`,
    "opencode/auth.json",
  );
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
const taskNames = manifest.tasks || (manifest.task ? [manifest.task] : []);
if (taskNames.length === 0)
  throw new Error("matrix manifest must name at least one task");
const tasks = taskNames.map((name) =>
  path.resolve(path.dirname(manifestPath), name),
);
const taskIDs = new Map(
  tasks.map((task) => [task, JSON.parse(fs.readFileSync(task, "utf8")).id]),
);
const loreBuild =
  args["lore-build"] || path.resolve(path.dirname(manifestPath), "../../../..");
const loreRevision = (() => {
  try {
    return execFileSync(
      "jj",
      ["log", "-r", "@", "--no-graph", "-T", "commit_id"],
      {
        cwd: loreBuild,
        encoding: "utf8",
      },
    ).trim();
  } catch {
    return "unavailable";
  }
})();

if (!Array.isArray(manifest.models) || manifest.models.length !== 5) {
  throw new Error(
    "matrix manifest must enumerate exactly the five requested models",
  );
}
if (
  manifest.models.some((model) => !REQUIRED_MODELS.has(model.name)) ||
  new Set(manifest.models.map((model) => model.name)).size !==
    REQUIRED_MODELS.size
) {
  throw new Error("matrix must contain each requested model exactly once");
}
if (
  !Array.isArray(manifest.runtimes) ||
  manifest.runtimes.length !== REQUIRED_RUNTIMES.size ||
  manifest.runtimes.some((runtime) => !REQUIRED_RUNTIMES.has(runtime))
) {
  throw new Error("matrix must contain exactly the opencode and pi runtimes");
}
if (
  !Array.isArray(manifest.arms) ||
  manifest.arms.length !== REQUIRED_ARMS.size ||
  manifest.arms.some((arm) => !REQUIRED_ARMS.has(arm))
) {
  throw new Error("matrix must contain exactly lore and nolore arms");
}
for (const model of manifest.models) {
  const expected = REQUIRED_ROUTES[model.name];
  if (
    !expected ||
    model.model !== expected.model ||
    model.workerModel !== expected.workerModel ||
    model.authProvider !== expected.authProvider
  ) {
    throw new Error(
      `matrix route for ${model.name} differs from the approved configuration`,
    );
  }
  if (!model.model?.includes("/") || !model.workerModel?.includes("/")) {
    throw new Error(`invalid exact model routing for ${model.name}`);
  }
  if (!auth[model.authProvider]) {
    throw new Error(
      `missing auth entry '${model.authProvider}' for ${model.name}`,
    );
  }
}

const sha = (value) => createHash("sha256").update(value).digest("hex");
function requireMatchingRunInputs(runManifest) {
  if (
    runManifest.shard?.index !== shard.index ||
    runManifest.shard?.count !== shard.count
  ) {
    throw new Error("cannot resume: shard assignment changed");
  }
  const requireFiles = (inputs, label) => {
    for (const input of inputs) {
      const file =
        input.path || path.join(path.dirname(manifestPath), input.name);
      if (!fs.existsSync(file) || sha(fs.readFileSync(file)) !== input.sha256) {
        throw new Error(`cannot resume: ${label} changed: ${file}`);
      }
    }
  };
  requireFiles(runManifest.tasks, "task input");
  requireFiles(runManifest.generatedInputs, "generated input");
  requireFiles(runManifest.harnessInputs, "harness input");
  if (
    treeHash(path.join(path.dirname(manifestPath), "seed-min")) !==
    runManifest.seedManifestSha256
  ) {
    throw new Error("cannot resume: seed manifest changed");
  }
  if (loreRevision !== runManifest.loreRevision) {
    throw new Error("cannot resume: Lore build revision changed");
  }
  for (const [runtime, version] of Object.entries(runManifest.runtimes)) {
    if (runtimeVersion(runtime) !== version) {
      throw new Error(`cannot resume: ${runtime} version changed`);
    }
  }
}
function treeHash(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        entries.push(`${rel}:${sha(fs.readFileSync(full))}`);
    }
  };
  walk(root);
  return sha(entries.sort().join("\n"));
}
const manifestSha = sha(fs.readFileSync(manifestSourcePath));
const runtimeVersion = (command, commandArgs = ["--version"]) => {
  try {
    return execFileSync(command, commandArgs, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
};
if (!DRY_RUN) {
  if (RESUME) {
    if (!fs.existsSync(path.join(root, MATRIX_STATE_FILE))) {
      throw new Error(`matrix state is required to resume: ${root}`);
    }
  } else if (fs.existsSync(root)) {
    if (fs.readdirSync(root).length > 0) {
      throw new Error(
        `output directory must be empty for a from-scratch run: ${root}`,
      );
    }
  } else {
    fs.mkdirSync(root, { recursive: true });
  }
}
function run(command, commandArgs, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function ensureGeneratedInputs() {
  const dir = path.dirname(manifestPath);
  const required = [
    ["blob-mid.md", "351"],
    ["blob-sm.md", "250"],
  ];
  for (const [name, sizeKb] of required) {
    const target = path.join(dir, name);
    fs.rmSync(target, { force: true });
    execFileSync("bun", ["gen-blob.mjs", name, sizeKb], {
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  try {
    execFileSync(
      "docker",
      ["image", "inspect", args["verifier-image"] || "python:3.12-alpine"],
      {
        stdio: "ignore",
      },
    );
  } catch {
    throw new Error(
      "verifier image is unavailable; run docker pull python:3.12-alpine first",
    );
  }
}

function ensureGatewayBundle() {
  const dist = path.join(loreBuild, "packages/gateway/dist");
  const required = ["index.bun.js", "embedding-worker.js", "vector-worker.js"];
  const missing = required.filter(
    (name) => !fs.existsSync(path.join(dist, name)),
  );
  if (missing.length > 0) {
    console.error(
      `[preflight] gateway bundle is missing ${missing.join(", ")}; building companion worker artifacts`,
    );
    execFileSync("pnpm", ["--filter", "@loreai/gateway", "run", "bundle"], {
      cwd: loreBuild,
      // Keep dry-run stdout valid JSON even when artifact repair is required.
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  const stillMissing = required.filter(
    (name) => !fs.existsSync(path.join(dist, name)),
  );
  if (stillMissing.length > 0) {
    throw new Error(
      `gateway bundle is missing required worker artifacts: ${stillMissing.join(", ")}`,
    );
  }
}

if (!DRY_RUN && RESUME) {
  requireMatchingRunInputs(
    JSON.parse(fs.readFileSync(path.join(root, "run-manifest.json"), "utf8")),
  );
}

if (!DRY_RUN && !RESUME) {
  ensureGeneratedInputs();
  ensureGatewayBundle();
}

if (!DRY_RUN && !RESUME) {
  fs.copyFileSync(manifestPath, path.join(root, "manifest.json"));
  fs.writeFileSync(
    path.join(root, "run-manifest.json"),
    `${JSON.stringify(
      {
        manifestSha,
        tasks: tasks.map((task) => ({
          path: task,
          sha256: sha(fs.readFileSync(task)),
        })),
        generatedInputs: ["blob-mid.md", "blob-sm.md"].map((name) => ({
          name,
          sha256: sha(
            fs.readFileSync(path.join(path.dirname(manifestPath), name)),
          ),
        })),
        harnessInputs: [
          "driver.mjs",
          "score.mjs",
          "checkpoint-score.mjs",
          "verify-iterative-orders.py",
          "verify-retention-orders.py",
          "gen-blob.mjs",
        ].map((name) => ({
          name,
          sha256: sha(
            fs.readFileSync(path.join(path.dirname(manifestPath), name)),
          ),
        })),
        seedManifestSha256: treeHash(
          path.join(path.dirname(manifestPath), "seed-min"),
        ),
        loreBuild,
        loreRevision,
        shard,
        startedAt: new Date().toISOString(),
        runtimes: {
          opencode: runtimeVersion("opencode"),
          pi: runtimeVersion("pi"),
        },
      },
      null,
      2,
    )}\n`,
  );
}

const allPlannedCells = [];
for (const task of tasks) {
  const taskId = taskIDs.get(task);
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error(`task must define a non-empty id: ${task}`);
  }
  for (const model of manifest.models) {
    for (const runtime of manifest.runtimes) {
      for (
        let repetition = 0;
        repetition < manifest.repetitions;
        repetition++
      ) {
        const factSeed = sha(
          `${manifestSha}:${taskId}:${model.name}:${runtime}:${repetition}`,
        );
        for (const arm of manifest.arms) {
          allPlannedCells.push({
            task: taskId,
            model: model.name,
            runtime,
            arm,
            repetition: repetition + 1,
            factMapId: sha(`${taskId}:${factSeed}`).slice(0, 16),
            out: `${taskId}-${model.name}-${runtime}-${arm}-r${repetition + 1}`,
          });
        }
      }
    }
  }
}
const plannedCells = allPlannedCells.filter(
  (_, index) => index % shard.count === shard.index,
);
if (DRY_RUN) {
  console.log(
    JSON.stringify(
      {
        manifest: manifestPath,
        shard,
        totalCells: allPlannedCells.length,
        cells: plannedCells,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const statePath = path.join(root, MATRIX_STATE_FILE);
const runManifestSha = sha(
  fs.readFileSync(path.join(root, "run-manifest.json")),
);
const state = RESUME
  ? readMatrixState(statePath)
  : createMatrixState({
      manifestSha,
      runManifestSha,
      shard,
      cells: plannedCells,
    });
if (
  state.manifestSha !== manifestSha ||
  state.runManifestSha !== runManifestSha
) {
  throw new Error("matrix state does not match this manifest and run inputs");
}
if (state.shard?.index !== shard.index || state.shard?.count !== shard.count) {
  throw new Error("matrix state does not match this shard assignment");
}
for (const cell of plannedCells) {
  const record = state.cells[cellKey(cell)];
  if (!record || JSON.stringify(record.input) !== JSON.stringify(cell)) {
    throw new Error(
      `matrix state does not match planned cell: ${cellKey(cell)}`,
    );
  }
}
if (!RESUME) writeMatrixState(statePath, state);

const dirs = [];
const invalidCells = [];
for (const task of tasks) {
  const taskId = taskIDs.get(task);
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error(`task must define a non-empty id: ${task}`);
  }
  for (const model of manifest.models) {
    for (const runtime of manifest.runtimes) {
      for (
        let repetition = 0;
        repetition < manifest.repetitions;
        repetition++
      ) {
        const factSeed = sha(
          `${manifestSha}:${taskId}:${model.name}:${runtime}:${repetition}`,
        );
        for (const arm of manifest.arms) {
          const out = path.join(
            root,
            `${taskId}-${model.name}-${runtime}-${arm}-r${repetition + 1}`,
          );
          const cell = plannedCells.find(
            (candidate) =>
              candidate.task === taskId &&
              candidate.model === model.name &&
              candidate.runtime === runtime &&
              candidate.arm === arm &&
              candidate.repetition === repetition + 1,
          );
          if (!cell) continue;
          const record = state.cells[cellKey(cell)];
          if (hasMatchingTerminalResult(root, record, sha)) {
            console.error(`[resume] skipping terminal cell ${cellKey(cell)}`);
            const result = JSON.parse(
              fs.readFileSync(path.join(out, "result.json"), "utf8"),
            );
            if (result.valid) dirs.push(out);
            else invalidCells.push(cellKey(cell));
            continue;
          }
          startCell(record);
          writeMatrixState(statePath, state);
          const code = await run(
            "bun",
            [
              "driver.mjs",
              "--task",
              task,
              "--arm",
              arm,
              "--model",
              model.model,
              "--worker-model",
              model.workerModel,
              "--agent-runtime",
              runtime,
              "--auth",
              authPath,
              "--out",
              out,
              "--lore-build",
              loreBuild,
              "--cap-context",
              String(manifest.capContext),
              "--cap-output",
              String(manifest.capOutput),
              "--fact-seed",
              factSeed,
              "--repetition",
              String(repetition + 1),
              "--verifier-image",
              args["verifier-image"] || "python:3.12-alpine",
              "--keep",
            ],
            path.dirname(manifestPath),
          );
          // A driver crash can bypass its own teardown. Never preserve either
          // runtime's isolated credential, whether the cell passed or failed.
          fs.rmSync(path.join(out, "data/opencode/auth.json"), { force: true });
          fs.rmSync(path.join(out, "pi-home/auth.json"), { force: true });
          const resultPath = path.join(out, "result.json");
          if (code !== 0 && !fs.existsSync(resultPath)) {
            returnCellToPending(record);
            writeMatrixState(statePath, state);
            throw new Error(
              `matrix cell failed: ${taskId}/${model.name}/${runtime}/${arm}`,
            );
          }
          const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
          record.state = "terminal";
          record.terminalOutcome =
            result.terminalOutcome ||
            (result.valid ? "completed" : "infrastructure-failure");
          record.resultSha256 = sha(fs.readFileSync(resultPath));
          record.updatedAt = new Date().toISOString();
          writeMatrixState(statePath, state);
          if (result.valid) dirs.push(out);
          else invalidCells.push(cellKey(cell));
        }
      }
    }
  }
}

if (invalidCells.length > 0) {
  throw new Error(
    `matrix contains invalid terminal cells: ${invalidCells.join(", ")}`,
  );
}

const checkpointDirs = [];
const retentionDirs = [];
for (const dir of dirs) {
  const result = JSON.parse(
    fs.readFileSync(path.join(dir, "result.json"), "utf8"),
  );
  (result.checkpoints?.length ? checkpointDirs : retentionDirs).push(dir);
}
if (checkpointDirs.length) {
  const scoreCode = await run(
    "bun",
    ["checkpoint-score.mjs", ...checkpointDirs],
    path.dirname(manifestPath),
  );
  if (scoreCode !== 0) process.exit(scoreCode);
}
if (retentionDirs.length) {
  const scoreCode = await run(
    "bun",
    ["score.mjs", ...retentionDirs],
    path.dirname(manifestPath),
  );
  if (scoreCode !== 0) process.exit(scoreCode);
}
