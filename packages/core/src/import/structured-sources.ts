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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseEngramExport } from "./sources/engram";
import {
  defaultEmbeddedDirs,
  embeddedStorageCandidates,
  resolveMem0Doc,
} from "./sources/mem0";
import { safeParseImportDoc, type LoreImportDoc } from "./schema";

export type StructuredSourceName = "engram" | "mem0";

/**
 * Options passed to `produceDoc`. `filePath` and `project` are generic; the
 * `mem0*` fields are mem0-specific deployment overrides (ignored by Engram).
 */
export type ProduceDocOptions = {
  filePath?: string;
  project?: string;
  mem0QdrantUrl?: string;
  mem0Collection?: string;
  mem0ServerUrl?: string;
  mem0Token?: string;
  mem0Path?: string;
  mem0User?: string;
};

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
   * source's own export CLI, or probe a running server). Throws with an
   * actionable message on failure. May be async (network probes).
   */
  produceDoc(opts?: ProduceDocOptions): LoreImportDoc | Promise<LoreImportDoc>;
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

  produceDoc(opts?: ProduceDocOptions): LoreImportDoc {
    let raw: unknown;
    if (opts?.filePath) {
      raw = readJson(opts.filePath);
    } else if (hasBinary("engram")) {
      // `engram export [file]` writes the ExportData JSON to a FILE (default
      // `engram-export.json`) and prints a human-readable summary ("Exported to
      // …", possibly preceded by an "Update available" banner) to stdout — it
      // does NOT emit JSON on stdout. So we hand it an explicit temp file, then
      // read and parse that file. Parsing stdout fails with e.g.
      // `Unexpected token 'E', "Exported t"... is not valid JSON` — or, when the
      // update banner precedes the summary, `"Update ava"...` (issue #1398).
      const dir = mkdtempSync(join(tmpdir(), "lore-engram-"));
      const exportFile = join(dir, "engram-export.json");
      try {
        execFileSync("engram", ["export", exportFile], {
          stdio: "ignore",
          maxBuffer: 256 * 1024 * 1024,
        });
        raw = readJson(exportFile);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
// mem0
// ---------------------------------------------------------------------------

export const mem0Source: StructuredSource = {
  name: "mem0",
  displayName: "mem0",

  detect(): boolean {
    // Embedded-default store artifacts (cheap, synchronous existence checks).
    // A running Qdrant/mem0 server is detected at produceDoc time (async probe);
    // detection here just surfaces the source when a local store is present.
    // Reuse the resolver's dir list + candidate paths so detect() and
    // resolveMem0Doc can never drift on where the embedded store lives.
    for (const dir of defaultEmbeddedDirs()) {
      for (const storagePath of embeddedStorageCandidates(dir)) {
        if (existsSync(storagePath)) return true;
      }
    }
    return false;
  },

  produceDoc(opts?: ProduceDocOptions): Promise<LoreImportDoc> {
    return resolveMem0Doc({
      filePath: opts?.filePath,
      project: opts?.project,
      qdrantUrl: opts?.mem0QdrantUrl,
      collection: opts?.mem0Collection,
      serverUrl: opts?.mem0ServerUrl,
      token: opts?.mem0Token,
      embeddedPath: opts?.mem0Path,
      userId: opts?.mem0User,
    });
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const sources: StructuredSource[] = [engramSource, mem0Source];

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
