/**
 * `x-lore-session-title` (#1921): the harness-provided session title is
 * decoded, sanitized and persisted as the session's explicit title — and the
 * header is stripped before any upstream forwarding.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LORE_SESSION_TITLE_HEADER,
  parseHarnessSessionTitle,
} from "../src/session-title-header";
import { forwardClientHeaders } from "../src/translate/types";
import { setUpstreamInterceptor } from "../src/pipeline";
import { DEFAULT_MODEL, DEFAULT_SYSTEM } from "./helpers/fixtures";
import { createHarness, type Harness } from "./helpers/harness";

describe("parseHarnessSessionTitle", () => {
  it("decodes percent-encoded unicode titles", () => {
    expect(
      parseHarnessSessionTitle(encodeURIComponent("Fix the Ünïcode bug")),
    ).toBe("Fix the Ünïcode bug");
  });

  it("trims surrounding whitespace", () => {
    expect(parseHarnessSessionTitle("My%20Task%20%20")).toBe("My Task");
  });

  it("rejects absent, empty and whitespace-only values", () => {
    expect(parseHarnessSessionTitle(undefined)).toBeNull();
    expect(parseHarnessSessionTitle("")).toBeNull();
    expect(parseHarnessSessionTitle("%20%20")).toBeNull();
  });

  it("rejects malformed percent-encoding instead of throwing", () => {
    expect(parseHarnessSessionTitle("%E0%A4%A")).toBeNull();
  });

  it("caps at 512 characters", () => {
    const title = "x".repeat(600);
    expect(parseHarnessSessionTitle(title)).toBe("x".repeat(512));
  });

  it("rejects OpenCode's auto placeholder, case-insensitively", () => {
    expect(
      parseHarnessSessionTitle(encodeURIComponent("New session - 2026-09-27")),
    ).toBeNull();
    expect(parseHarnessSessionTitle("NEW%20SESSION")).toBeNull();
  });

  it("accepts a normal title", () => {
    expect(parseHarnessSessionTitle("My%20Task")).toBe("My Task");
  });
});

describe("upstream forwarding", () => {
  it("strips x-lore-session-title from client headers", () => {
    const forwarded = forwardClientHeaders({
      [LORE_SESSION_TITLE_HEADER]: "My%20Task",
      "x-custom-header": "keep-me",
    });
    expect(forwarded[LORE_SESSION_TITLE_HEADER]).toBeUndefined();
    expect(forwarded["x-custom-header"]).toBe("keep-me");
  });
});

describe("pipeline consumption", () => {
  let harness: Harness;
  let capturedBodies: unknown[];

  beforeAll(async () => {
    harness = await createHarness({
      fixtures: [],
      projectPath: mkdtempSync(join(tmpdir(), "lore-title-hdr-")),
    });
  });

  beforeEach(() => {
    capturedBodies = [];
    setUpstreamInterceptor(async (body) => {
      capturedBodies.push(body);
      return new Response(
        JSON.stringify({
          id: "msg_title",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: DEFAULT_MODEL,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  });

  afterEach(() => {
    setUpstreamInterceptor(undefined);
  });

  afterAll(async () => {
    await harness.teardown();
  });

  const chat = (extraHeaders: Record<string, string>) =>
    harness.chat(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        stream: false,
        system: DEFAULT_SYSTEM,
        messages: [{ role: "user", content: "hello" }],
      },
      "test-key",
      extraHeaders,
    );

  it("persists the harness title as the session's explicit title", async () => {
    const resp = await chat({
      "x-lore-session-id": "title-session",
      [LORE_SESSION_TITLE_HEADER]: "My%20Task",
    });
    expect(resp.status, await resp.text()).toBe(200);

    // The gateway remaps client session ids to its own lore session id, so
    // assert on the title itself rather than the client-supplied id.
    const rows = harness.queryDB<{ title: string }>(
      "SELECT title FROM session_state WHERE title IS NOT NULL",
    );
    expect(rows).toEqual([{ title: "My Task" }]);

    // And the management API reports it as an explicit title.
    const list = await (
      await harness.request(
        `/api/v1/projects/${encodeURIComponent(harness.queryDB<{ id: string }>("SELECT id FROM projects LIMIT 1")[0]?.id)}/sessions`,
      )
    ).json();
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "My Task",
          title_source: "explicit",
        }),
      ]),
    );
  });

  it("ignores placeholder and malformed values", async () => {
    const titlesBefore = harness.queryDB(
      "SELECT title FROM session_state WHERE title IS NOT NULL",
    );
    const resp = await chat({
      "x-lore-session-id": "placeholder-session",
      [LORE_SESSION_TITLE_HEADER]: encodeURIComponent("New session - 2026-09"),
    });
    expect(resp.status, await resp.text()).toBe(200);
    const bad = await chat({
      "x-lore-session-id": "malformed-session",
      [LORE_SESSION_TITLE_HEADER]: "%E0%A4%A",
    });
    expect(bad.status, await bad.text()).toBe(200);

    const rows = harness.queryDB<{ title: string | null }>(
      "SELECT title FROM session_state WHERE title IS NOT NULL",
    );
    expect(rows).toEqual(titlesBefore);
  });
});
