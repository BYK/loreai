import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
const versionAssignments = workflow.match(
  /^[ \t]*version_sanitised=\$\([\s\S]*?\)[ \t]*$/gm,
);

describe("Craft publish-state version filenames", () => {
  it("covers both retry-state writing and failure-state reading", () => {
    expect(versionAssignments).toHaveLength(2);
  });

  it.each([
    ["1.2.3", "1.2.3"],
    ["1.2.3-rc.1", "1.2.3-rc.1"],
    ["1.2.3-RC.1", "version-MS4yLjMtUkMuMQ"],
    ["1.2.3+build.7", "version-MS4yLjMrYnVpbGQuNw"],
    ["1.2.3-build.7", "1.2.3-build.7"],
  ])("uses Craft 3.3.0's lossless filename for %s", (version, expected) => {
    for (const assignment of versionAssignments ?? []) {
      const result = execFileSync(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-eu",
          "-c",
          [
            "sanitise() { printf '%s' \"$1\" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]\\+/_/g; s/^_\\+//; s/_\\+$//'; }",
            assignment,
            "printf '%s' \"$version_sanitised\"",
          ].join("\n"),
        ],
        {
          env: {
            PATH: process.env.PATH,
            VERSION: version,
            BASH_ENV: "/dev/null",
          },
          encoding: "utf8",
        },
      );
      expect(result).toBe(expected);
    }
  });
});
