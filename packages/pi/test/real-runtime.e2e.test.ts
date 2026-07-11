import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  AuthStorage,
  type CreateAgentSessionResult,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import lorePiExtension from "../src/index";
import { anthropicMessageToSSE } from "../../gateway/test/helpers/replay";

/**
 * End-to-end test against the REAL Pi runtime.
 *
 * Unlike `extension.e2e.test.ts` (which hand-rolls a mock `ExtensionAPI`),
 * this test loads our actual extension through Pi's real extension-loading
 * machinery (`DefaultResourceLoader` + `createAgentSession`) and drives a
 * real `session.prompt()` turn. The only thing mocked is the upstream LLM —
 * a real in-process Lore gateway sits in the middle, exactly as in
 * production, and the extension reroutes Pi's provider traffic through it.
 *
 * This closes the gap that the mock-context tests cannot: it proves our
 * extension binds to Pi's *real* `ExtensionAPI` contract (catching API drift,
 * the way the hand-mock cannot), that a real agent turn round-trips through
 * the gateway, and — critically for the Daniel Griesser TUI-corruption bug —
 * that loading and running the extension under the real runtime writes
 * NOTHING resembling our log markers (`[lore]` / `pi: `) to stdout/stderr.
 *
 * Upstream is mocked (no real API call); everything else is real.
 */

/** A minimal Anthropic assistant message the mocked upstream returns. */
function cannedMessage(text: string) {
  return {
    id: "msg_real_e2e",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 50, output_tokens: 8 },
  };
}

const MOCK_REPLY = "hello from the mocked upstream";

