import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractSha256,
  extractStableChain,
  filterAndSortChainTags,
  getPatchFromVersion,
  getPatchTargetSha256,
  ghcrSource,
  type GitHubRelease,
  getStableTargetSha256,
  type OciManifest,
  validateChainStep,
} from "../src";

// A semver-ish comparator matching the gateway's compareVersions contract
// (returns -1 | 0 | 1) for the nightly tag-ordering tests.
function cmp(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function release(
  tag: string,
  assets: { name: string; size: number; digest?: string }[],
): GitHubRelease {
  return {
    tag_name: tag,
    assets: assets.map((a) => ({
      ...a,
      browser_download_url: `https://example.test/${tag}/${a.name}`,
    })),
  };
}

const BINARY = "tool-linux-x64";

describe("extractSha256", () => {
  it("parses a sha256: digest to lowercase hex", () => {
    expect(
      extractSha256({
        name: BINARY,
        size: 1,
        digest: "sha256:ABCDEF01",
        browser_download_url: "",
      }),
    ).toBe("abcdef01");
  });

  it("returns null for a missing or non-sha256 digest", () => {
    expect(
      extractSha256({ name: BINARY, size: 1, browser_download_url: "" }),
    ).toBeNull();
    expect(
      extractSha256({
        name: BINARY,
        size: 1,
        digest: "md5:deadbeef",
        browser_download_url: "",
      }),
    ).toBeNull();
  });
});

describe("getStableTargetSha256", () => {
  it("reads the binary asset's digest", () => {
    const r = release("1.2.0", [
      { name: BINARY, size: 100, digest: "sha256:cafe" },
      { name: `${BINARY}.gz`, size: 40 },
      { name: `${BINARY}.patch`, size: 5 },
    ]);
    expect(getStableTargetSha256(r, BINARY)).toBe("cafe");
  });

  it("returns null when the binary asset is absent", () => {
    const r = release("1.2.0", [{ name: `${BINARY}.gz`, size: 40 }]);
    expect(getStableTargetSha256(r, BINARY)).toBeNull();
  });
});

describe("extractStableChain", () => {
  // Releases are newest-first (as GitHub returns them). Digests are hex.
  const releases: GitHubRelease[] = [
    release("1.2.0", [
      { name: BINARY, size: 100, digest: "sha256:aaaa" },
      { name: `${BINARY}.gz`, size: 40 },
      { name: `${BINARY}.patch`, size: 5 },
    ]),
    release("1.1.0", [
      { name: BINARY, size: 100, digest: "sha256:bbbb" },
      { name: `${BINARY}.gz`, size: 40 },
      { name: `${BINARY}.patch`, size: 6 },
    ]),
    release("1.0.0", [
      { name: BINARY, size: 100, digest: "sha256:cccc" },
      { name: `${BINARY}.gz`, size: 40 },
    ]),
  ];

  it("builds the oldest-first chain and steps from current to target", () => {
    const info = extractStableChain({
      releases,
      currentVersion: "1.0.0",
      targetVersion: "1.2.0",
      binaryName: BINARY,
      fullGzSize: 40,
    });
    expect(info).not.toBeNull();
    // Two hops: 1.0.0 -> 1.1.0 -> 1.2.0. Expected sha is the target's.
    expect(info?.expectedSha256).toBe("aaaa");
    expect(info?.steps).toEqual([
      { fromVersion: "1.0.0", toVersion: "1.1.0" },
      { fromVersion: "1.1.0", toVersion: "1.2.0" },
    ]);
    // patchUrls are apply-order: 1.1.0's patch first, then 1.2.0's.
    expect(info?.patchUrls).toEqual([
      "https://example.test/1.1.0/tool-linux-x64.patch",
      "https://example.test/1.2.0/tool-linux-x64.patch",
    ]);
  });

  it("returns null when a hop is missing its patch asset", () => {
    // 1.0.0 has no patch asset, but it is the current version (not in the
    // chain slice), so drop 1.1.0's patch instead to force a gap.
    const broken = releases.map((r) =>
      r.tag_name === "1.1.0"
        ? { ...r, assets: r.assets.filter((a) => !a.name.endsWith(".patch")) }
        : r,
    );
    expect(
      extractStableChain({
        releases: broken,
        currentVersion: "1.0.0",
        targetVersion: "1.2.0",
        binaryName: BINARY,
        fullGzSize: 40,
      }),
    ).toBeNull();
  });

  it("returns null when the chain exceeds the size ratio gate", () => {
    // fullGzSize tiny → 60% ratio easily exceeded by the 5+6 byte patches.
    expect(
      extractStableChain({
        releases,
        currentVersion: "1.0.0",
        targetVersion: "1.2.0",
        binaryName: BINARY,
        fullGzSize: 1,
      }),
    ).toBeNull();
  });

  it("returns null when target is not older than current in the list", () => {
    expect(
      extractStableChain({
        releases,
        currentVersion: "1.2.0",
        targetVersion: "1.0.0",
        binaryName: BINARY,
        fullGzSize: 40,
      }),
    ).toBeNull();
  });
});

describe("filterAndSortChainTags", () => {
  it("keeps only (current, target] tags, sorted ascending", () => {
    const tags = [
      "patch-1.3.0",
      "patch-1.1.0",
      "patch-1.2.0",
      "patch-0.9.0",
      "patch-2.0.0",
    ];
    expect(filterAndSortChainTags(tags, "1.0.0", "1.3.0", cmp)).toEqual([
      "patch-1.1.0",
      "patch-1.2.0",
      "patch-1.3.0",
    ]);
  });

  it("excludes the current version and anything past the target", () => {
    const tags = ["patch-1.0.0", "patch-1.1.0", "patch-1.2.0"];
    expect(filterAndSortChainTags(tags, "1.0.0", "1.1.0", cmp)).toEqual([
      "patch-1.1.0",
    ]);
  });
});

describe("validateChainStep", () => {
  function manifest(fromVersion: string, patchSize: number): OciManifest {
    return {
      schemaVersion: 2,
      annotations: { "from-version": fromVersion },
      layers: [
        {
          digest: "sha256:deadbeef",
          mediaType: "application/octet-stream",
          size: patchSize,
          annotations: {
            "org.opencontainers.image.title": `${BINARY}.patch`,
          },
        },
      ],
    };
  }

  it("accepts a step whose from-version and patch layer match", () => {
    const res = validateChainStep(manifest("1.0.0", 50), {
      expectedFrom: "1.0.0",
      patchLayerName: `${BINARY}.patch`,
      sizeLimit: 100,
    });
    expect(res).toEqual({ ok: true, digest: "sha256:deadbeef", size: 50 });
  });

  it("rejects a from-version mismatch (broken chain link)", () => {
    const res = validateChainStep(manifest("9.9.9", 50), {
      expectedFrom: "1.0.0",
      patchLayerName: `${BINARY}.patch`,
      sizeLimit: 100,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a patch layer over the size limit", () => {
    const res = validateChainStep(manifest("1.0.0", 500), {
      expectedFrom: "1.0.0",
      patchLayerName: `${BINARY}.patch`,
      sizeLimit: 100,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects when the named patch layer is absent", () => {
    const res = validateChainStep(manifest("1.0.0", 50), {
      expectedFrom: "1.0.0",
      patchLayerName: "other.patch",
      sizeLimit: 100,
    });
    expect(res.ok).toBe(false);
  });
});

describe("OCI manifest annotation helpers", () => {
  const m: OciManifest = {
    schemaVersion: 2,
    annotations: {
      "from-version": "1.0.0",
      [`sha256-${BINARY}`]: "abc123",
    },
    layers: [],
  };
  it("reads from-version", () => {
    expect(getPatchFromVersion(m)).toBe("1.0.0");
    expect(getPatchFromVersion({ schemaVersion: 2, layers: [] })).toBeNull();
  });
  it("reads the per-binary target sha256", () => {
    expect(getPatchTargetSha256(m, BINARY)).toBe("abc123");
    expect(getPatchTargetSha256(m, "other")).toBeNull();
  });
});

describe("ghcrSource resolveChain — SourceStrategy contract on network failure", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns null (not throw) when the registry is unreachable", async () => {
    // The OCI client uses global fetch; make every call fail like a network
    // outage. Per the SourceStrategy contract a resolution failure must be a
    // null (→ fall back to full download, reported `unavailable`), never a
    // thrown system error.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const source = ghcrSource({
      registry: "https://ghcr.io",
      repo: "owner/project",
      userAgent: "test/1.0.0",
      binaryName: BINARY,
      targetTag: (v) => `nightly-${v}`,
      compareVersions: cmp,
    });

    await expect(source.resolveChain("1.0.0", "1.1.0")).resolves.toBeNull();
  });
});
