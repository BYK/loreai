import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  fetchOAuthQuotaSnapshot,
  fetchQuotaDeduped,
  maybeFetchQuota,
  isAnthropicOAuthSession,
  getQuotaForCredential,
  getQuotaForFingerprint,
  isQuotaPaused,
  computeQuotaPressure,
  deleteQuotaForFingerprint,
  _resetQuotaForTest,
  type QuotaSnapshot,
} from "../src/quota";
import {
  setSessionAuth,
  authFingerprint,
  _resetAuthForTest,
  type AuthCredential,
} from "../src/auth";
import { captureBillingPrefix, _resetForTest as resetCch } from "../src/cch";

// Must match QUOTA_URL in ../src/quota.ts. Used to scope the fetch-mock
// capture to the quota request and ignore unrelated fetches (issue #527).
const QUOTA_URL = "https://api.anthropic.com/api/oauth/usage";

const BEARER: AuthCredential = { scheme: "bearer", value: "oauth-token-abc" };
const API_KEY: AuthCredential = { scheme: "api-key", value: "sk-ant-xyz" };
const BILLING =
  "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;";

let originalFetch: typeof globalThis.fetch;

function quotaBody(fiveHour = 45.2, sevenDay = 12.8): string {
  return JSON.stringify({
    five_hour: { utilization: fiveHour, resets_at: "2026-06-02T18:00:00Z" },
    seven_day: { utilization: sevenDay, resets_at: "2026-06-08T00:00:00Z" },
  });
}

/** Register a Claude Code OAuth session (bearer + billing header). */
function makeOAuthSession(sessionID: string, cred = BEARER): void {
  setSessionAuth(sessionID, cred);
  captureBillingPrefix(sessionID, BILLING);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetQuotaForTest();
  _resetAuthForTest();
  resetCch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Parsing / fetchOAuthQuotaSnapshot
// ---------------------------------------------------------------------------

describe("fetchOAuthQuotaSnapshot", () => {
  test("returns null for api-key credentials (no fetch)", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(quotaBody(), { status: 200 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(API_KEY);
    expect(snap).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("parses a valid 200 body", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(quotaBody(45.2, 12.8), { status: 200 })),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap).not.toBeNull();
    expect(snap?.fiveHour?.utilization).toBeCloseTo(45.2);
    expect(snap?.sevenDay?.utilization).toBeCloseTo(12.8);
    expect(snap?.fiveHour?.resetsAt).toBe(Date.parse("2026-06-02T18:00:00Z"));
  });

  test("sends bearer auth + oauth beta header", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      // Only capture the quota request — unrelated fetches (e.g. a Sentry
      // transport flush leaking in from another test file on shared CI
      // workers) must not clobber `capturedInit`. See issue #527.
      if (url.startsWith(QUOTA_URL)) {
        capturedInit = init;
      }
      return Promise.resolve(new Response(quotaBody(), { status: 200 }));
    }) as unknown as typeof fetch;

    await fetchOAuthQuotaSnapshot(BEARER);
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer oauth-token-abc");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  test("sends a Claude Code user-agent (fallback when no session)", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      // Capture only the quota request (see issue #527).
      if (url.startsWith(QUOTA_URL)) {
        capturedInit = init;
      }
      return Promise.resolve(new Response(quotaBody(), { status: 200 }));
    }) as unknown as typeof fetch;

    await fetchOAuthQuotaSnapshot(BEARER);
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["user-agent"]).toContain("claude-cli/");
  });

  test("fetches from the expected quota URL", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = mock((url: string) => {
      // Only capture the quota request — ignore Sentry transport flushes and
      // other background fetches that race with the mock (see #524 / #527).
      if (url.startsWith(QUOTA_URL)) {
        capturedUrl = url;
      }
      return Promise.resolve(new Response(quotaBody(), { status: 200 }));
    }) as unknown as typeof fetch;

    await fetchOAuthQuotaSnapshot(BEARER);
    // Guards against silent drift between this test file's QUOTA_URL
    // constant and the production QUOTA_URL in ../src/quota.ts.
    expect(capturedUrl).toBe(QUOTA_URL);
  });

  test("reuses sniffed Claude Code headers when a session is provided", async () => {
    makeOAuthSession("sid-ua");
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      // Capture only the quota request. Without this URL guard a Sentry
      // transport flush leaking in from another test file on shared CI
      // workers overwrites `capturedInit` with its own request (whose
      // user-agent is `sentry.javascript.bun/...`), flaking this test.
      // See issue #527.
      if (url.startsWith(QUOTA_URL)) {
        capturedInit = init;
      }
      return Promise.resolve(new Response(quotaBody(), { status: 200 }));
    }) as unknown as typeof fetch;

    await fetchOAuthQuotaSnapshot(BEARER, "sid-ua");
    const headers = capturedInit?.headers as Record<string, string>;
    // No captureSessionHeaders was called, so buildOAuthWorkerHeaders uses its
    // fallback Claude Code UA + worker betas (not sniffed session values).
    expect(headers["user-agent"]).toContain("claude-cli/");
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
  });

  test("missing seven_day → that window is null", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 50, resets_at: "2026-06-02T18:00:00Z" },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap?.fiveHour?.utilization).toBe(50);
    expect(snap?.sevenDay).toBeNull();
  });

  test("garbage resets_at → resetsAt null but utilization kept", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 30, resets_at: "not-a-date" },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap?.fiveHour?.utilization).toBe(30);
    expect(snap?.fiveHour?.resetsAt).toBeNull();
  });

  test("out-of-range utilization is clamped to [0,100]", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 150 },
            seven_day: { utilization: -10 },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap?.fiveHour?.utilization).toBe(100);
    expect(snap?.sevenDay?.utilization).toBe(0);
  });

  test("fraction-format utilization (0.0-1.0) is scaled to percent", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 0.452 },
            seven_day: { utilization: 0.128 },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap?.fiveHour?.utilization).toBeCloseTo(45.2);
    expect(snap?.sevenDay?.utilization).toBeCloseTo(12.8);
  });

  test("percent-format utilization (>1) is kept as-is", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ five_hour: { utilization: 45.2 } }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap?.fiveHour?.utilization).toBeCloseTo(45.2);
  });

  test("numeric epoch resets_at (seconds) is parsed to ms", async () => {
    const epochSec = 1_780_000_000;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 50, resets_at: epochSec },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap?.fiveHour?.resetsAt).toBe(epochSec * 1000);
  });

  test("numeric epoch resets_at (milliseconds) is kept as-is", async () => {
    const epochMs = 1_780_000_000_000;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 50, resets_at: epochMs },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap?.fiveHour?.resetsAt).toBe(epochMs);
  });

  test("empty body → both windows null, no throw", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap).not.toBeNull();
    expect(snap?.fiveHour).toBeNull();
    expect(snap?.sevenDay).toBeNull();
  });

  test("429 returns null without throwing", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("rate limited", { status: 429 })),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap).toBeNull();
  });

  test("401 returns null without throwing", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap).toBeNull();
  });

  test("network error returns null without throwing", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("connection refused")),
    ) as unknown as typeof fetch;

    const snap = await fetchOAuthQuotaSnapshot(BEARER);
    expect(snap).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// In-flight dedup
