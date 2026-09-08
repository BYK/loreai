/**
 * Regression coverage for the composite action that produces nightly binary
 * delta patches. The action executes outside the Node workspace, so exercise
 * its shell helper directly and verify the workflow carries its source-version
 * output from generation into publishing.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

function shouldAdvanceRollingNightly(
  currentVersion: string,
  candidateVersion: string,
): boolean {
  try {
    execFileSync(
      "bash",
      [
        "-c",
        'source "$HELPER"; should_advance_rolling_nightly "$CURRENT" "$CANDIDATE"',
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          HELPER: helperPath,
          CURRENT: currentVersion,
          CANDIDATE: candidateVersion,
        },
      },
    );
    return true;
  } catch {
    return false;
  }
}

function advanceRollingNightly({
  tags,
  currentVersion = "",
  failTagLookup = false,
  failManifestLookup = false,
}: {
  tags: string;
  currentVersion?: string;
  failTagLookup?: boolean;
  failManifestLookup?: boolean;
}): { commands: string[]; output: string } {
  const fakeBin = mkdtempSync(join(tmpdir(), "lore-binpatch-oras-"));
  const logPath = join(fakeBin, "oras.log");
  const fakeOras = join(fakeBin, "oras");
  writeFileSync(
    fakeOras,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ORAS_LOG"
case "$1" in
  repo)
    [ "$2" = tags ] || exit 2
    [ "$ORAS_FAIL_TAG_LOOKUP" = true ] && exit 1
    printf '%s\\n' "$ORAS_TAGS"
    ;;
  manifest)
    [ "$2" = fetch ] || exit 2
    [ "$ORAS_FAIL_MANIFEST_LOOKUP" = true ] && exit 1
    printf '{"annotations":{"version":"%s"}}\\n' "$ORAS_CURRENT_VERSION"
    ;;
  tag) ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(fakeOras, 0o755);

  try {
    const output = execFileSync(
      "bash",
      [
        "-c",
        'source "$HELPER"; advance_rolling_nightly "$FULL_REPO" "$NIGHTLY_TAG" "$PREFIX" "$CANDIDATE"',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HELPER: helperPath,
          FULL_REPO: "ghcr.io/byk/loreai",
          NIGHTLY_TAG: "nightly",
          PREFIX: "nightly-",
          CANDIDATE: "0.41.0-dev.1788889012",
          ORAS_LOG: logPath,
          ORAS_TAGS: tags,
          ORAS_CURRENT_VERSION: currentVersion,
          ORAS_FAIL_TAG_LOOKUP: String(failTagLookup),
          ORAS_FAIL_MANIFEST_LOOKUP: String(failManifestLookup),
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    return {
      commands: readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean),
      output,
    };
  } finally {
    rmSync(fakeBin, { force: true, recursive: true });
  }
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
    expect(publishStep).not.toMatch(/\beval\s+oras\s+push\b/);
    expect(publishStep).toContain(
      'oras push "${FULL_REPO}:${PATCH_TAG_PREFIX}${VERSION}"',
    );
    expect(publishStep).toContain('"${annotations[@]}"');
    expect(publishStep).toContain('"${patch_files[@]}"');
    expect(workflow).toContain(
      "from-version: ${{ needs.generate-patches.outputs.from-version }}",
    );
  });

  it("publishes the immutable nightly before advancing the rolling tag", () => {
    const action = readFileSync(join(actionDir, "action.yml"), "utf8");
    const pushStep = action.slice(
      action.indexOf(
        "- name: Push immutable versioned nightly to the registry",
      ),
      action.indexOf("- name: Update rolling nightly tag"),
    );
    const tagStep = action.slice(
      action.indexOf("- name: Update rolling nightly tag"),
      action.indexOf("- name: Push delta patches to the registry"),
    );

    // Model the bad interleaving explicitly: A writes its immutable manifest,
    // B publishes next, then A advances `nightly`. A must still tag A's digest,
    // never whatever B most recently placed at the rolling tag.
    expect(pushStep).toContain(
      'oras push "${REGISTRY}/${REPO}:${NIGHTLY_TAG_PREFIX}${VERSION}"',
    );
    expect(pushStep).not.toContain(
      'oras push "${REGISTRY}/${REPO}:${NIGHTLY_TAG}"',
    );
    expect(tagStep).toContain(
      'advance_rolling_nightly "$FULL_REPO" "$NIGHTLY_TAG" "$NIGHTLY_TAG_PREFIX" "$VERSION"',
    );
    expect(readFileSync(helperPath, "utf8")).toContain(
      'oras tag "${full_repo}:${nightly_tag_prefix}${candidate_version}" "$nightly_tag"',
    );
  });

  it("never regresses the rolling nightly when an older publisher finishes last", () => {
    const older = "0.41.0-dev.1788889012";
    const newer = "0.41.0-dev.1788889080";
    const action = readFileSync(join(actionDir, "action.yml"), "utf8");
    const workflow = readFileSync(
      join(__dirname, "../../../.github/workflows/ci.yml"),
      "utf8",
    );

    // The production order was B (newer) first, then A (older). The final
    // rolling pointer must remain on B, while a later C may advance it.
    expect(shouldAdvanceRollingNightly(newer, older)).toBe(false);
    expect(shouldAdvanceRollingNightly(older, newer)).toBe(true);
    expect(
      advanceRollingNightly({
        tags: ["nightly", `nightly-${newer}`].join("\n"),
        currentVersion: newer,
      }).commands,
    ).toEqual([
      "repo tags ghcr.io/byk/loreai",
      "manifest fetch ghcr.io/byk/loreai:nightly",
    ]);

    // An absent tag is a confirmed first-publish condition and can advance;
    // errors must fail closed rather than looking indistinguishable from absent.
    expect(
      advanceRollingNightly({ tags: `nightly-${older}` }).commands,
    ).toEqual([
      "repo tags ghcr.io/byk/loreai",
      "tag ghcr.io/byk/loreai:nightly-0.41.0-dev.1788889012 nightly",
    ]);
    expect(
      advanceRollingNightly({ tags: "", failTagLookup: true }).commands,
    ).toEqual(["repo tags ghcr.io/byk/loreai"]);
    expect(
      advanceRollingNightly({
        tags: "nightly",
        failManifestLookup: true,
      }).commands,
    ).toEqual([
      "repo tags ghcr.io/byk/loreai",
      "manifest fetch ghcr.io/byk/loreai:nightly",
    ]);
    expect(action).toContain(
      'advance_rolling_nightly "$FULL_REPO" "$NIGHTLY_TAG" "$NIGHTLY_TAG_PREFIX" "$VERSION"',
    );
    expect(workflow).toContain(
      "concurrency:\n      group: nightly-ghcr-publish\n      cancel-in-progress: false",
    );
  });
});
