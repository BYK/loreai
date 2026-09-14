import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installStandalone } from "../src/cli/install";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("installs a verified candidate and records its exact generation", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "lore-bootstrap-")));
  roots.push(home);
  const source = join(home, "candidate");
  writeFileSync(source, "binary", { mode: 0o700 });
  await installStandalone({
    home,
    source,
    channel: "stable",
    noModifyPath: true,
  });
  expect(readFileSync(join(home, ".local/bin/lore"), "utf8")).toBe("binary");
  expect(readFileSync(join(home, ".lore/install-path"), "utf8")).toMatch(
    /^lore-install-receipt-v3\n/,
  );
  expect(readFileSync(join(home, ".lore/channel"), "utf8")).toBe("stable");
  expect(existsSync(join(home, ".lore/install-transaction.json"))).toBe(false);
});
it("restores an existing installation when a later mandatory write fails", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "lore-bootstrap-")));
  roots.push(home);
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  mkdirSync(join(home, ".lore"), { mode: 0o700 });
  const source = join(home, "candidate");
  writeFileSync(source, "new", { mode: 0o700 });
  writeFileSync(join(home, ".local/bin/lore"), "old", { mode: 0o700 });
  writeFileSync(join(home, ".lore/install-path"), "old receipt", {
    mode: 0o600,
  });
  await expect(
    installStandalone({
      home,
      source,
      channel: "stable",
      noModifyPath: true,
      afterPublish: (_path, index) => {
        if (index === 1) throw new Error("injected failure");
      },
    }),
  ).rejects.toThrow("injected failure");
  expect(readFileSync(join(home, ".local/bin/lore"), "utf8")).toBe("old");
  expect(readFileSync(join(home, ".lore/install-path"), "utf8")).toBe(
    "old receipt",
  );
});

