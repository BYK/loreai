#!/usr/bin/env node
/**
 * Playwright `webServer`: runs the BUILT gateway (packages/gateway/dist/bin.cjs)
 * against a throw-away data directory seeded with a small, deterministic set
 * of projects and knowledge entries, so the e2e specs exercise the real
 * /ui static serving + /api/v1 read path instead of a mocked backend.
 *
 * Env:
 *   LORE_E2E_PORT   port to listen on (default 7995)
 *
 * Requires `pnpm --filter @loreai/core build` and
 * `pnpm --filter @loreai/gateway bundle` to have run.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const port = Number(process.env.LORE_E2E_PORT ?? 7995);

const dataHome = mkdtempSync(join(tmpdir(), "lore-ui-e2e-"));
const env = {
  ...process.env,
  XDG_DATA_HOME: dataHome,
  XDG_CONFIG_HOME: join(dataHome, "config"),
  XDG_STATE_HOME: join(dataHome, "state"),
  LORE_DB_PATH: join(dataHome, "lore.db"),
  LORE_LISTEN_PORT: String(port),
  LORE_LISTEN_HOST: "127.0.0.1",
  LORE_BATCH_DISABLED: "1",
  HF_HUB_OFFLINE: "1",
  NO_COLOR: "1",
};
writeFileSync(
  join(dataHome, ".lore.json"),
  JSON.stringify({ search: { embeddings: { enabled: false } } }),
);

// Seed in a separate process so the gateway opens a fully written DB.
const seed = spawn(
  process.execPath,
  [join(here, "seed.mjs"), join(dataHome, "projects")],
  { env, stdio: "inherit" },
);
await new Promise((resolve, reject) => {
  seed.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`seed exited with ${code}`)),
  );
  seed.on("error", reject);
});

const child = spawn(
  process.execPath,
  [join(repoRoot, "packages/gateway/dist/bin.cjs"), "start", "--local"],
  { env, cwd: dataHome, stdio: "inherit" },
);

const stop = (signal) => {
  if (child.exitCode === null) child.kill(signal);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop(signal));
}
child.on("exit", (code) => {
  rmSync(dataHome, { recursive: true, force: true });
  process.exit(code ?? 0);
});
