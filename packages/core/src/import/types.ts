/**
 * Types for the conversation import system.
 *
 * The import system detects and reads conversation history from external
 * AI coding agents (Claude Code, OpenCode, Aider, etc.) and extracts
 * long-term knowledge entries via the curator LLM prompt.
 */

/**
 * A chunk of conversation text from a foreign agent, ready for
 * knowledge extraction. Chunks are sized to fit within a single
 * LLM curator call (~12K tokens).
 */
export type ConversationChunk = {
  /** Human-readable label, e.g. "Claude Code session 2025-05-10 (1 of 3)" */
  label: string;
  /** Plain text of the conversation (role-prefixed lines) */
  text: string;
  /** Estimated token count (~text.length / 3) */
  estimatedTokens: number;
  /** When this chunk's messages were created (epoch ms), for sorting */
  timestamp: number;
};

/**
 * A detected session from a foreign agent.
 */
export type DetectedSession = {
  /** Unique identifier (agent-specific: file path, session UUID, etc.) */
  id: string;
  /** Human-readable label */
  label: string;
  /** When this session started (epoch ms) */
  startedAt: number;
  /** When this session last had activity (epoch ms) */
  lastActivityAt: number;
  /** Estimated total tokens across all messages */
  estimatedTokens: number;
  /** Number of conversation messages (user + assistant) */
  messageCount: number;
};

/**
 * Summary of what was detected for a project from one agent.
 */
export type DetectionResult = {
  /** Internal agent name (e.g. "claude-code", "opencode", "aider") */
  agentName: string;
  /** Human-readable agent name (e.g. "Claude Code") */
  agentDisplayName: string;
  /** Sessions found for this project */
  sessions: DetectedSession[];
  /** Total estimated tokens across all sessions */
  totalTokens: number;
  /** Total messages across all sessions */
  totalMessages: number;
};

/**
 * Adapter interface for reading conversation history from a specific
 * AI coding agent. Each agent implements this interface.
 */
export interface AgentHistoryProvider {
  /** Internal name (e.g. "claude-code", "opencode", "aider") */
  readonly name: string;
  /** Display name (e.g. "Claude Code") */
  readonly displayName: string;

  /**
   * Detect whether this agent has conversation history for the given
   * project paths. Should be a fast check — avoid reading full file contents.
   *
   * A session matches if the directory it was recorded under equals ANY of the
   * supplied paths. `projectPaths[0]` is the primary project path (cwd); the
   * remaining entries are sibling worktree/clone paths for the same repo (see
   * `projectSearchPaths`). Implementations MUST deduplicate returned sessions
   * (e.g. by their `id`) so overlapping candidate paths never yield duplicates.
   *
   * @returns Array of detected sessions, or empty array if none found.
   */
  detect(projectPaths: string[]): DetectedSession[];

  /**
   * Read conversation text from specific sessions, chunked for LLM
   * consumption. Each chunk is <= maxTokens estimated tokens.
   *
   * @param projectPath  The project directory
   * @param sessionIds   Which sessions to import (from detect() results)
   * @param maxTokens    Max estimated tokens per chunk (default: 12288)
   * @returns Conversation chunks ready for knowledge extraction
   */
  readChunks(
    projectPath: string,
    sessionIds: string[],
    maxTokens?: number,
  ): ConversationChunk[];
}

/**
 * A credential resolved from a harness's own on-disk auth store, mapped to the
 * shape Lore's gateway extraction client consumes.
 *
 * `scheme` mirrors the gateway `AuthCredential` scheme:
 *   - "api-key" → sent as `x-api-key`
 *   - "bearer"  → sent as `Authorization: Bearer <value>`
 */
export type AgentResolvedAuth = {
  /** How to present the credential to the upstream. */
  scheme: "api-key" | "bearer";
  /** The raw secret (API key or OAuth access token). */
  value: string;
  /**
   * Lore provider ID the credential authenticates (e.g. "anthropic", "openai",
   * "minimax", "openrouter"). Must be routable (present in the gateway's
   * PROVIDER_ROUTES) for the credential to be usable for extraction.
   */
  providerID: string;
  /**
   * Optional model hint. When omitted, callers fall back to
   * `defaultModelForProvider(providerID)`.
   */
  modelID?: string;
  /**
   * Expiry for OAuth-style credentials (epoch ms). Undefined for non-expiring
   * API keys. A credential at or past this instant is treated as expired and
   * skipped (v1 does not refresh — the harness owns that).
   */
  expiresAt?: number;
};

/**
 * Capability for reading a harness's OWN stored credentials so a standalone
 * `lore import` can authenticate knowledge extraction without a running gateway
 * or a dedicated `LORE_WORKER_API_KEY`.
 *
 * Parallel to {@link AgentHistoryProvider}: each harness owns both "read my
 * history" and "read my credentials". Implementations MUST NOT throw — return
 * an empty array on any missing/unreadable/unparseable store.
 */
export interface AgentAuthProvider {
  /** Internal name — matches the corresponding {@link AgentHistoryProvider.name}. */
  readonly name: string;

  /**
   * Read the harness's stored credentials, best-first (e.g. the provider the
   * harness is currently configured to use should come first). Returns an empty
   * array when nothing usable is found. Never throws.
   */
  readAuth(): AgentResolvedAuth[];
}
