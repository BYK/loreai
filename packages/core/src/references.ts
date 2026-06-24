// Reference-validity validator (#627 Phase 0) — extraction + resolution.
//
// Knowledge entries are saturated with literal references: `file:line` citations
// (`gradient.ts:3020`, `packages/core/src/db.ts:42`) and command refs
// (`pnpm run lint`, `npm run build`, `make check`). A reference can be wrong even
// when the cited file did not change in the last git-diff window (the entry was
// wrong when written, or churned across sessions with no anchor). This module
// answers the cheap, commit-anchor-free question "does the reference still
// *resolve* against the current repo?" — complementary to Phase 1/3's "did the
// cited file *change*?".
//
// 🔴 Load-bearing invariant: "cannot verify" ≠ "broken". Only a DEFINITIVELY
// resolved-and-missing reference is "missing". Anything the resolver can't check
// (no FS access, absolute/out-of-tree path, ambiguous basename, missing
// package.json, unknown line count) is "unknown" and must be treated as a strict
// no-op by callers — never a penalty. A whole-batch null result (e.g. a remote
// probe that errored or timed out) is likewise neutral.
//
// Resolution logic is shared between the local `DirectFsResolver` and the remote
// `SyntheticProbeResolver` via a single `RepoView` + `resolveRefAgainstView`, so
// the two modes can never silently diverge.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

/** A literal reference extracted from a knowledge entry's text. */
export type Reference =
  | { kind: "file"; path: string; line: number | null; raw: string }
  | {
      kind: "command";
      runner: "pnpm" | "npm" | "yarn" | "make";
      script: string;
      raw: string;
    };

/** Resolution status of a single reference against the current repo. */
export type RefStatus = "ok" | "missing" | "unknown";

/**
 * Resolves a batch of references against a project. Returns a map keyed by
 * `Reference.raw`, or `null` when the WHOLE batch is unverifiable (no FS access,
 * probe error/timeout). A null result is a strict no-op for callers — never a
 * penalty (see the load-bearing invariant above).
 */
export interface ReferenceResolver {
  resolve(refs: Reference[]): Promise<Map<string, RefStatus> | null>;
}

// --- Extraction ------------------------------------------------------------

// A path-ish token: an optional leading `/` (captured so absolute paths are
// recognized and skipped, not silently treated as repo-relative), optional dir
// segments, a filename, a dotted extension that MUST start with a letter (so
// version numbers like `2.3` and `1.2.3` are never mistaken for files), and an
// optional `:line` (or `:line:col` / `:start-end`).
const FILE_CAND_RE =
  /\/?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]{0,4}(?::\d+(?:[:-]\d+)?)?/g;

// Package-manager subcommands that are built-ins, NOT package.json scripts —
// extracting them as command refs would falsely flag e.g. `pnpm install`.
// Deliberately EXCLUDES npm lifecycle scripts (test/start/stop/restart) and
// common scripts (build/lint/...) which DO live in `scripts`.
const PM_BUILTINS = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "run",
  "exec",
  "dlx",
  "x",
  "create",
  "init",
  "why",
  "list",
  "ls",
  "outdated",
  "store",
  "patch",
  "link",
  "unlink",
  "publish",
  "pack",
  "audit",
  "prune",
  "dedupe",
  "config",
  "cache",
  "login",
  "logout",
  "whoami",
  "version",
  "set",
  "get",
  "import",
  "rebuild",
  "root",
  "bin",
  "help",
  "info",
  "view",
  "global",
  "env",
  "fund",
  "deprecate",
  "owner",
  "access",
]);

const PM_CMD_RE = /\b(pnpm|npm|yarn)\s+(?:run\s+)?([A-Za-z][A-Za-z0-9:_-]*)/g;
const MAKE_CMD_RE = /\bmake\s+([A-Za-z][A-Za-z0-9:_-]*)/g;

/**
 * Extract the literal `file:line` and command references from an entry's text.
 * Conservative by design — a file token is only kept when it has a `:line`
 * suffix OR a `/` path separator, so prose like `e.g`, `i.e`, and bare words are
 * never treated as files. Deduplicated by raw token (within this text).
 */
