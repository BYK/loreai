/** Idle, bounded vec0 garbage collection. Never fall back to a writer scan. */
import { db, isCurrentDatabase } from "./db";
import { isVecAvailable } from "./db/vec";
import { readStorageMode } from "./db/vec-store";
import { READ_JOB_TIMED_OUT, tryPoolRead } from "./vector-pool";

const TABLES = [
  { vec: "knowledge_vec", key: "id", source: "id", base: "knowledge_current" },
  { vec: "entity_vec", key: "id", source: "id", base: "entities" },
  { vec: "distillation_vec", key: "id", source: "id", base: "distillations" },
  {
    vec: "temporal_vec",
    key: "chunk_id",
    source: "message_id",
    base: "temporal_messages",
  },
] as const;

export const VEC0_ORPHAN_PAGE_SIZE = 128;
const PAGE_INTERVAL_MS = 1000;
const RETRY_INTERVAL_MS = 30_000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface Row {
  cursor: number;
  id: string;
  orphan: number;
}

/**
 * The host owns this service and must stop it before closing storage. A stop
 * fences late worker results; neither those results nor a timer can reopen DB.
 * One page is in flight at a time, and foreground activity gates both its read
 * and its deletes. An unavailable worker leaves harmless orphans for a retry.
 */
export function startVec0OrphanMaintenance(
  shouldPause: () => boolean,
): () => void {
  const connection = db();
  let stopped = false;
  let tableIndex = 0;
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout>;
  const current = () => !stopped && isCurrentDatabase(connection);
  const schedule = (delay: number) => {
    if (!current()) return;
    timer = setTimeout(() => {
      void tick();
    }, delay);
    timer.unref?.();
  };
  const tick = async () => {
    let delay = PAGE_INTERVAL_MS;
    try {
      if (!current()) return;
      if (shouldPause()) return;
      if (!isVecAvailable() || readStorageMode(connection) !== "vec0") {
        delay = RETRY_INTERVAL_MS;
        return;
      }
      const table = TABLES[tableIndex];
      // vec0's text-key shadow index supplies an indexed rowid cursor. Reading
      // shadow metadata is safe; all writes go through the virtual table API.
      // Materialize BEFORE testing liveness: LIMIT on orphan matches alone
      // would still walk an entire healthy corpus. No vectors cross the RPC.
      const result = await tryPoolRead({
        sql: `WITH page AS MATERIALIZED (
          SELECT rowid AS cursor, id FROM ${table.vec}_rowids
          WHERE rowid > ? ORDER BY rowid LIMIT ?
        ) SELECT page.cursor, page.id,
          NOT EXISTS (SELECT 1 FROM ${table.base} b WHERE b.id = v.${table.source}) AS orphan
          FROM page CROSS JOIN ${table.vec} v ON v.${table.key} = page.id
          ORDER BY page.cursor`,
        params: [cursor, VEC0_ORPHAN_PAGE_SIZE],
        mode: "all",
      });
      if (!current()) return;
      if (!result || result === READ_JOB_TIMED_OUT) {
        delay = RETRY_INTERVAL_MS;
        return;
      }
      if (shouldPause()) return; // replay this small page after traffic settles
      const rows = result.rows as Row[];
      // Bound the writer lock to one small page. The liveness check uses the
      // CURRENT vector source, not the reader's snapshot: delete/recreate and
      // a restored base row must survive. The equality selects the exact key.
      const busyTimeout = (
        connection.query("PRAGMA busy_timeout").get() as { timeout: number }
      ).timeout;
      connection.exec("PRAGMA busy_timeout = 0");
      try {
        connection.exec("SAVEPOINT vec0_idle_gc");
        try {
          for (const row of rows) {
            if (row.orphan) {
              connection
                .query(`DELETE FROM ${table.vec} WHERE ${table.key} = ?
              AND NOT EXISTS (SELECT 1 FROM ${table.base} b
                WHERE b.id = ${table.vec}.${table.source})`)
                .run(row.id);
            }
          }
          connection.exec("RELEASE vec0_idle_gc");
        } catch (error) {
          connection.exec("ROLLBACK TO vec0_idle_gc");
          connection.exec("RELEASE vec0_idle_gc");
          throw error;
        }
      } finally {
        connection.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
      }
      if (rows.length < VEC0_ORPHAN_PAGE_SIZE) {
        cursor = 0;
        tableIndex++;
        if (tableIndex === TABLES.length) {
          tableIndex = 0;
          delay = SWEEP_INTERVAL_MS;
        }
      } else {
        cursor = rows[rows.length - 1].cursor;
      }
    } catch {
      // Best-effort derived index maintenance. Do not expose raw SQL/row data
      // to diagnostics, and do not turn worker/schema failures into scan loops.
      delay = RETRY_INTERVAL_MS;
    } finally {
      schedule(delay);
    }
  };
  schedule(PAGE_INTERVAL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
