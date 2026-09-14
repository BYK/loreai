/** Exercise the actual SEA installer before ordinary CLI/vendor initialization. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = realpathSync(resolve(process.argv[2]));
const home = realpathSync(mkdtempSync(join(tmpdir(), "lore-sea-install-")));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  const expected = hash(readFileSync(binary));
  const result = spawnSync(
    binary,
    [
      "setup",
      "--install",
      "--channel",
      "stable",
      "--source-sha256",
      expected,
      "--observed-tombstone",
      "missing",
      "--no-modify-path",
    ],
    {
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LORE_INSTALL_DIR: join(home, ".local/bin"),
        LORE_CONFIG_DIR: join(home, ".lore"),
      },
    },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const installed = join(
    home,
    ".local/bin",
    process.platform === "win32" ? "lore.exe" : "lore",
  );
  assert.equal(hash(readFileSync(installed)), expected);
  const receipt = readFileSync(join(home, ".lore/install-path"), "utf8");
  assert.ok(receipt.startsWith("lore-install-receipt-v3\n"));
  assert.ok(receipt.includes(`sha256=${expected}\n`));
  assert.equal(readFileSync(join(home, ".lore/channel"), "utf8"), "stable");
  assert.equal(existsSync(join(home, ".lore/install-transaction.json")), false);
  assert.equal(existsSync(join(home, ".lore/embeddings-vendored")), false);
  console.log(
    "Standalone installation, receipt, and startup isolation verified",
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}