// Common English words that look like make targets in prose ("make sure", "make
// it", "make progress") but are never repo build commands. Extracted as `make X`
// would produce a false "missing" penalty on any repo with a Makefile.
const MAKE_PROSE_STOPWORDS = new Set([
  "sure",
  "it",
  "the",
  "a",
  "an",
  "this",
  "that",
  "them",
  "your",
  "our",
  "their",
  "my",
  "me",
  "use",
  "sense",
  "do",
  "run",
  "changes",
  "progress",
  "surest",
  "current",
  "actual",
  "real",
  "certain",
  "specific",
  "particular",
  "possible",
  "clear",
  "great",
  "good",
  "better",
  "best",
  "simple",
  "easy",
  "quick",
  "fast",
  "sure",
  "certain",
  "definite",
  "likely",
  "unlikely",
  "enough",
  // Possessive / contractions that can look like targets
  "its",
  "it's",
  "them",
  "those",
  "these",
]);

export function extractReferences(text: string): Reference[] {
  if (!text) return [];
  const out: Reference[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(FILE_CAND_RE)) {
    const raw = m[0];
    const hasSlash = raw.includes("/");
    const colonIdx = raw.indexOf(":");
    const hasLine = colonIdx !== -1;
    // Conservative gate: require a line suffix or a path separator. A bare
    // `foo.bar` with neither is too ambiguous (could be prose) to act on.
    if (!hasSlash && !hasLine) continue;
    const path = hasLine ? raw.slice(0, colonIdx) : raw;
    const line = hasLine ? Number.parseInt(raw.slice(colonIdx + 1), 10) : null;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({
      kind: "file",
      path,
      line: Number.isNaN(line as number) ? null : line,
      raw,
    });
  }

  for (const m of text.matchAll(PM_CMD_RE)) {
    const runner = m[1] as "pnpm" | "npm" | "yarn";
    const script = m[2];
    if (PM_BUILTINS.has(script)) continue;
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ kind: "command", runner, script, raw });
  }

  for (const m of text.matchAll(MAKE_CMD_RE)) {
    const script = m[1];
    if (MAKE_PROSE_STOPWORDS.has(script)) continue;
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ kind: "command", runner: "make", script, raw });
  }

  return out;
}

/** The lowercase basename of a reference path (last `/`-segment). */
function basenameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// --- Shared resolution -----------------------------------------------------

/**
 * A read-only view of a repository, sufficient to resolve any reference.
 * `DirectFsResolver` builds it from the local filesystem; `SyntheticProbeResolver`
 * builds it from a client probe's output. `scripts`/`makeTargets` are `null` when
 * the source (package.json / Makefile) is absent — i.e. unverifiable, not empty.
 * `truncated` is true when the walk hit the file cap — not-found refs downgrade
 * to `"unknown"` (neutral) so the load-bearing invariant holds.
 */
export interface RepoView {
  /** Set of repo-relative file paths (for relative-path existence). */
  files: Set<string>;
  /** basename -> repo-relative paths (for bare-filename resolution + ambiguity). */
  basenames: Map<string, string[]>;
  /** package.json script names, or null if package.json is unavailable. */
  scripts: Set<string> | null;
  /** Makefile target names, or null if no Makefile. */
  makeTargets: Set<string> | null;
  /** Line count for a repo-relative file, or null if it can't be determined. */
  lineCount(relpath: string): number | null;
  /** True when the file walk was truncated by WALK_FILE_CAP — file-not-found is
   *  treated as "unknown" (never "missing"), preventing mass false penalties on
   *  large repos. */
  truncated?: boolean;
}

/** Resolve a single reference against a repo view. Pure; the heart of both modes. */
export function resolveRefAgainstView(
  ref: Reference,
  view: RepoView,
): RefStatus {
  if (ref.kind === "command") {
    if (ref.runner === "make") {
      if (view.makeTargets == null) return "unknown";
      return view.makeTargets.has(ref.script) ? "ok" : "missing";
    }
    if (view.scripts == null) return "unknown";
    return view.scripts.has(ref.script) ? "ok" : "missing";
  }

  // file ref
  if (isAbsolute(ref.path)) return "unknown";
  const rel = normalize(ref.path);
  if (rel.startsWith("..")) return "unknown";

  let targetExists: boolean;
  let target: string | undefined;
  if (ref.path.includes("/")) {
    target = rel;
    targetExists = view.files.has(rel);
  } else {
    const matches = view.basenames.get(ref.path) ?? [];
    if (matches.length === 0) targetExists = false;
    else if (matches.length > 1)
      return "unknown"; // ambiguous → neutral
    else {
      target = matches[0];
      targetExists = true;
    }
  }
  if (!targetExists) {
    // A truncated walk cannot definitively say "not found" → unknown (neutral).
    return view.truncated ? "unknown" : "missing";
  }
  if (ref.line == null) return "ok";
  const lc = view.lineCount(target!);
  if (lc == null) return "unknown"; // exists but line count unknown → neutral
  return ref.line >= 1 && ref.line <= lc ? "ok" : "missing";
}

