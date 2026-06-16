/**
 * CLI `lore sync` — Basic-tier cloud sync of knowledge + the entity graph.
 *
 *   lore sync enable     Turn on sync (reconciles existing rows) and sync now
 *   lore sync disable    Turn off local change-capture (keeps remote data)
 *   lore sync status     Show whether sync is on, pending changes, last result
 *   lore sync now        Run one push-then-pull cycle
 *   lore sync            Alias for `status`
 *
 * Runs without the gateway — talks to the local DB + Supabase directly. Requires
 * `lore login` first (sync needs the user's account).
 */
import { syncData, getKV } from "@loreai/core";

export async function commandSync(
  positionals: string[],
  _values: Record<string, unknown>,
): Promise<void> {
  const sub = positionals[0] ?? "status";

  switch (sub) {
    case "enable":
      await cmdEnable();
      break;
    case "disable":
      cmdDisable();
      break;
    case "status":
      await cmdStatus();
      break;
    case "now":
      await cmdNow();
      break;
    default:
      console.error(
        `Unknown sync subcommand "${sub}".\nUsage: lore sync [enable|disable|status|now]`,
      );
      process.exitCode = 1;
  }
}

async function cmdEnable(): Promise<void> {
  const { getCurrentUser } = await import("../supabase");
  const user = await getCurrentUser();
  if (!user) {
    console.error(
      'Not logged in. Run "lore login" first, then "lore sync enable".',
    );
    process.exitCode = 1;
    return;
  }
  if (syncData.isSyncEnabled()) {
    console.log("Sync is already enabled.");
  } else {
    syncData.enableSync("basic");
    console.log(
      `Sync enabled for ${formatUser(user)}. Reconciling existing knowledge + entities…`,
    );
  }
  await runSync();
}

function cmdDisable(): void {
  if (!syncData.isSyncEnabled()) {
    console.log("Sync is not enabled.");
    return;
  }
  syncData.disableSync();
  console.log(
    "Sync disabled. Local change-capture is off; your synced data remains on the server.",
  );
}

async function cmdStatus(): Promise<void> {
  const enabled = syncData.isSyncEnabled();
  console.log(`Sync: ${enabled ? "enabled" : "disabled"}`);

  const { getCurrentUser } = await import("../supabase");
  const user = await getCurrentUser();
  console.log(`Account: ${user ? formatUser(user) : "not logged in"}`);

  if (enabled) {
    // Pending = distinct (table,row_id) with an outbox seq beyond that table's
    // push cursor. Cursors are per table.
    const seen = new Set<string>();
    for (const meta of syncData.syncedTables("basic")) {
      const cursor = Number(getKV(`sync.push.${meta.table}`) ?? "0");
      for (const e of syncData.readOutbox(cursor, 100_000, meta.table)) {
        seen.add(`${e.table_name}\x1f${e.row_id}`);
      }
    }
    console.log(`Pending local changes: ${seen.size}`);
  }
}

async function cmdNow(): Promise<void> {
  if (!syncData.isSyncEnabled()) {
    console.error('Sync is not enabled. Run "lore sync enable" first.');
    process.exitCode = 1;
    return;
  }
  await runSync();
}

/** Run one sync cycle and print a human-readable summary. */
async function runSync(): Promise<void> {
  const { syncOnce } = await import("../sync");
  const r = await syncOnce();
  if (r.notAuthed) {
    console.error('Session expired. Run "lore login" again.');
    process.exitCode = 1;
    return;
  }
  console.log(
    `Synced: pushed ${r.pushed}, pulled ${r.pulled}` +
      (r.conflicts
        ? `, ${r.conflicts} conflict(s) resolved (remote wins)`
        : ""),
  );
  if (r.quotaHit) {
    console.error(
      `\nReached your free-tier sync limit on "${r.quotaHit.table}". ` +
        "Some changes were not uploaded. Upgrade to Pro to sync more.",
    );
    process.exitCode = 1;
  }
}

function formatUser(u: {
  github_login?: string | null;
  email?: string | null;
}): string {
  return u.github_login ? `@${u.github_login}` : (u.email ?? "your account");
}
