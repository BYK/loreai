import { dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/harness";
import { DEFAULT_SYSTEM } from "./helpers/fixtures";
import { getActiveSessions, setUpstreamInterceptor } from "../src/pipeline";
import { buildOpenAIResponsesResponse } from "../src/translate/openai-responses";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

for (const incomplete of [false, true]) {
  it(`preserves current Codex quota during session header migration (incomplete=${incomplete})`, async () => {
    harness = await createHarness({ fixtures: [] });
    let calls = 0;
    const quotaEvents: Record<string, unknown>[] = [];
    setUpstreamInterceptor(async () => {
      calls++;
      const quota = {
        type: "codex.rate_limits",
        rate_limits: {
          primary: {
            used_percent: calls * 10,
            window_minutes: 300,
            reset_at: 2000000000,
          },
          secondary: {
            used_percent: calls * 20,
            window_minutes: 10080,
            reset_at: 2000100000,
          },
        },
      };
      quotaEvents.push(quota);
      const response = buildOpenAIResponsesResponse(
        {
          id: "resp_quota",
          model: "gpt-5",
          content: [{ type: "text", text: "Hello quota" }],
          stopReason: calls === 2 && incomplete ? "max_tokens" : "end_turn",
          usage: { inputTokens: 600000, outputTokens: 3 },
        },
        true,
      );
      return new Response(
        `event: codex.rate_limits\ndata: ${JSON.stringify(quota)}\n\n${await response.text()}`,
        {
          headers: {
            "content-type": "text/event-stream",
            "x-codex-primary-used-percent": String(calls * 10),
            "x-codex-secondary-reset-at": "2000100000",
          },
        },
      );
    });
    const projectPath = dirname(harness.dbPath);
    const request = {
      model: "gpt-5",
      stream: true,
      instructions: DEFAULT_SYSTEM + "\nWorking directory: " + projectPath,
      input: [{ role: "user", content: "Hello" }],
      tools: ["read", "write", "shell"].map((name) => ({
        type: "function",
        name,
        description: name,
        parameters: { type: "object", properties: {} },
      })),
    };
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer account-one",
      "x-lore-provider": "openai-codex",
      "x-lore-project": projectPath,
      "x-session-id": "codex-before-plugin",
    };
    const initial = await harness.request("/v1/codex/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    expect(initial.status).toBe(200);
    expect(await initial.text()).toContain("Hello quota");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getActiveSessions().size).toBe(1);

    const migrated = await harness.request("/v1/codex/responses", {
      method: "POST",
      headers: { ...headers, "x-lore-session-id": "codex-after-plugin" },
      body: JSON.stringify(request),
    });
    const body = await migrated.text();
    expect(migrated.status, body).toBe(200);
    expect(calls).toBe(2);
    expect(getActiveSessions().size).toBe(1);
    expect(migrated.headers.get("x-codex-primary-used-percent")).toBe("20");
    expect(migrated.headers.get("x-codex-secondary-reset-at")).toBe(
      "2000100000",
    );
    const events = body
      .split("\n\n")
      .filter((frame) => frame.startsWith("event: codex.rate_limits\n"))
      .map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
    expect(events).toEqual([quotaEvents[1]]);
    expect(body).toContain(
      incomplete ? "event: response.incomplete" : "event: response.completed",
    );
    expect(body).not.toContain('"input_tokens":600000');
  });
}
