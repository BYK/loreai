import { describe, expect, test, vi } from "vitest";
import {
  ANTHROPIC_PROVIDERS,
  buildProviderRegistrations,
  GATEWAY_PROVIDERS,
  OPENAI_PROVIDERS,
  runCompaction,
  sessionIDFor,
} from "../src/internal";

const GW = "http://127.0.0.1:31234";

describe("buildProviderRegistrations", () => {
  test("routes Anthropic providers to the gateway root, OpenAI to /v1", () => {
    const regs = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "sess-1",
      projectPath: "/proj",
      env: {},
    });
    const byProvider = new Map(regs.map((r) => [r.provider, r]));

    // One registration per gateway-routable provider.
    expect(regs).toHaveLength(GATEWAY_PROVIDERS.length);

    for (const p of ANTHROPIC_PROVIDERS) {
      expect(byProvider.get(p)?.baseUrl).toBe(GW);
    }
    for (const p of OPENAI_PROVIDERS) {
      expect(byProvider.get(p)?.baseUrl).toBe(`${GW}/v1`);
    }
  });

  test("every registration carries session/project/provider attribution headers", () => {
    const regs = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "sess-2",
      projectPath: "/work/repo",
      env: {},
    });
    for (const reg of regs) {
      expect(reg.headers["x-lore-session-id"]).toBe("sess-2");
      expect(reg.headers["x-lore-project"]).toBe("/work/repo");
      expect(reg.headers["x-lore-provider"]).toBe(reg.provider);
    }
  });

  test("injects git remote only when provided", () => {
    const withRemote = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "s",
      projectPath: "/p",
      gitRemote: "git@github.com:acme/repo.git",
      env: {},
    });
    expect(withRemote[0].headers["x-lore-git-remote"]).toBe(
      "git@github.com:acme/repo.git",
    );

    const withoutRemote = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "s",
      projectPath: "/p",
      env: {},
    });
    for (const reg of withoutRemote) {
      expect(reg.headers["x-lore-git-remote"]).toBeUndefined();
    }
  });

  test("injects x-lore-upstream-url from LORE_UPSTREAM_<PROVIDER> on that provider only", () => {
    const regs = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "s",
      projectPath: "/p",
      env: { LORE_UPSTREAM_VLLM: "http://localhost:8000" },
    });
    const byProvider = new Map(regs.map((r) => [r.provider, r]));
    expect(byProvider.get("vllm")?.headers["x-lore-upstream-url"]).toBe(
      "http://localhost:8000",
    );
    // A different provider must NOT pick up vllm's upstream.
    expect(
      byProvider.get("ollama")?.headers["x-lore-upstream-url"],
    ).toBeUndefined();
  });
});

describe("sessionIDFor", () => {
  test("returns an ephemeral, per-process id when no session file", () => {
    expect(sessionIDFor(undefined)).toBe(`pi-ephemeral-${process.pid}`);
  });

  test("derives a stable pi-<24hex> id from the session file path", () => {
    const a = sessionIDFor("/home/u/.pi/sessions/abc.json");
    const b = sessionIDFor("/home/u/.pi/sessions/abc.json");
    expect(a).toBe(b); // stable
    expect(a).toMatch(/^pi-[0-9a-f]{24}$/);
    // Different files → different ids.
    expect(sessionIDFor("/home/u/.pi/sessions/def.json")).not.toBe(a);
  });
});

