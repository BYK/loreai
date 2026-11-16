/**
 * Generate the `environment.md` reference page by walking the gateway
 * source for LORE_* env-var accesses.
 *
 * Walks the gateway src tree (and the core package) for process.env.LORE_*
 * and env.LORE_* references, dedupes by variable name, extracts the JSDoc
 * comment above the first use site, and groups entries by subsystem (the
 * file path). Each entry also surfaces the default value when the source
 * uses OR or nullish-coalescing patterns.
 *
 * Mirrors the Sentry CLI env-registry pattern: the source is the SoT, the
 * generator emits a hand-shaped reference, and a check command diffs
 * against the committed file.
 *
 * Usage:
 *   pnpm generate:env-docs                  # write environment.md
 *   pnpm check:env-docs                     # exit 1 if environment.md is stale
 */
import { writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const GATEWAY_SRC = join(REPO_ROOT, "packages/gateway/src");
const OUTPUT_PATH = join(
  REPO_ROOT,
  "packages/website/src/content/docs/docs/environment.md",
);

const checkOnly = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Source walk
// ---------------------------------------------------------------------------

interface EnvVarEntry {
  name: string;
  /** Absolute file path of the first use site */
  file: string;
  /** Line number (1-indexed) of the first use site */
  line: number;
  /** JSDoc/comment block immediately above the first use site, if any */
  description: string;
  /** Default value parsed from `||`/`??` patterns and `parseXxx(env.LORE_X, DEFAULT)` calls, if any */
  defaultValue: string | null;
  /** Parsing helper used (e.g. "parsePort", "isTruthy", "parseCurlHeaders", "trimTrailingSlash") */
  parser: string | null;
}

const VAR_NAME_REGEX = /\b(?:process\.env|env)\.LORE_[A-Z][A-Z0-9_]*/g;

/** Recursively walk a directory collecting .ts files. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Read the JSDoc/comment block immediately above the given line. */
function readDescriptionAbove(source: string, line: number): string {
  const lines = source.split("\n");
  // Walk backwards from `line - 1` (0-indexed) until we find a non-blank
  // line. If it's a JSDoc/comment close (`*/`), keep going and collect the
  // comment block. If it's code, return empty.
  const block: string[] = [];
  let i = line - 1 - 1; // 0-indexed line above the env-var reference
  // Allow up to 30 lines of lookback for the comment block.
  let budget = 30;
  while (i >= 0 && budget > 0) {
    const text = lines[i] ?? "";
    const trimmed = text.trim();
    if (block.length === 0 && trimmed === "") {
      i--;
      continue;
    }
    if (trimmed.endsWith("*/")) {
      // Walk back to the comment opener
      block.unshift(text);
      i--;
      while (i >= 0 && !lines[i]?.trimStart().startsWith("/*")) {
        block.unshift(lines[i] ?? "");
        i--;
        budget--;
      }
      if (i >= 0) {
        block.unshift(lines[i] ?? "");
        i--;
      }
      break;
    }
    if (trimmed.startsWith("//")) {
      block.unshift(text);
      i--;
      continue;
    }
    if (block.length === 0) {
      // No comment found; stop.
      return "";
    }
    break;
  }
  return cleanComment(block.join("\n"));
}

/**
 * Fallback: when the JSDoc directly above the env-var line is empty
 * (common in `loadConfig()` — the JSDoc lives on the `GatewayConfig`
 * interface field, not at the use site), scan the whole file for a JSDoc
 * block that mentions the env-var name and return the most useful
 * sentence (the one right after the env-var name mention).
 */
function readDescriptionByName(source: string, name: string): string | null {
  return searchJSDocForEnvVar(source, name);
}

/**
 * Project-wide JSDoc search. When the per-file search above fails
 * (the env var's first use is in a different file from where its
 * JSDoc lives — common when the var is read in a help-text log
 * line but documented at the actual functional use), fall back to
 * searching every other source file in the project. Returns the
 * first JSDoc that both mentions the name and includes an
 * "Env: LORE_X" / "env var" marker (the most specific signal that
 * the JSDoc is about the env var, not just incidentally mentions
 * the name).
 */
function readDescriptionByNameProjectWide(
  name: string,
  excludeFile: string,
  allFiles: string[],
): string | null {
  for (const file of allFiles) {
    if (file === excludeFile) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const found = searchJSDocForEnvVar(source, name);
    if (found) return found;
  }
  return null;
}

function searchJSDocForEnvVar(source: string, name: string): string | null {
  // Find every comment block in the file; check if it mentions the name.
  // JSDoc blocks end with `*/`. We capture each `/** ... */` block.
  // matchAll is used instead of .exec() to avoid the lastIndex-reset
  // infinite loop that happens when exec() returns null (lastIndex
  // resets to 0, the next call finds a match again, forever).
  const blockRe = /\/\*\*([\s\S]*?)\*\//g;
  const candidates: { block: string; idx: number }[] = [];
  for (const match of source.matchAll(blockRe)) {
    if (match[1]?.includes(name)) {
      candidates.push({ block: match[1] ?? "", idx: match.index ?? 0 });
    }
  }
  if (candidates.length === 0) return null;

  // Prefer the JSDoc block that has the env-var name at the start of a
  // sentence (typical of `* Env: LORE_X` patterns) or with a
  // "Env:" / "env var" / "(env:" marker.
  for (const c of candidates) {
    const cleaned = cleanComment(c.block);
    if (
      cleaned.match(new RegExp(`(env(ironment)?\\s+var\\s*:?\\s*${name})`, "i"))
    ) {
      return cleaned;
    }
  }
  // Fall back to the first block that mentions the name.
  return cleanComment(candidates[0]?.block ?? "");
}

/** Strip comment markers and leading `*` from a JSDoc block. */
function cleanComment(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("/**")) {
        return trimmed.slice(3).trimStart();
      }
      if (trimmed.startsWith("/*")) {
        return trimmed.slice(2).trimStart();
      }
      if (trimmed.startsWith("*/")) {
        return "";
      }
      if (trimmed.startsWith("*")) {
        return trimmed.slice(1).trimStart();
      }
      if (trimmed.startsWith("//")) {
        return trimmed.slice(2).trimStart();
      }
      return line;
    })
    .filter((l) => l.length > 0)
    .join(" ")
    .trim();
}

