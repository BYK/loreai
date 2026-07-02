/**
 * Pipeline `/lore:*` slash-command coverage.
 *
 * Slash commands are intercepted in handleRequest (Case 0) and answered with
 * a synthetic response — no upstream call — so these run against the harness
 * with empty fixtures. This exercises the slash dispatcher + per-command
 * handlers + the synthetic-response builders (slashResponse →
 * nonStreamHttpResponse / streamHttpResponse), including the streaming SSE
 * wire path that the replay harness can't drive for normal turns.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { DEFAULT_MODEL } from "./helpers/fixtures";

function slashBody(command: string, stream = false): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 256,
    stream,
    messages: [{ role: "user", content: command }],
  };
}

async function textOf(resp: Response): Promise<string> {
  const body = (await resp.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  return body.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

describe("Pipeline — /lore:* slash commands", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("intercepts /lore:amnesia:on and :off without forwarding upstream", async () => {
    harness = await createHarness({ fixtures: [] });

    const on = await harness.chat(slashBody("/lore:amnesia:on"));
    expect(on.status).toBe(200);
    expect(await textOf(on)).toContain("Amnesia mode on");

    const off = await harness.chat(slashBody("/lore:amnesia:off"));
    expect(off.status).toBe(200);
    expect(await textOf(off)).toContain("Amnesia mode off");
  });

  it("handles /lore:warm:stop|keep|auto", async () => {
    harness = await createHarness({ fixtures: [] });

    expect(
      await textOf(await harness.chat(slashBody("/lore:warm:stop"))),
    ).toContain("Cache warming stopped");
    expect(
      await textOf(await harness.chat(slashBody("/lore:warm:keep"))),
    ).toContain("Keeping cache warm");
    expect(
      await textOf(await harness.chat(slashBody("/lore:warm:auto"))),
    ).toContain("Cache warming set to auto");
  });

  it("handles global /lore:warm:off and /lore:warm:on (persisted toggle)", async () => {
    const { isWarmingEnabled } = await import("../src/cache-warmer");
    harness = await createHarness({ fixtures: [] });

    const off = await harness.chat(slashBody("/lore:warm:off"));
    expect(off.status).toBe(200);
    expect(await textOf(off)).toContain("Cache warming disabled globally");
    expect(isWarmingEnabled()).toBe(false);

    const on = await harness.chat(slashBody("/lore:warm:on"));
    expect(on.status).toBe(200);
    expect(await textOf(on)).toContain("Cache warming enabled globally");
    expect(isWarmingEnabled()).toBe(true);
  });

  it("returns a helpful error for an unknown /lore:* command", async () => {
    harness = await createHarness({ fixtures: [] });

    const resp = await harness.chat(slashBody("/lore:bogus"));
    expect(resp.status).toBe(200);
    const text = await textOf(resp);
    expect(text).toContain("Unknown command");
    expect(text).toContain("/lore:curate");
  });

  it("intercepts /lore:curate (reports no active session when session-less)", async () => {
    // Without a known session header the curate handler can't resolve a
    // session, so it reports that rather than forwarding upstream. This still
    // covers the dispatcher + handleCurateSlashCommand entry path.
    harness = await createHarness({ fixtures: [] });

    const resp = await harness.chat(slashBody("/lore:curate"));
    expect(resp.status).toBe(200);
    expect(await textOf(resp)).toContain(
      "No active session found for curation",
    );
  });

  it("streams a slash-command response as Anthropic SSE", async () => {
    harness = await createHarness({ fixtures: [] });

    const resp = await harness.chat(slashBody("/lore:warm:stop", true));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const sse = await resp.text();
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("Cache warming stopped.");
    expect(sse).toContain("event: message_stop");
  });
});
