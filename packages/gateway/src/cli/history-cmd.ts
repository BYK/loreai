/**
 * CLI `lore log` / `lore diff` — a read-only view of the append-only knowledge
 * version history (#962). We already store the full `logical_id + version`
 * trajectory (A2, #823); these surface it. Runs WITHOUT the gateway — reads the
 * local SQLite DB directly (like `lore data`), so no LLM client is needed.
 *
 *   lore log [<id>] [--project <path>] [--limit <n>] [--json]
 *     <id>        show the version timeline for one entry (version id or logical_id)
 *     (no id)     show recent knowledge changes across the project
 *   lore diff <id> [<v1> <v2>] [--json]
 *     default     latest superseded version → current
 *     <v1> <v2>   diff two explicit version numbers
 *
 * The history is bounded by compaction (#909): superseded versions past the
 * retention window are gone by design, so `log` shows the kept window.
 */
import { resolve } from "node:path";

type KnowledgeVersion = import("@loreai/core").ltm.KnowledgeVersion;

function fmtTs(ms: number): string {
  // Local YYYY-MM-DD HH:MM — compact + sortable in the terminal.
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function marker(v: KnowledgeVersion): string {
  if (v.is_deleted) return "deleted";
  return v.is_current ? "current" : "superseded";
}

const shortId = (id: string) => id.slice(0, 8);
const author = (v: KnowledgeVersion) => v.updated_by || "—";

/**
 * A `--limit` → positive integer, defaulting for missing/garbage. Guards against a
 * NaN/fractional value reaching a SQL `LIMIT ?` bind (node:sqlite rejects it with a
 * raw "datatype mismatch" that would otherwise dump a stack).
 */
function parseLimit(v: unknown, def: number): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (Number.isInteger(n) && n > 0) return n;
  console.error(`Ignoring invalid --limit "${v}" (using ${def}).`);
  return def;
}

/** Minimal LCS line diff → unified-ish `-`/`+`/` ` prefixed lines. Exported for tests. */
export type DiffLine = { kind: " " | "-" | "+"; text: string };
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  // dp[i][j] = LCS length of x[i:] and y[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        x[i] === y[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: " ", text: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "-", text: x[i] });
      i++;
    } else {
      out.push({ kind: "+", text: y[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "-", text: x[i++] });
  while (j < m) out.push({ kind: "+", text: y[j++] });
  return out;
}

function renderTimeline(versions: KnowledgeVersion[]): void {
  const current = versions[versions.length - 1];
  console.log(current.title);
  console.log(
    `logical ${shortId(current.logical_id)} · ${versions.length} version${versions.length === 1 ? "" : "s"}\n`,
  );
  // Newest first.
  for (const v of [...versions].reverse()) {
    const retitled = v.title !== current.title ? `  "${v.title}"` : "";
    console.log(
      `  v${v.version}  ${fmtTs(v.updated_at)}  ${marker(v).padEnd(10)}  ${author(v).padEnd(12)}  ${v.category}${retitled}`,
    );
  }
}

function renderRecent(rows: KnowledgeVersion[], projectPath: string): void {
  console.log(`Recent knowledge changes · ${projectPath}\n`);
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const v of rows) {
    console.log(
      `  ${fmtTs(v.updated_at)}  v${v.version}  ${marker(v).padEnd(10)}  ${v.title}  ·  ${author(v)}`,
    );
  }
}

export async function commandLog(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const { ltm, projectId } = await import("@loreai/core");
  const asJson = !!values.json;
  const id = positionals[0];

  // `lore log <id>` — the version timeline of one entry.
  if (id) {
    const versions = ltm.versionHistory(id);
    if (versions.length === 0) {
      console.error(`No knowledge entry found for id: ${id}`);
      process.exit(1);
    }
    if (asJson) {
      console.log(JSON.stringify(versions, null, 2));
      return;
    }
    renderTimeline(versions);
    return;
  }

  // `lore log [--project <path>]` — recent changes across the project.
  const projectPath = resolve((values.project as string) ?? process.cwd());
  const pid = projectId(projectPath);
  if (!pid) {
    console.error(
      `No tracked project at ${projectPath} yet (nothing has been stored here).`,
    );
    process.exit(1);
  }
  const rows = ltm.recentKnowledgeChanges(pid, parseLimit(values.limit, 20));
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  renderRecent(rows, projectPath);
}

function renderDiff(a: KnowledgeVersion, b: KnowledgeVersion): void {
  console.log(b.title);
  console.log(
    `logical ${shortId(b.logical_id)} · v${a.version} → v${b.version}   (${fmtTs(a.updated_at)} → ${fmtTs(b.updated_at)})\n`,
  );
  if (a.category !== b.category)
    console.log(`category: ${a.category} → ${b.category}`);
  if (a.title !== b.title) console.log(`title:    ${a.title} → ${b.title}`);
  if (a.is_deleted !== b.is_deleted)
    console.log(
      b.is_deleted ? "(entry deleted in this version)" : "(entry restored)",
    );
  console.log();
  for (const l of lineDiff(a.content, b.content))
    console.log(`${l.kind} ${l.text}`);
}

export async function commandDiff(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const { ltm } = await import("@loreai/core");
  const id = positionals[0];
  if (!id) {
    console.error(`Usage: lore diff <id> [<v1> <v2>] [--json]

  <id>        a knowledge entry (version id or logical_id)
  <v1> <v2>   two version numbers to compare (default: latest superseded → current)`);
    process.exit(1);
  }
  const versions = ltm.versionHistory(id);
  if (versions.length === 0) {
    console.error(`No knowledge entry found for id: ${id}`);
    process.exit(1);
  }

  let a: KnowledgeVersion | undefined;
  let b: KnowledgeVersion | undefined;
  if (positionals[1] !== undefined && positionals[2] !== undefined) {
    const v1 = Number(positionals[1]);
    const v2 = Number(positionals[2]);
    a = versions.find((v) => v.version === v1);
    b = versions.find((v) => v.version === v2);
    if (!a || !b) {
      console.error(
        `Version not found. Available: ${versions.map((v) => v.version).join(", ")}`,
      );
      process.exit(1);
    }
  } else {
    if (versions.length < 2) {
      console.log("Only one version — nothing to diff.");
      return;
    }
    // Default: latest superseded → current (versions are sorted ascending).
    a = versions[versions.length - 2];
    b = versions[versions.length - 1];
  }

  if (values.json) {
    console.log(
      JSON.stringify(
        { from: a, to: b, diff: lineDiff(a.content, b.content) },
        null,
        2,
      ),
    );
    return;
  }
  renderDiff(a, b);
}
