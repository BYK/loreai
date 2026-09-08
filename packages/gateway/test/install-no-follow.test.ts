import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readTrustedTextFile,
  removeTrustedFile,
  atomicWriteTrustedFile,
} from "../src/cli/json-config";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
for (const operation of ["read", "remove", "write"] as const) {
  it(`rejects a same-owner artifact symlink at the ${operation} boundary`, () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lore-no-follow-")));
    roots.push(home);
    const binary = join(home, "binary");
    const stage = join(home, ".binary.new");
    writeFileSync(binary, "verified binary", { mode: 0o700 });
    const identity = readTrustedTextFile(binary)!.identity;
    // A validated stage name can be substituted before the shared operation.
    symlinkSync(binary, stage);
    const run = () =>
      operation === "read"
        ? readTrustedTextFile(stage, { followSymlinks: false })
        : operation === "remove"
          ? removeTrustedFile(stage, identity, undefined, {
              followSymlinks: false,
            })
          : atomicWriteTrustedFile(stage, "replacement", {
              expectedIdentity: identity,
              followSymlinks: false,
            });
    expect(run).toThrow(/symbolic link/);
    expect(existsSync(binary)).toBe(true);
    expect(readFileSync(binary, "utf8")).toBe("verified binary");
  });
}