/** Try to extract a default value from the line containing the env-var ref. */
function extractDefaultValue(line: string, name: string): string | null {
  // Match `env.LORE_X || "default"`, `env.LORE_X || DEFAULT`, etc.
  const orMatch = new RegExp(
    `(?:process\\.env|env)\\.${name}\\s*\\|\\|\\s*([^,;)\\n]+)`,
  ).exec(line);
  if (orMatch) {
    return orMatch[1]?.trim() ?? null;
  }
  // Match `env.LORE_X ?? "default"`
  const nullishMatch = new RegExp(
    `(?:process\\.env|env)\\.${name}\\s*\\?\\?\\s*([^,;)\\n]+)`,
  ).exec(line);
  if (nullishMatch) {
    return nullishMatch[1]?.trim() ?? null;
  }
  // Match `parseXxx(env.LORE_X, DEFAULT)` — second arg is the default
  const parseMatch = new RegExp(
    `(\\w+)\\((?:process\\.env|env)\\.${name}\\s*,\\s*([^)]+)\\)`,
  ).exec(line);
  if (parseMatch) {
    return `${parseMatch[1]}(${parseMatch[2]?.trim() ?? ""})`;
  }
  return null;
}

/** Detect the parsing helper used (parsePort, isTruthy, etc.). */
function extractParser(line: string): string | null {
  const m = /(\w+)\((?:process\.env|env)\.LORE_/.exec(line);
  return m ? (m[1] ?? null) : null;
}

/** Map a file path to a subsystem name. */
function subsystemOf(file: string): string {
  // Core package source lives outside the gateway src tree, so a
  // bare `relative(GATEWAY_SRC, file)` would yield a leading ".."
  // segment and render as a `## ..` header. Resolve the package
  // root first and dispatch on which package the file belongs to.
  const coreSrc = join(REPO_ROOT, "packages/core/src");
  if (file.startsWith(coreSrc + sep)) {
    return "Memory, recall, and context";
  }
  const rel = relative(GATEWAY_SRC, file).split(sep);
  const top = rel[0] ?? "";
  switch (top) {
    case "cli":
      return "Launching and managing Lore";
    case "cache-warmer.ts":
    case "cost-tracker.ts":
    case "worker-model.ts":
    case "llm-adapter.ts":
    case "translate":
      return "Model providers and background work";
    case "pipeline.ts":
    case "idle.ts":
    case "batch-queue.ts":
      return "Session processing and idle work";
    case "config.ts":
      return "Gateway startup and routing";
    case "fetch-interceptor.ts":
    case "fetch.ts":
      return "Fetch interceptor";
    case "cch.ts":
    case "auth.ts":
    case "instrument.ts":
    case "hosted-config.ts":
      return "Authentication and operational telemetry";
    default:
      const names: Record<string, string> = {
        "background-limiter.ts": "Background request limits",
        "cache-analytics.ts": "Cache usage",
        "model-tides-client.ts": "Optional Model Tides uploads",
        "runtime-files.ts": "Runtime paths",
        "shutdown-deadline.ts": "Shutdown behavior",
        "sse-inactivity.ts": "Streaming timeouts",
      };
      return names[top] ?? top.replace(/\.ts$/, "").replaceAll("-", " ");
  }
}

// ---------------------------------------------------------------------------
// Walk sources, collect entries
// ---------------------------------------------------------------------------

function collectEntries(): Map<string, EnvVarEntry> {
  const entries = new Map<string, EnvVarEntry>();
  const files = walk(GATEWAY_SRC);
  // Also walk the core package's source — some env vars are read there.
  const coreSrc = join(REPO_ROOT, "packages/core/src");
  if (exists(coreSrc)) {
    files.push(...walk(coreSrc));
  }

  // Test-only env vars — never set in production, never meant for users.
  // Listed here so the JSDoc in src doesn't get pulled into the public docs
  // and so a careless rename of a SENTINEL/TEST_ env doesn't break --check.
  const TEST_ONLY_ENV = new Set<string>(["LORE_FORCED_EXIT_SENTINEL"]);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const localRegex = new RegExp(VAR_NAME_REGEX.source, "g");
      // matchAll avoids the lastIndex infinite loop that bites
      // single-line .exec() patterns when there's no match.
      for (const match of line.matchAll(localRegex)) {
        const name = match[0].split(".").pop() ?? "";
        if (!name.startsWith("LORE_")) continue;
        if (TEST_ONLY_ENV.has(name)) continue; // skip test-only sentinels
        // Skip CLI help-text lines: these reference the env var as a
        // bare `LORE_X` literal in a backtick template AND as a real
        // `process.env.LORE_X` / `env.LORE_X` access in a `${...}`
        // interpolation. The bare-literal form is the label that
        // appears before the parens; picking this line as "first use"
        // buries the real functional JSDoc further down. A genuine
        // use site never has the env var as a bare literal — it's
        // always prefixed with `process.env.` or `env.`. We test for
        // a bare occurrence by requiring the preceding character to
        // NOT be `.` (which would make it part of `process.env.LORE_X`).
        if (
          line.includes("`") &&
          new RegExp(`(?<!\\.)\\b${name}\\b`).test(line)
        ) {
          continue;
        }
        if (entries.has(name)) continue; // dedupe — first use site wins
        const aboveDesc = readDescriptionAbove(source, i + 1);
        const byNameDesc = aboveDesc
          ? null
          : readDescriptionByName(source, name);
        const projectWideDesc =
          aboveDesc || byNameDesc
            ? null
            : readDescriptionByNameProjectWide(name, file, files);
        const entry: EnvVarEntry = {
          name,
          file,
          line: i + 1,
          description: aboveDesc || byNameDesc || projectWideDesc || "",
          defaultValue: extractDefaultValue(line, name),
          parser: extractParser(line),
        };
        entries.set(name, entry);
      }
    }
  }
  return entries;
}

