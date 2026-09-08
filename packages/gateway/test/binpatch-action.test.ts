/**
 * Regression coverage for the composite action that produces nightly binary
 * delta patches. The action executes outside the Node workspace, so exercise
 * its shell helper directly and verify the workflow carries its source-version
 * output from generation into publishing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const actionDir = join(__dirname, "../../binpatch/action");
const helperPath = join(actionDir, "nightly-tags.sh");

function selectPreviousNightlyTag(tags: string, targetVersion: string): string {
  return execFileSync(
    "bash",
    [
      "-c",
      'source "$HELPER"; select_previous_nightly_tag "$TAGS" "$PREFIX" "$VERSION"',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HELPER: helperPath,
        TAGS: tags,
        PREFIX: "nightly-",
        VERSION: targetVersion,
      },
    },
  ).trim();
}

describe("binpatch nightly publisher", () => {
  it("selects the newest tag below an unpublished target, never a newer racing build", () => {
    expect(existsSync(helperPath)).toBe(true);

    const target = "0.41.0-dev.1788889012";
    const tags = [
      "nightly-0.41.0-dev.1788888006",
      // This is the exact adversarial order from the production failure: a
      // newer workflow published before the target workflow reached generate.
      "nightly-0.41.0-dev.1788889080",
      "nightly-not-a-version",
      "stable-0.41.0-dev.1788888999",
    ].join("\n");

    expect(selectPreviousNightlyTag(tags, target)).toBe(
      "nightly-0.41.0-dev.1788888006",
    );
  });

  it("keeps choosing the immediate predecessor when the target tag already exists", () => {
    const target = "0.41.0-dev.1788889012";
    const tags = [
      "nightly-0.41.0-dev.1788888006",
      `nightly-${target}`,
      "nightly-0.41.0-dev.1788889080",
    ].join("\n");

    expect(selectPreviousNightlyTag(tags, target)).toBe(
      "nightly-0.41.0-dev.1788888006",
    );
  });

  it("returns no source when the registry has no older nightly", () => {
    expect(
      selectPreviousNightlyTag(
        ["nightly-0.41.0-dev.1788889012", "nightly-0.41.0-dev.1788889080"].join(
          "\n",
        ),
        "0.41.0-dev.1788889012",
      ),
    ).toBe("");
  });

  it("carries the generation-time source version into publish rather than rediscovering it", () => {
    const action = readFileSync(join(actionDir, "action.yml"), "utf8");
    const workflow = readFileSync(
      join(__dirname, "../../../.github/workflows/ci.yml"),
      "utf8",
    );

    expect(action).toContain("PATCH_FROM_VERSION: ${{ inputs.from-version }}");
    expect(action).toContain("from-version=${PATCH_FROM_VERSION}");
    const publishStep = action.slice(
      action.indexOf("- name: Push delta patches to the registry"),
      action.indexOf("# ---- surface outputs"),
    );
    expect(publishStep).not.toContain("oras repo tags");
    expect(workflow).toContain(
      "from-version: ${{ needs.generate-patches.outputs.from-version }}",
    );
  });
});
