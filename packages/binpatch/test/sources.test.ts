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
  OciClient,
  type OciManifest,
  validateChainStep,
} from "../src";

// Build a JSON Response for mocked fetch calls.
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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
    expect(info).not.toHaveProperty("failure");
    if ("failure" in info) throw new Error("expected a chain, got a failure");
    // Two hops: 1.0.0 -> 1.1.0 -> 1.2.0. Expected sha is the target's.
    expect(info.expectedSha256).toBe("aaaa");
    expect(info.steps).toEqual([
      { fromVersion: "1.0.0", toVersion: "1.1.0" },
      { fromVersion: "1.1.0", toVersion: "1.2.0" },
    ]);
    // patchUrls are apply-order: 1.1.0's patch first, then 1.2.0's.
    expect(info.patchUrls).toEqual([
      "https://example.test/1.1.0/tool-linux-x64.patch",
      "https://example.test/1.2.0/tool-linux-x64.patch",
    ]);
  });

  it("reports malformed_chain when a hop is missing its patch asset", () => {
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
    ).toEqual({ failure: "malformed_chain" });
  });

  it("reports over_budget when the chain exceeds the size ratio gate", () => {
    // fullGzSize tiny → 60% ratio easily exceeded by the 5+6 byte patches.
    expect(
      extractStableChain({
        releases,
        currentVersion: "1.0.0",
        targetVersion: "1.2.0",
        binaryName: BINARY,
        fullGzSize: 1,
      }),
    ).toEqual({ failure: "over_budget" });
  });

  it("reports no_patches when target is not older than current in the list", () => {
    expect(
      extractStableChain({
        releases,
        currentVersion: "1.2.0",
        targetVersion: "1.0.0",
        binaryName: BINARY,
        fullGzSize: 40,
      }),
    ).toEqual({ failure: "no_patches" });
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

  it("rejects a from-version mismatch (broken chain link) as malformed", () => {
    const res = validateChainStep(manifest("9.9.9", 50), {
      expectedFrom: "1.0.0",
      patchLayerName: `${BINARY}.patch`,
      sizeLimit: 100,
    });
    expect(res).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a patch layer over the size limit as over_budget", () => {
    const res = validateChainStep(manifest("1.0.0", 500), {
      expectedFrom: "1.0.0",
      patchLayerName: `${BINARY}.patch`,
      sizeLimit: 100,
    });
    expect(res).toEqual({ ok: false, reason: "over_budget" });
  });

  it("rejects (as malformed) when the named patch layer is absent", () => {
    const res = validateChainStep(manifest("1.0.0", 50), {
      expectedFrom: "1.0.0",
      patchLayerName: "other.patch",
      sizeLimit: 100,
    });
    expect(res).toEqual({ ok: false, reason: "malformed" });
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

  it("returns null (not throw) and reports 'network' when the registry is unreachable", async () => {
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

    const report = vi.fn();
    await expect(
      source.resolveChain("1.0.0", "1.1.0", undefined, report),
    ).resolves.toBeNull();
    expect(report).toHaveBeenCalledExactlyOnceWith("network");
  });

  it("reports 'malformed_chain' when a patch tag in range is missing its platform layer", async () => {
    // The exact poisoned-publish scenario: a patch tag exists in the range
    // (so it is NOT 'no_patches'), links correctly by from-version, but its
    // manifest carries a bogus layer instead of `${BINARY}.patch` (e.g. a
    // dependency patch that leaked into publish). The chain must be rejected
    // and classified `malformed_chain` so the poison is observable.
    const token = { token: "t" };
    const gzLayer = {
      digest: "sha256:gz",
      mediaType: "application/gzip",
      size: 1000,
      annotations: { "org.opencontainers.image.title": `${BINARY}.gz` },
    };
    const targetManifest = { schemaVersion: 2, layers: [gzLayer] };
    // patch-1.1.0 links from 1.0.0 but has a bogus (non-platform) layer.
    const poisonedManifest = {
      schemaVersion: 2,
      annotations: { "from-version": "1.0.0" },
      layers: [
        {
          digest: "sha256:bogus",
          mediaType: "application/vnd.oci.image.layer.v1.tar",
          size: 42,
          annotations: {
            "org.opencontainers.image.title": "@dep__thing@1.2.3.patch",
          },
        },
      ],
    };

    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/token")) return json(token);
      if (u.includes("/tags/list")) return json({ tags: ["patch-1.1.0"] });
      if (u.includes("/manifests/nightly-1.1.0")) return json(targetManifest);
      if (u.includes("/manifests/patch-1.1.0")) return json(poisonedManifest);
      throw new TypeError(`unexpected fetch: ${u}`);
    });

    const source = ghcrSource({
      registry: "https://ghcr.io",
      repo: "owner/project",
      userAgent: "test/1.0.0",
      binaryName: BINARY,
      targetTag: (v) => `nightly-${v}`,
      compareVersions: cmp,
    });

    const report = vi.fn();
    await expect(
      source.resolveChain("1.0.0", "1.1.0", undefined, report),
    ).resolves.toBeNull();
    expect(report).toHaveBeenCalledExactlyOnceWith("malformed_chain");
  });

  it("reports 'network' (not 'malformed_chain') when a chain manifest fetch fails transiently", async () => {
    // A patch tag is in range, but fetching its manifest fails (5xx / reset /
    // timeout). This is transient, NOT a poisoned publish — it must report
    // `network`, never a false `malformed_chain` poison alert. (A real poison
    // fetches HTTP 200 and is caught by validateNightlyChain instead.)
    const token = { token: "t" };
    const gzLayer = {
      digest: "sha256:gz",
      mediaType: "application/gzip",
      size: 1000,
      annotations: { "org.opencontainers.image.title": `${BINARY}.gz` },
    };
    const targetManifest = { schemaVersion: 2, layers: [gzLayer] };

    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/token")) return json(token);
      if (u.includes("/tags/list")) return json({ tags: ["patch-1.1.0"] });
      if (u.includes("/manifests/nightly-1.1.0")) return json(targetManifest);
      // The in-range patch manifest 5xxs on every (retried) attempt.
      if (u.includes("/manifests/patch-1.1.0")) {
        return new Response("upstream boom", { status: 503 });
      }
      throw new TypeError(`unexpected fetch: ${u}`);
    });

    const source = ghcrSource({
      registry: "https://ghcr.io",
      repo: "owner/project",
      userAgent: "test/1.0.0",
      binaryName: BINARY,
      targetTag: (v) => `nightly-${v}`,
      compareVersions: cmp,
    });

    const report = vi.fn();
    await expect(
      source.resolveChain("1.0.0", "1.1.0", undefined, report),
    ).resolves.toBeNull();
    expect(report).toHaveBeenCalledExactlyOnceWith("network");
  });
});