function exists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderPage(): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("title: Environment variables");
  lines.push(
    "description: Configure Lore startup, providers, memory, and operational behavior with environment variables.",
  );
  lines.push("sidebar:");
  lines.push("  order: 5");
  lines.push("---");
  lines.push("");
  lines.push(
    "<!-- Auto-generated from packages/gateway/src/**/*.ts and packages/core/src/**/*.ts. " +
      "Hand-edit the header above; the table below regenerates via pnpm generate:env-docs. -->",
  );
  lines.push("");
  lines.push(
    "Set environment variables in the shell or service that starts Lore, then restart the gateway. " +
      "For everyday tasks, start with [data and costs](/docs/data-and-costs/) or " +
      "[troubleshooting](/docs/troubleshooting/); use this page when you need a specific setting.",
  );
  lines.push("");
  lines.push("## Common tasks");
  lines.push("");
  lines.push("| Task | Setting or guide |");
  lines.push("|---|---|");
  lines.push(
    "| Opt out of production telemetry | Set `SENTRY_ENABLED=0` before startup; [full data boundary](/docs/installation-reference/#operational-telemetry) |",
  );
  lines.push(
    "| Choose a background model | `LORE_WORKER_MODEL`; review provider/auth requirements below |",
  );
  lines.push(
    "| Use a different data location | `LORE_DB_PATH`; point it at the database you intend to use |",
  );
  lines.push(
    "| Connect to a different gateway | [Setup and remote gateway guidance](/docs/setup/) |",
  );
  lines.push(
    "| Tune relevant knowledge | [Knowledge injection guide](/docs/guides/tune-knowledge-injection/) |",
  );
  lines.push("");
  lines.push("## Setting reference");
  lines.push("");
  lines.push(
    "Environment overrides are setting-specific. Not every `.lore.json` field has an environment equivalent; consult [configuration](/docs/configuration/) for file-based settings. Runtime-dependent defaults vary by platform or other configuration.",
  );
  lines.push("");

  const entries = collectEntries();
  // Group by subsystem
  const bySubsystem = new Map<string, EnvVarEntry[]>();
  for (const entry of entries.values()) {
    const sub = subsystemOf(entry.file);
    if (!bySubsystem.has(sub)) bySubsystem.set(sub, []);
    bySubsystem.get(sub)?.push(entry);
  }

  for (const [sub, list] of bySubsystem) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${sub}`);
    lines.push("");
    // Two-column layout: Variable (with Default + Parser as sub-lines
    // when set) and Description. This keeps the description column
    // wide for prose and prevents the table from exceeding the
    // viewport on long entries (the previous 4-column layout
    // produced a horizontal scroll on every long description).
    lines.push("| Variable | Description |");
    lines.push("|---|---|");
    for (const e of list) {
      const meta: string[] = [];
      if (e.defaultValue) {
        const defaultValue = e.defaultValue.replace(
          /^parse\w+\((true|false|\d+(?:\.\d+)?)\)$/,
          "$1",
        );
        const literal = /^(?:true|false|\d+(?:\.\d+)?|"[^"]*"|'[^']*')$/.test(
          defaultValue,
        );
        meta.push(
          defaultValue === "undefined"
            ? "**Default:** not set"
            : literal
              ? `**Default:** \`${defaultValue}\``
              : "**Default:** runtime-dependent",
        );
      }

      const variableCell =
        meta.length > 0
          ? `\`${e.name}\`<br>${meta.join("<br>")}`
          : `\`${e.name}\``;
      const desc = (
        e.description ||
        "No usage guidance is currently published for this setting. Keep the default unless an integration guide or maintainer directs otherwise."
      )
        .replace(/\{@link\s+([^}\s]+)(?:\s+[^}]+)?\}/g, "`$1`")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      lines.push(`| ${variableCell} | ${desc} |`);
    }
    lines.push("");
  }

  lines.push("## How variables are evaluated");
  lines.push("");
  lines.push(
    "Restart Lore after changing its environment. A shell export does not change the environment of an already-running gateway. The startup diagnostics report invalid settings; interpretation and validation depend on the variable.",
  );
  lines.push("");
  lines.push(
    "The reference is generated from documented source settings. Descriptions can contain advanced integration details; [open a docs issue](https://github.com/BYK/loreai/issues/new/choose) if a setting's effect is unclear.",
  );
  lines.push("");

  return lines.join("\n");
}

const generated = renderPage();

if (checkOnly) {
  let existing: string;
  try {
    existing = readFileSync(OUTPUT_PATH, "utf8");
  } catch {
    console.error(
      `[generate-env-docs] --check: ${OUTPUT_PATH} does not exist. Run 'pnpm run generate:env-docs' to create it.`,
    );
    process.exit(1);
  }
  if (existing !== generated) {
    console.error(
      `[generate-env-docs] --check: ${OUTPUT_PATH} is stale. Run 'pnpm run generate:env-docs' to update it.`,
    );
    process.exit(1);
  }
  console.log(`[generate-env-docs] --check: ${OUTPUT_PATH} is up to date.`);
} else {
  writeFileSync(OUTPUT_PATH, generated, "utf8");
  console.log(`[generate-env-docs] wrote ${OUTPUT_PATH}`);
}