import { createHash } from "node:crypto";
import { readdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import {
  acquireLifecycleLock,
  createUninstallTombstone,
} from "../src/lifecycle-lock";
import { removeInstallerPathBlock } from "../src/cli/uninstall";
import {
  _setInstallPublicationHookForTest,
  stageInstallFile,
  commitInstallTransaction,
  recoverInstallTransaction,
} from "../src/cli/lib/install-transaction";
function fixture() {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), "lore-install-runtime-")),
  );
  roots.push(home);
  const source = join(home, "candidate");
  writeFileSync(source, "new", { mode: 0o700 });
  return {
    home,
    source,
    channel: "stable" as const,
    noModifyPath: true,
    env: {},
  };
}
afterEach(() => _setInstallPublicationHookForTest(undefined));
it("preserves recovery evidence immediately after ownership is lost", () => {
  const { home } = fixture();
  const path = join(home, "target");
  const journal = join(home, "journal");
  writeFileSync(path, "old", { mode: 0o600 });
  const file = stageInstallFile(path, "new", 0o600);
  let owned = true;
  expect(() =>
    commitInstallTransaction(
      journal,
      [file],
      () => {
        if (!owned) throw new Error("lost lock");
      },
      () => {
        owned = false;
        throw new Error("lost lock");
      },
    ),
  ).toThrow();
  expect(JSON.parse(readFileSync(journal, "utf8")).direction).toBe("complete");
  expect(existsSync(file.stage)).toBe(true);
  expect(existsSync(file.backup)).toBe(true);
});
it("rolls back when failure follows link but precedes displaced cleanup", () => {
  const { home } = fixture();
  const path = join(home, "target");
  const journal = join(home, "journal");
  writeFileSync(path, "old", { mode: 0o600 });
  const file = stageInstallFile(path, "new", 0o600);
  _setInstallPublicationHookForTest((phase) => {
    if (phase === "linked") {
      _setInstallPublicationHookForTest(undefined);
      throw new Error("fsync failed");
    }
  });
  expect(() =>
    commitInstallTransaction(
      journal,
      [file],
      () => {},
      () => {},
    ),
  ).toThrow("fsync failed");
  expect(readFileSync(path, "utf8")).toBe("old");
  expect(existsSync(journal)).toBe(false);
});
it("preserves an unknown same-content successor and the recovery journal", () => {
  const { home } = fixture();
  const path = join(home, "target");
  const journal = join(home, "journal");
  writeFileSync(path, "old", { mode: 0o600 });
  const file = stageInstallFile(path, "new", 0o600);
  expect(() =>
    commitInstallTransaction(
      journal,
      [file],
      () => {},
      () => {
        renameSync(path, path + ".displaced");
        writeFileSync(path, "new", { mode: 0o600 });
        throw new Error("changed");
      },
    ),
  ).toThrow();
  expect(readFileSync(path, "utf8")).toBe("new");
  expect(existsSync(journal)).toBe(true);
});
it("cleans unpublished stages when a later stage fails", async () => {
  const f = fixture();
  mkdirSync(join(f.home, ".lore"), { mode: 0o700 });
  mkdirSync(join(f.home, ".lore/channel"));
  await expect(installStandalone(f)).rejects.toThrow();
  expect(readdirSync(join(f.home, ".local/bin"))).toEqual([]);
  expect(readdirSync(join(f.home, ".lore")).sort()).toEqual(["channel"]);
});
it("rejects a changed candidate without publishing", async () => {
  const f = fixture();
  await expect(
    installStandalone({ ...f, expectedSha256: "0".repeat(64) }),
  ).rejects.toThrow("candidate changed");
  expect(existsSync(join(f.home, ".local/bin/lore"))).toBe(false);
});
it("rejects uninstall that happened during the download", async () => {
  const f = fixture();
  const lock = await acquireLifecycleLock("uninstall", {
    lockPath: join(f.home, ".lore/lifecycle.lock"),
  });
  createUninstallTombstone(lock);
  lock.release();
  await expect(
    installStandalone({ ...f, observedTombstone: "missing" }),
  ).rejects.toThrow("Uninstall generation changed");
  expect(existsSync(join(f.home, ".local/bin/lore"))).toBe(false);
});
it("clears only its observed uninstall marker after verified installation", async () => {
  const f = fixture();
  const lock = await acquireLifecycleLock("uninstall", {
    lockPath: join(f.home, ".lore/lifecycle.lock"),
  });
  createUninstallTombstone(lock);
  lock.release();
  const observedTombstone = createHash("sha256")
    .update(readFileSync(join(f.home, ".lore/uninstalled.json")))
    .digest("hex");
  await installStandalone({ ...f, observedTombstone });
  expect(existsSync(join(f.home, ".lore/uninstalled.json"))).toBe(false);
});
it("does not install while another lifecycle operation owns the lock", async () => {
  const f = fixture();
  const lock = await acquireLifecycleLock("setup", {
    lockPath: join(f.home, ".lore/lifecycle.lock"),
  });
  try {
    await expect(installStandalone(f)).rejects.toThrow(/busy/);
  } finally {
    lock.release();
  }
  expect(existsSync(join(f.home, ".local"))).toBe(false);
});
it("keeps Bash login profiles usable", async () => {
  const f = fixture();
  writeFileSync(join(f.home, ".bash_profile"), "# login\n", { mode: 0o600 });
  await installStandalone({
    ...f,
    noModifyPath: false,
    env: { SHELL: "/bin/bash", PATH: "/usr/bin" },
  });
  expect(readFileSync(join(f.home, ".bash_profile"), "utf8")).toContain(
    "# Added by lore installer",
  );
});
it("uses the reversible fish stanza with quote and backslash escaping", async () => {
  const f = fixture();
  const directory = join(f.home, "bin'quoted\\path");
  await installStandalone({
    ...f,
    installDir: directory,
    noModifyPath: false,
    env: { SHELL: "/usr/bin/fish", PATH: "/usr/bin" },
  });
  const text = readFileSync(join(f.home, ".config/fish/config.fish"), "utf8");
  expect(text).toContain("set -gx PATH");
  expect(removeInstallerPathBlock(text, directory, "fish")).not.toContain(
    "set -gx PATH",
  );
});
it("rejects executable and receipt symlinks", async () => {
  const f = fixture();
  mkdirSync(join(f.home, ".local/bin"), { recursive: true });
  const victim = join(f.home, "victim");
  writeFileSync(victim, "user data");
  symlinkSync(victim, join(f.home, ".local/bin/lore"));
  await expect(installStandalone(f)).rejects.toThrow(/symlink/);
  expect(readFileSync(victim, "utf8")).toBe("user data");
});

