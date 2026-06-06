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

export class Database extends DatabaseSync {
  query(sql: string): QueryStatement {
    let map = statementCache.get(this);
    if (!map) {
      map = new Map();
      statementCache.set(this, map);
    }
    let entry = map.get(sql);
    if (!entry) {
      const stmt = this.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      entry = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        all: (...args: any[]) => stmt.all(...args) as Record<string, unknown>[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get: (...args: any[]) => {
          const result = stmt.get(...args) as Record<string, unknown> | null;
          return result ?? null;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
