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
  engramSource,
  getStructuredSources,
  getStructuredSource,
  detectStructuredSources,
  type StructuredSource,
  type StructuredSourceName,
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
