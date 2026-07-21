import { describe, test, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  mem0RecordToEntry,
  mem0RecordsToDoc,
  scrollQdrantCollection,
  fetchMem0ServerMemories,
  readEmbeddedStorage,
  embeddedStorageCandidates,
  parseMem0File,
  resolveMem0Doc,
} from "../../src/import/sources/mem0";
import { MAX_IMPORT_CONTENT_LENGTH } from "../../src/import/schema";

const TMP = join(fileURLToPath(new URL(".", import.meta.url)), "__tmp_mem0__");
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// Pickle blobs captured from CPython pickle.dumps(..., protocol=4). No Python at
// test time — we bake the bytes and only read them.
const PICKLE = {
  // Direct-attribute PointStruct: obj.payload.* on the object itself.
  direct:
    "gASV5gAAAAAAAACMCF9fbWFpbl9flIwBUJSTlCmBlH2UKIwCaWSUjARwdC0xlIwHcGF5bG9hZJR9lCiMBGRhdGGUjB9QcmVmZXJzIGRhcmsgbW9kZSBpbiB0aGUgZWRpdG9ylIwHdXNlcl9pZJSMBWFsaWNllIwEaGFzaJSMAmgxlIwKY3JlYXRlZF9hdJSMGTIwMjYtMDctMTlUMDk6MTI6MDAtMDA6MDCUjAhtZXRhZGF0YZR9lIwEcmVwb5SMCy9ob21lL3UvYXBwlHN1jAZ2ZWN0b3KUXZQoRz+5mZmZmZmaRz/JmZmZmZmaZXViLg==",
  // __dict__/pydantic setstate PointStruct: obj.__dict__.payload.*.
  dicted:
    "gASVggAAAAAAAACMCF9fbWFpbl9flIwBUZSTlClSlH2UjAhfX2RpY3RfX5R9lCiMAmlklIwEcHQtMpSMB3BheWxvYWSUfZQojARkYXRhlIwRVXNlcyBwbnBtIG5vdCBucG2UjAd1c2VyX2lklIwDYm9ilHWMBnZlY3RvcpRdlEc/0zMzMzMzM2F1c2Iu",
  // datetime in payload → decodes to a non-primitive; must be ignored.
  dtime:
    "gASViwAAAAAAAACMCF9fbWFpbl9flIwBUJSTlCmBlH2UKIwCaWSUjARwdC0zlIwHcGF5bG9hZJR9lCiMBGRhdGGUjAxIYXMgZGF0ZXRpbWWUjApjcmVhdGVkX2F0lIwIZGF0ZXRpbWWUjAhkYXRldGltZZSTlEMKB+oHEwkMAAAAAJSFlFKUdYwGdmVjdG9ylF2UdWIu",
};

// A REAL point captured from mem0 2.0.12's embedded Qdrant store
// (qdrant_client.http.models.models.PointStruct, pydantic __dict__ shape). The
// `points.id` COLUMN is base64(pickle(uuid)) — NOT the plain id — while the
// real UUID lives inside the pickled point's __dict__.id. Regression fixture
// for the id-column bug found by importing a real store.
const REAL_MEM0 = {
  // base64 of pickle.dumps("50000c04-da53-4fac-b10e-d699c84264dd")
  idColumn:
    "gASVKAAAAAAAAACMJDUwMDAwYzA0LWRhNTMtNGZhYy1iMTBlLWQ2OTljODQyNjRkZJQu",
  uuid: "50000c04-da53-4fac-b10e-d699c84264dd",
  point:
    "gASVnAEAAAAAAACMIHFkcmFudF9jbGllbnQuaHR0cC5tb2RlbHMubW9kZWxzlIwLUG9pbnRTdHJ1Y3SUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwCaWSUjCQ1MDAwMGMwNC1kYTUzLTRmYWMtYjEwZS1kNjk5Yzg0MjY0ZGSUjAZ2ZWN0b3KUfZSMAJRdlChHAAAAAAAAAABHP7mZmZmZmZpHP8mZmZmZmZpHP9MzMzMzMzRHP9mZmZmZmZpHP+AAAAAAAABHP+MzMzMzMzRHP+ZmZmZmZmdlc4wHcGF5bG9hZJR9lCiMBGRhdGGUjB9QcmVmZXJzIGRhcmsgbW9kZSBpbiB0aGUgZWRpdG9ylIwHdXNlcl9pZJSMBWFsaWNllIwEaGFzaJSMAmgwlIwIbWV0YWRhdGGUfZSMBHJlcG+UjAsvaG9tZS91L2FwcJRzdXWMEl9fcHlkYW50aWNfZXh0cmFfX5ROjBdfX3B5ZGFudGljX2ZpZWxkc19zZXRfX5SPlChoB2gJaA2QjBRfX3B5ZGFudGljX3ByaXZhdGVfX5ROdWIu",
};