describe("runCompaction", () => {
  const base = {
    gatewayBase: GW,
    sessionID: "sess-c",
    projectPath: "/proj",
    previousSummary: "prev",
    firstKeptEntryId: "entry-7",
    tokensBefore: 4242,
    // These tests are about the gateway fetch path itself; disable the
    // cancel-when-small policy which is tested separately below.
    cancelThreshold: 0,
  };

  test("POSTs to /v1/compact with session header + body, returns shaped result", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ summary: "fresh summary" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await runCompaction({ ...base, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${GW}/v1/compact`);
    expect((init!.headers as Record<string, string>)["x-lore-session-id"]).toBe(
      "sess-c",
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      project_path: "/proj",
      previous_summary: "prev",
    });

    expect(result).toEqual({
      compaction: {
        summary: "fresh summary",
        firstKeptEntryId: "entry-7",
        tokensBefore: 4242,
      },
    });
  });

  test("returns undefined on 404 session_not_found (graceful fallback)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "session_not_found" }), {
          status: 404,
        }),
    );
    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
  });

  test("returns undefined on a non-2xx error", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
  });

  test("returns undefined when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
  });

  test("returns undefined on a 2xx with an empty summary", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ summary: "" }), { status: 200 }),
    );
    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Cancel-when-small policy (Lore manages the window via raw context + recall).
  // This is the on-Pi analog of OpenCode's --cap-context mechanism.
  // ---------------------------------------------------------------------------
  describe("cancel-when-small policy", () => {
    test("returns { cancel: true } when tokensBefore is below threshold", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("fetch should not be called when we cancel");
      });
      const result = await runCompaction({
        gatewayBase: GW,
        sessionID: "sess-c",
        projectPath: "/proj",
        previousSummary: undefined,
        firstKeptEntryId: "entry-7",
        tokensBefore: 50_000,
        cancelThreshold: 200_000,
        fetchImpl,
      });
      expect(result).toEqual({ cancel: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    test("returns { cancel: true } at tokensBefore == threshold - 1 (boundary)", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("fetch should not be called when we cancel");
      });
      const result = await runCompaction({
        gatewayBase: GW,
        sessionID: "sess-c",
        projectPath: "/proj",
        previousSummary: undefined,
        firstKeptEntryId: "entry-7",
        tokensBefore: 199_999,
        cancelThreshold: 200_000,
        fetchImpl,
      });
      expect(result).toEqual({ cancel: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    test("falls through to /v1/compact when tokensBefore is at threshold (raw context would not fit)", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ summary: "ok" }), { status: 200 }),
      );
      const result = await runCompaction({
        gatewayBase: GW,
        sessionID: "sess-c",
        projectPath: "/proj",
        previousSummary: undefined,
        firstKeptEntryId: "entry-7",
        tokensBefore: 200_000,
        cancelThreshold: 200_000,
        fetchImpl,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(result).toEqual({
        compaction: {
          summary: "ok",
          firstKeptEntryId: "entry-7",
          tokensBefore: 200_000,
        },
      });
    });

    test("returns { cancel: true } for any tokensBefore < threshold (sub-threshold fast path)", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("fetch should not be called when we cancel");
      });
      for (const tokensBefore of [1, 100, 5_000, 50_000, 199_999]) {
        const result = await runCompaction({
          gatewayBase: GW,
          sessionID: "sess-c",
          projectPath: "/proj",
          previousSummary: undefined,
          firstKeptEntryId: "entry-7",
          tokensBefore,
          cancelThreshold: 200_000,
          fetchImpl,
        });
        expect(result).toEqual({ cancel: true });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    test("falls through to /v1/compact when tokensBefore >= threshold (must compact)", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ summary: "ok" }), { status: 200 }),
      );
      for (const tokensBefore of [200_000, 250_000, 1_000_000]) {
        vi.mocked(fetchImpl).mockClear();
        const result = await runCompaction({
          gatewayBase: GW,
          sessionID: "sess-c",
          projectPath: "/proj",
          previousSummary: undefined,
          firstKeptEntryId: "entry-7",
          tokensBefore,
          cancelThreshold: 200_000,
          fetchImpl,
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(result).toEqual({
          compaction: {
            summary: "ok",
            firstKeptEntryId: "entry-7",
            tokensBefore,
          },
        });
      }
    });

    test("does NOT cancel when loreActive is false (fall through to /v1/compact)", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ summary: "ok" }), { status: 200 }),
      );
      const result = await runCompaction({
        gatewayBase: GW,
        sessionID: "sess-c",
        projectPath: "/proj",
        previousSummary: undefined,
        firstKeptEntryId: "entry-7",
        tokensBefore: 50_000,
        cancelThreshold: 200_000,
        loreActive: false,
        fetchImpl,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(result).toEqual({
        compaction: {
          summary: "ok",
          firstKeptEntryId: "entry-7",
          tokensBefore: 50_000,
        },
      });
    });

    test("does NOT cancel when tokensBefore is 0 / NaN (unknown size — fall through)", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ summary: "ok" }), { status: 200 }),
      );
      for (const tokensBefore of [0, NaN, -1]) {
        vi.mocked(fetchImpl).mockClear();
        const result = await runCompaction({
          gatewayBase: GW,
          sessionID: "sess-c",
          projectPath: "/proj",
          previousSummary: undefined,
          firstKeptEntryId: "entry-7",
          tokensBefore,
          cancelThreshold: 200_000,
          fetchImpl,
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(result).toEqual({
          compaction: {
            summary: "ok",
            firstKeptEntryId: "entry-7",
            tokensBefore,
          },
        });
      }
    });

    test("resolves threshold from LORE_PI_CANCEL_THRESHOLD env var", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("fetch should not be called when we cancel");
      });
      const result = await runCompaction({
        gatewayBase: GW,
        sessionID: "sess-c",
        projectPath: "/proj",
        previousSummary: undefined,
        firstKeptEntryId: "entry-7",
        tokensBefore: 50_000,
        env: { LORE_PI_CANCEL_THRESHOLD: "100000" } as NodeJS.ProcessEnv,
        fetchImpl,
      });
      expect(result).toEqual({ cancel: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    test("rejects invalid LORE_PI_CANCEL_THRESHOLD env values (falls back to default)", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ summary: "ok" }), { status: 200 }),
      );
      for (const bad of ["", "abc", "0", "-5", "not-a-number"]) {
        const env = {
          LORE_PI_CANCEL_THRESHOLD: bad,
        } as unknown as NodeJS.ProcessEnv;
        vi.mocked(fetchImpl).mockClear();
        const result = await runCompaction({
          gatewayBase: GW,
          sessionID: "sess-c",
          projectPath: "/proj",
          previousSummary: undefined,
          firstKeptEntryId: "entry-7",
          tokensBefore: 50_000,
          env,
          fetchImpl,
        });
        // Default 200K → 50K < 200K → cancel. Both path result and fetch
        // call behavior confirm the env override was rejected.
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(result).toEqual({ cancel: true });
      }
    });
  });
});
