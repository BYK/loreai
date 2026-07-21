/**
 * mem0 source adapter — native, Python-free migration of mem0 memories into a
 * `LoreImportDoc`.
 *
 * mem0 has several deployment shapes; this adapter reads every common one
 * without invoking Python:
 *   1. Qdrant server (OpenMemory / raw Qdrant)  → HTTP `points/scroll` (fetch)
 *   2. mem0 self-hosted server (FastAPI)        → HTTP `GET /memories` (fetch)
 *   3. Embedded default (`Memory()`)            → read `storage.sqlite` +
 *                                                 decode pickled Qdrant points
 *   4. Explicit `--file <dump.json>`            → generic LoreImportDoc / raw
 *
 * The vector is never used (we ignore embeddings). Only the payload text and a
 * few metadata fields are imported. mem0 OSS has no category → default
 * `pattern` (per plan decision); a fresh Lore UUIDv7 is minted per entry, with
 * the mem0 point id kept as `external_id` for idempotency.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseImportDoc,
  safeParseImportDoc,
  MAX_IMPORT_CONTENT_LENGTH,
  type LoreImportDoc,
  type LoreImportEntry,
} from "../schema";

/** A single normalized mem0 memory record, source-shape-independent. */
export type Mem0Record = {
  id?: string | number;
  /** Memory text — Qdrant/embedded payload key is `data`; server REST is `memory`. */
  data?: unknown;
  memory?: unknown;
  user_id?: unknown;
  hash?: unknown;
  created_at?: unknown;
  metadata?: Record<string, unknown> | null;
};

/** Coerce an unknown payload value to a plain string, or undefined. */
function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Map one normalized mem0 record → a `LoreImportEntry` (or null to skip).
 * `data` (embedded/Qdrant) and `memory` (server REST) both carry the text.
 */
export function mem0RecordToEntry(
  rec: Mem0Record,
  opts?: { project?: string },
): LoreImportEntry | null {
  const text = asString(rec.data) ?? asString(rec.memory);
  if (!text || text.trim() === "") return null;

  const entry: LoreImportEntry = {
    // Clamp to the schema ceiling so an oversized memory is truncated here
    // rather than failing validation and aborting the whole import.
    content:
      text.length > MAX_IMPORT_CONTENT_LENGTH
        ? text.slice(0, MAX_IMPORT_CONTENT_LENGTH)
        : text,
    // mem0 OSS has no category taxonomy → default pattern (plan decision).
    category: "pattern",
  };

  // Project: explicit --project wins; else metadata.repo if present.
  const repo = asString(rec.metadata?.repo);
  const project = opts?.project ?? repo;
  if (project) entry.project = project;

  const createdAt = asString(rec.created_at);
  if (createdAt) entry.created_at = createdAt;

  const externalId =
    rec.id != null ? String(rec.id) : (asString(rec.hash) ?? undefined);
  if (externalId) entry.external_id = externalId;

  return entry;
}

/** Build a validated LoreImportDoc from normalized mem0 records. */
export function mem0RecordsToDoc(
  records: Mem0Record[],
  opts?: { project?: string },
): LoreImportDoc {
  const entries: LoreImportEntry[] = [];
  for (const rec of records) {
    const entry = mem0RecordToEntry(rec, opts);
    if (entry) entries.push(entry);
  }
  return parseImportDoc({
    lore_import_version: 1,
    source: "mem0",
    entries,
  });
}

// ---------------------------------------------------------------------------
// Native path 1 — Qdrant scroll (OpenMemory / raw Qdrant server)
// ---------------------------------------------------------------------------

/** A Qdrant point as returned by the scroll API (only fields we read). */
type QdrantPoint = {
  id?: string | number;
  payload?: Record<string, unknown> | null;
};

/**
 * Scroll every point out of a Qdrant collection via the HTTP API (pure fetch,
 * no @qdrant/js-client-rest — the official client has no embedded mode and its
 * scroll() is a 1:1 wrapper over this same endpoint). Paginates on
 * `next_page_offset` until null.
 */
export async function scrollQdrantCollection(opts: {
  url: string;
  collection: string;
  apiKey?: string;
  pageSize?: number;
  fetchImpl?: typeof fetch;
}): Promise<Mem0Record[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/+$/, "");
  const limit = opts.pageSize ?? 256;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.apiKey) headers["api-key"] = opts.apiKey;

  const records: Mem0Record[] = [];
  let offset: unknown = null;
  // Bound iterations defensively so a misbehaving server can't spin forever.
  for (let page = 0; page < 100_000; page++) {
    const res = await doFetch(
      `${base}/collections/${encodeURIComponent(opts.collection)}/points/scroll`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          limit,
          with_payload: true,
          with_vector: false,
          offset,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(
        `Qdrant scroll failed (${res.status} ${res.statusText}) for collection "${opts.collection}" at ${base}.`,
      );
    }
    const body = (await res.json()) as {
      result?: { points?: QdrantPoint[]; next_page_offset?: unknown };
    };
    const points = body.result?.points ?? [];
    for (const p of points) {
      // On-store payload text key is `data` (NOT `memory`).
      const payload = p.payload ?? {};
      records.push({ id: p.id, ...payload });
    }
    const next = body.result?.next_page_offset ?? null;
    // Stop when the server signals no more pages OR returns an empty page.
    if (next == null || points.length === 0) break;
    offset = next;
  }
  return records;
}