function makeStorageSqlite(name: string, blobsB64: string[]): string {
  const p = join(TMP, name);
  const db = new DatabaseSync(p);
  db.exec("CREATE TABLE points (id TEXT PRIMARY KEY, point BLOB)");
  const stmt = db.prepare("INSERT INTO points VALUES (?, ?)");
  blobsB64.forEach((b64, i) => {
    stmt.run(`row-${i}`, Buffer.from(b64, "base64"));
  });
  db.close();
  return p;
}

describe("mem0RecordToEntry", () => {
  test("maps data/user/metadata; defaults category pattern", () => {
    const entry = mem0RecordToEntry({
      id: "m-1",
      data: "Prefers dark mode",
      user_id: "alice",
      metadata: { repo: "/home/u/app" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("Prefers dark mode");
    expect(entry!.category).toBe("pattern");
    expect(entry!.project).toBe("/home/u/app");
    expect(entry!.external_id).toBe("m-1");
  });

  test("falls back to `memory` key (server REST shape)", () => {
    const entry = mem0RecordToEntry({ id: 7, memory: "Uses pnpm" });
    expect(entry!.content).toBe("Uses pnpm");
    expect(entry!.external_id).toBe("7");
  });

  test("explicit project overrides metadata.repo", () => {
    const entry = mem0RecordToEntry(
      { data: "x", metadata: { repo: "/from/meta" } },
      { project: "/from/flag" },
    );
    expect(entry!.project).toBe("/from/flag");
  });

  test("skips empty/whitespace and non-string content", () => {
    expect(mem0RecordToEntry({ data: "   " })).toBeNull();
    expect(mem0RecordToEntry({ data: null })).toBeNull();
    expect(mem0RecordToEntry({})).toBeNull();
  });

  test("truncates oversized content to the schema ceiling", () => {
    const entry = mem0RecordToEntry({ data: "z".repeat(80_000) });
    expect(entry!.content.length).toBeLessThanOrEqual(
      MAX_IMPORT_CONTENT_LENGTH,
    );
  });

  test("falls back to hash as external_id when id is absent", () => {
    const entry = mem0RecordToEntry({ data: "x", hash: "deadbeef" });
    expect(entry!.external_id).toBe("deadbeef");
  });
});

describe("mem0RecordsToDoc", () => {
  test("builds a validated mem0 doc, dropping skips", () => {
    const doc = mem0RecordsToDoc([
      { data: "keep 1", id: "1" },
      { data: "  ", id: "2" },
      { memory: "keep 2", id: "3" },
    ]);
    expect(doc.source).toBe("mem0");
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries.every((e) => e.category === "pattern")).toBe(true);
  });
});

describe("scrollQdrantCollection", () => {
  test("paginates over next_page_offset and reads payload.data", async () => {
    const pages = [
      {
        result: {
          points: [
            { id: "a", payload: { data: "first", user_id: "u1" } },
            { id: "b", payload: { data: "second", user_id: "u1" } },
          ],
          next_page_offset: "cursor-1",
        },
      },
      {
        result: {
          points: [{ id: "c", payload: { data: "third", user_id: "u1" } }],
          next_page_offset: null,
        },
      },
    ];
    let call = 0;
    const fetchImpl = (async (_url: string, _init: unknown) => {
      const body = pages[call++];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
      };
    }) as unknown as typeof fetch;

    const recs = await scrollQdrantCollection({
      url: "http://127.0.0.1:6333",
      collection: "mem0",
      fetchImpl,
      pageSize: 2,
    });
    expect(call).toBe(2);
    expect(recs.map((r) => r.data)).toEqual(["first", "second", "third"]);
    expect(recs[0].id).toBe("a");
  });

  test("throws on a non-ok response", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      scrollQdrantCollection({
        url: "http://127.0.0.1:6333",
        collection: "missing",
        fetchImpl,
      }),
    ).rejects.toThrow(/Qdrant scroll failed/);
  });

  test("stops on an empty page even if server returns a trailing cursor", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          result: { points: [], next_page_offset: "still-here" },
        }),
      };
    }) as unknown as typeof fetch;
    const recs = await scrollQdrantCollection({
      url: "http://127.0.0.1:6333",
      collection: "mem0",
      fetchImpl,
    });
    expect(recs).toHaveLength(0);
    expect(call).toBe(1);
  });
});

