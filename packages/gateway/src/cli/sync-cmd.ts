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
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { keystore, syncData, getKV } from "@loreai/core";

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

export async function cmdEnable(
  prompts: EncryptionPrompts = cliEncryptionPrompts,
): Promise<void> {
  const { getCurrentUser, getAuthedClient } = await import("../supabase");
  const user = await getCurrentUser();
  if (!user) {
    console.error(
      'Not logged in. Run "lore login" first, then "lore sync enable".',
    );
    process.exitCode = 1;
    return;
  }
  const justEnabled = !syncData.isSyncEnabled();
  if (justEnabled) {
    syncData.enableSync("basic");
    console.log(
      `Sync enabled for ${formatUser(user)}. Reconciling existing knowledge + entities…`,
    );
  } else {
    console.log("Sync is already enabled.");
  }

  // Arm encryption before any knowledge is pushed. Pull the key tables first so a fresh
  // device unlocks the existing account key rather than minting a second one, and only
  // report `confirmed` when we POSITIVELY verified the remote's escrow state — so a
  // silent pull failure can never route a device with a real remote key into a
  // first-device mint (which would clobber it).
  const outcome = await bootstrapEncryption(async () => {
    const client = await getAuthedClient();
    if (!client) return { confirmed: false };
    const { pullOnce } = await import("../sync");
    await pullOnce(client); // applies account_escrow + scope_keys if present
    const { data, error } = await client
      .from("account_escrow")
      .select("id")
      .limit(1);
    if (error) return { confirmed: false }; // unreachable → don't risk a mint
    // A row exists but we're still deciding as a first device (pull didn't apply it) →
    // treat as unconfirmed rather than clobber.
    if ((data?.length ?? 0) > 0) return { confirmed: false };
    return { confirmed: true }; // verified: no remote key → safe first-device setup
  }, prompts);

  if (outcome === "aborted") {
    // Encryption is REQUIRED to sync — never leave sync armed but unencrypted (that
    // would push plaintext). Turn sync off whether or not we enabled it in this call,
    // including a pre-existing plaintext sync from before encryption was available.
    syncData.disableSync();
    console.error(
      "Encryption setup canceled. Sync is now off — it requires encryption. " +
        "Run `lore sync enable` and set a passphrase to turn it on.",
    );
    process.exitCode = 1;
    return;
  }

  // Eager-mint the per-scope DEK now that encryption is "on", so scope_keys is enqueued
  // and ships with the FIRST push. Otherwise it's minted lazily during the first knowledge
  // encrypt (getScopeKey inside encryptColumns) and its capture lands a cycle later — a
  // window where a fresh device pulls the ciphertext without the key and mints a DIVERGENT
  // DEK, which under 0012 first-write-wins can orphan the data (#1182).
  // Guard on user_id (mirrors the resolver's fail-closed contract) and swallow a transient
  // mint failure: it degrades to the pre-fix lazy mint rather than aborting a valid enable.
  if (user.user_id) {
    try {
      await keystore.getScopeKey(user.user_id);
    } catch (e) {
      console.error(
        `sync: could not pre-provision the encryption key (will mint on first push): ${(e as Error).message}`,
      );
    }
  }

  await runSync();
}

/** Prompt callbacks for the encryption bootstrap (injectable for tests). */
export interface EncryptionPrompts {
  /** A new passphrase (with confirmation), or null if the user declined/aborted. */
  newPassphrase(): Promise<string | null>;
  /** An existing secret to unlock with, or null to abort. */
  existingSecret(): Promise<{
    kind: "passphrase" | "recovery";
    value: string;
  } | null>;
  showRecoveryCode(code: string): void;
  log(msg: string): void;
}

/**
 * Turn on encryption for `lore sync enable`. `syncKeys` fetches any existing escrow
 * FIRST (so a fresh device unlocks rather than minting a divergent key) and reports
 * whether it POSITIVELY confirmed the remote's escrow state. Returns "on" when the
 * device can encrypt/decrypt, or "aborted" if the user declined or we can't safely set up.
 *
 * Fail-safe rule: we only mint a first-device key when `confirmed` is true. A silent
 * pull failure (pullOnce swallows network errors) must NEVER route a fresh device that
 * actually has a remote key into first-device setup — that would clobber device-1's
 * escrow/DEK on a remote with no immutability guard and lock it out (#825 C-4b review).
 */
export async function bootstrapEncryption(
  syncKeys: () => Promise<{ confirmed: boolean }>,
  prompts: EncryptionPrompts,
): Promise<"on" | "aborted"> {
  let confirmed = false;
  try {
    ({ confirmed } = await syncKeys());
  } catch {
    confirmed = false;
  }

  const state = keystore.encryptionState();
  if (state === "on") return "on";

  if (state === "off") {
    if (!confirmed) {
      // Could not verify the remote has no key — refuse to mint (would risk a clobber).
      prompts.log(
        "Couldn't confirm whether this account already has an encryption key. " +
          "Check your connection and run `lore sync enable` again.",
      );
      return "aborted";
    }
    const pass = await prompts.newPassphrase();
    if (!pass) return "aborted";
    const recovery = generateRecoveryCode();
    keystore.setPassphrase(pass, { recoveryCode: recovery });
    prompts.showRecoveryCode(recovery);
    prompts.log(
      "Encryption enabled — your synced knowledge is end-to-end encrypted.",
    );
    return "on";
  }

  // locked: a fresh device that pulled the escrow — unlock with the existing secret.
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await prompts.existingSecret();
    if (!entry) return "aborted";
    const ok =
      entry.kind === "recovery"
        ? keystore.unlockWithRecoveryCode(normalizeRecoveryCode(entry.value))
        : keystore.unlockWithPassphrase(entry.value);
    if (ok) {
      prompts.log("Unlocked — syncing your encrypted knowledge.");
      return "on";
    }
    prompts.log("That didn't match. Try again.");
  }
  prompts.log("Too many failed attempts.");
  return "aborted";
}

