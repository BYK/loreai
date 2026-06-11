/**
 * Tests for the fixture recorder/replayer (`src/recorder.ts`).
 *
 * Recording mode: intercepts upstream calls, appends a `FixtureEntry` NDJSON
 * line, and returns a reconstituted Response. Replay mode: serves stored
 * fixtures in sequence without ever touching upstream.
 */
import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startRecording,
  stopRecording,
  getRecordedInterceptor,
  getReplayInterceptor,
  type FixtureEntry,
} from "../src/recorder";

let tmpDir: string | null = null;

function makeFixturePath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "lore-recorder-test-"));
  return join(tmpDir, "fixtures.ndjson");
}

function readEntries(path: string): FixtureEntry[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureEntry);
}

/** Get the active recording interceptor, asserting it exists. */
function activeInterceptor() {
  const i = getRecordedInterceptor();
  expect(i).not.toBeNull();
  return i as NonNullable<typeof i>;
}

afterEach(() => {
  stopRecording();
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    tmpDir = null;
  }
});

describe("recorder — recording mode", () => {
  test("getRecordedInterceptor returns null when not recording", () => {
    stopRecording();
    expect(getRecordedInterceptor()).toBeNull();
  });

  test("records a JSON upstream call and reconstitutes the response", async () => {
    const path = makeFixturePath();
    startRecording(path);
    const interceptor = activeInterceptor();

    const requestBody = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    };
    const responseBody = { id: "resp_1", type: "message", content: [] };
    let calls = 0;
    const makeRealRequest = async () => {
      calls++;
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json", "x-custom": "v" },
      });
    };

    const out = await interceptor(requestBody, "m", false, makeRealRequest);

    // The real request is performed exactly once and the response is preserved.
    expect(calls).toBe(1);
    expect(out.status).toBe(200);
    expect(out.headers.get("x-custom")).toBe("v");
    expect(await out.json()).toEqual(responseBody);

    // A single fixture entry is appended with parsed request/response.
    const entries = readEntries(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(0);
    expect(entries[0].model).toBe("m");
    expect(entries[0].wasStreaming).toBe(false);
    expect(entries[0].request).toEqual(requestBody);
    expect(entries[0].response).toEqual(responseBody);
    expect(typeof entries[0].ts).toBe("number");
  });

  test("increments the sequence counter across calls", async () => {
    const path = makeFixturePath();
    startRecording(path);
    const interceptor = activeInterceptor();
    const thunk = (b: unknown) => async () =>
      new Response(JSON.stringify(b), { status: 200 });

    await interceptor({ q: 1 }, "m", true, thunk({ a: 1 }));
    await interceptor({ q: 2 }, "m", false, thunk({ a: 2 }));

    const entries = readEntries(path);
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(0);
    expect(entries[0].wasStreaming).toBe(true);
    expect(entries[1].seq).toBe(1);
    expect(entries[1].wasStreaming).toBe(false);
  });

  test("stores a non-JSON upstream body as a raw string", async () => {
    const path = makeFixturePath();
    startRecording(path);
    const interceptor = activeInterceptor();
    const raw = "event: message\ndata: not-json\n\n";

    const out = await interceptor(
      {},
      "m",
      true,
      async () => new Response(raw, { status: 200 }),
    );

    expect(await out.text()).toBe(raw);
    expect(readEntries(path)[0].response).toBe(raw);
  });

  test("startRecording resets the sequence counter", async () => {
    const path = makeFixturePath();
    startRecording(path);
    const i1 = activeInterceptor();
    await i1({}, "m", false, async () => new Response("{}", { status: 200 }));

    // Restart recording — counter should reset to 0.
    startRecording(path);
    const i2 = activeInterceptor();
    await i2({}, "m", false, async () => new Response("{}", { status: 200 }));

    const entries = readEntries(path);
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(0);
    expect(entries[1].seq).toBe(0);
  });

  test("stopRecording disables the interceptor", () => {
    startRecording(makeFixturePath());
    expect(getRecordedInterceptor()).not.toBeNull();
    stopRecording();
    expect(getRecordedInterceptor()).toBeNull();
  });
});

describe("recorder — replay mode", () => {
  const fixtures: FixtureEntry[] = [
    {
      seq: 0,
      ts: 1,
      request: { a: 1 },
      response: { id: "r0" },
      wasStreaming: false,
      model: "m0",
    },
    {
      seq: 1,
      ts: 2,
      request: { a: 2 },
      response: { id: "r1" },
      wasStreaming: true,
      model: "m1",
    },
  ];

  test("replays fixtures in sequence without calling makeRealRequest", async () => {
    const interceptor = getReplayInterceptor(fixtures);
    const throwThunk = async (): Promise<Response> => {
      throw new Error("upstream should not be called during replay");
    };

    const r0 = await interceptor({}, "m", false, throwThunk);
    expect(r0.status).toBe(200);
    expect(r0.headers.get("content-type")).toBe("application/json");
    expect(await r0.json()).toEqual({ id: "r0" });

    const r1 = await interceptor({}, "m", false, throwThunk);
    expect(await r1.json()).toEqual({ id: "r1" });
  });

  test("throws when fixtures are exhausted", async () => {
    const interceptor = getReplayInterceptor([fixtures[0]]);
    await interceptor({}, "m", false, async () => new Response("{}"));
    await expect(
      interceptor({}, "m", false, async () => new Response("{}")),
    ).rejects.toThrow(/Replay exhausted/);
  });
});
