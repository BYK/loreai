// Node runtime driver for Lore's SQLite access.
//
// Selected via the `#db/driver` subpath import map when running under Node
// (Pi extension, future ACP server, and CI nodes that aren't Bun). `node:sqlite`
// has shipped in Node since 22.5 and stabilized (no flag) in Node 24.
//
// Bun deliberately does NOT implement `node:sqlite`, so src code that imports
// from this file must go through `#db/driver`. Never import `node:sqlite`
// directly outside this file — it will break the test runner which runs against src.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const statementCache = new WeakMap<DatabaseSync, Map<string, unknown>>();

interface QueryStatement {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | null;
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: bigint };
}

/**
 * `allowExtension` (required to load the sqlite-vec native extension) landed in
 * `node:sqlite` in Node 23.5 and was backported to Node 22.13 (LTS). Passing
 * it on older Node throws during option validation, so we gate on the runtime
 * version. On 22.5–22.12 and 23.0–23.4 the option is omitted and vector
 * search transparently uses the JS brute-force fallback.
 *
 * `nodeVersion` is parameterized for testability — production callers should
 * leave it unset to read the live runtime version.
 */
export function supportsAllowExtension(
  nodeVersion: string = process.versions.node,
): boolean {
  const [maj = 0, min = 0] = nodeVersion.split(".").map(Number);
  return maj > 23 || (maj === 23 && min >= 5) || (maj === 22 && min >= 13);
}

export class Database extends DatabaseSync {
  constructor(
    path: ConstructorParameters<typeof DatabaseSync>[0],
    options?: ConstructorParameters<typeof DatabaseSync>[1],
  ) {
    super(
      path,
      supportsAllowExtension()
        ? { ...(options ?? {}), allowExtension: true }
        : options,
    );
  }

  query(sql: string): QueryStatement {
    let map = statementCache.get(this);
    if (!map) {
      map = new Map();
      statementCache.set(this, map);
    }
    let entry = map.get(sql);
    if (!entry) {
      const stmt = this.prepare(sql);
      entry = {
        // biome-ignore lint/suspicious/noExplicitAny: node:sqlite prepare().all() accepts variadic args
        all: (...args: any[]) => stmt.all(...args) as Record<string, unknown>[],
        // biome-ignore lint/suspicious/noExplicitAny: node:sqlite prepare().get() accepts variadic args
        get: (...args: any[]) => {
          const result = stmt.get(...args) as Record<string, unknown> | null;
          return result ?? null;
        },
        // biome-ignore lint/suspicious/noExplicitAny: node:sqlite prepare().run() accepts variadic args
        run: (...args: any[]) =>
          stmt.run(...args) as { changes: number; lastInsertRowid: bigint },
      };
      map.set(sql, entry);
    }
    return entry as QueryStatement;
  }
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
