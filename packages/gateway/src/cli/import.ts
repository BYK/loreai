/**
 * `lore import` — detect and import knowledge from external AI agent conversations.
 *
 * Scans for conversation history from Claude Code, OpenCode, and Aider,
 * then extracts knowledge entries via the curator LLM.
 *
 * When `LORE_REMOTE_URL` is set, detection and chunk reading happen locally
 * (they require filesystem access), but extraction is delegated to the remote
 * gateway via the REST API. No local gateway startup is needed.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  conversationImport,
  config as loreConfig,
  ensureProject,
  setLastImportAt,
  load,
} from "@loreai/core";
type DetectionResult =
  import("@loreai/core").conversationImport.DetectionResult;
import { createGatewayLLMClient } from "../llm-adapter";
import { resolveAuth, workerKeyScheme, type AuthCredential } from "../auth";
import { exportLoreFile } from "@loreai/core";
import { startGateway, type StartOptions } from "./start";
import {
  getRemoteUrl,
  projectQueryParams,
  remoteGet,
  remotePost,
} from "./remote";

const {
  detectAll,
  extractKnowledge,
  getProvider,
  isImported,
  recordImport,
  computeHash,
  getStructuredSource,
  getStructuredSources,
  detectStructuredSources,
  importStructuredEntries,
  safeParseImportDoc,
} = conversationImport;
type StructuredSourceName = conversationImport.StructuredSourceName;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

async function confirm(message: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} ${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") resolve(defaultYes);
      else resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Read a single line from the given prompt. Returns "" for non-TTY input so
 * callers can apply their own default. Injectable reader for testing.
 */
type LineReader = (prompt: string) => Promise<string>;

const readLine: LineReader = (prompt: string) =>
  new Promise<string>((resolve) => {
    if (!process.stdin.isTTY) {
      resolve("");
      return;
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });

/**
 * Parse a comma/space-separated list of 1-based indices into 0-based indices.
 *
 * Accepts:
 *   - "" / "a" / "all"  → all indices [0..count)
 *   - "1,3" / "1 3"     → [0, 2]
 * Invalid/out-of-range tokens cause a return of `null` (caller re-prompts).
 * Duplicates are collapsed; result is sorted ascending.
 */
export function parseIndexSelection(
  input: string,
  count: number,
): number[] | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "a" || trimmed === "all") {
    return Array.from({ length: count }, (_, i) => i);
  }

  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  const picked = new Set<number>();
  for (const tok of tokens) {
    if (!/^\d+$/.test(tok)) return null;
    const n = Number.parseInt(tok, 10);
    if (n < 1 || n > count) return null;
    picked.add(n - 1);
  }
  if (picked.size === 0) return null;
  return [...picked].sort((a, b) => a - b);
}

/**
 * Prompt the user to pick a subset of items by number. Returns the selected
 * 0-based indices. Non-TTY (and no injected reader) → all. After `maxTries`
 * invalid attempts → all.
 */
export async function selectIndices(
  count: number,
  opts: { reader?: LineReader; maxTries?: number } = {},
): Promise<number[]> {
  const reader = opts.reader ?? readLine;
  const maxTries = opts.maxTries ?? 3;
  const all = () => Array.from({ length: count }, (_, i) => i);
  // Without an injected reader, only prompt on a real TTY; otherwise import all.
  if (!opts.reader && !process.stdin.isTTY) return all();

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const answer = await reader(
      "[lore] Which histories to import? (comma-separated numbers, or 'a' for all): ",
    );
    const parsed = parseIndexSelection(answer, count);
    if (parsed) return parsed;
    console.error(
      "[lore] Invalid selection — enter e.g. '1,3' or 'a' for all.",
    );
  }
  // Fall back to importing everything after repeated invalid input.
  console.error("[lore] Defaulting to all agents.");
  return all();
}

/** A detected session already recorded on the remote gateway. */
type RemoteImportRecord = {
  agent_name: string;
  source_id: string;
  source_hash: string;
};

/**
 * Restrict detection results to a single agent by internal name.
 *
 * Returns the filtered results (possibly empty). Pure — no I/O.
 */