// ---------------------------------------------------------------------------
// Native path 2 — mem0 self-hosted server REST
// ---------------------------------------------------------------------------

/**
 * Read memories from a mem0 self-hosted FastAPI server (`GET /memories`).
 * Requires a user id (mem0 server scopes by user). Auth via X-API-Key/token.
 */
export async function fetchMem0ServerMemories(opts: {
  url: string;
  userId: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<Mem0Record[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers["X-API-Key"] = opts.apiKey;

  const res = await doFetch(
    `${base}/memories?user_id=${encodeURIComponent(opts.userId)}`,
    { headers },
  );
  if (!res.ok) {
    throw new Error(
      `mem0 server request failed (${res.status} ${res.statusText}) at ${base}. ` +
        (res.status === 401 || res.status === 403
          ? "Provide --mem0-token for an authenticated server."
          : ""),
    );
  }
  const body = (await res.json()) as
    | {
        results?: Mem0Record[];
        memories?: Mem0Record[];
      }
    | Mem0Record[];
  if (Array.isArray(body)) return body;
  return body.results ?? body.memories ?? [];
}

// ---------------------------------------------------------------------------
// Native path 3 — embedded default: read storage.sqlite + decode pickle
// ---------------------------------------------------------------------------

/** Candidate paths for the embedded Qdrant store's SQLite file. */
export function embeddedStorageCandidates(baseDir: string): string[] {
  // Layout: <baseDir>/collection/<name>/storage.sqlite. mem0's default
  // collection is "mem0"; OpenMemory uses "openmemory".
  return [
    join(baseDir, "collection", "mem0", "storage.sqlite"),
    join(baseDir, "collection", "openmemory", "storage.sqlite"),
  ];
}

/**
 * Read + pickle-decode an embedded Qdrant `storage.sqlite`. Pure Node — opens
 * the file read-only via node:sqlite and decodes each `point` BLOB with
 * `pickleparser` (both deps lazy-imported so detection-only paths stay light).
 *
 * pickleparser represents the decoded PointStruct with instance attributes
 * either directly on the object OR under `__dict__` (pydantic __setstate__
 * shape) — we guard with `obj.__dict__ ?? obj`. Non-primitive payload values
 * (e.g. a pickled datetime) decode to an empty wrapper and are coerced/ignored.
 */
export async function readEmbeddedStorage(
  storagePath: string,
): Promise<Mem0Record[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const { Parser } = await import("pickleparser");

  const db = new DatabaseSync(storagePath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, point FROM points").all() as {
      id: unknown;
      point: Uint8Array;
    }[];
    const parser = new Parser();
    const records: Mem0Record[] = [];
    for (const row of rows) {
      if (!(row.point instanceof Uint8Array)) continue;
      let obj: Record<string, unknown>;
      try {
        obj = parser.parse<Record<string, unknown>>(row.point);
      } catch {
        // A single undecodable blob must not abort the whole import.
        continue;
      }
      const state =
        (obj as { __dict__?: Record<string, unknown> }).__dict__ ?? obj;
      const payload = (state.payload ?? {}) as Record<string, unknown>;
      // Prefer the point id decoded from the pickled PointStruct (`state.id` is
      // the real UUID). The `points.id` COLUMN is NOT the plain id — real mem0
      // stores it as base64(pickle(uuid)), so using it verbatim yields a
      // garbage external_id. Fall back to the raw column only if the decoded
      // point carries no id.
      const decodedId = state.id;
      const id =
        typeof decodedId === "string" || typeof decodedId === "number"
          ? decodedId
          : (row.id as string | number);
      records.push({ id, ...payload });
    }
    return records;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Native path 4 — explicit --file dump
// ---------------------------------------------------------------------------

/**
 * Read a `--file` dump. Accepts either an already-normalized `LoreImportDoc`
 * (generic pass-through) or a raw mem0 export shape (`{ results: [...] }` or a
 * bare array of records).
 */
export function parseMem0File(
  filePath: string,
  opts?: { project?: string },
): LoreImportDoc {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));

  // Already a LoreImportDoc?
  const asGeneric = safeParseImportDoc(raw);
  if (asGeneric.success) return asGeneric.data;

  // Raw mem0 export: `{ results: [...] }`, `{ memories: [...] }`, or bare array.
  const records: Mem0Record[] = Array.isArray(raw)
    ? (raw as Mem0Record[])
    : ((raw?.results ?? raw?.memories ?? []) as Mem0Record[]);
  return mem0RecordsToDoc(records, opts);
}

// ---------------------------------------------------------------------------
// Resolver — auto-detect deployment shape and produce the doc
// ---------------------------------------------------------------------------

export type Mem0ResolveOptions = {
  /** Explicit dump file (skips all auto-detection). */
  filePath?: string;
  /** Default project for entries lacking metadata.repo. */
  project?: string;
  /** Overrides. */
  qdrantUrl?: string;
  collection?: string;
  serverUrl?: string;
  token?: string;
  /** Embedded store base dir (contains collection/<name>/storage.sqlite). */
  embeddedPath?: string;
  userId?: string;
  fetchImpl?: typeof fetch;
  /** Probe function (injectable for tests). Returns true when URL is reachable. */
  probe?: (url: string) => Promise<boolean>;
};

const DEFAULT_QDRANT_URL = "http://127.0.0.1:6333";
const DEFAULT_SERVER_URL = "http://127.0.0.1:8888";

/** Default TCP/HTTP reachability probe — a short HEAD/GET that never throws. */
async function defaultProbe(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    try {
      const res = await doFetch(url, { signal: ctrl.signal });
      return res.ok || res.status === 401 || res.status === 403;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Default embedded-store base dir (`~/.mem0` sibling `/tmp/qdrant`, or cwd). */
function defaultEmbeddedDirs(): string[] {
  const dirs = ["/tmp/qdrant"];
  const home = process.env.HOME;
  if (home) dirs.push(join(home, ".mem0"));
  return dirs;
}

/**
 * Auto-detect the mem0 deployment shape and produce a validated LoreImportDoc.
 * Order: explicit file → Qdrant server → mem0 server → embedded store. Throws
 * an actionable error (with a manual `--file` one-liner) when nothing is found.
 */
export async function resolveMem0Doc(
  opts: Mem0ResolveOptions = {},
): Promise<LoreImportDoc> {
  const project = opts.project;

  // 0. Explicit file always wins.
  if (opts.filePath) return parseMem0File(opts.filePath, { project });

  const probe = opts.probe ?? ((u: string) => defaultProbe(u, opts.fetchImpl));

  // 1. Qdrant server (OpenMemory / raw Qdrant).
  const qdrantUrl = opts.qdrantUrl ?? DEFAULT_QDRANT_URL;
  if (await probe(`${qdrantUrl.replace(/\/+$/, "")}/collections`)) {
    const collection = opts.collection ?? "openmemory";
    let records: Mem0Record[];
    try {
      records = await scrollQdrantCollection({
        url: qdrantUrl,
        collection,
        apiKey: opts.token,
        fetchImpl: opts.fetchImpl,
      });
    } catch {
      // Try the other default collection name before giving up.
      records = await scrollQdrantCollection({
        url: qdrantUrl,
        collection: opts.collection ?? "mem0",
        apiKey: opts.token,
        fetchImpl: opts.fetchImpl,
      });
    }
    return mem0RecordsToDoc(records, { project });
  }

  // 2. mem0 self-hosted server (needs a user id).
  const serverUrl = opts.serverUrl ?? DEFAULT_SERVER_URL;
  if (opts.serverUrl || opts.userId) {
    if (await probe(`${serverUrl.replace(/\/+$/, "")}/docs`)) {
      if (!opts.userId) {
        throw new Error(
          "mem0 server detected but no user id given. Pass --mem0-user <id>.",
        );
      }
      const records = await fetchMem0ServerMemories({
        url: serverUrl,
        userId: opts.userId,
        apiKey: opts.token,
        fetchImpl: opts.fetchImpl,
      });
      return mem0RecordsToDoc(records, { project });
    }
  }

  // 3. Embedded default store.
  const baseDirs = opts.embeddedPath
    ? [opts.embeddedPath]
    : defaultEmbeddedDirs();
  for (const dir of baseDirs) {
    for (const storagePath of embeddedStorageCandidates(dir)) {
      if (existsSync(storagePath)) {
        const records = await readEmbeddedStorage(storagePath);
        return mem0RecordsToDoc(records, { project });
      }
    }
  }

  // 4. Nothing found — actionable last-resort guidance.
  throw new Error(
    "No mem0 data found. Start your mem0 server, or point Lore at it with " +
      "--mem0-qdrant/--mem0-server/--mem0-path, or export manually and pass --file:\n" +
      '  pip install mem0ai && python -c "import json;from mem0 import Memory;' +
      'm=Memory();print(json.dumps(m.get_all(user_id=\\"YOUR_USER\\")))" > mem0.json\n' +
      "  lore import --source mem0 --file mem0.json",
  );
}
