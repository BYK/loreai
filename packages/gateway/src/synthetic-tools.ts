/**
 * Synthetic tool primitive — inject + capture + strip local runtime queries
 * without involving the LLM.
 *
 * The gateway identifies a tool the CLIENT already exposes (a file-reader or
 * shell), emits a synthetic `tool_use` for it, captures the `tool_result` on
 * the next request, and strips the entire round-trip before forwarding
 * upstream. The LLM never sees the exchange.
 *
 * Strategy: **try every known name ∪ shape-match**. The known-name allowlist
 * is a fast-path / corroboration, but shape (the parameter schema) is the
 * authoritative decider — unknown, renamed, or namespaced tools still match.
 */

import { normalizeRemoteUrl, log } from "@loreai/core";

import type {
  GatewayTool,
  GatewayToolUseBlock,
  GatewayRequest,
  GatewayContentBlock,
} from "./translate/types";

// ---------------------------------------------------------------------------
// Synthetic tool-use ID — recognizable prefix so we can strip our own blocks
// ---------------------------------------------------------------------------

const SYNTHETIC_ID_PREFIX = "lore_syn_";

/** Mint a unique synthetic tool_use ID. */
export function mintSyntheticToolUseId(): string {
  return `${SYNTHETIC_ID_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Check whether a tool_use ID was minted by us. */
export function isSyntheticToolUseId(id: string): boolean {
  return typeof id === "string" && id.startsWith(SYNTHETIC_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// Tool target descriptors — what the gateway discovered about the client tool
// ---------------------------------------------------------------------------

export type ReadToolTarget = {
  kind: "read";
  toolName: string;
  /** Detected path parameter name (e.g. "filePath", "path", "file_path"). */
  pathParam: string;
  /** Values for OTHER required params we must fill for the harness to accept. */
  extraRequired: Record<string, unknown>;
};

export type ShellToolTarget = {
  kind: "shell";
  toolName: string;
  /** Detected command parameter name (e.g. "command", "cmd", "commands"). */
  commandParam: string;
  /** True when the command param is `string[]` (Codex-classic, Cline-SDK). */
  commandIsArray: boolean;
  /** Values for OTHER required params (e.g. OpenCode `description`, Cline `requires_approval`). */
  extraRequired: Record<string, unknown>;
};

export type SyntheticToolTarget = ReadToolTarget | ShellToolTarget;

// ---------------------------------------------------------------------------
// Schema introspection helpers
// ---------------------------------------------------------------------------

type SchemaProperty = {
  type?: string;
  enum?: unknown[];
  items?: { type?: string };
};

type InputSchema = {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
};

/** Safely extract typed schema from a GatewayTool's inputSchema. */
function parseSchema(tool: GatewayTool): InputSchema | null {
  const s = tool.inputSchema as InputSchema | undefined;
  if (!s || typeof s !== "object" || !s.properties) return null;
  return s;
}

/**
 * Normalize a tool name for matching — strip namespace prefixes (MCP, dot-
 * delimited), lowercase, remove non-alphanumeric characters.
 *
 * Examples:
 *   "mcp__filesystem__read_file" → "readfile"
 *   "filesystem/read_file"       → "readfile"
 *   "functions.Read"             → "read"
 *   "Bash"                       → "bash"
 */
function normalizeName(name: string): string {
  // Take the last segment after __, /, or .
  const segments = name.split(/__|[/.]/);
  const last = segments[segments.length - 1] ?? name;
  return last.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Normalize a parameter name for allowlist comparison.
 * Strips underscores, lowercases.   "file_path" → "filepath", "filePath" → "filepath"
 */
function normalizeParamName(name: string): string {
  return name.toLowerCase().replace(/_/g, "");
}

/** Known path-parameter names (normalized). */
const PATH_PARAM_NAMES = new Set(["filepath", "path", "absolutepath", "file"]);

/** Known command-parameter names (normalized). */
const CMD_PARAM_NAMES = new Set([
  "command",
  "cmd",
  "commands",
  "shellcommand",
  "script",
]);

/** Parameters whose presence disqualifies a tool as a plain file-reader. */
const READ_DISQUALIFIERS = new Set([
  "content",
  "oldstring",
  "oldtext",
  "newstring",
  "newtext",
  "edits",
  "diff",
  "patch",
  "pattern",
  "regex",
  "query",
  "queries",
]);

// ---------------------------------------------------------------------------
// findReadTool — dynamic shape-match for a file-reader
// ---------------------------------------------------------------------------

/**
 * Find a tool that can read a file, preferring plain readers over dual-purpose
 * tools (like OpenHands `file_editor` with `command:"view"`).
 *
 * Disqualifies write/edit/grep/search tools by checking for conflicting
 * required parameters.
 */
export function findReadTool(tools: GatewayTool[]): ReadToolTarget | null {
  let fileEditorFallback: ReadToolTarget | null = null;

  for (const tool of tools) {
    const schema = parseSchema(tool);
    if (!schema?.properties) continue;

    const required = new Set(schema.required ?? []);
    const props = schema.properties;

    // Find a required string param whose normalized name is a known path name.
    let pathParam: string | null = null;
    for (const [name, prop] of Object.entries(props)) {
      if (!required.has(name)) continue;
      if (prop.type !== "string") continue;
      if (prop.enum) continue; // enum string ≠ free-form path
      if (PATH_PARAM_NAMES.has(normalizeParamName(name))) {
        pathParam = name;
        break;
      }
    }
    if (!pathParam) continue;

    // Check for disqualifying required params (content, edits, pattern, …).
    let disqualified = false;
    for (const reqName of required) {
      if (reqName === pathParam) continue;
      const norm = normalizeParamName(reqName);
      if (READ_DISQUALIFIERS.has(norm)) {
        disqualified = true;
        break;
      }
    }
    if (disqualified) continue;

    // Check for a `command` enum containing "view" (OpenHands file_editor).
    const commandProp = Object.entries(props).find(
      ([n]) =>
        normalizeParamName(n) === "command" || normalizeParamName(n) === "mode",
    );
    if (commandProp) {
      const [cmdName, cmdPropDef] = commandProp;
      if (
        cmdPropDef.enum &&
        Array.isArray(cmdPropDef.enum) &&
        cmdPropDef.enum.includes("view")
      ) {
        // This is a dual-purpose editor with a "view" mode — use as fallback.
        if (!fileEditorFallback) {
          const extra: Record<string, unknown> = { [cmdName]: "view" };
          // Fill other required params
          fillExtraRequired(extra, schema, new Set([pathParam, cmdName]));
          fileEditorFallback = {
            kind: "read",
            toolName: tool.name,
            pathParam,
            extraRequired: extra,
          };
        }
        continue; // prefer a plain reader
      }
      // Has a non-view command/mode param — this isn't a reader.
      if (required.has(commandProp[0])) continue;
    }

    // Also disqualify if a required param looks command-like (shell tool, not reader).
    let hasShellParam = false;
    for (const reqName of required) {
      if (reqName === pathParam) continue;
      const norm = normalizeParamName(reqName);
      if (CMD_PARAM_NAMES.has(norm)) {
        hasShellParam = true;
        break;
      }
    }
    if (hasShellParam) continue;

    // Plain reader — build the target.
    const extraRequired: Record<string, unknown> = {};
    fillExtraRequired(extraRequired, schema, new Set([pathParam]));

    return {
      kind: "read",
      toolName: tool.name,
      pathParam,
      extraRequired,
    };
  }

  return fileEditorFallback;
}

// ---------------------------------------------------------------------------
// findShellTool — dynamic shape-match for a shell/command executor
// ---------------------------------------------------------------------------

/**
 * Find a tool that can execute a shell command.
 *
 * Matches tools with a required `command`/`cmd`/`commands` param (string or
 * string[]), excluding enum-constrained params (which are mode selectors,
 * not free-form commands) and `code` params (Python runners, not shells).
 */
export function findShellTool(tools: GatewayTool[]): ShellToolTarget | null {
  for (const tool of tools) {
    const schema = parseSchema(tool);
    if (!schema?.properties) continue;

    const required = new Set(schema.required ?? []);
    const props = schema.properties;

    // Find a required string/string[] param whose normalized name is cmd-like.
    let commandParam: string | null = null;
    let commandIsArray = false;
    for (const [name, prop] of Object.entries(props)) {
      if (!required.has(name)) continue;
      const norm = normalizeParamName(name);
      if (!CMD_PARAM_NAMES.has(norm)) continue;

      // Reject enum-constrained (mode selectors like file_editor `command`).
      if (prop.enum) continue;

      if (prop.type === "string") {
        commandParam = name;
        commandIsArray = false;
        break;
      }
      if (prop.type === "array" && prop.items?.type === "string") {
        commandParam = name;
        commandIsArray = true;
        break;
      }
    }
    if (!commandParam) continue;

    // Corroborate: description should mention shell/bash/command/terminal/CLI,
    // OR the normalized tool name should look shell-like. This prevents
    // false positives on tools that happen to have a `command` param
    // but aren't shell executors (e.g. file_editor with enum `command`
    // — already excluded above, but belt-and-suspenders).
    const desc = tool.description.toLowerCase();
    const nameNorm = normalizeName(tool.name);
    const shellSignals =
      /\b(shell|bash|command|terminal|cli|execute|exec|pty)\b/;
    const nameSignals =
      /^(bash|sh|shell|terminal|execcommand|executecommand|runcommand|runcommands|runshellcommand|unifiedexec)$/;
    if (!shellSignals.test(desc) && !nameSignals.test(nameNorm)) {
      continue;
    }

    const extraRequired: Record<string, unknown> = {};
    fillExtraRequired(extraRequired, schema, new Set([commandParam]));

    return {
      kind: "shell",
      toolName: tool.name,
      commandParam,
      commandIsArray,
      extraRequired,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fill OTHER required params with benign defaults
// ---------------------------------------------------------------------------

/**
 * Walk the schema's `required` array minus `exclude` and fill `target` with
 * benign defaults by JSON type — so the harness doesn't reject the call for
 * missing required params.
 */
function fillExtraRequired(
  target: Record<string, unknown>,
  schema: InputSchema,
  exclude: Set<string>,
): void {
  const required = schema.required ?? [];
  const props = schema.properties ?? {};
  for (const name of required) {
    if (exclude.has(name)) continue;
    if (name in target) continue; // already set (e.g. command:"view")
    const prop = props[name];
    if (!prop) continue;

    if (prop.type === "string") {
      if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
        target[name] = prop.enum[0]; // first allowed value
      } else {
        target[name] = "Resolve project root for Lore memory attribution";
      }
    } else if (prop.type === "boolean") {
      target[name] = false;
    } else if (prop.type === "number" || prop.type === "integer") {
      target[name] = 0;
    }
    // Other types (object, array) — skip; rare for required shell/read params.
  }
}

// ---------------------------------------------------------------------------
// Build a synthetic tool_use block for a project-resolution probe
// ---------------------------------------------------------------------------

/**
 * Shell script that discovers the project root, remote, HEAD, and cwd.
 *
 * Uses `;` (not `&&`) as the command separator so each command runs
 * independently — a missing git repo shouldn't prevent `pwd` from
 * reporting the client's working directory.
 */
const RESOLVE_PROJECT_SCRIPT = [
  "git rev-parse --show-toplevel 2>/dev/null",
  "git config --get remote.upstream.url 2>/dev/null || git config --get remote.origin.url 2>/dev/null",
  "git rev-parse HEAD 2>/dev/null",
  "pwd",
].join("; ");

/**
 * Build the `input` object for a synthetic tool_use that probes for
 * project information.
 */
export function buildResolveProjectInput(
  target: SyntheticToolTarget,
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...target.extraRequired };

  if (target.kind === "read") {
    input[target.pathParam] = ".git/config";
  } else {
    // Shell: wrap in array if needed.
    if (target.commandIsArray) {
      input[target.commandParam] = ["bash", "-lc", RESOLVE_PROJECT_SCRIPT];
    } else {
      input[target.commandParam] = RESOLVE_PROJECT_SCRIPT;
    }
  }
  return input;
}

/**
 * Build a synthetic shell tool_use that runs an arbitrary read-only `script`
 * (used by the #627 reference-validity probe). Mirrors buildResolveProjectInput's
 * array-vs-string handling. The caller is responsible for the script being
 * read-only and shell-injection-safe.
 */
export function buildShellProbeBlock(
  target: ShellToolTarget,
  script: string,
): GatewayToolUseBlock {
  const input: Record<string, unknown> = { ...target.extraRequired };
  input[target.commandParam] = target.commandIsArray
    ? ["bash", "-lc", script]
    : script;
  return {
    type: "tool_use",
    id: mintSyntheticToolUseId(),
    name: target.toolName,
    input,
  };
}

/** Marker separating the project-resolution output from the appended
 *  reference-validity snapshot in a combined shell probe (#627 piggyback). */
export const REFCHECK_SECTION_SEP = "===LORE-REFCHECK-SNAPSHOT===";

/**
 * Build a SHELL probe that runs the project-resolution script AND, after a
 * separator, an appended read-only reference-validity snapshot script (#627). A
 * single round-trip carries both — refcheck never adds its own injection. Only
 * valid for the shell stage (the read probe can't run a script).
 */
export function buildCombinedResolveRefcheckBlock(
  target: ShellToolTarget,
  refcheckScript: string,
): GatewayToolUseBlock {
  const combined = `${RESOLVE_PROJECT_SCRIPT}\nprintf '%s\\n' '${REFCHECK_SECTION_SEP}'\n${refcheckScript}`;
  return buildShellProbeBlock(target, combined);
}

/** Split a combined probe's output into the resolution part and the refcheck
 *  snapshot part. Returns refcheck=null when the separator is absent (the probe
 *  was resolution-only). */
export function splitProbeOutput(text: string): {
  resolution: string;
  refcheck: string | null;
} {
  const i = text.indexOf(REFCHECK_SECTION_SEP);
  if (i === -1) return { resolution: text, refcheck: null };
  return {
    resolution: text.slice(0, i),
    refcheck: text.slice(i + REFCHECK_SECTION_SEP.length),
  };
}

/** Build a complete GatewayToolUseBlock for a synthetic probe. */
export function buildSyntheticToolUseBlock(
  target: SyntheticToolTarget,
): GatewayToolUseBlock {
  return {
    type: "tool_use",
    id: mintSyntheticToolUseId(),
    name: target.toolName,
    input: buildResolveProjectInput(target),
  };
}

// ---------------------------------------------------------------------------
// Capture a returning tool_result from the client
// ---------------------------------------------------------------------------

/**
 * Scan the request's messages for a tool_result matching our pending
 * synthetic tool_use ID. Returns the text content + error flag, or null.
 */
export function captureSyntheticToolResult(
  req: GatewayRequest,
  pendingToolUseId: string,
): { text: string; isError: boolean } | null {
  for (const msg of req.messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (block.toolUseId !== pendingToolUseId) continue;
      // Extract text from the content blocks.
      const textParts: string[] = [];
      for (const sub of block.content) {
        if (sub.type === "text") textParts.push(sub.text);
      }
      return { text: textParts.join("\n"), isError: block.isError === true };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strip synthetic tool round-trip from the conversation
// ---------------------------------------------------------------------------

/**
 * Remove ALL synthetic tool_use and tool_result blocks from the request's
 * messages so the LLM never sees the probe exchange. Mutates in place.
 *
 * After stripping, any message left with an empty `content` array is removed
 * entirely to preserve message-alternation invariants.
 */
export function stripSyntheticRoundTrips(req: GatewayRequest): boolean {
  let stripped = false;

  for (const msg of req.messages) {
    const before = msg.content.length;
    msg.content = msg.content.filter((block: GatewayContentBlock) => {
      if (block.type === "tool_use" && isSyntheticToolUseId(block.id)) {
        return false;
      }
      if (
        block.type === "tool_result" &&
        isSyntheticToolUseId(block.toolUseId)
      ) {
        return false;
      }
      return true;
    });
    if (msg.content.length < before) stripped = true;
  }

  // Remove empty messages.
  if (stripped) {
    req.messages = req.messages.filter((m) => m.content.length > 0);
  }

  return stripped;
}

// ---------------------------------------------------------------------------
// Parse the raw probe output into project-resolution data
// ---------------------------------------------------------------------------

export type ResolveProjectResult = {
  root?: string;
  gitRemote?: string;
  gitHead?: string;
};

/**
 * Parse the output of a read probe (`.git/config` file contents).
 *
 * Extracts the `url = …` line under `[remote "upstream"]` (preferred)
 * or `[remote "origin"]`. Only yields `gitRemote`.
 */
function parseGitConfig(text: string): ResolveProjectResult {
  const result: ResolveProjectResult = {};

  // Parse INI-style git config. Track current section.
  let currentRemote: string | null = null;
  let originUrl: string | null = null;
  let upstreamUrl: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Section header: [remote "origin"]
    const sectionMatch = /^\[remote\s+"([^"]+)"\]/.exec(line);
    if (sectionMatch) {
      currentRemote = sectionMatch[1];
      continue;
    }
    // Any other section header resets
    if (line.startsWith("[")) {
      currentRemote = null;
      continue;
    }
    // url = ... line within a remote section
    if (currentRemote) {
      const urlMatch = /^\s*url\s*=\s*(.+)/.exec(line);
      if (urlMatch) {
        const url = urlMatch[1].trim();
        if (currentRemote === "upstream") {
          upstreamUrl = url;
        } else if (currentRemote === "origin") {
          originUrl = url;
        }
      }
    }
  }

  const rawUrl = upstreamUrl ?? originUrl;
  if (rawUrl) {
    try {
      result.gitRemote = normalizeRemoteUrl(rawUrl);
    } catch {
      // Malformed URL — skip.
      log.warn(`synthetic-tools: failed to normalize remote URL: ${rawUrl}`);
    }
  }

  return result;
}

/**
 * Parse the output of a shell probe (positional stdout lines).
 *
 * Expected format (4 lines, some may be blank):
 *   line 1: git rev-parse --show-toplevel (repo root, blank if not a git repo)
 *   line 2: git remote URL (upstream preferred over origin, blank if none)
 *   line 3: git rev-parse HEAD (commit SHA, blank if not a git repo)
 *   line 4: pwd (always present — the client's real cwd)
 */
function parseShellOutput(text: string): ResolveProjectResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const result: ResolveProjectResult = {};

  const gitRoot = lines[0] || undefined;
  const remoteRaw = lines[1] || undefined;
  const gitHead = lines[2] || undefined;
  const pwd = lines[3] || undefined;

  // Root: prefer git root, fall back to pwd (covers non-git dirs).
  result.root = gitRoot || pwd;

  if (remoteRaw) {
    try {
      result.gitRemote = normalizeRemoteUrl(remoteRaw);
    } catch {
      log.warn(`synthetic-tools: failed to normalize remote URL: ${remoteRaw}`);
    }
  }

  if (gitHead && /^[0-9a-f]{7,40}$/.test(gitHead)) {
    result.gitHead = gitHead;
  }

  return result;
}

/**
 * Parse the raw tool output into project-resolution data, dispatching
 * by probe kind.
 */
export function parseResolveProjectResult(
  kind: "read" | "shell",
  rawOutput: string,
): ResolveProjectResult {
  if (kind === "read") return parseGitConfig(rawOutput);
  return parseShellOutput(rawOutput);
}