import { spawnSync } from "node:child_process";
for (const phase of ["quarantined", "linked"]) {
  it(`recovers in a fresh process after termination at ${phase}`, () => {
    const { home } = fixture();
    writeFileSync(join(home, "binary"), "old binary", { mode: 0o700 });
    writeFileSync(join(home, "receipt"), "old receipt", { mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(import.meta.dirname, "install-transaction-child.ts"),
        home,
        phase,
      ],
      { encoding: "utf8" },
    );
    expect(child.status, child.stderr).toBe(17);
    recoverInstallTransaction(
      join(home, "journal"),
      () => {},
      () => {},
      "old epoch",
    );
    expect(readFileSync(join(home, "binary"), "utf8")).toBe("new binary");
    expect(readFileSync(join(home, "receipt"), "utf8")).toBe("new receipt");
    expect(existsSync(join(home, "journal"))).toBe(false);
  });
}
it("does not replay an interrupted installation after a newer uninstall", () => {
  const { home } = fixture();
  writeFileSync(join(home, "binary"), "old binary", { mode: 0o700 });
  writeFileSync(join(home, "receipt"), "old receipt", { mode: 0o600 });
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "install-transaction-child.ts"),
      home,
      "linked",
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(17);
  unlinkSync(join(home, "binary"));
  unlinkSync(join(home, "receipt"));
  recoverInstallTransaction(
    join(home, "journal"),
    () => {},
    () => {},
    "new uninstall epoch",
  );
  expect(existsSync(join(home, "binary"))).toBe(false);
  expect(existsSync(join(home, "receipt"))).toBe(false);
});
it("retains evidence if a recovered target changes while another target is published", () => {
  const { home } = fixture();
  writeFileSync(join(home, "binary"), "old binary", { mode: 0o700 });
  writeFileSync(join(home, "receipt"), "old receipt", { mode: 0o600 });
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "install-transaction-child.ts"),
      home,
      "linked",
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(17);
  _setInstallPublicationHookForTest((phase, path) => {
    if (phase === "linked" && path === join(home, "receipt")) {
      renameSync(join(home, "binary"), join(home, "other"));
      writeFileSync(join(home, "binary"), "successor", { mode: 0o700 });
    }
  });
  expect(() =>
    recoverInstallTransaction(
      join(home, "journal"),
      () => {},
      () => {},
      "old epoch",
    ),
  ).toThrow("changed before commit");
  expect(existsSync(join(home, "journal"))).toBe(true);
  expect(readFileSync(join(home, "binary"), "utf8")).toBe("successor");
});

it("preserves supported installation and config overrides outside HOME", async () => {
  const options = fixture();
  const other = fixture();
  const installDir = join(other.home, "bin");
  const configDir = join(other.home, "config");
  await installStandalone({ ...options, installDir, configDir });
  expect(readFileSync(join(installDir, "lore"), "utf8")).toBe("new");
  expect(readFileSync(join(configDir, "channel"), "utf8")).toBe("stable");
});

it("does not replay pre-uninstall PATH edits into a different installation", async () => {
  const options = fixture();
  const profile = join(options.home, ".profile");
  writeFileSync(profile, "# user profile\n", { mode: 0o600 });
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "install-transaction-child.ts"),
      options.home,
      "profile",
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(17);
  expect(existsSync(profile)).toBe(false);
  const lock = await acquireLifecycleLock("uninstall", {
    lockPath: join(options.home, ".lore/lifecycle.lock"),
  });
  try {
    createUninstallTombstone(lock);
  } finally {
    lock.release();
  }
  const newDirectory = join(options.home, "other-bin");
  await installStandalone({
    ...options,
    installDir: newDirectory,
    noModifyPath: false,
  });
  const text = readFileSync(profile, "utf8");
  expect(text).toContain("# user profile");
  expect(text).toContain(newDirectory);
  expect(text).not.toContain(join(options.home, ".local/bin"));
});

it("recovers an interrupted user profile even when PATH updates are disabled", async () => {
  const options = fixture();
  const profile = join(options.home, ".profile");
  writeFileSync(profile, "# preserved user profile\n", { mode: 0o600 });
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "install-transaction-child.ts"),
      options.home,
      "profile",
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(17);
  expect(existsSync(profile)).toBe(false);
  await installStandalone(options);
  expect(readFileSync(profile, "utf8")).toBe("# preserved user profile\n");
});

it("retains rollback evidence when an earlier restored file gains a successor", () => {
  const { home } = fixture();
  const first = join(home, "first");
  const second = join(home, "second");
  const journal = join(home, "journal");
  writeFileSync(first, "old first", { mode: 0o600 });
  writeFileSync(second, "old second", { mode: 0o600 });
  const files = [
    stageInstallFile(first, "new first", 0o600),
    stageInstallFile(second, "new second", 0o600),
  ];
  let rollingBack = false;
  _setInstallPublicationHookForTest((phase, path) => {
    if (rollingBack && phase === "linked" && path === first) {
      renameSync(second, second + ".restored");
      writeFileSync(second, "user successor", { mode: 0o600 });
    }
  });
  expect(() =>
    commitInstallTransaction(
      journal,
      files,
      () => {},
      () => {
        rollingBack = true;
        throw new Error("mandatory failure");
      },
    ),
  ).toThrow();
  expect(readFileSync(second, "utf8")).toBe("user successor");
  expect(existsSync(journal)).toBe(true);
  expect(existsSync(files[1].backup)).toBe(true);
});
