/**
 * Auto-detection and background import of prior AI agent conversations.
 *
 * Called from `lore run` between gateway startup and agent launch.
 * Offers import per newly-detected agent (tracked via import_history per agent;
 * declines are recorded as "__declined__" sentinels). Agents already imported or
 * previously declined are skipped, so a newly installed agent is still offered.
 * Prompts once per new agent, then runs import in the background if confirmed.
 */
import { createInterface } from "node:readline";
import {
  conversationImport,
  config as loreConfig,
  ensureProject,
  exportLoreFile,
} from "@loreai/core";
import { createGatewayLLMClient } from "../llm-adapter";
import { resolveAuth } from "../auth";
import { registerPendingImport } from "../pending-import";
import type { GatewayConfig } from "../config";

const {
  detectAll,
  extractKnowledge,
  getProvider,
  isImported,
  recordImport,
  recordDecline,
  hasAgentImportRecord,
  computeHash,
} = conversationImport;

async function promptYesNo(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [Y/n]: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "" || trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Auto-detect prior conversations and offer to import them.
 * Called from `commandRun()` before launching the agent.
 *
 * - Only offers agents not yet imported or declined for this project.
 * - Shows a one-line prompt to the user.
 * - If confirmed, runs extraction in the background (fire-and-forget).
 * - If declined, records a per-agent decline sentinel so we don't ask again.
 */
export async function maybeAutoImport(
  gatewayConfig: GatewayConfig,
): Promise<void> {
  const projectPath = process.cwd();

  try {
    ensureProject(projectPath);
  } catch {
    return; // Can't determine project — skip
  }

  // Detect conversation history across all known agents. Worktree-aware:
  // finds sessions recorded under the repo's main checkout and any worktree.
  let results = detectAll(projectPath, { worktrees: true });
  if (results.length === 0) return;

  // PER-AGENT GATE (apply FIRST): only consider agents we've never handled
  // here — neither imported (real rows) nor declined ("__declined__" sentinel).
  // This must run before the per-session filter below: a declined agent has no
  // session rows, so isImported() would not catch it — only the gate does.
  // Known agents with new sessions are intentionally skipped; incremental
  // same-agent imports remain the job of explicit `lore import`.
  results = results.filter(
    (r) => !hasAgentImportRecord(projectPath, r.agentName),
  );
  if (results.length === 0) return;

  // Defensive per-session filter for the surviving brand-new agents.
  for (const result of results) {
    result.sessions = result.sessions.filter((sess) => {
      const hash = computeHash({
        messageCount: sess.messageCount,
        lastTimestamp: sess.lastActivityAt,
      });
      return !isImported(projectPath, result.agentName, sess.id, hash);
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
  results = results.filter((r) => r.sessions.length > 0);
  if (results.length === 0) return;

  const totalMessages = results.reduce((s, r) => s + r.totalMessages, 0);
  const agentNames = results.map((r) => r.agentDisplayName).join(", ");

  // Prompt the user (lists only the brand-new agents).
  const ok = await promptYesNo(
    `[lore] Found ${totalMessages} messages from prior conversations (${agentNames}).\n` +
      "[lore] Import knowledge from them?",
  );

  // Record decline sentinels BEFORE any background work — prevents a second
  // `lore run` from re-prompting while the background import is still running.
  // On accept, the sentinels are harmless: real recordImport() rows (with actual
  // session source_ids) are written later and hasAgentImportRecord() returns true
  // regardless. This mirrors the old per-project setLastImportAt() which also
  // ran before checking the user's answer.
  for (const result of results) {
    recordDecline(projectPath, result.agentName);
  }

  if (!ok) return;

  const cfg = loreConfig();
  const defaultModel = cfg.model ?? {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  };
  const llm = createGatewayLLMClient(
    {
      anthropic: gatewayConfig.upstreamAnthropic,
      openai: gatewayConfig.upstreamOpenAI,
    },
    resolveAuth,
    defaultModel,
  );

  const hasWorkerKey = !!gatewayConfig.workerApiKey;

  const job = (authedProviderID?: string) => {
    // The extraction runs on the configured default model. If the first turn
    // authenticated a DIFFERENT provider (e.g. session=openai but default
    // model=anthropic) and no credential resolves for the model's provider,
    // the extraction can't authenticate — skip loudly rather than silently
    // churning no-auth. A matching/agnostic credential (or worker key) proceeds.
    const usable =
      hasWorkerKey || resolveAuth(undefined, defaultModel.providerID) != null;
    if (!usable) {
      // Never leave a promised import silently dropped: we told the user it
      // would "start after your first message". Explain the mismatch when we
      // know the provider; otherwise give a generic, still-actionable notice.
      if (authedProviderID && authedProviderID !== defaultModel.providerID) {
        console.log(
          `[lore] Skipping knowledge import: your session uses ${authedProviderID}, ` +
            `but import is configured for ${defaultModel.providerID}. ` +
            `Run \`lore import\` once authenticated with ${defaultModel.providerID}.`,
        );
      } else {
        console.log(
          `[lore] Skipping knowledge import: no usable ${defaultModel.providerID} ` +
            `credential is available. Run \`lore import\` once authenticated.`,
        );
      }
      return Promise.resolve();
    }
    return runBackgroundImport(
      llm,
      projectPath,
      results,
      defaultModel,
      hasWorkerKey,
    ).catch(() => {
      // Background import failed — non-fatal, don't alarm the user.
    });
  };

  // A dedicated worker key is always usable, so the import can run right away.
  // Otherwise we must WAIT for a real credential: at `lore run` startup no turn
  // has been proxied yet, so resolveAuth() is null and firing now would make
  // every extraction call fail no-auth (session=_unknown), churn the whole
  // backlog, and produce zero knowledge. Defer until the first authenticated
  // turn binds a credential (pipeline flushes via flushPendingImport()).
  const hasCredential =
    hasWorkerKey || resolveAuth(undefined, defaultModel.providerID) != null;

  if (hasCredential) {
    console.log("[lore] Importing knowledge in background...");
    void job();
  } else {
    // Fire-and-forget once the first authenticated turn arrives.
    registerPendingImport(job);
    console.log("[lore] Knowledge import will start after your first message.");
  }
}

async function runBackgroundImport(
  llm: import("@loreai/core").LLMClient,
  projectPath: string,
  results: import("@loreai/core").conversationImport.DetectionResult[],
  model: { providerID: string; modelID: string },
  hasWorkerKey: boolean,
): Promise<void> {
  // Final auth guard: never churn a large backlog when no credential is
  // resolvable. Every extraction call would fail no-auth and produce zero
  // knowledge. Callers already gate on this, but the deferred path could race
  // a credential going stale between the flush trigger and this run.
  if (!hasWorkerKey && resolveAuth(undefined, model.providerID) == null) {
    return;
  }

  let totalCreated = 0;
  let totalUpdated = 0;

  for (const result of results) {
    const provider = getProvider(result.agentName);
    if (!provider) continue;

    const sessionIds = result.sessions.map((s) => s.id);
    const chunks = provider.readChunks(projectPath, sessionIds);
    if (chunks.length === 0) continue;

    const extractResult = await extractKnowledge({
      llm,
      projectPath,
      chunks,
      model,
    });

    // Record imports
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
  }

  // Export .lore.md
  try {
    exportLoreFile(projectPath);
  } catch {
    // Non-fatal
  }

  if (totalCreated > 0 || totalUpdated > 0) {
    console.log(
      `[lore] Background import complete: ${totalCreated} entries created, ${totalUpdated} updated.`,
    );
  }
}
