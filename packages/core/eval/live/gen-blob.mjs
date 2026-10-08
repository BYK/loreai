// Generates a large "legacy API spec" reference blob that the task pipes via
// stdin each turn. Sized so a single turn's context lands just over the 200K
// model's compaction threshold (~136K) but under the 200K hard limit — so each
// blob turn triggers exactly one native compaction (and never overflows a
// request). Empirically ~700KB ≈ 145K counted tokens on the first turn.
//
// Usage: bun gen-blob.mjs <out-file> [approxKB]
import fs from "node:fs";

const OUT = process.argv[2] || "blob-spec.md";
const KB = Number(process.argv[3] || "700");
const domains = [
  "orders",
  "inventory",
  "shipping",
  "billing",
  "returns",
  "pricing",
  "catalog",
  "auth",
  "audit",
  "webhooks",
  "reporting",
  "tax",
];

const secs = [];
let i = 0;
let n = 0;
// ~1080 bytes/section empirically; sections needed ≈ KB*1024/1080.
const target = Math.round((KB * 1024) / 1080);
outer: for (let e = 1; ; e++) {
  for (const d of domains) {
    i++;
    if (++n > target) break outer;
    secs.push(`### ${d}.endpoint_${e} (op #${i})

**Path:** \`/v2/${d}/resource_${e}/{id}\`
**Methods:** GET, POST, PUT, PATCH, DELETE

Request validation: the ${d} resource_${e} payload must include a stable client request-id for idempotency, an integer cents amount for any monetary field, and integer quantities. All timestamps are UTC ISO-8601 and produced by the shared clock helper. The handler validates the payload against the ${d} schema, enforces the per-resource invariants, writes an audit row capturing actor/action/at, and returns the persisted representation. On retry with the same request-id the operation is idempotent and returns the original result without duplicating side effects. Concurrent writers are serialized per-row; readers observe a consistent snapshot. Error responses use the shared error envelope with a machine-readable code and a human-readable message. Rate limits apply per client per minute. Pagination is keyset-based on (created_at, id). Soft-deletes set a tombstone and are excluded from default listings but retained for audit and returns processing.`);
  }
}
const body = `# Legacy Warehouse API v2 — Full Endpoint Specification\n\nThis document specifies every endpoint. Implementations MUST conform exactly.\n\n${secs.join("\n\n")}\n`;
fs.writeFileSync(OUT, body);
console.log(
  `${OUT}: ${body.length.toLocaleString()} bytes (~${Math.round(body.length / 4).toLocaleString()} raw tokens, ${secs.length} sections)`,
);
