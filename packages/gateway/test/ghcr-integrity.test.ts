import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadNightlyBlob } from "../src/cli/lib/ghcr";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
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

it.each([false, true])(
  "allows a verified blob body taking more than thirty seconds (redirect=%s)",
  async (redirect) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(
        () =>
          controller.abort(
            new DOMException("Download timed out", "TimeoutError"),
          ),
        delay,
      );
      return controller.signal;
    });
    const content = "slow verified nightly blob";
    let calls = 0;
    globalThis.fetch = vi.fn(async (_input, init?: RequestInit) => {
      if (redirect && calls++ === 0) {
        return new Response(null, {
          status: 307,
          headers: { Location: "https://blob.test/nightly.gz" },
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(content));
              controller.close();
            }, 45_000);
            init?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                controller.error(init.signal?.reason);
              },
              { once: true },
            );
          },
        }),
      );
    }) as unknown as typeof fetch;
    const result = downloadNightlyBlob(
      "token",
      `sha256:${sha256(content)}`,
    ).then(
      async (response) => ({ content: await response.text() }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await result).toEqual({ content });
  },
);