// ---------------------------------------------------------------------------

describe("fetchQuotaDeduped", () => {
  test("concurrent calls for same fingerprint → one underlying fetch", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = mock(
      () =>
        new Promise<Response>((r) => {
          resolveFetch = r;
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const p1 = fetchQuotaDeduped(BEARER);
    const p2 = fetchQuotaDeduped(BEARER);
    // Wait for the serial gate to release and fetch to be invoked before
    // resolving it.
    await new Promise((r) => setTimeout(r, 10));
    resolveFetch(new Response(quotaBody(), { status: 200 }));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2 as QuotaSnapshot);
  });

  test("serial gate keeps advancing after a failed fetch (no deadlock)", async () => {
    // A failure must release the serial gate so subsequent fetches proceed.
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network")),
    ) as unknown as typeof fetch;
    const r1 = await fetchOAuthQuotaSnapshot(BEARER);
    expect(r1).toBeNull();

    // The gate should be free — a following fetch must complete, not hang.
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(quotaBody(), { status: 200 })),
    ) as unknown as typeof fetch;
    const r2 = await fetchOAuthQuotaSnapshot(BEARER);
    expect(r2).not.toBeNull();
  });

  test("stores result in cache, then clears inflight (allows re-fetch)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(quotaBody(), { status: 200 })),
    ) as unknown as typeof fetch;

    await fetchQuotaDeduped(BEARER);
    expect(getQuotaForCredential(BEARER)).not.toBeNull();

    // A second sequential call issues a fresh fetch (inflight cleared).
    const fetchMock2 = mock(() =>
      Promise.resolve(new Response(quotaBody(), { status: 200 })),
    );
    globalThis.fetch = fetchMock2 as unknown as typeof fetch;
    await fetchQuotaDeduped(BEARER);
    expect(fetchMock2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Applicability gate
// ---------------------------------------------------------------------------

describe("isAnthropicOAuthSession", () => {
  test("true for bearer + billing header", () => {
    makeOAuthSession("sid-oauth");
    expect(isAnthropicOAuthSession("sid-oauth")).toBe(true);
  });

  test("false for bearer WITHOUT billing header (non-Anthropic provider)", () => {
    setSessionAuth("sid-bearer", BEARER); // no captureBillingPrefix
    expect(isAnthropicOAuthSession("sid-bearer")).toBe(false);
  });

  test("false for api-key session", () => {
    setSessionAuth("sid-key", API_KEY);
    captureBillingPrefix("sid-key", BILLING);
    expect(isAnthropicOAuthSession("sid-key")).toBe(false);
  });
});

describe("maybeFetchQuota — provider isolation", () => {
  test("no fetch for bearer-but-not-Claude-Code session", () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(quotaBody(), { status: 200 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    setSessionAuth("sid-bearer", BEARER); // no billing header
    maybeFetchQuota("sid-bearer", BEARER);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("no fetch for api-key session", () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(quotaBody(), { status: 200 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    setSessionAuth("sid-key", API_KEY);
    captureBillingPrefix("sid-key", BILLING);
    maybeFetchQuota("sid-key", API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("per-account cooldown prevents a second fetch within 5 min", async () => {
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls++;
      return Promise.resolve(new Response(quotaBody(), { status: 200 }));
    }) as unknown as typeof fetch;

    makeOAuthSession("sid-oauth");
    maybeFetchQuota("sid-oauth", BEARER);
    maybeFetchQuota("sid-oauth", BEARER); // within cooldown — skipped
    // Allow the first background fetch to settle.
    await new Promise((r) => setTimeout(r, 1100));
    expect(calls).toBe(1);
  });

  test("a failed fetch does not hold the full 5-min cooldown (retry allowed sooner)", async () => {
    // First fetch fails (timeout) → only the short retry cooldown should apply.
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("boom")),
    ) as unknown as typeof fetch;

    makeOAuthSession("sid-retry");
    maybeFetchQuota("sid-retry", BEARER);
    await new Promise((r) => setTimeout(r, 1100)); // let the failed fetch settle

    // The cooldown was set to (now - 5min + 30s), so the account is still
    // gated now, but will be eligible again in ~30s rather than 5min. Verify
    // the next call within the SHORT window is still skipped (no stampede)...
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls++;
      return Promise.resolve(new Response(quotaBody(), { status: 200 }));
    }) as unknown as typeof fetch;
    maybeFetchQuota("sid-retry", BEARER);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0); // still inside the 30s retry window
  });

  test("a successful fetch holds the full cooldown", async () => {
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls++;
      return Promise.resolve(new Response(quotaBody(), { status: 200 }));
    }) as unknown as typeof fetch;

    makeOAuthSession("sid-ok");
    maybeFetchQuota("sid-ok", BEARER);
    await new Promise((r) => setTimeout(r, 1100));
    expect(calls).toBe(1);
    expect(getQuotaForCredential(BEARER)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pause threshold
// ---------------------------------------------------------------------------

describe("isQuotaPaused", () => {
  test("true when 5h utilization > 95%", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(quotaBody(96, 20), { status: 200 })),
    ) as unknown as typeof fetch;

    await fetchQuotaDeduped(BEARER);
    expect(isQuotaPaused(BEARER)).toBe(true);
  });

  test("false when 5h utilization below threshold", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(quotaBody(50, 20), { status: 200 })),
    ) as unknown as typeof fetch;

    await fetchQuotaDeduped(BEARER);
    expect(isQuotaPaused(BEARER)).toBe(false);
  });

  test("false for null / unknown credential", () => {
    expect(isQuotaPaused(null)).toBe(false);
    expect(isQuotaPaused(API_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeQuotaPressure
// ---------------------------------------------------------------------------

describe("computeQuotaPressure", () => {
  function snap(five: number, seven: number): QuotaSnapshot {
    return {
      fiveHour: { utilization: five, resetsAt: null },
      sevenDay: { utilization: seven, resetsAt: null },
      fetchedAt: Date.now(),
    };
  }

  test("0 below the 80% floor", () => {
    expect(computeQuotaPressure(snap(50, 70))).toBe(0);
    expect(computeQuotaPressure(snap(80, 80))).toBe(0);
  });

  test("ramps to 1 at 100%", () => {
    expect(computeQuotaPressure(snap(100, 0))).toBe(1);
    expect(computeQuotaPressure(snap(90, 0))).toBeCloseTo(0.5);
  });

  test("uses the max of 5h and 7d", () => {
    expect(computeQuotaPressure(snap(40, 90))).toBeCloseTo(0.5);
  });

  test("0 for null snapshot", () => {
    expect(computeQuotaPressure(null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Eviction GC
// ---------------------------------------------------------------------------

describe("deleteQuotaForFingerprint", () => {
  test("drops cached snapshot and pause state", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(quotaBody(96, 20), { status: 200 })),
    ) as unknown as typeof fetch;

    await fetchQuotaDeduped(BEARER);
    const fp = authFingerprint(BEARER);
    expect(getQuotaForFingerprint(fp)).not.toBeNull();
    expect(isQuotaPaused(BEARER)).toBe(true);

    deleteQuotaForFingerprint(fp);
    expect(getQuotaForFingerprint(fp)).toBeNull();
    expect(isQuotaPaused(BEARER)).toBe(false);
  });
});
