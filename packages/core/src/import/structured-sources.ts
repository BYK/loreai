/**
 * Structured-memory sources — detection + document production for import lanes
 * that read ALREADY-CURATED memory (Engram, mem0, ...) rather than raw
 * conversation transcripts.
 *
 * Unlike `AgentHistoryProvider` (which yields conversation chunks for the
 * curator LLM), a `StructuredSource` yields a validated `LoreImportDoc` that is
 * written directly to the knowledge store via `importStructuredEntries`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEngramExport } from "./sources/engram";
import { safeParseImportDoc, type LoreImportDoc } from "./schema";

export type StructuredSourceName = "engram" | "mem0";

export type StructuredSource = {
  /** Internal name (matches LoreImportDoc.source and --agent filter). */
  readonly name: StructuredSourceName;
  /** Human-readable name. */
  readonly displayName: string;
  /**
   * Fast, side-effect-free check: does this source appear to be present on the
   * machine? Used to surface it in `lore import` auto-detection.
   */
  detect(): boolean;
  /**
   * Produce a validated LoreImportDoc from this source. When `filePath` is
   * provided, read/convert that file; otherwise auto-discover (e.g. run the
   * source's own export CLI). Throws with an actionable message on failure.
   */
  produceDoc(opts?: { filePath?: string }): LoreImportDoc;
};

/** True when `bin` is resolvable on PATH (best-effort, never throws). */
function hasBinary(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Read + JSON-parse a file, returning the parsed value. Throws on error. */
function readJson(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Engram
// ---------------------------------------------------------------------------

export const engramSource: StructuredSource = {
  name: "engram",
  displayName: "Engram",

  detect(): boolean {
    // Engram is a single Go binary; its default DB lives under ~/.engram.
    if (hasBinary("engram")) return true;
    const dbPath = join(homedir(), ".engram", "engram.db");
    return existsSync(dbPath);
  },

  produceDoc(opts?: { filePath?: string }): LoreImportDoc {
    let raw: unknown;
    if (opts?.filePath) {
      raw = readJson(opts.filePath);
    } else if (hasBinary("engram")) {
      // `engram export` writes the ExportData JSON to stdout.
      const out = execFileSync("engram", ["export"], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      raw = JSON.parse(out);
    } else {
      throw new Error(
        "Engram not found. Install the `engram` binary or pass --file <export.json> " +
          "(produce it with `engram export export.json`).",
      );
    }
    // If the file is already a LoreImportDoc (generic pass-through), accept it.
    const asGeneric = safeParseImportDoc(raw);
    if (asGeneric.success) return asGeneric.data;
    // Otherwise treat it as a native Engram export.
    return parseEngramExport(raw);
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const sources: StructuredSource[] = [engramSource];

/** All registered structured sources. */
export function getStructuredSources(): readonly StructuredSource[] {
  return sources;
}

/** Look up a structured source by name. */
export function getStructuredSource(
  name: string,
): StructuredSource | undefined {
  return sources.find((s) => s.name === name);
}

/** Detect which structured sources are present on this machine. */
export function detectStructuredSources(): StructuredSource[] {
  return sources.filter((s) => {
    try {
      return s.detect();
    } catch {
      return false;
    }
  });
}