export function applyAgentFilter(
  results: DetectionResult[],
  agentFilter: string | null,
): DetectionResult[] {
  if (!agentFilter) return results;
  return results.filter((r) => r.agentName === agentFilter);
}

/**
 * Drop sessions that have already been imported, recompute per-agent totals,
 * and remove agents left with no new sessions.
 *
 * Dedup source depends on mode:
 *   - remote: match against the remote gateway's import-history rows
 *   - local:  consult the local import DB via `isImportedLocal`
 *
 * Both the hash function and the local-check are injected so this is a pure,
 * testable transform with no direct filesystem/DB dependency.
 */
export function filterAlreadyImported(
  results: DetectionResult[],
  opts: {
    projectPath: string;
    hashOf: (sess: { messageCount: number; lastActivityAt: number }) => string;
    remoteImports?: RemoteImportRecord[];
    isImportedLocal: (
      projectPath: string,
      agentName: string,
      sourceId: string,
      hash: string,
    ) => unknown;
    hasProvider?: (agentName: string) => boolean;
  },
): DetectionResult[] {
  const { projectPath, hashOf, remoteImports, isImportedLocal } = opts;
  const hasProvider = opts.hasProvider ?? (() => true);

  for (const result of results) {
    if (!hasProvider(result.agentName)) continue;

    result.sessions = result.sessions.filter((sess) => {
      const hash = hashOf({
        messageCount: sess.messageCount,
        lastActivityAt: sess.lastActivityAt,
      });
      if (remoteImports) {
        // Check against remote import history
        return !remoteImports.some(
          (r) =>
            r.agent_name === result.agentName &&
            r.source_id === sess.id &&
            r.source_hash === hash,
        );
      }
      // Local mode: check local DB (truthy record → already imported)
      return !isImportedLocal(projectPath, result.agentName, sess.id, hash);
    });

    result.totalMessages = result.sessions.reduce(
      (s, sess) => s + sess.messageCount,
      0,
    );
    result.totalTokens = result.sessions.reduce(
      (s, sess) => s + sess.estimatedTokens,
      0,
    );
  }

  // Remove agents with no new sessions
  return results.filter((r) => r.sessions.length > 0);
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structured-memory import (Engram / mem0)
// ---------------------------------------------------------------------------

const STRUCTURED_SOURCE_NAMES: readonly StructuredSourceName[] = [
  "engram",
  "mem0",
];

function isStructuredName(name: string): name is StructuredSourceName {
  return (STRUCTURED_SOURCE_NAMES as readonly string[]).includes(name);
}

/**
 * Decide whether this `lore import` invocation targets a structured-memory
 * source, and which one. Precedence:
 *   1. explicit `--source <name>`,
 *   2. `--agent <name>` naming a structured source,
 *   3. `--file` with no source, when exactly one structured source is detected.
 *
 * A bare `lore import` (no flags) does NOT auto-route to a structured source
 * even if one is installed — it stays on the conversation-import lane so a user
 * who merely has the `engram` binary on PATH isn't surprised. Structured import
 * requires an explicit signal (`--source`, `--agent <structured>`, or `--file`).
 *
 * Returns null to fall through to the conversation-import lane.
 */
export function resolveStructuredSourceName(opts: {
  sourceFlag: string | null;
  agentFilter: string | null;
  fileFlag: string | null;
}): StructuredSourceName | null {
  const { sourceFlag, agentFilter, fileFlag } = opts;
  if (sourceFlag && isStructuredName(sourceFlag)) return sourceFlag;
  if (agentFilter && isStructuredName(agentFilter)) return agentFilter;
  // A --file with no source: auto-route to a detected structured source when
  // exactly one is present (a file is an explicit migration intent).
  if (fileFlag && !sourceFlag && !agentFilter) {
    const detected = detectStructuredSources();
    if (detected.length === 1) return detected[0].name;
  }
  return null;
}

async function importStructured(opts: {
  remote: string | undefined;
  projectPath: string;
  sourceName: StructuredSourceName;
  filePath: string | null;
  dryRun: boolean;
  yes: boolean;
  global: boolean;
  mem0?: {
    qdrantUrl?: string;
    collection?: string;
    serverUrl?: string;
    token?: string;
    path?: string;
    user?: string;
  };
}): Promise<void> {
  const { projectPath, sourceName, filePath, dryRun, global } = opts;

  const source = getStructuredSource(sourceName);
  if (!source) {
    const supported = getStructuredSources()
      .map((s) => s.name)
      .join(", ");
    console.error(
      `[lore] Import source "${sourceName}" is not available yet. Supported: ${supported}.`,
    );
    return;
  }

  console.log(
    `[lore] Importing structured memory from ${source.displayName}...`,
  );

  // Produce the normalized document (runs the source's export CLI, reads
  // --file, or probes a running server). This always happens client-side — the
  // remote gateway has no shared filesystem with the client. May be async.
  let doc: conversationImport.LoreImportDoc;
  try {
    doc = await source.produceDoc({
      filePath: filePath ?? undefined,
      project: projectPath,
      mem0QdrantUrl: opts.mem0?.qdrantUrl,
      mem0Collection: opts.mem0?.collection,
      mem0ServerUrl: opts.mem0?.serverUrl,
      mem0Token: opts.mem0?.token,
      mem0Path: opts.mem0?.path,
      mem0User: opts.mem0?.user,
    });
  } catch (err) {
    console.error(
      `[lore] Could not read ${source.displayName} memory: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (doc.entries.length === 0) {
    console.log(`[lore] No entries found in ${source.displayName} memory.`);
    return;
  }

  console.log(`[lore] Found ${doc.entries.length} entries.`);

  if (dryRun) {
    const preview = importStructuredEntries(doc, {
      defaultProjectPath: projectPath,
      global,
      dryRun: true,
    });
    console.log(
      `[lore] Dry run — would create ${preview.created}, update ${preview.updated}, skip ${preview.skipped}.`,
    );
    return;
  }

  if (!opts.yes) {
    const ok = await confirm(
      `[lore] Import ${doc.entries.length} entries from ${source.displayName}?`,
    );
    if (!ok) {
      console.log("[lore] Import cancelled.");
      return;
    }
  }

  // Remote mode: send the validated doc to the gateway for the actual write.
  if (opts.remote) {
    await importStructuredRemote(opts.remote, projectPath, doc, global);
    return;
  }

  // Local mode: write directly.
  const result = importStructuredEntries(doc, {
    defaultProjectPath: projectPath,
    global,
  });

  setLastImportAt(projectPath, Date.now());
  try {
    // Ensure imported entries become searchable even in a short-lived CLI.
    const { embedding } = await import("@loreai/core");
    await embedding.backfillEmbeddings();
  } catch {
    // Non-fatal — embeddings backfill on next gateway boot.
  }
  try {
    exportLoreFile(projectPath);
  } catch {
    // Non-fatal
  }

  console.log(
    `[lore] Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`,
  );
  console.log("[lore] Run `lore data list knowledge` to review.");
}

async function importStructuredRemote(
  remote: string,
  projectPath: string,
  doc: conversationImport.LoreImportDoc,
  global: boolean,
): Promise<void> {
  const { getGitRemote, normalizeRemoteUrl } = await import("@loreai/core");
  const raw = getGitRemote(projectPath);
  const normalized = raw ? normalizeRemoteUrl(raw) : undefined;

  console.log(`\n[lore] Using remote gateway at ${remote}`);

  // Re-validate before sending (defensive; the server re-validates too).
  const check = safeParseImportDoc(doc);
  if (!check.success) {
    console.error(
      "[lore] Internal error: produced an invalid import document.",
    );
    return;
  }

  let result: { created: number; updated: number; skipped: number };
  try {
    result = await remotePost(
      remote,
      "/api/v1/import/structured",
      {
        git_remote: normalized,
        path: projectPath,
        global,
        doc,
      },
      { compress: true },
    );
  } catch (err) {
    console.error(
      `[lore] Structured import failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  setLastImportAt(projectPath, Date.now());
  try {
    exportLoreFile(projectPath);
  } catch {
    // Non-fatal
  }

  console.log(
    `[lore] Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`,
  );
  console.log("[lore] Run `lore data list knowledge` to review.");
}

export async function commandImport(
  _args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  // Parse flags
  const dryRun = flags["dry-run"] === true || flags.dryRun === true;
  const yes = flags.yes === true || flags.y === true;
  const agentFilter = (flags.agent as string) ?? null;
  const sourceFlag = (flags.source as string) ?? null;
  const fileFlag = (flags.file as string) ?? null;
  const global = flags.global === true;
  const mem0Opts = {
    qdrantUrl: (flags["mem0-qdrant"] as string) ?? undefined,
    collection: (flags["mem0-collection"] as string) ?? undefined,
    serverUrl: (flags["mem0-server"] as string) ?? undefined,
    token: (flags["mem0-token"] as string) ?? undefined,
    path: (flags["mem0-path"] as string) ?? undefined,
    user: (flags["mem0-user"] as string) ?? undefined,
  };
  const noWorktrees =
    flags["no-worktrees"] === true || flags.noWorktrees === true;
  const projectFlag = flags.project as string | undefined;
  const projectPath = projectFlag ? resolve(projectFlag) : process.cwd();

  const remote = getRemoteUrl();

  // Initialize core (loads config, opens DB, runs migrations).
  // In remote mode we still need load() for detectAll / readChunks which use
  // core's provider registry. A local project record may be created later by
  // the belt-and-suspenders recordImport() call — that's intentional so the
  // local DB has dedup history if the user later runs without LORE_REMOTE_URL.
  await load(projectPath);
  if (!remote) {
    ensureProject(projectPath);
  }

  // Structured-memory import lane (Engram / mem0). Routed by --source/--file
  // (or --agent naming a structured source). This reads ALREADY structured
  // memory and writes it directly to the knowledge store (no curator LLM).
  // Conversation-history import (below) is the other lane.
  if (sourceFlag && !getStructuredSource(sourceFlag)) {
    const supported = getStructuredSources()
      .map((s) => s.name)
      .join(", ");
    console.error(
      `[lore] Import source "${sourceFlag}" is not available. Supported: ${supported}.`,
    );
    return;
  }
  const structuredName = resolveStructuredSourceName({
    sourceFlag,
    agentFilter,
    fileFlag,
  });
  if (structuredName) {
    await importStructured({
      remote,
      projectPath,
      sourceName: structuredName,
      filePath: fileFlag,
      dryRun,
      yes,
      global,
      mem0: mem0Opts,
    });
    return;
  }

  // Detect conversation history (local filesystem scan — always local)
  console.log("[lore] Scanning for conversation history...\n");

  let results = detectAll(projectPath, { worktrees: !noWorktrees });

  if (agentFilter) {
    results = applyAgentFilter(results, agentFilter);
    if (results.length === 0) {
      console.log(
        `[lore] No conversation history found from "${agentFilter}" for this project.`,
      );
      return;
    }
  }

  if (results.length === 0) {
    console.log(
      "[lore] No prior AI conversation history found for this project.",
    );
    return;
  }

  // Filter out already-imported sessions.
  // In remote mode, fetch import history from the remote gateway.
  let remoteImports: RemoteImportRecord[] | undefined;
  if (remote) {
    try {
      const pq = projectQueryParams(projectPath);
      remoteImports = await remoteGet<typeof remoteImports>(
        remote,
        `/api/v1/import/history?${pq}`,
      );
    } catch (err: unknown) {
      // 400/404 = project doesn't exist on remote yet (first import) — proceed without dedup
      const status =
        err instanceof Error && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status === 400 || status === 404) {
        console.error(
          "[lore] Note: project not yet known to remote gateway — all sessions will be imported.",
        );
      } else {
        // Server errors, auth failures, network issues — re-throw (don't silently double-import)
        throw err;
      }
    }
  }

  results = filterAlreadyImported(results, {
    projectPath,
    hashOf: (sess) =>
      computeHash({
        messageCount: sess.messageCount,
        lastTimestamp: sess.lastActivityAt,
      }),
    remoteImports,
    isImportedLocal: isImported,
    hasProvider: (name) => getProvider(name) != null,
  });

  if (results.length === 0) {
    console.log(
      "[lore] All detected conversations have already been imported.",
    );
    return;
  }

  // Show detection summary. When more than one agent was detected and we can
  // prompt interactively (TTY, no --agent filter, not --yes/--dry-run), offer a
  // numbered multi-select so the user can import a subset.
  const canSelect =
    results.length > 1 &&
    !agentFilter &&
    !yes &&
    !dryRun &&
    process.stdin.isTTY;

  console.log("Found prior conversations for this project:\n");
  results.forEach((result, i) => {
    const prefix = canSelect ? `  ${i + 1}. ` : "  ";
    console.log(`${prefix}${result.agentDisplayName}`);
    console.log(
      `    ${result.sessions.length} sessions, ~${result.totalMessages} messages`,
    );
    if (result.sessions.length > 0) {
      const latest = result.sessions[0];
      console.log(`    Most recent: ${formatDate(latest.lastActivityAt)}`);
    }
    console.log();
  });

  // Interactive agent selection (subset). Non-TTY / --yes / --agent → all.
  if (canSelect) {
    const chosen = await selectIndices(results.length);
    results = chosen.map((i) => results[i]);
    if (results.length === 0) {
      console.log("[lore] No agents selected — import cancelled.");
      return;
    }
  }

  // Recompute totals over the (possibly narrowed) selection.
  const totalMessages = results.reduce((s, r) => s + r.totalMessages, 0);
  const totalSessions = results.reduce((s, r) => s + r.sessions.length, 0);

  // Estimate LLM calls (one per ~12K token chunk)
  const totalTokens = results.reduce((s, r) => s + r.totalTokens, 0);
  const estimatedChunks = Math.ceil(totalTokens / 12288);
  console.log(
    `  Total: ${totalSessions} sessions, ~${totalMessages} messages (~${estimatedChunks} LLM calls)\n`,
  );

  if (dryRun) {
    console.log("[lore] Dry run — no imports performed.");
    return;
  }

  // Confirm unless --yes
  if (!yes) {
    const ok = await confirm(
      "[lore] Import knowledge from these conversations?",
    );
    if (!ok) {
      console.log("[lore] Import cancelled.");
      return;
    }
  }

  // Remote mode: delegate extraction to the remote gateway
  if (remote) {
    await importRemote(remote, projectPath, results);
    return;
  }

  // Start gateway for LLM access
  console.log("\n[lore] Starting gateway for LLM access...");

  // Import always runs locally — reading local agent history files.
  const startOpts: StartOptions = { quiet: true, local: true };
  const { config, owned, shutdown } = await startGateway(startOpts);
  const cfg = loreConfig();
  // `cfg.model` is normally unset — Lore takes the model from the first client
  // request. Standalone `lore import` has no request, so it falls back to a
  // built-in default. Track whether the provider was *explicitly* configured so
  // the no-credential message below doesn't tell a Copilot/OpenRouter user to
  // set an "anthropic key" they don't have.
  const modelExplicit = cfg.model != null;
  const defaultModel = cfg.model ?? {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  };

  // Extraction needs a usable credential. `lore import` is a standalone CLI
  // process: it never proxies a conversation turn, so no client credential is
  // ever captured under a session. The ONLY credential it can use is a
  // dedicated worker key (LORE_WORKER_API_KEY). Without one, every extraction
  // call resolves no-auth and `llm.prompt` returns null — the import would
  // silently create ZERO knowledge while reporting success (the exact trap a
  // user hit). Fail loudly with actionable guidance instead.
  const workerApiKey = config.workerApiKey;
  const getImportAuth: (
    sessionID?: string,
    providerID?: string,
  ) => AuthCredential | null = workerApiKey
    ? (_sessionID, providerID) => ({
        scheme: workerKeyScheme(providerID),
        value: workerApiKey,
      })
    : resolveAuth;

  if (
    !workerApiKey &&
    getImportAuth(undefined, defaultModel.providerID) == null
  ) {
    // Only name a specific provider when the user explicitly configured one.
    // Otherwise stay neutral: many users authenticate via a subscription
    // (GitHub Copilot, Claude/ChatGPT OAuth) and have no API key to export at
    // all, so leading with LORE_WORKER_API_KEY sends them down a dead end. The
    // universal path is `lore run` + one message, which captures whatever
    // credential the agent already uses.
    const keyHint = modelExplicit
      ? `<your ${defaultModel.providerID} key>`
      : "<key for your provider>";
    console.error(
      `\n[lore] Can't import: no credential is available for background extraction.\n` +
        `[lore] \`lore import\` runs standalone with no conversation to borrow a\n` +
        `[lore] credential from. Two ways forward:\n` +
        `[lore]\n` +
        `[lore]   1. Easiest — run \`lore run\`, send one message, and the import\n` +
        `[lore]      happens automatically once your credential is captured.\n` +
        `[lore]\n` +
        `[lore]   2. Give \`lore import\` a dedicated worker key and retry:\n` +
        `[lore]        export LORE_WORKER_API_KEY=${keyHint}\n` +
        `[lore]        lore import`,
    );
    if (owned) await shutdown();
    return;
  }

  const llm = createGatewayLLMClient(
    { anthropic: config.upstreamAnthropic, openai: config.upstreamOpenAI },
    getImportAuth,
    defaultModel,
  );

  try {
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;
    let _totalChunks = 0;
    let totalFailed = 0;

    for (const result of results) {
      const provider = getProvider(result.agentName);
      if (!provider) continue;

      const sessionIds = result.sessions.map((s) => s.id);
      console.log(`[lore] Reading ${result.agentDisplayName} conversations...`);

      const chunks = provider.readChunks(projectPath, sessionIds);
      if (chunks.length === 0) {
        console.log(
          `[lore] No extractable content from ${result.agentDisplayName}.`,
        );
        continue;
      }

      console.log(
        `[lore] Extracting knowledge from ${chunks.length} chunks (${result.agentDisplayName})...`,
      );

      const extractResult = await extractKnowledge({
        llm,
        projectPath,
        chunks,
        model: defaultModel,
        onProgress: (progress) => {
          process.stderr.write(
            `\r[lore]   Chunk ${progress.current}/${progress.total} — ${progress.created} created, ${progress.updated} updated`,
          );
        },
      });

      // Clear the progress line
      process.stderr.write("\n");

      // Only mark sessions imported if the LLM actually answered a chunk. A
      // no-auth run returns null per chunk (0 answered) without throwing — the
      // pre-flight guard above catches the common case, but a credential can go
      // stale mid-run. Recording a never-answered run would permanently
      // suppress a real re-import via hasAgentImportRecord().
      if (extractResult.chunksAnswered === 0) {
        console.log(
          `[lore] No response from the model for ${result.agentDisplayName} — ` +
            `skipping (will retry on next import).`,
        );
        totalFailed += extractResult.chunksFailed;
        continue;
      }

      // Record imports for each session
      for (const sess of result.sessions) {
        const hash = computeHash({
          messageCount: sess.messageCount,
          lastTimestamp: sess.lastActivityAt,
        });
        recordImport(projectPath, result.agentName, sess.id, hash, {
          created: extractResult.created,
          updated: extractResult.updated,
        });
      }

      totalCreated += extractResult.created;
      totalUpdated += extractResult.updated;
      totalDeleted += extractResult.deleted;
      _totalChunks += extractResult.chunksProcessed;
      totalFailed += extractResult.chunksFailed;
    }

    // Record import timestamp (supplementary — auto-import gates on per-agent
    // import_history rows via hasAgentImportRecord, not this timestamp)
    setLastImportAt(projectPath, Date.now());

    // Export .lore.md
    try {
      exportLoreFile(projectPath);
    } catch {
      // Non-fatal
    }

    // Summary
    console.log(
      `\n[lore] Import complete: ${totalCreated} entries created, ${totalUpdated} updated` +
        (totalDeleted ? `, ${totalDeleted} deleted` : "") +
        (totalFailed ? ` (${totalFailed} chunks failed)` : "") +
        ".",
    );
    console.log("[lore] Run `lore data list knowledge` to review.");
  } finally {
    if (owned) await shutdown();
  }
}

// ---------------------------------------------------------------------------
// Remote import — detection + chunk reading local, extraction via gateway API
// ---------------------------------------------------------------------------

async function importRemote(
  remote: string,
  projectPath: string,
  results: ReturnType<typeof detectAll>,
): Promise<void> {
  const { getGitRemote, normalizeRemoteUrl } = await import("@loreai/core");
  const raw = getGitRemote(projectPath);
  const normalized = raw ? normalizeRemoteUrl(raw) : undefined;

  console.log(`\n[lore] Using remote gateway at ${remote}`);

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  let _totalChunks = 0;
  let totalFailed = 0;

  for (const result of results) {
    const provider = getProvider(result.agentName);
    if (!provider) continue;

    const sessionIds = result.sessions.map((s) => s.id);
    console.log(`[lore] Reading ${result.agentDisplayName} conversations...`);

    const chunks = provider.readChunks(projectPath, sessionIds);
    if (chunks.length === 0) {
      console.log(
        `[lore] No extractable content from ${result.agentDisplayName}.`,
      );
      continue;
    }

    console.log(
      `[lore] Extracting knowledge from ${chunks.length} chunks via remote gateway (${result.agentDisplayName})...`,
    );

    // Send chunks to remote gateway for extraction (zstd-compressed)
    let extractResult: {
      created: number;
      updated: number;
      deleted: number;
      chunksProcessed: number;
      chunksFailed: number;
    };
    try {
      extractResult = await remotePost(
        remote,
        "/api/v1/import/extract",
        {
          git_remote: normalized,
          path: projectPath,
          chunks: chunks.map((c) => ({
            label: c.label,
            text: c.text,
            estimatedTokens: c.estimatedTokens,
            timestamp: c.timestamp,
          })),
        },
        { compress: true },
      );
    } catch (err) {
      console.error(
        `[lore] Extraction failed for ${result.agentDisplayName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      totalFailed += chunks.length;
      continue;
    }

    // Record imports on remote gateway + locally (belt-and-suspenders:
    // remote is source of truth, local prevents re-detection if user
    // later runs without LORE_REMOTE_URL)
    for (const sess of result.sessions) {
      const hash = computeHash({
        messageCount: sess.messageCount,
        lastTimestamp: sess.lastActivityAt,
      });
      try {
        await remotePost(remote, "/api/v1/import/record", {
          git_remote: normalized,
          path: projectPath,
          agent_name: result.agentName,
          source_id: sess.id,
          source_hash: hash,
          stats: {
            created: extractResult.created,
            updated: extractResult.updated,
          },
        });
      } catch (err) {
        console.error(
          `[lore] Warning: failed to record import on remote: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Also record locally (belt-and-suspenders)
      try {
        recordImport(projectPath, result.agentName, sess.id, hash, {
          created: extractResult.created,
          updated: extractResult.updated,
        });
      } catch {
        // Non-fatal — remote record is the source of truth
      }
    }

    totalCreated += extractResult.created;
    totalUpdated += extractResult.updated;
    totalDeleted += extractResult.deleted;
    _totalChunks += extractResult.chunksProcessed;
    totalFailed += extractResult.chunksFailed;
  }

  // Record import timestamp locally (supplementary — auto-import gates on per-agent
  // import_history rows via hasAgentImportRecord, not this timestamp)
  setLastImportAt(projectPath, Date.now());

  // Export .lore.md locally so knowledge appears in the local file
  try {
    exportLoreFile(projectPath);
  } catch {
    // Non-fatal
  }

  // Summary
  console.log(
    `\n[lore] Import complete: ${totalCreated} entries created, ${totalUpdated} updated` +
      (totalDeleted ? `, ${totalDeleted} deleted` : "") +
      (totalFailed ? ` (${totalFailed} chunks failed)` : "") +
      ".",
  );
  console.log("[lore] Run `lore data list knowledge` to review.");
}
