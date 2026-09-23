import { log } from "@loreai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import {
  handleRequest,
  resetPipelineState,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { upstreamFetch } from "../src/fetch";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

const mockUpstreamFetch = vi.mocked(upstreamFetch);
const silentSink = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  captureException: vi.fn(),
};

afterEach(async () => {
  setUpstreamInterceptor(undefined);
  mockUpstreamFetch.mockReset();
  log.registerSink(silentSink);
  await resetPipelineState({ fast: true });
});

describe("upstream fetch diagnostics", () => {
  it.each([
    [
      "abort errors",
      Object.assign(new Error("client disconnected"), {
        name: "AbortError",
        code: "ECONNRESET",
      }),
    ],
    [
      "redirect-policy errors",
      Object.assign(
        new Error("redirect rejected", {
          cause: Object.assign(new Error("socket cause"), {
            code: "ECONNRESET",
          }),
        }),
        { name: "RedirectError", code: "ERR_INVALID_REDIRECT" },
      ),
    ],
  ])("does not log transport diagnostics for %s", async (_kind, failure) => {
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    mockUpstreamFetch.mockRejectedValue(failure);

    const response = await handleRequest(
      {
        protocol: "openai",
        model: "gpt-test",
        system: "You are a coding assistant.",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: { "x-lore-provider": "openai" },
      },
      loadConfig(),
    );

    expect(response.status).toBe(502);
    expect(
      messages.some((message) => message.startsWith("upstream fetch failed")),
    ).toBe(false);
  });

  it("logs safe diagnostics for a raw Bun socket error", async () => {
    const privateCauseMessage = "PRIVATE_SOCKET_ERROR_MESSAGE";
    const privateAddress = "PRIVATE_SOCKET_ADDRESS";
    const credential = "PRIVATE_UPSTREAM_CREDENTIAL";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });

    // Bun's nodeHttpFetch rejects the raw node:http error instead of Undici's
    // `TypeError("fetch failed")` wrapper.
    mockUpstreamFetch.mockRejectedValue(
      Object.assign(new Error(privateCauseMessage), {
        code: "ECONNRESET",
        errno: -104,
        syscall: "connect",
        address: privateAddress,
      }),
    );

    const response = await handleRequest(
      {
        protocol: "openai",
        model: "gpt-test",
        system: "You are a coding assistant.",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [],
        stream: false,
        maxTokens: 64,
        metadata: {},
        rawHeaders: {
          "x-lore-agent": "coder",
          "x-lore-provider": "openai",
          authorization: `Bearer ${credential}`,
        },
      },
      loadConfig(),
    );

    expect(response.status).toBe(502);
    const diagnostic = messages.find((message) =>
      message.startsWith("upstream fetch failed"),
    );
    expect(diagnostic).toContain("provider=openai");
    expect(diagnostic).toContain("model=gpt-test");
    expect(diagnostic).toContain("protocol=openai");
    expect(diagnostic).toContain("host=api.openai.com");
    expect(diagnostic).toContain("causeCodes=ECONNRESET");
    expect(diagnostic).toContain("errno=-104");
    expect(diagnostic).toContain("syscall=connect");
    expect(messages.join("\n")).not.toContain(privateCauseMessage);
    expect(messages.join("\n")).not.toContain(privateAddress);
    expect(messages.join("\n")).not.toContain(credential);
  });
});