describe("fetchMem0ServerMemories", () => {
  test("reads results[] and sends the api key", async () => {
    let sawHeader: string | undefined;
    const fetchImpl = (async (
      _url: string,
      init: { headers?: Record<string, string> },
    ) => {
      sawHeader = init?.headers?.["X-API-Key"];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ results: [{ id: "s1", memory: "server mem" }] }),
      };
    }) as unknown as typeof fetch;
    const recs = await fetchMem0ServerMemories({
      url: "http://127.0.0.1:8888",
      userId: "alice",
      apiKey: "secret",
      fetchImpl,
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].memory).toBe("server mem");
    expect(sawHeader).toBe("secret");
  });

  test("throws with auth hint on 401", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      fetchMem0ServerMemories({
        url: "http://127.0.0.1:8888",
        userId: "alice",
        fetchImpl,
      }),
    ).rejects.toThrow(/--mem0-token/);
  });
});

describe("readEmbeddedStorage (native pickle reader)", () => {
  test("decodes direct-attribute and __dict__ point shapes", async () => {
    const path = makeStorageSqlite("s1.sqlite", [PICKLE.direct, PICKLE.dicted]);
    const recs = await readEmbeddedStorage(path);
    const byData = recs.map((r) => r.data);
    expect(byData).toContain("Prefers dark mode in the editor");
    expect(byData).toContain("Uses pnpm not npm");
    const alice = recs.find(
      (r) => r.data === "Prefers dark mode in the editor",
    );
    expect((alice!.metadata as { repo?: string })?.repo).toBe("/home/u/app");
    expect(alice!.user_id).toBe("alice");
  });

  test("gracefully ignores a non-primitive payload value (datetime)", async () => {
    const path = makeStorageSqlite("s2.sqlite", [PICKLE.dtime]);
    const recs = await readEmbeddedStorage(path);
    expect(recs).toHaveLength(1);
    // Content still reads; created_at (a datetime object) is coerced away later.
    const doc = mem0RecordsToDoc(recs);
    expect(doc.entries[0].content).toBe("Has datetime");
    expect(doc.entries[0].created_at).toBeUndefined();
  });

  test("skips an undecodable blob instead of aborting the whole read", async () => {
    // A single corrupt/undecodable point must not throw — the reader continues
    // and still returns the good rows.
    const p = join(TMP, "corrupt.sqlite");
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE points (id TEXT PRIMARY KEY, point BLOB)");
    const ins = db.prepare("INSERT INTO points VALUES (?, ?)");
    ins.run("bad", Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])); // not a pickle
    ins.run("good", Buffer.from(PICKLE.direct, "base64"));
    db.close();

    const recs = await readEmbeddedStorage(p);
    expect(recs).toHaveLength(1);
    expect(recs[0].data).toBe("Prefers dark mode in the editor");
  });

  test("embeddedStorageCandidates covers mem0 + openmemory collections", () => {
    const cands = embeddedStorageCandidates("/base");
    expect(cands).toContain("/base/collection/mem0/storage.sqlite");
    expect(cands).toContain("/base/collection/openmemory/storage.sqlite");
  });

  test("uses the point's decoded UUID, NOT the base64-pickled id column (real mem0 2.0.12)", async () => {
    // Regression: real mem0 stores points.id as base64(pickle(uuid)); the plain
    // UUID lives in the pickled point's __dict__.id. The reader must read the
    // decoded id, not the column, or external_id becomes a garbage blob.
    const p = join(TMP, "real.sqlite");
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE points (id TEXT PRIMARY KEY, point BLOB)");
    db.prepare("INSERT INTO points VALUES (?, ?)").run(
      REAL_MEM0.idColumn,
      Buffer.from(REAL_MEM0.point, "base64"),
    );
    db.close();

    const recs = await readEmbeddedStorage(p);
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(REAL_MEM0.uuid);
    expect(recs[0].data).toBe("Prefers dark mode in the editor");

    const doc = mem0RecordsToDoc(recs);
    expect(doc.entries[0].external_id).toBe(REAL_MEM0.uuid);
  });
});