// --- Direct-FS resolver ----------------------------------------------------

const WALK_IGNORE = new Set([
  "node_modules",
  ".git",
  ".jj",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "out",
  ".turbo",
  ".vercel",
  "vendor",
  "target",
  "__pycache__",
  ".svn",
  ".hg",
  ".venv",
  ".pytest_cache",
  ".idea",
  ".vim",
]);
const WALK_FILE_CAP = 60_000; // bound pathological trees

/**
 * Resolves references against a local filesystem rooted at `root`. Used when the
 * gateway is co-located with the repo (native plugin / `lore run`). Never returns
 * null (the root is assumed statable by the caller's discriminator); individual
 * refs that can't be verified resolve to "unknown".
 */
export class DirectFsResolver implements ReferenceResolver {
  private view: RepoView | null = null;
  constructor(private readonly root: string) {}

  // biome-ignore lint/suspicious/useAwait: async to satisfy the ReferenceResolver interface
  async resolve(refs: Reference[]): Promise<Map<string, RefStatus> | null> {
    const view = this.repoView();
    const map = new Map<string, RefStatus>();
    for (const ref of refs) map.set(ref.raw, resolveRefAgainstView(ref, view));
    return map;
  }

  private repoView(): RepoView {
    if (this.view) return this.view;
    const walk = this.walk();
    const root = this.root;
    this.view = {
      files: walk.files,
      basenames: walk.basenames,
      truncated: walk.truncated,
      scripts: readScripts(safeRead(join(root, "package.json"))),
      makeTargets: readMakeTargets(
        safeRead(join(root, "Makefile")) ??
          safeRead(join(root, "makefile")) ??
          safeRead(join(root, "GNUmakefile")),
      ),
      lineCount(rel: string): number | null {
        try {
          const full = join(root, rel);
          if (!statSync(full).isFile()) return null;
          return readFileSync(full, "utf8").split("\n").length;
        } catch {
          return null;
        }
      },
    };
    return this.view;
  }

  private walk(): {
    files: Set<string>;
    basenames: Map<string, string[]>;
    truncated: boolean;
  } {
    const files = new Set<string>();
    const basenames = new Map<string, string[]>();
    let count = 0;
    let truncated = false;
    const recur = (dir: string, rel: string): void => {
      if (count >= WALK_FILE_CAP) {
        truncated = true;
        return;
      }
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (count >= WALK_FILE_CAP) {
          truncated = true;
          return;
        }
        if (e.isDirectory()) {
          if (WALK_IGNORE.has(e.name)) continue;
          recur(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
        } else if (e.isFile()) {
          count++;
          const relPath = rel ? `${rel}/${e.name}` : e.name;
          files.add(relPath);
          const arr = basenames.get(e.name);
          if (arr) arr.push(relPath);
          else basenames.set(e.name, [relPath]);
        }
      }
    };
    recur(this.root, "");
    return { files, basenames, truncated };
  }
}

// --- No-op resolver --------------------------------------------------------

/** Always-neutral resolver: every batch is unverifiable. Used when the gateway
 *  cannot reach a filesystem and no probe is available. */
export class NoopResolver implements ReferenceResolver {
  // biome-ignore lint/suspicious/useAwait: async to satisfy the ReferenceResolver interface
  async resolve(_refs: Reference[]): Promise<Map<string, RefStatus> | null> {
    return null;
  }
}

// --- Synthetic client probe (remote gateway mode) --------------------------
//
// In remote-gateway mode the gateway can't see the client's repo, so it asks the
// client (via the synthetic-tool channel) to run a read-only shell probe that
// emits a repo SNAPSHOT, then resolves refs against it in-process with the SAME
// `resolveRefAgainstView` as Direct-FS. All paths/scripts embedded in the script
// come from `extractReferences`, whose charset (`[A-Za-z0-9_.-]` + `/`) excludes
// every shell metacharacter — so the embedded `__refset` cannot inject shell.

const PROBE_PKG = "===LORE-PKG===";
const PROBE_MAKE = "===LORE-MAKE===";
const PROBE_LINES = "===LORE-LINES===";

/**
 * Build the read-only shell probe that emits a repo snapshot: the tracked file
 * list, package.json, the Makefile, and `<path>\t<lineCount>` for every tracked
 * file whose basename is referenced (so line-range checks work without dumping
 * counts for the whole tree).
 */