/**
 * The canonical (dashless, uppercase) recovery code: 24 Crockford-base32 symbols =
 * 120 bits of entropy. Display adds dashes for readability; `normalizeRecoveryCode`
 * strips them back so a paste with-or-without dashes/spaces still unlocks.
 */
export function generateRecoveryCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford (no I,L,O,U)
  const bytes = randomBytes(15); // 15 bytes = 120 bits = exactly 24 × 5-bit symbols
  // Standard base32 accumulator: feed 8 bits at a time, emit a 5-bit symbol whenever
  // ≥5 bits are buffered, keeping only the undrained low bits (stays within 32 bits).
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(acc >> bits) & 0x1f];
    }
    acc &= (1 << bits) - 1; // drop the emitted high bits; keep the `bits` leftover
  }
  return out; // 120 bits ÷ 5 = 24 symbols, no remainder
}

/**
 * Canonicalize a recovery code for matching: strip dashes/spaces, uppercase, and apply
 * Crockford base32 error-correction for the chars the generator alphabet omits — O→0 and
 * I/L→1 — so a hand-transcribed code (O-for-0, I/L-for-1) still unlocks.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .replace(/[^0-9A-Za-z]/g, "")
    .toUpperCase()
    .replace(/[ILO]/g, (c) => (c === "O" ? "0" : "1"));
}

/** Group the 24-char code into 6 dash-separated blocks of 4 for display. */
function formatRecoveryCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

/**
 * Read a line with the typed characters hidden (no echo) — for passphrases. Reads stdin
 * in raw mode and never writes the keystrokes back, so nothing is echoed. Avoids the
 * private `readline._writeToOutput` mute trick (which would leak the passphrase in
 * plaintext if that Node internal ever changed).
 */
function promptSecret(question: string): Promise<string> {
  const { stdin, stdout } = process;
  return new Promise((resolve) => {
    stdout.write(question);
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    // Decode as UTF-8 at the stream: its StringDecoder buffers a multi-byte char that
    // is split across two `data` chunks, so we always iterate whole code points.
    stdin.setEncoding("utf8");
    stdin.resume();
    let buf = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\n");
    };
    const onEnd = (): void => {
      // stdin closed (piped input, no trailing newline) → resolve what we have rather
      // than hang forever.
      cleanup();
      resolve(buf);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        switch (ch) {
          case "\n":
          case "\r":
          case "\u0004": // Ctrl-D / EOT
            cleanup();
            resolve(buf);
            return;
          case "\u0003": // Ctrl-C
            cleanup();
            process.exit(130);
            return;
          case "\u007f": // backspace / DEL
          case "\b":
            buf = buf.slice(0, -1);
            break;
          default:
            if (ch >= " ") buf += ch; // ignore other control chars
        }
      }
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}

/** Read a visible line (for non-secret input like a pasted recovery code). */
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** The real terminal prompts wired into `lore sync enable`. */
const cliEncryptionPrompts: EncryptionPrompts = {
  async newPassphrase() {
    console.log(
      "\nSet an encryption passphrase to protect your synced knowledge.\n" +
        "You'll need it to add a new device — it is never sent to the server, so it cannot be recovered for you.",
    );
    const p1 = (await promptSecret("Passphrase: ")).trim();
    if (!p1) return null;
    const p2 = (await promptSecret("Confirm passphrase: ")).trim();
    if (p1 !== p2) {
      console.error("Passphrases didn't match.");
      return null;
    }
    return p1;
  },
  async existingSecret() {
    console.log(
      "\nThis device needs your encryption passphrase to read your synced knowledge.",
    );
    const p = (
      await promptSecret("Passphrase (blank to use a recovery code): ")
    ).trim();
    if (p) return { kind: "passphrase", value: p };
    const code = await promptLine("Recovery code: ");
    if (!code) return null;
    return { kind: "recovery", value: code };
  },
  showRecoveryCode(code) {
    console.log(
      `\n  Recovery code:  ${formatRecoveryCode(code)}\n\n` +
        "  Save this now. It's the ONLY way back in if you forget your passphrase.\n",
    );
  },
  log(msg) {
    console.log(msg);
  },
};

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

  const enc = keystore.encryptionState();
  console.log(
    `Encryption: ${
      enc === "on"
        ? "on (knowledge encrypted)"
        : enc === "locked"
          ? "locked — run `lore sync enable` and enter your passphrase"
          : "off (not set up)"
    }`,
  );

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
