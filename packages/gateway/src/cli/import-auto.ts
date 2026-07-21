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

  // On DECLINE: record per-agent decline sentinels so we don't re-prompt.
  //
  // On ACCEPT: do NOT pre-record anything here. The import is now DEFERRED until
  // the first authenticated turn (#1366) and may not run in this invocation at
  // all (e.g. the agent never proxies a turn through this gateway). Recording a
  // sentinel up-front would set hasAgentImportRecord()=true and permanently
  // suppress the offer even though nothing was ever imported — the exact trap a
  // user hit (accepted, import never fired, project stayed empty forever).
  // Instead, only a completed extraction records the agent (recordImport in
  // runBackgroundImport), so an unfinished/never-fired import is re-offered on
  // the next `lore run`.
  if (!ok) {
    for (const result of results) {
      recordDecline(projectPath, result.agentName);
    }
    return;
  }

  const cfg = loreConfig();
  const modelExplicit = cfg.model != null;
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
      // Re-register so a LATER authenticated turn retries. flushPendingImport
      // is one-shot (it clears `pending` before calling us), so without this a
      // single unusable-credential turn would permanently drop the import and
      // make the "send one message and it will import automatically" promise
      // below a lie (Seer #15392788). Re-registering keeps the offer alive; a
      // turn that finally binds a usable credential runs the extraction.
      registerPendingImport(job);
      // Never leave the user without a signal: explain the mismatch when we
      // know the provider AND the user explicitly configured a model (naming a
      // provider they never chose would be misleading — a Copilot/OpenRouter
      // user shouldn't be told to authenticate "anthropic"). Otherwise give a
      // generic, still-truthful "send one message" notice (now backed by the
      // re-registration above).
      if (
        modelExplicit &&
        authedProviderID &&
        authedProviderID !== defaultModel.providerID
      ) {
        console.log(
          `[lore] Skipping knowledge import for now: your session uses ${authedProviderID}, ` +
            `but import is configured for ${defaultModel.providerID}. ` +
            `Send a message with ${defaultModel.providerID} and it will import automatically.`,
        );
      } else {
        console.log(
          "[lore] Skipping knowledge import for now: no usable credential is available yet. " +
            "Send one message and the import will start automatically.",
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

    // Only mark these sessions imported if the LLM actually answered at least
    // one chunk. A no-auth run returns null per chunk without throwing (0
    // answered) — recording it would set hasAgentImportRecord()=true and
    // permanently suppress a real import on the next run. Skip recording so it
    // is retried. (created/updated can legitimately be 0 when the model
    // answered but found nothing worth keeping — that DOES record.)
    if (extractResult.chunksAnswered === 0) continue;

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
