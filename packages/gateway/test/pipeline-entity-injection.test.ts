/**
 * Pipeline known-entity injection (system[1]).
 *
 * Verifies that entities stored for the active project are injected into the
 * stable system block (system[1]) on turn 1 via entitiesForSession() +
 * formatForPrompt(), and that injection stays conservative: a repo owned by a
 * DIFFERENT project is NOT injected (that would re-introduce the cross-project
 * context leak repaired by DB migration 38 — such repos are discoverable on
 * demand via recall instead).
 *
 * The upstream interceptor captures the built Anthropic request body so the
 * test can assert on the system blocks the gateway actually sends upstream.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { DEFAULT_MODEL, DEFAULT_SYSTEM } from "./helpers/fixtures";
import { setUpstreamInterceptor } from "../src/pipeline";
import { entities, ensureProject } from "@loreai/core";

function makeBody(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
  };
}

interface Sink {
  body?: Record<string, unknown>;
}

/** Interceptor that records the upstream body and returns a canned reply. */
function captureInterceptor(sink: Sink) {
  return async (requestBody: unknown): Promise<Response> => {
    sink.body = requestBody as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "msg_capture",
        type: "message",
        role: "assistant",
        model: DEFAULT_MODEL,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

describe("Pipeline — known-entity injection (system[1])", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("injects current-project entities into system[1] on turn 1", async () => {
    harness = await createHarness({ fixtures: [] });

    const project = process.cwd(); // harness sends x-lore-project: process.cwd()
    ensureProject(project);
    entities.create({
      projectPath: project,
      entityType: "person",
      canonicalName: "ZephyrQuux",
    });

    const sink: Sink = {};
    setUpstreamInterceptor(captureInterceptor(sink));

    const resp = await harness.chat(makeBody("hello"));
    expect(resp.status).toBe(200);
    await resp.text();

    const sys = JSON.stringify(sink.body?.system ?? "");
    expect(sys).toContain("Known entities");
    expect(sys).toContain("ZephyrQuux");
    // Caveat line: agents must know the list is partial and recall covers more.
    expect(sys).toContain("Partial list");
    expect(sys).toContain("recall tool");
  });

  it("does NOT inject another project's repo entity (respects migration 38)", async () => {
    harness = await createHarness({ fixtures: [] });

    const project = process.cwd();
    ensureProject(project);
    // Give the current project at least one injectable entity so the block is
    // built — otherwise absence proves nothing.
    entities.create({
      projectPath: project,
      entityType: "person",
      canonicalName: "HomePerson",
    });

    const OTHER = "/tmp/lore-entity-inject-other";
    ensureProject(OTHER);
    entities.create({
      projectPath: OTHER,
      entityType: "repo",
      canonicalName: "OtherProjectRepoXYZ",
    });

    const sink: Sink = {};
    setUpstreamInterceptor(captureInterceptor(sink));

    const resp = await harness.chat(makeBody("hello"));
    expect(resp.status).toBe(200);
    await resp.text();

    const sys = JSON.stringify(sink.body?.system ?? "");
    expect(sys).toContain("Known entities"); // block was built
    expect(sys).not.toContain("OtherProjectRepoXYZ"); // but stayed conservative
  });
});
