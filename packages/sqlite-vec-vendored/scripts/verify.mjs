// Verify a freshly built vec0 extension end-to-end:
//   1. load it into an in-memory node:sqlite database,
//   2. confirm vec_version() reports v0.1.10,
//   3. run a DiskANN int8 KNN query (the path patch 0001 fixes) and check order.
//
// Usage: node verify.mjs <linux-x64|linux-arm64|darwin-arm64|windows-x64>
//
// Run on the matching native runner so node loads the target's own binary.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const EXT = {
  "linux-x64": "so",
  "linux-arm64": "so",
  "darwin-arm64": "dylib",
  "windows-x64": "dll",
};

const target = process.argv[2];
if (!EXT[target]) {
  console.error(
    "usage: node verify.mjs <linux-x64|linux-arm64|darwin-arm64|windows-x64>",
  );
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "prebuilt", target, `vec0.${EXT[target]}`);
if (!existsSync(binPath)) {
  console.error(`verify: missing binary for ${target} at ${binPath}`);
  process.exit(1);
}

function f32(values) {
  const buf = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) buf.writeFloatLE(values[i], i * 4);
  return buf;
}

const db = new DatabaseSync(":memory:", { allowExtension: true });
try {
  db.loadExtension(binPath);

  const version = db.prepare("SELECT vec_version() AS v").get().v;
  if (!String(version).startsWith("v0.1.10")) {
    console.error(`verify: unexpected vec_version: ${version}`);
    process.exit(1);
  }

  db.exec(
    "CREATE VIRTUAL TABLE d USING vec0(" +
      "id TEXT PRIMARY KEY, " +
      "emb float[4] distance_metric=cosine " +
      "INDEXED BY diskann(neighbor_quantizer=int8))",
  );
  const ins = db.prepare("INSERT INTO d(id, emb) VALUES (?, ?)");
  ins.run("a", f32([1, 0, 0, 0]));
  ins.run("b", f32([0, 1, 0, 0]));
  ins.run("c", f32([0.9, 0.1, 0, 0]));

  const rows = db
    .prepare("SELECT id FROM d WHERE emb MATCH ? AND k = 3 ORDER BY distance")
    .all(f32([1, 0, 0, 0]));
  const order = rows.map((r) => r.id).join(",");
  if (order !== "a,c,b") {
    console.error(`verify: unexpected DiskANN int8 KNN order: ${order}`);
    process.exit(1);
  }

  console.log(
    `OK ${target}: vec_version=${version}, DiskANN int8 KNN order=${order}`,
  );
} finally {
  db.close();
}
