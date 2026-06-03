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
export async function maybeAutoImport(gatewayConfig: GatewayConfig): Promise<void> {
  const projectPath = process.cwd();

  try {
    ensureProject(projectPath);
  } catch {
    return; // Can't determine project — skip
  }

  // Detect conversation history across all known agents.
  let results = detectAll(projectPath);
  if (results.length === 0) return;

  // PER-AGENT GATE (apply FIRST): only consider agents we've never handled
  // here — neither imported (real rows) nor declined ("__declined__" sentinel).
  // This must run before the per-session filter below: a declined agent has no
  // session rows, so isImported() would not catch it — only the gate does.
  // Known agents with new sessions are intentionally skipped; incremental
  // same-agent imports remain the job of explicit `lore import`.
  results = results.filter((r) => !hasAgentImportRecord(projectPath, r.agentName));
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
    result.totalMessages = result.sessions.reduce((s, sess) => s + sess.messageCount, 0);
    result.totalTokens = result.sessions.reduce((s, sess) => s + sess.estimatedTokens, 0);
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

  // Run import in the background (fire-and-forget)
  console.log("[lore] Importing knowledge in background...");

  const cfg = loreConfig();
  const defaultModel = cfg.model ?? {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  };
  const llm = createGatewayLLMClient(
    { anthropic: gatewayConfig.upstreamAnthropic, openai: gatewayConfig.upstreamOpenAI },
    resolveAuth,
    defaultModel,
  );

  // Fire-and-forget — don't await, let it run while the agent starts
  runBackgroundImport(llm, projectPath, results, defaultModel).catch(() => {
    // Background import failed — non-fatal, don't alarm the user.
  });
}

async function runBackgroundImport(
  llm: import("@loreai/core").LLMClient,
  projectPath: string,
  results: import("@loreai/core").conversationImport.DetectionResult[],
  model: { providerID: string; modelID: string },
): Promise<void> {
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