describe("pi extension — e2e against the real Pi runtime", () => {
  let stopServer: (() => void) | undefined;
  let session: CreateAgentSessionResult["session"] | undefined;
  let extensionsResult:
    | CreateAgentSessionResult["extensionsResult"]
    | undefined;
  const originalEnv = { ...process.env };
  // Upstream request `metadata.user_id` values the gateway forwarded — proof a
  // turn actually reached the gateway pipeline (and under which session id).
  const upstreamSessions: Array<string | undefined> = [];
  // Everything written to stdout/stderr across load + a real prompt turn.
  const captured: string[] = [];
  // Assistant text streamed back to the SDK (proves the round-trip completed).
  let assistantText = "";

  beforeAll(async () => {
    // Indirect specifier so pi's `tsc --noEmit` doesn't try to resolve the
    // gateway's built types (not on pi's typecheck path); mirrors
    // extension.e2e.test.ts. Resolved at runtime via the workspace dependency.
    const gwPkg = "@loreai/gateway";
    const gw = (await import(gwPkg)) as unknown as {
      loadConfig: () => { port: number; hosts: string[] } & Record<
        string,
        unknown
      >;
      startServer: (c: unknown) => Promise<{ stop: () => void; port: number }>;
      resetPipelineState: (opts?: { fast?: boolean }) => Promise<void>;
    };
    const { close: closeDB } = (await import("@loreai/core")) as unknown as {
      close: () => void;
    };
    const { setUpstreamInterceptor } =
      (await import("../../gateway/src/pipeline")) as unknown as {
        setUpstreamInterceptor: (
          fn:
            | ((
                body: unknown,
                model: string,
                streaming: boolean,
                makeReal: () => Promise<Response>,
              ) => Promise<Response>)
            | undefined,
        ) => void;
      };

    closeDB();
    await gw.resetPipelineState();

    // Mock upstream: never hit a real API. Pi's agent streams, so emit a
    // well-formed Anthropic SSE sequence for streaming turns (the gateway
    // forwards an SSE byte stream upstream) and plain JSON otherwise.
    setUpstreamInterceptor(async (body, _model, streaming) => {
      const b = body as { metadata?: { user_id?: string } } | undefined;
      upstreamSessions.push(b?.metadata?.user_id);
      const message = cannedMessage(MOCK_REPLY);
      if (streaming) {
        return new Response(anthropicMessageToSSE(message), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify(message), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const config = gw.loadConfig();
    config.port = 0;
    config.hosts = ["127.0.0.1"];
    const server = await gw.startServer(config);
    stopServer = () => server.stop();
    const baseURL = `http://127.0.0.1:${server.port}`;

    // Activate the otherwise-inert-in-test extension against the real gateway.
    process.env.LORE_PI_FORCE_ACTIVE = "1";
    process.env.LORE_GATEWAY_URL = baseURL;
    delete process.env.LORE_DISABLED;
    delete process.env.LORE_REMOTE_URL;

    // Isolated cwd/agentDir so DefaultResourceLoader discovers nothing from the
    // real repo (.pi/, AGENTS.md, etc.) — our extension is injected explicitly.
    const cwd = mkdtempSync(join(tmpdir(), "lore-pi-rt-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "lore-pi-rt-agent-"));

    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    // Runtime key (not persisted) so the anthropic provider is "available".
    authStorage.setRuntimeApiKey("anthropic", "test-key-not-real");
    const modelRegistry = ModelRegistry.create(
      authStorage,
      join(agentDir, "models.json"),
    );
    const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
    expect(model, "built-in anthropic model should resolve").toBeTruthy();

    // Load OUR real extension through Pi's real ResourceLoader. `reload()`
    // invokes the extension factory (where the routing log line fires), so it
    // must run INSIDE the capture window below.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [
        (pi) =>
          lorePiExtension(
            pi as Parameters<typeof lorePiExtension>[0],
          ) as void | Promise<void>,
      ],
    });

    // Capture everything written to the terminal across the entire real
    // lifecycle: extension load (the factory runs during `reload()`), provider
    // flush + session_start during createAgentSession, AND the real prompt
    // turn. We spy on BOTH the low-level fd writes AND console.* — vitest
    // reroutes console.* away from process.stdout.write, but in a real Pi TUI a
    // stray console.* call is exactly what corrupts the screen, so we must
    // observe it directly. Record-and-suppress (the headless SDK is silent).
    const record = (chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
    };
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        record(chunk);
        return true;
      });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        record(chunk);
        return true;
      });
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      }),
    );

    try {
      await resourceLoader.reload();

      const created = await createAgentSession({
        cwd,
        agentDir,
        model: model ?? undefined,
        authStorage,
        modelRegistry,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        noTools: "all",
      });
      session = created.session;
      extensionsResult = created.extensionsResult;

      session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          assistantText += event.assistantMessageEvent.delta;
        }
      });

      // A real agent turn — routed by our extension through the gateway to the
      // mocked upstream. One turn, no tools → ends on the canned end_turn.
      await session.prompt("Say hello.");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      for (const spy of consoleSpies) spy.mockRestore();
    }
  }, 60_000);

  afterAll(async () => {
    try {
      session?.dispose();
    } catch {
      /* best-effort */
    }
    process.env = { ...originalEnv };
    stopServer?.();
    // Mirror the gateway harness teardown so no pipeline timers / interceptor
    // state leak into other tests sharing this worker.
    try {
      const { setUpstreamInterceptor, resetPipelineState } =
        (await import("../../gateway/src/pipeline")) as unknown as {
          setUpstreamInterceptor: (fn: undefined) => void;
          resetPipelineState: (opts?: { fast?: boolean }) => Promise<void>;
        };
      const { close: closeDB } = (await import("@loreai/core")) as unknown as {
        close: () => void;
      };
      setUpstreamInterceptor(undefined);
      closeDB();
      await resetPipelineState({ fast: true });
    } catch {
      /* best-effort */
    }
  });

  test("loads our extension under the real ExtensionAPI with no errors", () => {
    expect(extensionsResult).toBeDefined();
    // Our extension factory bound to Pi's real ExtensionAPI without throwing.
    expect(extensionsResult?.errors ?? []).toEqual([]);
    // It was actually loaded (not silently dropped).
    expect(extensionsResult?.extensions.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("a real prompt round-trips through the gateway to the mocked upstream", () => {
    // The turn reached the gateway pipeline (not a real Anthropic endpoint):
    // the extension's provider override / fetch interceptor rerouted Pi's
    // anthropic-messages call through the in-process gateway.
    expect(upstreamSessions.length).toBeGreaterThan(0);
    // And the SDK received the mocked assistant text end-to-end — the full
    // Pi-agent → gateway → mocked-SSE-upstream → Pi-agent round-trip completed.
    expect(assistantText).toContain(MOCK_REPLY);
  });

  test("does not corrupt the TUI: the extension writes no markers to stdout/stderr", () => {
    const all = captured.join("");
    // The TUI-corruption regression (Daniel Griesser, 2026-06-28): routine
    // status from the *extension* leaking to the terminal. Every pi log line
    // is `pi: `-prefixed and file-routed via the core `log` module; reverting
    // any of the extension's log.*→console.* changes would surface a `pi: `
    // line here. (We scope to the extension's own marker rather than `[lore]`
    // because the in-process gateway — a separate process in production —
    // legitimately logs `[lore]` lines that are out of scope for this test.)
    expect(all).not.toContain("pi: ");
  });
});
