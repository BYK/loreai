import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadNightlyBlob } from "../src/cli/lib/ghcr";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("GHCR blob integrity", () => {
  it("returns bytes that match the OCI manifest digest", async () => {
    const content = "published nightly blob";
    globalThis.fetch = vi.fn(
      async () => new Response(content),
    ) as unknown as typeof fetch;

    const response = await downloadNightlyBlob(
      "token",
      `sha256:${sha256(content)}`,
    );

    expect(await response.text()).toBe(content);
  });

  it("rejects a tampered GHCR blob before returning it to a consumer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { Location: "https://blob.test/nightly.gz" },
        }),
      )
      .mockResolvedValueOnce(new Response("tampered blob"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      downloadNightlyBlob("token", `sha256:${sha256("published blob")}`),
    ).rejects.toThrow(/OCI blob digest mismatch/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty(
      "Authorization",
    );
  });

  it("rejects malformed manifest digests without downloading a blob", async () => {
    const fetchMock = vi.fn(async () => new Response("blob"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      downloadNightlyBlob("token", "sha256:not-a-digest"),
    ).rejects.toThrow(/invalid OCI blob digest/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTPS blob redirect before following it", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { Location: "http://blob.test/nightly.gz" },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      downloadNightlyBlob("token", `sha256:${sha256("published blob")}`),
    ).rejects.toThrow(/authenticated HTTPS URL/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
