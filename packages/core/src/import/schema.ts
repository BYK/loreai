/**
 * Schema for the structured-memory import format (`LoreImportDoc`).
 *
 * This is the single trust boundary for all structured imports: adapter output
 * (Engram, mem0, ...) AND user-supplied `--file` input are validated against
 * this schema before anything touches the DB. Malformed input fails fast with a
 * precise, path-annotated error rather than producing garbage knowledge entries.
 *
 * `zod@4` already backs `LoreConfig`; we reuse it here for consistency.
 */
import { z } from "zod";

/** Bump when the wire format changes incompatibly; the importer branches on it. */
export const LORE_IMPORT_VERSION = 1;

/**
 * Hard ceiling on entry `content` length at the schema trust boundary
 * (defense-in-depth). The importer truncates to 1200 chars downstream; this
 * larger ceiling only bounds the in-memory parsed doc so a pathological input
 * can't blow up memory. Source adapters should clamp to this BEFORE building a
 * doc so a single oversized record is truncated rather than aborting the whole
 * import with a validation error.
 */
export const MAX_IMPORT_CONTENT_LENGTH = 65_536;

/** Lore knowledge categories an imported entry may map to. */
export const IMPORT_CATEGORIES = [
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
] as const;

export const LoreImportEntry = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Entry title; synthesized from content when absent."),
    content: z
      .string()
      .trim()
      .min(1)
      // Hard ceiling at the trust boundary (defense-in-depth): the importer
      // truncates to 1200 chars, but bounding here caps the in-memory parsed
      // doc so a 100k-entry doc of huge strings can't blow up memory before the
      // importer ever runs. 64K per entry is far above any real curated memory.
      .max(MAX_IMPORT_CONTENT_LENGTH)
      .describe("Entry body. Truncated to 1200 chars by the importer."),
    category: z
      .enum(IMPORT_CATEGORIES)
      .optional()
      .describe("Lore category; defaults per-source (mem0 → pattern)."),
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Repo path or name; overridden by --project."),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("0..1; defaults to 1.0."),
    created_at: z
      .union([z.string(), z.number()])
      .optional()
      .describe("ISO8601 string or epoch ms; informational."),
    external_id: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Source-native id for idempotency/dedup."),
  })
  // Reject unknown keys so a wrong-shape file (e.g. a raw mem0 dump or Engram
  // export handed in directly) fails clearly instead of importing junk.
  .strict();

export const LoreImportDoc = z
  .object({
    lore_import_version: z
      .literal(LORE_IMPORT_VERSION)
      .describe("Format version. Unknown versions are rejected."),
    source: z
      .enum(["engram", "mem0", "generic"])
      .describe("Origin of the entries (informational + routing)."),
    entries: z.array(LoreImportEntry).max(100_000),
  })
  .strict();

export type LoreImportEntry = z.infer<typeof LoreImportEntry>;
export type LoreImportDoc = z.infer<typeof LoreImportDoc>;

/**
 * Parse and validate an arbitrary value as a `LoreImportDoc`.
 * Throws a `ZodError` with a path-annotated message on failure.
 */
export function parseImportDoc(value: unknown): LoreImportDoc {
  return LoreImportDoc.parse(value);
}

/**
 * Non-throwing variant. Returns the standard zod `SafeParseReturnType`.
 * Callers (CLI `--file`, server endpoint) use `z.prettifyError` on failure.
 */
export function safeParseImportDoc(value: unknown) {
  return LoreImportDoc.safeParse(value);
}
