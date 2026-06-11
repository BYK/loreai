/**
 * Coverage for the explicit compaction endpoints (`POST /v1/compact`, used by
 * the Pi plugin). Focuses on the request-validation + no-session branches of
 * handleCompactEndpoint, which return deterministic responses without any
 * upstream call.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";

async function postCompact(baseURL: string, body: string): Promise<Response> {
  return fetch(`${baseURL}/v1/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /v1/compact", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("returns 400 on invalid JSON", async () => {
    harness = await createHarness({ fixtures: [] });
    const resp = await postCompact(harness.baseURL, "{ not json");
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toBe("Invalid JSON body");
  });

  it("returns 400 when project_path is missing", async () => {
    harness = await createHarness({ fixtures: [] });
    const resp = await postCompact(harness.baseURL, JSON.stringify({}));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("project_path is required");
  });

  it("returns 404 when no active session exists for the project", async () => {
    harness = await createHarness({ fixtures: [] });
    const resp = await postCompact(
      harness.baseURL,
      JSON.stringify({ project_path: process.cwd() }),
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string; message: string };
    expect(body.error).toBe("session_not_found");
    expect(body.message).toContain("No active session found");
  });
});
