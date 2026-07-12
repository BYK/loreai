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

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

/** A literal reference extracted from a knowledge entry's text. */
export type Reference =
  | { kind: "file"; path: string; line: number | null; raw: string }
  | {
      kind: "command";
      runner: "pnpm" | "npm" | "yarn" | "make";
      script: string;
      /** True when an explicit `run` verb preceded the script (`pnpm run X`).
       *  A bare `pnpm X` is ambiguous with a noun phrase ("npm registry") and is
       *  resolved confirm-only (never "missing"). `make` is always false. */
      explicit: boolean;
      raw: string;
    }
  | {
      /** A cited code identifier (function / const / class / type name) that the
       *  entry claims still exists — e.g. "`evaluateCacheStrategy` called only
       *  from `cache-warmer.ts:1252`" (#911). Only extracted when (a) inside a
       *  backtick span, (b) the entry ALSO has a file ref (the adjacency bound),
       *  and (c) the token is "codey" (PascalCase / camelCase / has `_` / was
       *  call-like). Resolution is presence-only (grep), never AST: present
       *  anywhere in tracked source → ok; searched-and-absent repo-wide →
       *  missing; grep unavailable → unknown. */
      kind: "symbol";
      name: string;
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

// Group 2 captures the explicit `run` verb (if present) so resolution can
// distinguish an unambiguous `pnpm run X` (a script invocation that may be
// "missing") from a bare `npm X` (which may be a noun phrase like "npm registry"
// and must never penalize).
const PM_CMD_RE = /\b(pnpm|npm|yarn)\s+(run\s+)?([A-Za-z][A-Za-z0-9:_-]*)/g;
const MAKE_CMD_RE = /\bmake\s+([A-Za-z][A-Za-z0-9:_-]*)/g;

// Candidate code identifiers inside a backtick span (#911). The charset is the
// grep-safe identifier set `[A-Za-z_][A-Za-z0-9_]*` ON PURPOSE — every extracted
// name must be safe to embed in `git grep -F -- <name>` and in the client probe
// without any escaping, and a name we can't grep must never be coined (it would
// resolve "missing" on a Set absence). `$`-bearing identifiers are simply not
// extracted (false negative, the safe direction). Group 1 is the identifier; the
// trailing `\(?` lets us tell a call-site (`foo(`) from a bare token.
const SYMBOL_CAND_RE = /([A-Za-z_][A-Za-z0-9_]*)(\()?/g;

// A token is treated as a cited *symbol* (not prose) only when it carries a code
// marker: it was call-like (`foo(`), PascalCase/camelCase (an internal case
// change), or snake/CONSTANT_CASE (an `_`). Bare marker-free lowercase words
// (`run`, `total`, `state`, `file`) read as prose and are rejected — this gate is
// the load-bearing false-positive killer for the 🔴 never-penalize invariant.
function isCodeySymbol(name: string, callLike: boolean): boolean {
  if (callLike) return true;
  if (name.includes("_")) return true;
  // mixed case covers both camelCase (`sessionID`) and PascalCase (`RepoView`).
  return /[a-z]/.test(name) && /[A-Z]/.test(name);
}

// Inline-code / fenced-code spans (the inner text between backtick runs).
// Command references are extracted ONLY from inside code spans, and only ever
// per single line (see codeLines). Knowledge entries consistently backtick-wrap
// real commands (`pnpm run lint`, `make check`), so this is high-precision with
// negligible recall loss. False negatives (an un-backticked command not checked)
// are acceptable; false positives (penalizing prose) are NOT — this is the
// load-bearing invariant ("cannot verify" ≠ "broken").
//
// Two further guards against fabricating a phantom command out of prose:
//  1. Per-line matching: the command regexes use `\s+`, and `\n` is whitespace,
//     so concatenating spans/lines would let `make` on one line fuse with the
//     next token (`` `make` … `Makefile` `` → "make Makefile"). Matching each
//     line in isolation prevents cross-span and cross-line fusion.
//  2. Explicit-verb gate (see resolveRefAgainstView): a pnpm/npm/yarn ref only
//     resolves "missing" on an absent script when it was an explicit
//     `<pm> run <script>`. A bare `<pm> <word>` is ambiguous with a noun phrase
//     ("npm registry", "yarn about") so an absent bare script is "unknown"
//     (neutral). `make` has no `run` verb and reads as prose ("make sense"), so
//     it is always confirm-only (absent → "unknown").
const CODE_SPAN_RE = /`+([^`]+)`+/g;

// A path first-segment that looks like a DNS host (`github.com`,
// `www.example.com`): used to reject bare/relative URLs that would otherwise
// match FILE_CAND_RE via their `/` (e.g. `github.com/org/repo/Home.md`). A real
// repo directory never looks like `label.tld`; `.github` (leading dot) does NOT
// match (the first char must be alphanumeric).
const HOSTLIKE_FIRST_SEG_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** The inner text of every backtick code span in `text`, split into individual
 *  lines. Matching commands per-line keeps `\s+` in the command regexes from
 *  fusing a runner with a token on a separate span/line. */
function codeLines(text: string): string[] {
  const lines: string[] = [];
  for (const m of text.matchAll(CODE_SPAN_RE))
    for (const line of m[1].split("\n")) lines.push(line);
  return lines;
}

/**
 * Extract the literal `file:line` and command references from an entry's text.
 * Conservative by design:
 * - A file token is only kept when it has a `:line` suffix OR a `/` path
 *   separator (so prose like `e.g`, `i.e`, and bare words are never files), and
 *   its first path segment must not look like a DNS host (so bare URLs like
 *   `github.com/org/repo/x.md` are rejected).
 * - A command token is only kept when it appears inside a backtick code span
 *   (so prose like "make decisions"/"yarn about" is never a command).
 * Deduplicated by raw token (within this text).
 */
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
    // Reject relative URLs whose first segment is a DNS host (`github.com/...`,
    // `www.example.com/...`). Absolute-path URLs (`/host/...`) are handled
    // downstream by the isAbsolute → "unknown" guard.
    const slashIdx = path.indexOf("/");
    if (slashIdx > 0 && HOSTLIKE_FIRST_SEG_RE.test(path.slice(0, slashIdx)))
      continue;
    const line = hasLine ? Number.parseInt(raw.slice(colonIdx + 1), 10) : null;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({
      kind: "file",
      path,
      line: Number.isNaN(line) ? null : line,
      raw,
    });
  }

  // Symbol refs are only meaningful when the entry also anchors a file (the
  // adjacency bound from #911): a backtick identifier with no co-cited file is
  // too unmoored to act on. Computed once, before the code-span scan.
  const hasFileRef = out.some((r) => r.kind === "file");

  // Commands only from inside backtick code spans, matched PER LINE (see
  // codeLines rationale) so neither separate spans nor separate lines can fuse
  // a runner with an unrelated following token into a phantom command.
  for (const line of codeLines(text)) {
    for (const m of line.matchAll(PM_CMD_RE)) {
      const runner = m[1] as "pnpm" | "npm" | "yarn";
      const explicit = m[2] !== undefined; // had a `run` verb
      const script = m[3];
      if (PM_BUILTINS.has(script)) continue;
      const raw = m[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push({ kind: "command", runner, script, explicit, raw });
    }

    for (const m of line.matchAll(MAKE_CMD_RE)) {
      const script = m[1];
      const raw = m[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push({
        kind: "command",
        runner: "make",
        script,
        explicit: false,
        raw,
      });
    }

    // Symbols: only when the entry anchors a file (adjacency bound) and the
    // token passes the codey-shape gate. `raw` is the bare name (a `foo` and a
    // `foo(` citation dedupe to one resolve).
    if (!hasFileRef) continue;
    for (const m of line.matchAll(SYMBOL_CAND_RE)) {
      const name = m[1];
      const callLike = m[2] !== undefined;
      if (!isCodeySymbol(name, callLike)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ kind: "symbol", name, raw: name });
    }
  }

  return out;
}

/** The basename (last `/`-segment) of a path, preserving its original case. */
function basenameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Append `value` to the array at `key`, creating the array on first insert.
 *  Used to build the case-folded `filesLower`/`basenames` indices in both the
 *  Direct-FS walk and the probe snapshot parser. */
function pushIndex(
  map: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
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
  /** Set of repo-relative file paths, ACTUAL case (fast exact-case existence). */
  files: Set<string>;
  /** lowercased repo-relative path -> actual-case path(s) (case-insensitive
   *  fallback). An array len > 1 means a case-collision (`Foo.ts`/`foo.ts` on a
   *  case-sensitive FS) — ambiguous, so the resolver stays neutral. */
  filesLower: Map<string, string[]>;
  /** lowercased basename -> actual-case repo-relative paths (for bare-filename
   *  resolution + ambiguity). Keyed case-insensitively; values keep the real
   *  case so `lineCount` reads the right file. */
  basenames: Map<string, string[]>;
  /** package.json script names, or null if package.json is unavailable. */
  scripts: Set<string> | null;
  /** Makefile target names, or null if no Makefile. */
  makeTargets: Set<string> | null;
  /** Cited symbol names confirmed PRESENT (word-boundary occurrence anywhere in
   *  tracked source, incl. usages/comments). `null` when symbol presence is
   *  entirely unavailable (non-git repo, `find` fallback) — every symbol ref then
   *  resolves "unknown" (neutral). Subset of `searchedSymbols`. (#911) */
  presentSymbols: Set<string> | null;
  /** Cited symbol names the resolver DEFINITIVELY searched for (grep ran and
   *  returned found/not-found). A symbol in `searchedSymbols` but not
   *  `presentSymbols` is confirmed-ABSENT → "missing"; a symbol that was NOT
   *  searched (grep errored, e.g. exit 128) is omitted from both sets → "unknown"
   *  (neutral), never a false "missing". `null` whenever `presentSymbols` is null.
   *  This is what keeps a transient grep error off the dangerous side of the 🔴
   *  invariant. (#911) */
  searchedSymbols: Set<string> | null;
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
  if (ref.kind === "symbol") {
    // Presence resolution (#911), three-way so a grep error is never a false
    // "missing": no presence info at all → neutral; found → ok; searched and not
    // found → missing (confirmed absent); searched-set present but this name not
    // in it (grep errored for it) → neutral. "Found anywhere" (incl.
    // usage/comment) counts as ok — declining definition-vs-usage precision keeps
    // us off the dangerous side of the 🔴 invariant. NOTE: a "missing" here is
    // only ACTED ON by validateProjectReferences when the symbol was previously
    // confirmed present (drift); a never-present external/historical mention is a
    // no-op. The pure verdict stays presence-shaped so both modes agree.
    if (view.presentSymbols == null) return "unknown";
    if (view.presentSymbols.has(ref.name)) return "ok";
    if (view.searchedSymbols != null && !view.searchedSymbols.has(ref.name))
      return "unknown"; // not definitively searched (grep error) → neutral
    return "missing"; // searched and absent
  }

  if (ref.kind === "command") {
    // `make` has no `run` verb and "make X" reads as prose ("make sense"); it is
    // confirm-only — an absent target is UNKNOWN (neutral), never "missing".
    if (ref.runner === "make") {
      if (view.makeTargets == null) return "unknown";
      return view.makeTargets.has(ref.script) ? "ok" : "unknown";
    }
    // pnpm/npm/yarn resolve against package.json scripts. A present script is
    // "ok" either way. For an ABSENT script we only penalize ("missing") when the
    // reference was an EXPLICIT `<pm> run <script>` — a bare `<pm> <word>` is
    // ambiguous with a noun phrase ("npm registry", "yarn about", "pnpm
    // workspace") and must stay neutral ("unknown"). (Mirrors the explicit-verb
    // guard from the verifier-detection fix in PR #927.)
    if (view.scripts == null) return "unknown";
    if (view.scripts.has(ref.script)) return "ok";
    return ref.explicit ? "missing" : "unknown";
  }

  // file ref
  if (isAbsolute(ref.path)) return "unknown";
  // Normalize `.`/`..` segments, then force forward slashes: on Windows
  // `path.normalize` emits backslashes, but `view.files`/`basenames` are built
  // with forward slashes on every platform (both the FS walk and the probe
  // snapshot), so a backslash path would never match → false "missing". (Seer.)
  const rel = normalize(ref.path).replace(/\\/g, "/");
  if (rel.startsWith("..")) return "unknown";

  // Reference file resolution is case-INSENSITIVE (#969): a citation like
  // `DB.ts` for an actual `db.ts` must not false-"missing" on a case-sensitive
  // FS ("cannot verify" ≠ "broken"). We prefer an exact-case hit, then fall back
  // to a case-folded lookup; a case-collision (two siblings differing only in
  // case) is ambiguous and stays neutral so we never emit a false penalty. The
  // resolved ACTUAL-case path is what feeds `lineCount` (the line bound below).
  let targetExists: boolean;
  let target: string | undefined;
  if (ref.path.includes("/")) {
    if (view.files.has(rel)) {
      target = rel; // exact case
      targetExists = true;
    } else {
      const ci = view.filesLower.get(rel.toLowerCase()) ?? [];
      if (ci.length === 1) {
        target = ci[0];
        targetExists = true;
      } else if (ci.length > 1) {
        return "unknown"; // case-collision → ambiguous → neutral
      } else {
        targetExists = false;
      }
    }
  } else {
    const matches = view.basenames.get(rel.toLowerCase()) ?? [];
    if (matches.length === 0) targetExists = false;
    else if (matches.length === 1) {
      target = matches[0];
      targetExists = true;
    } else {
      // Several files share this case-folded basename. Prefer a UNIQUE
      // exact-case match (preserves the prior precise behavior); a genuinely
      // ambiguous set stays neutral.
      const exact = matches.filter((p) => basenameOf(p) === ref.path);
      if (exact.length === 1) {
        target = exact[0];
        targetExists = true;
      } else return "unknown"; // ambiguous → neutral
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

  async resolve(refs: Reference[]): Promise<Map<string, RefStatus> | null> {
    // The file/command view is ref-independent and cached. Symbol presence IS
    // ref-dependent (we grep for exactly the cited names), so compute it per
    // batch and overlay it onto a fresh view for this call (#911).
    const names = [
      ...new Set(refs.flatMap((r) => (r.kind === "symbol" ? [r.name] : []))),
    ];
    const sym = this.symbolPresence(names);
    const view: RepoView = {
      ...this.repoView(),
      presentSymbols: sym?.present ?? null,
      searchedSymbols: sym?.searched ?? null,
    };
    const map = new Map<string, RefStatus>();
    for (const ref of refs) map.set(ref.raw, resolveRefAgainstView(ref, view));
    return map;
  }

  /** Which of `names` are present vs definitively searched, via `git grep`.
   *  Returns null when symbol presence can't be determined at all (root isn't a
   *  git work tree / git unavailable) → every symbol ref stays "unknown". An
   *  empty input yields empty sets (irrelevant — no symbol refs to resolve).
   *
   *  Greps from the repo TOPLEVEL (not `this.root`) so a symbol defined in a
   *  sibling package of a monorepo still resolves — matching the synthetic
   *  probe's `cd $(git rev-parse --show-toplevel)` so the two modes agree (SF3).
   *  `GIT_*` env is scrubbed so a gateway launched under a stray `GIT_DIR` /
   *  `GIT_INDEX_FILE` can't grep the wrong repo and mass-false-miss (SF2).
   *  A grep exit of 0=present, 1=absent; ANY other status (128 error, signal)
   *  leaves the name UNSEARCHED → "unknown" (SF1) — never a false "missing". */
  private symbolPresence(
    names: string[],
  ): { present: Set<string>; searched: Set<string> } | null {
    if (names.length === 0) return { present: new Set(), searched: new Set() };
    const env = scrubbedGitEnv();
    const top = spawnSync(
      "git",
      ["-C", this.root, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", env },
    );
    if (top.status !== 0) return null;
    const cwd = top.stdout.trim();
    if (!cwd) return null;
    const present = new Set<string>();
    const searched = new Set<string>();
    for (const name of names) {
      // Defense-in-depth: extraction already guarantees this charset, but assert
      // again so a future regex change can't turn a name into a grep argument we
      // can't reason about. A non-conforming name is left UNSEARCHED → neutral.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      // `-q` short-circuits on first hit (bounded, fast); `-w` whole word (so
      // `foo` never matches `foobar`); `-F` fixed string; `--` so a name can't be
      // read as a flag.
      const r = spawnSync("git", ["-C", cwd, "grep", "-qwF", "--", name], {
        encoding: "utf8",
        env,
      });
      if (r.status === 0) {
        present.add(name);
        searched.add(name);
      } else if (r.status === 1) {
        searched.add(name); // definitively absent
      }
      // any other status (e.g. 128 / null) → unsearched → "unknown" (neutral)
    }
    return { present, searched };
  }

  private repoView(): RepoView {
    if (this.view) return this.view;
    const walk = this.walk();
    const root = this.root;
    this.view = {
      files: walk.files,
      filesLower: walk.filesLower,
      basenames: walk.basenames,
      truncated: walk.truncated,
      // Placeholders — symbol presence is computed per batch in resolve() and
      // overlaid; the cached file/command view never carries it.
      presentSymbols: null,
      searchedSymbols: null,
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
    filesLower: Map<string, string[]>;
    basenames: Map<string, string[]>;
    truncated: boolean;
  } {
    const files = new Set<string>();
    const filesLower = new Map<string, string[]>();
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
          pushIndex(filesLower, relPath.toLowerCase(), relPath);
          pushIndex(basenames, e.name.toLowerCase(), relPath);
        }
      }
    };
    recur(this.root, "");
    return { files, filesLower, basenames, truncated };
  }
}

// --- No-op resolver --------------------------------------------------------

/** Always-neutral resolver: every batch is unverifiable. Used when the gateway
 *  cannot reach a filesystem and no probe is available. */
export class NoopResolver implements ReferenceResolver {
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
// #911 symbol section. PROBE_SYMS opens it; PROBE_SYMS_OK is emitted ONLY inside
// the `git`-present branch (so "grep ran" is distinguishable from "git absent");
// PROBE_SYMS_DONE is emitted ONLY after every per-symbol grep completed, so a
// truncated probe (output cut mid-section) yields a NULL set instead of a partial
// one that would false-"missing" the un-emitted symbols (SF4). Between OK and
// DONE, each searched symbol emits `name\t1` (present) or `name\t0` (absent); a
// grep that errored emits nothing → the name stays UNSEARCHED → "unknown".
const PROBE_SYMS = "===LORE-SYMS===";
const PROBE_SYMS_OK = "===LORE-SYMS-OK===";
const PROBE_SYMS_DONE = "===LORE-SYMS-DONE===";

/** A copy of the process env with git context-overrides removed, so a `git grep`
 *  the gateway spawns can't be redirected to the wrong repo (or a `/dev/null`
 *  index) by an inherited `GIT_DIR` / `GIT_INDEX_FILE` / `GIT_WORK_TREE` and
 *  mass-false-miss every symbol (#911 SF2). */
function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
  ])
    delete env[k];
  return env;
}

/**
 * Build the read-only shell probe that emits a repo snapshot: the tracked file
 * list, package.json, the Makefile, and `<path>\t<lineCount>` for every tracked
 * file whose basename is referenced (so line-range checks work without dumping
 * counts for the whole tree).
 */
export function buildRefcheckProbeScript(refs: Reference[]): string {
  const basenames = new Set<string>();
  for (const ref of refs) {
    if (ref.kind !== "file") continue;
    const bn = basenameOf(ref.path);
    // Defense-in-depth: the extraction charset already excludes shell
    // metacharacters, but assert it again at the interpolation site so a future
    // regex broadening can't silently turn `__refset='…'` into a shell-injection
    // sink. A non-conforming basename is simply dropped (no line-count check).
    // Lowercased so the membership test matches the (also-lowercased) basename
    // emitted by the shell — reference resolution is case-insensitive (#969).
    // Lowercasing preserves the `[A-Za-z0-9_.-]` charset, so it stays injection-safe.
    if (/^[A-Za-z0-9_.-]+$/.test(bn)) basenames.add(bn.toLowerCase());
  }
  // `|a.ts|b.ts|` — a glob-case membership test; basenames are metachar-free.
  const refset = `|${[...basenames].join("|")}|`;

  // Cited symbols (#911), identifier-charset only (single-quote-safe; assert
  // again as defense-in-depth). One grep per symbol, emitted as a literal command
  // list (no shell `for … in`, so an empty list is a non-issue). Each emits
  // `name\t1` (present) or `name\t0` (absent); a grep that ERRORED (exit 128, not
  // 0/1) emits nothing → the parser leaves it UNSEARCHED → "unknown" (SF1). The
  // grep runs from the repo root (leading `cd` subshell) so it agrees with the
  // toplevel-scoped Direct-FS grep.
  const symbols = new Set<string>();
  for (const ref of refs) {
    if (ref.kind !== "symbol") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.name)) symbols.add(ref.name);
  }
  const symbolLines = [...symbols].map(
    (s) =>
      `git grep -qwF -- '${s}' 2>/dev/null; case $? in 0) printf '%s\\t1\\n' '${s}';; 1) printf '%s\\t0\\n' '${s}';; esac`,
  );
  // Run the snapshot from the REPO ROOT, not the client's CWD. `git ls-files`
  // (and the `find` fallback) emit paths relative to the working directory, but
  // knowledge refs are repo-root-relative (`packages/core/src/db.ts:42`). An
  // agent launched from a subdirectory would otherwise produce subdir-relative
  // paths → every root-relative ref "missing" → mass false penalty. The cd runs
  // in a subshell so it cannot affect the (already-emitted) resolution section
  // of a combined probe; a non-git CWD falls back to `.` (current behavior).
  return [
    `( cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" 2>/dev/null`,
    `__f=$(git ls-files 2>/dev/null)`,
    `[ -z "$__f" ] && __f=$(find . \\( -name node_modules -o -name .git -o -name dist -o -name build -o -name coverage \\) -prune -o -type f -print 2>/dev/null | sed 's|^\\./||')`,
    `printf '%s\\n' "$__f"`,
    `printf '%s\\n' '${PROBE_PKG}'`,
    `cat package.json 2>/dev/null`,
    `printf '%s\\n' '${PROBE_MAKE}'`,
    `for mf in Makefile makefile GNUmakefile; do [ -f "$mf" ] && { cat "$mf"; break; }; done`,
    `printf '%s\\n' '${PROBE_LINES}'`,
    `__refset='${refset}'`,
    `printf '%s\\n' "$__f" | while IFS= read -r f; do bn=$(printf '%s' "\${f##*/}" | tr '[:upper:]' '[:lower:]'); case "$__refset" in *"|$bn|"*) printf '%s\\t%s\\n' "$f" "$(wc -l < "$f" 2>/dev/null)";; esac; done`,
    // Symbol section: OK is printed only inside a git work tree (so the parser
    // tells "ran" from "git absent"); DONE is printed only after EVERY per-symbol
    // grep completed, so a truncated probe → no DONE → neutral (SF4), never a
    // partial set that false-misses the un-emitted symbols.
    `printf '%s\\n' '${PROBE_SYMS}'`,
    `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
    `printf '%s\\n' '${PROBE_SYMS_OK}'`,
    ...symbolLines,
    `printf '%s\\n' '${PROBE_SYMS_DONE}'`,
    `fi`,
    // Force a 0 exit: a per-symbol `git grep -q` returns 1 when absent, which
    // would otherwise make the whole probe exit non-zero → the client tool marks
    // it `isError` → the ENTIRE refcheck batch goes neutral. A trailing `true`
    // keeps a legitimately-absent symbol a real signal, not a silent batch abort.
    `true`,
    `)`,
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

  // The symbol section (if any) follows PROBE_LINES, so the lines block ends
  // where it begins. Older probes have no PROBE_SYMS — lines run to EOF.
  const symsAt = text.indexOf(PROBE_SYMS);
  const fileBlock = text.slice(0, pkgAt);
  const pkgBlock = text.slice(pkgAt + PROBE_PKG.length, makeAt);
  const makeBlock = text.slice(makeAt + PROBE_MAKE.length, linesAt);
  const linesBlock = text.slice(
    linesAt + PROBE_LINES.length,
    symsAt === -1 ? text.length : symsAt,
  );

  const files = new Set<string>();
  const filesLower = new Map<string, string[]>();
  const basenames = new Map<string, string[]>();
  for (const raw of fileBlock.split("\n")) {
    const f = raw.trim();
    if (!f) continue;
    files.add(f);
    // Case-folded indices (#969), keyed lowercase with actual-case values —
    // identical shape to the Direct-FS walk so the two modes stay in parity.
    pushIndex(filesLower, f.toLowerCase(), f);
    pushIndex(basenames, basenameOf(f).toLowerCase(), f);
  }
  // An empty file list means the probe couldn't enumerate the repo (git absent
  // AND `find` empty, or it ran in the wrong place) — the snapshot is
  // unverifiable, not "every file is missing". Treat as neutral (null) so a
  // degenerate probe can never mass-penalize. (A genuinely empty repo has no
  // refs to resolve anyway.)
  if (files.size === 0) return null;

  const lineCounts = new Map<string, number>();
  for (const raw of linesBlock.split("\n")) {
    const tab = raw.indexOf("\t");
    if (tab === -1) continue;
    const path = raw.slice(0, tab).trim();
    const n = Number.parseInt(raw.slice(tab + 1).trim(), 10);
    if (path && !Number.isNaN(n)) lineCounts.set(path, n + 1); // +1: trailing-newline lenience, mirrors Direct-FS split
  }

  // Symbol presence (#911): both sets are null unless the section is bounded by
  // BOTH the OK marker (client ran `git grep`) AND the DONE marker (every grep
  // completed — output not truncated). Each `name\t1` line is present+searched;
  // `name\t0` is searched-absent; an errored grep emitted nothing → unsearched →
  // "unknown". Missing OK (git absent) / missing DONE (truncated) / old probe →
  // null (neutral), so a degenerate or cut-off probe can never false-"missing".
  let presentSymbols: Set<string> | null = null;
  let searchedSymbols: Set<string> | null = null;
  if (symsAt !== -1) {
    const symsBlock = text.slice(symsAt + PROBE_SYMS.length);
    const okAt = symsBlock.indexOf(PROBE_SYMS_OK);
    const doneAt = symsBlock.indexOf(PROBE_SYMS_DONE);
    if (okAt !== -1 && doneAt !== -1 && doneAt > okAt) {
      const present = new Set<string>();
      const searched = new Set<string>();
      for (const raw of symsBlock
        .slice(okAt + PROBE_SYMS_OK.length, doneAt)
        .split("\n")) {
        const tab = raw.indexOf("\t");
        if (tab === -1) continue;
        const name = raw.slice(0, tab).trim();
        const bit = raw.slice(tab + 1).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        if (bit === "1") {
          present.add(name);
          searched.add(name);
        } else if (bit === "0") {
          searched.add(name);
        }
      }
      presentSymbols = present;
      searchedSymbols = searched;
    }
  }

  return {
    files,
    filesLower,
    basenames,
    presentSymbols,
    searchedSymbols,
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
