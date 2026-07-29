/**
 * Conversation import system — detects and imports knowledge from
 * external AI coding agent conversation histories.
 */

// Types
export type {
  ConversationChunk,
  DetectedSession,
  DetectionResult,
  AgentHistoryProvider,
  AgentAuthProvider,
  AgentResolvedAuth,
} from "./types";

// Detection
export { detectAll } from "./detect";
export { projectSearchPaths } from "./scope";

// Provider registry
export {
  registerProvider,
  getProviders,
  getProvider,
  clearProviders,
} from "./providers";

// Harness on-disk auth registry
export {
  registerAuthProvider,
  getAuthProviders,
  getAuthProvider,
  clearAuthProviders,
  readUsableAuth,
} from "./auth";

// OpenCode active-provider detection — the gateway uses this to know which
// on-disk credential / shell env var to prefer when the user has configured
// multiple providers (see `getOpenCodeActiveProvider` in `./auth/opencode`).
export { getOpenCodeActiveProvider } from "./auth/opencode";

// Extraction (lazy — avoid pulling in LLM/curator deps for detection-only use)
export {
  extractKnowledge,
  type ExtractionProgress,
  type ExtractionResult,
} from "./extract";

// Idempotency
export {
  isImported,
  recordImport,
  recordDecline,
  hasAgentImportRecord,
  computeHash,
  listImports,
  type ImportRecord,
} from "./history";

// Structured-memory import (Engram, mem0, ...) — direct-to-LTM lane, no curator
export {
  LoreImportDoc,
  LoreImportEntry,
  LORE_IMPORT_VERSION,
  MAX_IMPORT_CONTENT_LENGTH,
  IMPORT_CATEGORIES,
  parseImportDoc,
  safeParseImportDoc,
} from "./schema";
export {
  importStructuredEntries,
  type StructuredImportOptions,
  type StructuredImportResult,
  type StructuredImportEntryResult,
} from "./structured";
export { parseEngramExport } from "./sources/engram";
export {
  resolveMem0Doc,
  parseMem0File,
  mem0RecordsToDoc,
  mem0RecordToEntry,
  scrollQdrantCollection,
  fetchMem0ServerMemories,
  readEmbeddedStorage,
  embeddedStorageCandidates,
  defaultEmbeddedDirs,
  type Mem0Record,
  type Mem0ResolveOptions,
} from "./sources/mem0";
export {
  engramSource,
  mem0Source,
  getStructuredSources,
  getStructuredSource,
  detectStructuredSources,
  type StructuredSource,
  type StructuredSourceName,
  type ProduceDocOptions,
} from "./structured-sources";

// Register built-in providers on first import.
// Each provider module calls registerProvider() at load time.
import "./providers/claude-code";
import "./providers/codex";
import "./providers/opencode";
import "./providers/cline";
import "./providers/continue";
import "./providers/pi";
import "./providers/aider";

// Register built-in harness auth readers on first import.
// Each reader module calls registerAuthProvider() at load time.
import "./auth/opencode";
import "./auth/claude-code";
import "./auth/codex";
import "./auth/pi";
