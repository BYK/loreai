import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ghcrSource, githubReleaseSource } from "binpatch";
import { compareVersions } from "../src/cli/lib/binary";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const urlString = (url: string | URL | Request) =>
  typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
const binary = "lore-darwin-arm64";
const json = (value: unknown) => Response.json(value);

function nightly({ missing = false, brokenLink = false } = {}) {
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = urlString(url);
    if (path.includes("/token?")) return json({ token: "anonymous" });
    if (path.includes("/tags/list"))
      return json({ tags: ["patch-1.0.1", "patch-1.0.2"] });
    if (path.endsWith("/manifests/nightly-1.0.2"))
      return json({
        layers: [
          {
            size: 10000,
            annotations: { "org.opencontainers.image.title": `${binary}.gz` },
          },
        ],
      });
    if (path.includes("/manifests/patch-")) {
      const first = path.endsWith("1.0.1");
      return json({
        annotations: {
          "from-version": first ? "1.0.0" : "1.0.1",
          [`sha256-${binary}`]: sha(first ? "middle" : "new"),
          ...(missing
            ? {}
            : {
                [`source-sha256-${binary}`]: sha(
                  first ? "old" : brokenLink ? "different middle" : "middle",
                ),
              }),
        },
        layers: [
          {
            size: 3,
            digest: `sha256:${sha(first ? "p1" : "p2")}`,
            annotations: {
              "org.opencontainers.image.title": `${binary}.patch`,
            },
          },
        ],
      });
    }
    if (path.includes("/blobs/")) return new Response("123");
    throw Error(`Unexpected fetch: ${path}`);
  });
  return {
    fetcher,
    source: ghcrSource({
      registry: "https://registry.example",
      repo: "test/lore",
      binaryName: binary,
      userAgent: "test",
      targetTag: (v) => `nightly-${v}`,
      compareVersions,
      fetch: fetcher as unknown as typeof fetch,
    }),
  };
}

describe("published delta source identity", () => {
  it("carries the first base checksum through a two-hop nightly chain", async () => {
    const { source } = nightly();
    expect(await source.resolveChain("1.0.0", "1.0.2")).toMatchObject({
      sourceSha256: sha("old"),
      expectedSha256: sha("new"),
      steps: [
        { fromVersion: "1.0.0", toVersion: "1.0.1" },
        { fromVersion: "1.0.1", toVersion: "1.0.2" },
      ],
    });
  });
  it.each([{ missing: true }, { brokenLink: true }])(
    "skips legacy or incompatible nightly chains before fetching patch bytes: %j",
    async (options) => {
      const { source, fetcher } = nightly(options);
      const report = vi.fn();
      expect(
        await source.resolveChain("1.0.0", "1.0.2", undefined, report),
      ).toBeNull();
      expect(
        fetcher.mock.calls.some(([url]) => urlString(url).includes("/blobs/")),
      ).toBe(false);
      expect(report).toHaveBeenCalledWith(
        options.missing ? "source_unverified" : "malformed_chain",
      );
    },
  );
  it.each([
    "valid",
    "tampered",
    "wrong-version",
    "missing",
    "malformed",
    "matching-raw",
    "conflicting-raw",
  ])("validates stable patch sidecar identity: %s", async (kind) => {
    const metadata = JSON.stringify({
      fromVersion: kind === "wrong-version" ? "0.9.0" : "1.0.0",
      sourceSha256: sha("old"),
      targetSha256: sha("new"),
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (urlString(url).includes("/releases?"))
        return json([
          {
            tag_name: "1.0.1",
            assets: [
              { name: `${binary}.gz`, size: 10000 },
              ...(kind.endsWith("-raw")
                ? [
                    {
                      name: binary,
                      size: 3,
                      digest: `sha256:${sha(kind === "matching-raw" ? "new" : "different target")}`,
                      browser_download_url: "https://assets.example/binary",
                    },
                  ]
                : []),
              {
                name: `${binary}.patch`,
                size: 3,
                browser_download_url: "https://assets.example/patch",
              },
              ...(kind === "missing"
                ? []
                : [
                    {
                      name: `${binary}.patch.json`,
                      size: metadata.length,
                      digest: `sha256:${sha(kind === "tampered" ? "different" : kind === "malformed" ? "{" : metadata)}`,
                      browser_download_url: "https://assets.example/metadata",
                    },
                  ]),
            ],
          },
          { tag_name: "1.0.0", assets: [] },
        ]);
      if (urlString(url).endsWith("/metadata"))
        return new Response(kind === "malformed" ? "{" : metadata);
      if (urlString(url).endsWith("/patch")) return new Response("123");
      throw Error("Unexpected fetch");
    });
    const source = githubReleaseSource({
      releasesUrl: "https://api.example/releases",
      binaryName: binary,
      userAgent: "test",
      fetch: fetcher as unknown as typeof fetch,
    });
    const chain = await source.resolveChain("1.0.0", "1.0.1");
    if (kind === "valid" || kind === "matching-raw")
      expect(chain).toMatchObject({
        sourceSha256: sha("old"),
        expectedSha256: sha("new"),
      });
    else {
      expect(chain).toBeNull();
      expect(
        fetcher.mock.calls.some(([url]) => urlString(url).endsWith("/patch")),
      ).toBe(false);
    }
  });
});