describe("parseMem0File", () => {
  test("passes through a generic LoreImportDoc", () => {
    const p = join(TMP, "generic.json");
    writeFileSync(
      p,
      JSON.stringify({
        lore_import_version: 1,
        source: "generic",
        entries: [{ content: "already normalized", category: "pattern" }],
      }),
    );
    const doc = parseMem0File(p);
    expect(doc.source).toBe("generic");
    expect(doc.entries[0].content).toBe("already normalized");
  });

  test("converts a raw mem0 export ({results:[...]}) ", () => {
    const p = join(TMP, "raw.json");
    writeFileSync(
      p,
      JSON.stringify({
        results: [{ id: "1", memory: "raw mem", user_id: "u" }],
      }),
    );
    const doc = parseMem0File(p);
    expect(doc.source).toBe("mem0");
    expect(doc.entries[0].content).toBe("raw mem");
  });

  test("converts a bare array export", () => {
    const p = join(TMP, "arr.json");
    writeFileSync(p, JSON.stringify([{ id: "1", data: "bare" }]));
    const doc = parseMem0File(p);
    expect(doc.entries[0].content).toBe("bare");
  });
});

describe("resolveMem0Doc (auto-detect)", () => {
  test("explicit file wins over all probes", async () => {
    const p = join(TMP, "explicit.json");
    writeFileSync(p, JSON.stringify([{ id: "1", data: "explicit" }]));
    let probed = false;
    const doc = await resolveMem0Doc({
      filePath: p,
      probe: async () => {
        probed = true;
        return true;
      },
    });
    expect(doc.entries[0].content).toBe("explicit");
    expect(probed).toBe(false);
  });

  test("routes to Qdrant scroll when :6333 is reachable", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/points/scroll")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: {
              points: [{ id: "q1", payload: { data: "from qdrant" } }],
              next_page_offset: null,
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
      };
    }) as unknown as typeof fetch;
    const doc = await resolveMem0Doc({
      probe: async (u) => u.includes("/collections"),
      fetchImpl,
    });
    expect(doc.entries[0].content).toBe("from qdrant");
  });

  test("falls back to embedded store when no server is reachable", async () => {
    const dir = join(TMP, "embedded");
    const collDir = join(dir, "collection", "mem0");
    mkdirSync(collDir, { recursive: true });
    const dbPath = join(collDir, "storage.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE points (id TEXT PRIMARY KEY, point BLOB)");
    db.prepare("INSERT INTO points VALUES (?, ?)").run(
      "row-0",
      Buffer.from(PICKLE.direct, "base64"),
    );
    db.close();
    const doc = await resolveMem0Doc({
      embeddedPath: dir,
      probe: async () => false,
    });
    expect(doc.entries[0].content).toBe("Prefers dark mode in the editor");
  });

  test("throws actionable guidance when nothing is found", async () => {
    await expect(
      resolveMem0Doc({
        embeddedPath: join(TMP, "does-not-exist"),
        probe: async () => false,
      }),
    ).rejects.toThrow(/No mem0 data found|--file/);
  });

  test("routes to the mem0 server when serverUrl+user given and Qdrant is down", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/memories")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ results: [{ id: "s1", memory: "srv mem" }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
      };
    }) as unknown as typeof fetch;
    const doc = await resolveMem0Doc({
      serverUrl: "http://127.0.0.1:8888",
      userId: "alice",
      // Qdrant probe fails; server /docs probe passes.
      probe: async (u) => u.includes("/docs"),
      fetchImpl,
    });
    expect(doc.entries[0].content).toBe("srv mem");
  });

  test("errors with --mem0-user hint when server is reachable but no user id", async () => {
    await expect(
      resolveMem0Doc({
        serverUrl: "http://127.0.0.1:8888",
        probe: async (u) => u.includes("/docs"),
      }),
    ).rejects.toThrow(/--mem0-user/);
  });

  test("does NOT try the server branch when neither serverUrl nor userId is set", async () => {
    // Guard: the server branch is gated on `serverUrl || userId`. With neither,
    // a passing /docs probe must NOT trigger a server fetch — we fall through to
    // embedded (absent here) and get the actionable not-found error. Only the
    // /docs probe passes (Qdrant /collections fails) to isolate the server gate.
    let serverFetched = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/memories")) serverFetched = true;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
      };
    }) as unknown as typeof fetch;
    await expect(
      resolveMem0Doc({
        embeddedPath: join(TMP, "nope"),
        probe: async (u) => u.includes("/docs"),
        fetchImpl,
      }),
    ).rejects.toThrow(/No mem0 data found|--file/);
    expect(serverFetched).toBe(false);
  });
});
