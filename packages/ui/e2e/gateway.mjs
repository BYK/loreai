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
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const port = Number(process.env.LORE_E2E_PORT ?? 7995);

// A tiny local Model Tides stub so the upload e2e exercises the real
// consented-upload flow end to end without touching the network. Implements
// the contribute.mjs surface the gateway calls: create (POST personal-v2),
// GET /:id, share/unshare/contribute/withdraw, rotate, DELETE.
const tides = {
  id: "7b2f9a3e-1c4d-7e5f-8a6b-0c1d2e3f4a5b",
  token: "A".repeat(43),
  created: false,
  deleted: false,
  published: true,
  inAggregate: false,
  revision: 1,
  counts: [],
};
const stub = createServer((req, res) => {
  void stubHandle(req, res);
});
async function stubHandle(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = (body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  if (req.method === "POST" && url === "/api/contributions/personal-v2") {
    const snapshot = JSON.parse(brotliDecompressSync(raw).toString());
    tides.created = true;
    tides.deleted = false;
    // Reset for the next project sharing this stub (desktop + mobile workers
    // run the same spec against one server).
    tides.published = true;
    tides.inAggregate = false;
    tides.revision = 1;
    tides.counts = snapshot.weeks.flatMap(({ week, models }) =>
      Object.entries(models).map(([model, count]) => ({ week, model, count })),
    );
    return json({
      id: tides.id,
      published: true,
      inAggregate: false,
      metricVersion: 2,
      token: tides.token,
      url: `${stubBase}/u/${tides.id}`,
    });
  }
  const m = url.match(/^\/api\/contributions\/[^/]+(\/.*)?$/);
  if (!m || tides.deleted) return json({ error: "gone" }, 410);
  const tail = m[1] ?? "";
  if (req.method === "GET" && tail === "") {
    return json({
      id: tides.id,
      published: tides.published,
      inAggregate: tides.inAggregate,
      revision: tides.revision,
      metricVersion: 2,
      counts: tides.counts,
    });
  }
  if (req.method === "PUT" && tail === "") {
    tides.revision += 1;
    return json({
      id: tides.id,
      published: tides.published,
      inAggregate: tides.inAggregate,
      metricVersion: 2,
    });
  }
  if (req.method === "DELETE" && tail === "") {
    tides.deleted = true;
    res.writeHead(200);
    return res.end();
  }
  if (req.method === "POST" && tail === "/share") {
    tides.published = true;
    tides.revision += 1;
    return json({
      id: tides.id,
      published: true,
      url: `${stubBase}/u/${tides.id}`,
    });
  }
  if (req.method === "POST" && tail === "/unshare") {
    tides.published = false;
    return json({ id: tides.id, published: false });
  }
  if (req.method === "POST" && tail === "/contribute") {
    tides.inAggregate = true;
    tides.revision += 1;
    return json({ id: tides.id, inAggregate: true });
  }
  if (req.method === "POST" && tail === "/withdraw") {
    tides.inAggregate = false;
    return json({ id: tides.id, inAggregate: false });
  }
  if (req.method === "POST" && tail === "/rotate") {
    return json({ token: "B".repeat(43) });
  }
  return json({ error: "no stub route" }, 404);
}
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

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
  LORE_MODEL_TIDES_ENDPOINT: `${stubBase}/api/contributions`,
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
  stub.close();
  if (child.exitCode === null) child.kill(signal);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop(signal));
}
child.on("exit", (code) => {
  rmSync(dataHome, { recursive: true, force: true });
  process.exit(code ?? 0);
});