describe("OciClient.downloadBlob — redirect always carries a timeout signal", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("applies a timeout to the redirected blob fetch even when no signal is passed", async () => {
    // First call: registry returns a 307 to blob storage. Second call: the
    // redirect target. Capture the redirect call's signal — it MUST be a live
    // AbortSignal (buildSignal's timeout) even though downloadBlob is called
    // with signal=undefined (e.g. from prefetch), so a stalled Azure blob
    // download can never hang the CLI forever.
    let redirectSignal: AbortSignal | null | undefined;
    let sawRedirectCall = false;
    let call = 0;
    globalThis.fetch = vi.fn(
      async (_url: unknown, init?: { signal?: AbortSignal | null }) => {
        call++;
        if (call === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: "https://blob.example.com/obj" },
          });
        }
        sawRedirectCall = true;
        redirectSignal = init?.signal;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    );

    const client = new OciClient({
      registry: "https://ghcr.io",
      repo: "owner/project",
      userAgent: "test/1.0.0",
    });

    // No signal argument — the redirect must still get a timeout signal.
    const res = await client.downloadBlob("tok", "sha256:abc");
    expect(res.status).toBe(200);
    expect(sawRedirectCall).toBe(true);
    expect(redirectSignal).toBeInstanceOf(AbortSignal);
    expect(redirectSignal?.aborted).toBe(false);
  });
});
