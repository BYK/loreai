import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHarness, type Harness } from "./helpers/harness";
import { DEFAULT_MODEL, makeFixtureEntry } from "./helpers/fixtures";
import { createGatewayRecallClient } from "@loreai/core";
import { create as createKnowledge } from "../../core/src/ltm";
import { createRecallTool } from "../../opencode/src/recall-tool";
import { createPiRecallTool } from "../../pi/src/recall-tool";
import { createGatewayApp } from "../src/app";
import { loadConfig } from "../src/config";

describe("authenticated native recall", () => {
  let harness: Harness | undefined;
  afterEach(async () => harness?.teardown());

  test.each([false, true])(
    "resolves the gateway session after restart and rejects other credentials/projects (remote=%s)",
    async (remoteGateway) => {
      const marker = `native-session-memory-${crypto.randomUUID()}`;
      const sessionID = `harness-session-${crypto.randomUUID()}`;
      harness = await createHarness({
        configOverrides: {
          remoteGateway,
          gatewayAuthToken: "native-test-gateway-token-32-bytes-minimum",
        },
        fixtures: [
          makeFixtureEntry({
            seq: 0,
            model: DEFAULT_MODEL,
            requestMessages: [{ role: "user", content: marker }],
            responseText: "remembered",
            wasStreaming: false,
          }),
        ],
      });
      const response = await harness.chat(
        {
          model: DEFAULT_MODEL,
          max_tokens: 1024,
          stream: false,
          system: "You are a coding assistant. ".repeat(30),
          messages: [{ role: "user", content: marker }],
        },
        "native-key",
        {
          "x-lore-session-id": sessionID,
          "x-lore-gateway-token": "native-test-gateway-token-32-bytes-minimum",
        },
      );
      expect(response.status).toBe(200);
      await response.text();
      const call = (key = "native-key", project = process.cwd()) =>
        harness!.request("/v1/recall", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "x-lore-session-id": sessionID,
            "x-lore-project": project,
            "x-lore-gateway-token":
              "native-test-gateway-token-32-bytes-minimum",
          },
          body: JSON.stringify({ query: marker, scope: "session" }),
        });
      for (const restart of [false, true]) {
        if (restart) await harness.restartPipeline();
        const recalled = await call();
        expect(recalled.status).toBe(200);
        expect(await recalled.text()).toContain(marker);
        const wrongCredential = await call("another-key");
        expect(wrongCredential.status).toBe(404);
        expect(await wrongCredential.text()).not.toContain(marker);
        const wrongProject = await call("native-key", "/other-project");
        expect(wrongProject.status).toBe(403);
        expect(await wrongProject.text()).not.toContain(marker);
      }
    },
  );

  test("uses the gateway's loaded knowledge configuration for native tools", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "lore-native-config-"));
    try {
      writeFileSync(
        join(projectPath, ".lore.json"),
        JSON.stringify({ knowledge: { enabled: false } }),
      );
      const marker = "native-knowledge-disabled";
      harness = await createHarness({
        projectPath,
        fixtures: [
          makeFixtureEntry({
            seq: 0,
            model: DEFAULT_MODEL,
            requestMessages: [
              { role: "user", content: "remember this project" },
            ],
            responseText: "remembered",
            wasStreaming: false,
          }),
        ],
      });
      const chat = await harness.chat(
        {
          model: DEFAULT_MODEL,
          max_tokens: 1024,
          stream: false,
          system: "You are a coding assistant. ".repeat(30),
          messages: [{ role: "user", content: "remember this project" }],
        },
        "native-key",
        { "x-lore-session-id": "config-session" },
      );
      expect(chat.status).toBe(200);
      await chat.text();
      const id = createKnowledge({
        projectPath,
        title: marker,
        content: marker,
        category: "gotcha",
        scope: "project",
      });
      const client = createGatewayRecallClient(harness.baseURL);
      client.observeRequestHeaders(
        new Headers({
          "x-lore-project": projectPath,
          "x-lore-session-id": "config-session",
          "x-api-key": "native-key",
        }),
      );
      for (const input of [
        { query: marker, scope: "knowledge" },
        { id: `k:${id}` },
      ]) {
        const result = await client.execute(input, {
          projectPath,
          sessionID: "config-session",
        });
        expect(result).not.toContain(marker);
        expect(result).not.toContain("unavailable");
      }
    } finally {
      await harness?.teardown();
      harness = undefined;
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test("both native adapters use gateway-owned detail refs and credential-scoped internal sessions", async () => {
    const sessionID = `shared-harness-session-${crypto.randomUUID()}`;
    const markers = ["alpha-session-private", "beta-session-private"];
    harness = await createHarness({
      fixtures: markers.map((marker, seq) =>
        makeFixtureEntry({
          seq,
          model: DEFAULT_MODEL,
          requestMessages: [
            {
              role: "user",
              content: `${marker} ${"detail sentence. ".repeat(200)}`,
            },
          ],
          responseText: "remembered",
          wasStreaming: false,
        }),
      ),
    });
    const clients = [];
    for (const [index, marker] of markers.entries()) {
      const headers = {
        "x-api-key": `native-key-${index}`,
        "x-lore-provider": "anthropic",
        "x-lore-session-id": sessionID,
        "x-lore-project": process.cwd(),
      };
      const chat = await harness.chat(
        {
          model: DEFAULT_MODEL,
          max_tokens: 1024,
          stream: false,
          system: "You are a coding assistant. ".repeat(30),
          messages: [
            {
              role: "user",
              content: `${marker} ${"detail sentence. ".repeat(200)}`,
            },
          ],
        },
        headers["x-api-key"],
        headers,
      );
      expect(chat.status).toBe(200);
      await chat.text();
      const client = createGatewayRecallClient(harness.baseURL);
      client.observeRequestHeaders(new Headers(headers));
      clients.push(client);
    }
    const context = {
      sessionID,
      messageID: "native-message",
      agent: "build",
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    };
    const opencode = createRecallTool(clients[0]!.execute);
    const preview = await opencode.execute(
      { query: "detail sentence", scope: "session" },
      context,
    );
    expect(preview).toContain(markers[0]);
    expect(preview).not.toContain(markers[1]);
    const ref = preview.match(/detail ref: `([^`]+)`/)?.[1];
    expect(ref).toMatch(/^r:/);
    const detail = await opencode.execute({ id: ref }, context);
    expect(detail).toContain(markers[0]);
    expect(detail).not.toContain(markers[1]);
    const pi = createPiRecallTool(
      () => ({ projectPath: process.cwd(), sessionID }),
      clients[1]!.execute,
    );
    const piResult = await pi.execute(
      "call-1",
      { query: "detail sentence", scope: "session" },
      context.abort,
      undefined,
      {
        sessionManager: {
          getBranch: () => [
            {
              type: "message",
              id: "entry",
              message: {
                role: "assistant",
                provider: "anthropic",
                model: "model",
                timestamp: 1,
                content: [
                  { type: "toolCall", id: "call-1", name: "lore_recall" },
                ],
              },
            },
          ],
        },
      } as unknown as Parameters<typeof pi.execute>[4],
    );
    expect(JSON.stringify(piResult)).toContain(markers[1]);
    expect(JSON.stringify(piResult)).not.toContain(markers[0]);
    const wrongOwnerDetail = await clients[1]!.execute(
      { id: ref },
      { projectPath: process.cwd(), sessionID },
    );
    expect(wrongOwnerDetail).not.toContain(markers[0]);
  });

  test("the native endpoint uses data-plane access checks before reading its body", async () => {
    const app = createGatewayApp({
      ...loadConfig(),
      remoteGateway: true,
      gatewayAuthToken: "native-test-gateway-token-32-bytes-minimum",
    });
    for (const [headers, status] of [
      [{ origin: "https://untrusted.example" }, 403],
      [{ "x-api-key": "provider-key" }, 401],
    ] as const) {
      const response = await app.fetch(
        new Request("http://gateway/v1/recall", { method: "POST", headers }),
        { peerAddress: "192.0.2.1" },
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("allows keyless local provider sessions only on a local gateway's loopback connection", async () => {
    const marker = "keyless-native-session-memory";
    harness = await createHarness({
      fixtures: [
        makeFixtureEntry({
          seq: 0,
          model: DEFAULT_MODEL,
          requestMessages: [{ role: "user", content: marker }],
          responseText: "remembered",
          wasStreaming: false,
        }),
      ],
    });
    const headers = {
      "x-lore-session-id": "keyless-native-session",
      "x-lore-project": process.cwd(),
    };
    const chat = await harness.chat(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: "You are a coding assistant. ".repeat(30),
        messages: [{ role: "user", content: marker }],
      },
      null,
      headers,
    );
    expect(chat.status).toBe(200);
    await chat.text();
    const client = createGatewayRecallClient(harness.baseURL);
    client.observeRequestHeaders(new Headers(headers));
    expect(
      await client.execute(
        { query: marker, scope: "session" },
        { projectPath: process.cwd(), sessionID: "keyless-native-session" },
      ),
    ).toContain(marker);
    for (const [remoteGateway, peerAddress] of [
      [false, "192.0.2.1"],
      [true, "127.0.0.1"],
    ] as const) {
      const app = createGatewayApp({
        ...loadConfig(),
        remoteGateway,
        hostedMode: false,
      });
      const response = await app.fetch(
        new Request("http://gateway/v1/recall", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ query: marker, scope: "session" }),
        }),
        { peerAddress },
      );
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(marker);
    }
  });
});
