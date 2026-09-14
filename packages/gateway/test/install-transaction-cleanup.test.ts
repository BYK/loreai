import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  _setTrustedDirectoryFsyncHookForTest,
  _setTrustedFilePublishHookForTest,
  CommittedAtomicWriteError,
  readTrustedTextFile,
} from "../src/cli/json-config";
import {
  commitInstallTransaction,
  recoverInstallTransaction,
  stageInstallFile,
} from "../src/cli/lib/install-transaction";

const roots: string[] = [];
afterEach(() => {
  _setTrustedDirectoryFsyncHookForTest(null);
  _setTrustedFilePublishHookForTest(null);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "lore-install-cleanup-")),
  );
  roots.push(root);
  const target = join(root, "target");
  const journal = join(root, "journal");
  writeFileSync(target, "old", { mode: 0o600 });
  return { root, target, journal };
}

it("cleans a stage whose publication succeeded before its fsync failed", () => {
  const { root, target } = fixture();
  _setTrustedDirectoryFsyncHookForTest(() => {
    _setTrustedDirectoryFsyncHookForTest(null);
    throw new Error("stage fsync failed");
  });
  expect(() => stageInstallFile(target, "new", 0o600)).toThrow(
    "stage fsync failed",
  );
  expect(readFileSync(target, "utf8")).toBe("old");
  expect(readdirSync(root)).toEqual(["target"]);
});

it("discards completed stages when the initial journal was never published", () => {
  const { root, target, journal } = fixture();
  const file = stageInstallFile(target, "new", 0o600);
  _setTrustedFilePublishHookForTest((_operation, path) => {
    if (path === journal) throw new Error("journal publication failed");
  });
  expect(() =>
    commitInstallTransaction(
      journal,
      [file],
      () => {},
      () => {},
    ),
  ).toThrow("journal publication failed");
  expect(readFileSync(target, "utf8")).toBe("old");
  expect(readdirSync(root)).toEqual(["target"]);
});

it("retains a published journal and its stages when journal fsync fails", () => {
  const { target, journal } = fixture();
  const file = stageInstallFile(target, "new", 0o600);
  _setTrustedDirectoryFsyncHookForTest(() => {
    _setTrustedDirectoryFsyncHookForTest(null);
    throw new Error("journal fsync failed");
  });
  expect(() =>
    commitInstallTransaction(
      journal,
      [file],
      () => {},
      () => {},
    ),
  ).toThrow(CommittedAtomicWriteError);
  expect(existsSync(journal)).toBe(true);
  expect(existsSync(file.stage)).toBe(true);
  expect(existsSync(file.backup)).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("old");
  recoverInstallTransaction(
    journal,
    () => {},
    () => {},
  );
  expect(readFileSync(target, "utf8")).toBe("new");
  expect(existsSync(journal)).toBe(false);
});

it("does not delete a replacement stage while handling publication failure", () => {
  const { root, target } = fixture();
  let replacement = "";
  _setTrustedDirectoryFsyncHookForTest(() => {
    _setTrustedDirectoryFsyncHookForTest(null);
    const stage = readdirSync(root).find((name) => name.endsWith(".new"));
    if (!stage) throw new Error("missing stage fixture");
    replacement = join(root, stage);
    renameSync(replacement, replacement + ".original");
    writeFileSync(replacement, "successor", { mode: 0o600 });
    throw new Error("stage publication raced");
  });
  expect(() => stageInstallFile(target, "new", 0o600)).toThrow(AggregateError);
  expect(readFileSync(replacement, "utf8")).toBe("successor");
  expect(readFileSync(target, "utf8")).toBe("old");
});

it("retains unpublished stages if ownership is lost during journal publication", () => {
  const { target, journal } = fixture();
  const file = stageInstallFile(target, "new", 0o600);
  let owned = true;
  _setTrustedFilePublishHookForTest((_operation, path) => {
    if (path !== journal) return;
    owned = false;
    throw new Error("journal publication failed");
  });
  expect(() =>
    commitInstallTransaction(
      journal,
      [file],
      () => {
        if (!owned) throw new Error("ownership lost");
      },
      () => {},
    ),
  ).toThrow("ownership lost");
  expect(existsSync(journal)).toBe(false);
  expect(existsSync(file.stage)).toBe(true);
  expect(existsSync(file.backup)).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("old");
});

it("refuses a profile edit made after its replacement text was composed", () => {
  const { root, target } = fixture();
  const existing = readTrustedTextFile(target);
  writeFileSync(target, "new user edits", { mode: 0o600 });
  expect(() =>
    stageInstallFile(
      target,
      existing!.text + "\nPATH addition",
      0o600,
      existing,
    ),
  ).toThrow("changed before staging");
  expect(readFileSync(target, "utf8")).toBe("new user edits");
  expect(readdirSync(root)).toEqual(["target"]);
});