export function buildRefcheckProbeScript(refs: Reference[]): string {
  const basenames = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === "file") basenames.add(basenameOf(ref.path));
  }
  // `|a.ts|b.ts|` — a glob-case membership test; basenames are metachar-free.
  const refset = `|${[...basenames].join("|")}|`;
  return [
    `__f=$(git ls-files 2>/dev/null)`,
    `[ -z "$__f" ] && __f=$(find . \\( -name node_modules -o -name .git -o -name dist -o -name build -o -name coverage \\) -prune -o -type f -print 2>/dev/null | sed 's|^\\./||')`,
    `printf '%s\\n' "$__f"`,
    `printf '%s\\n' '${PROBE_PKG}'`,
    `cat package.json 2>/dev/null`,
    `printf '%s\\n' '${PROBE_MAKE}'`,
    `for mf in Makefile makefile GNUmakefile; do [ -f "$mf" ] && { cat "$mf"; break; }; done`,
    `printf '%s\\n' '${PROBE_LINES}'`,
    `__refset='${refset}'`,
    `printf '%s\\n' "$__f" | while IFS= read -r f; do bn=\${f##*/}; case "$__refset" in *"|$bn|"*) printf '%s\\t%s\\n' "$f" "$(wc -l < "$f" 2>/dev/null)";; esac; done`,
  ].join("\n");
}

/** Parse a probe snapshot into a RepoView, or null if it has no usable sections
 *  (malformed / empty output → unverifiable → neutral). */
export function parseProbeSnapshot(text: string): RepoView | null {
  if (!text?.includes(PROBE_PKG)) return null;
  const pkgAt = text.indexOf(PROBE_PKG);
  const makeAt = text.indexOf(PROBE_MAKE);
  const linesAt = text.indexOf(PROBE_LINES);
  if (makeAt === -1 || linesAt === -1) return null;

  const fileBlock = text.slice(0, pkgAt);
  const pkgBlock = text.slice(pkgAt + PROBE_PKG.length, makeAt);
  const makeBlock = text.slice(makeAt + PROBE_MAKE.length, linesAt);
  const linesBlock = text.slice(linesAt + PROBE_LINES.length);

  const files = new Set<string>();
  const basenames = new Map<string, string[]>();
  for (const raw of fileBlock.split("\n")) {
    const f = raw.trim();
    if (!f) continue;
    files.add(f);
    const bn = basenameOf(f);
    const arr = basenames.get(bn);
    if (arr) arr.push(f);
    else basenames.set(bn, [f]);
  }

  const lineCounts = new Map<string, number>();
  for (const raw of linesBlock.split("\n")) {
    const tab = raw.indexOf("\t");
    if (tab === -1) continue;
    const path = raw.slice(0, tab).trim();
    const n = Number.parseInt(raw.slice(tab + 1).trim(), 10);
    if (path && !Number.isNaN(n)) lineCounts.set(path, n + 1); // +1: trailing-newline lenience, mirrors Direct-FS split
  }

  return {
    files,
    basenames,
    scripts: readScripts(pkgBlock.trim() || null),
    makeTargets: readMakeTargets(makeBlock.trim() || null),
    lineCount: (rel) => lineCounts.get(rel) ?? null,
  };
}

/**
 * Resolver backed by a client probe's captured output. Constructed by the gateway
 * with the `tool_result` text once the client returns it (two-request flow lives
 * in the pipeline). Returns null when the snapshot is malformed/empty (neutral).
 */
export class SyntheticProbeResolver implements ReferenceResolver {
  constructor(private readonly probeText: string) {}

  // biome-ignore lint/suspicious/useAwait: async to satisfy the ReferenceResolver interface
  async resolve(refs: Reference[]): Promise<Map<string, RefStatus> | null> {
    const view = parseProbeSnapshot(this.probeText);
    if (view == null) return null;
    const map = new Map<string, RefStatus>();
    for (const ref of refs) map.set(ref.raw, resolveRefAgainstView(ref, view));
    return map;
  }
}

// --- small shared parsers --------------------------------------------------

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readScripts(pkgJson: string | null): Set<string> | null {
  if (pkgJson == null) return null;
  try {
    const pkg = JSON.parse(pkgJson) as { scripts?: Record<string, unknown> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return null;
  }
}

function readMakeTargets(makefile: string | null): Set<string> | null {
  if (makefile == null) return null;
  const targets = new Set<string>();
  for (const line of makefile.split("\n")) {
    // A target line: `name:` at column 0 (not a `.PHONY`-style directive, not an
    // `=` assignment, not a tab-indented recipe line).
    const t = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/);
    if (t && !t[1].startsWith(".")) targets.add(t[1]);
  }
  return targets;
}
