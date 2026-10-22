import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const actionDir = join(__dirname, "../../binpatch/action");
const action = readFileSync(join(actionDir, "action.yml"), "utf8");
function shellStep(name: string) {
  const start = action.indexOf(`    - name: ${name}\n`);
  const end = action.indexOf("\n    - name:", start + 1);
  const step = action.slice(start, end === -1 ? undefined : end);
  const body = step.slice(
    step.indexOf("      run: |\n") + "      run: |\n".length,
  );
  return body
    .replace(/^        /gm, "")
    .replaceAll("${{ github.action_path }}", actionDir);
}
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(process.platform === "win32")(
  "delta generation source checksums",
  () => {
    it("carries the exact generation-time base into publish without the old binary present", () => {
      const root = mkdtempSync(join(tmpdir(), "lore-publish-source-"));
      try {
        for (const dir of ["old-binaries", "new-binaries", "patches", "tools"])
          mkdirSync(join(root, dir));
        writeFileSync(
          join(root, "old-binaries/lore-darwin-arm64"),
          "official base",
        );
        writeFileSync(
          join(root, "new-binaries/lore-darwin-arm64"),
          "official target",
        );
        const tools: Record<string, string> = {
          bsdiff: '#!/bin/bash\nprintf patch > "$3"\n',
          stat: '#!/usr/bin/env node\nprocess.stdout.write(String(require("node:fs").statSync(process.argv.at(-1)).size));\n',
          oras: '#!/bin/bash\nprintf "%s\\n" "$@" > "$ORAS_LOG"\n',
        };
        for (const [name, code] of Object.entries(tools)) {
          const path = join(root, "tools", name);
          writeFileSync(path, code);
          chmodSync(path, 0o755);
        }
        const env = {
          ...process.env,
          PATH: `${join(root, "tools")}:${process.env.PATH}`,
          NEW_BIN_DIR: "new-binaries",
          PATCHES_DIR: "patches",
          BINARY_GLOB: "lore-*",
          FROM_VERSION: "1.0.0",
        };
        execFileSync("bash", ["-c", shellStep("Generate delta patches")], {
          cwd: root,
          env,
          stdio: "pipe",
        });
        const metadataPath = join(root, "patches/lore-darwin-arm64.patch.json");
        expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toEqual({
          fromVersion: "1.0.0",
          sourceSha256: sha("official base"),
          targetSha256: sha("official target"),
        });
        rmSync(join(root, "old-binaries"), { recursive: true });
        const log = join(root, "oras.log");
        const publish = () =>
          execFileSync(
            "bash",
            ["-c", shellStep("Push delta patches to the registry")],
            {
              cwd: root,
              env: {
                ...env,
                VERSION: "1.0.1",
                PATCH_FROM_VERSION: "1.0.0",
                REGISTRY: "registry.example",
                REPO: "test/lore",
                PATCH_TAG_PREFIX: "patch-",
                ARTIFACT_TYPE_PREFIX: "test",
                BINARIES_DIR: "new-binaries",
                PATCH_PUSH_FATAL: "true",
                ORAS_LOG: log,
              },
              stdio: "pipe",
            },
          );
        publish();
        expect(readFileSync(log, "utf8")).toContain(
          `source-sha256-lore-darwin-arm64=${sha("official base")}`,
        );
        expect(readFileSync(log, "utf8")).toContain(
          `sha256-lore-darwin-arm64=${sha("official target")}`,
        );
        // Missing metadata and a changed target must never publish an unverifiable patch.
        rmSync(log);
        rmSync(metadataPath);
        publish();
        expect(() => readFileSync(log)).toThrow();
        writeFileSync(
          metadataPath,
          JSON.stringify({
            fromVersion: "1.0.0",
            sourceSha256: sha("official base"),
            targetSha256: sha("different target"),
          }),
        );
        publish();
        expect(() => readFileSync(log)).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
