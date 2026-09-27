import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import {
  handleRequest,
  resetPipelineState,
  setUpstreamInterceptor,
} from "../src/pipeline";
import type { GatewayRequest } from "../src/translate/types";

const previousDataHome = process.env.XDG_DATA_HOME;
const directories: string[] = [];

afterEach(async () => {
  setUpstreamInterceptor(undefined);
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  await resetPipelineState({ fast: true });
});

it("saves the complete upstream 400 exchange while preserving the response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lore-400-dump-"));
  directories.push(directory);
  process.env.XDG_DATA_HOME = directory;
  const upstreamError = '{"detail":"Bad Request"}';
  let forwardedBody: unknown;
  setUpstreamInterceptor(async (body) => {
    forwardedBody = body;
    return new Response(upstreamError, {
      status: 400,
      headers: {
        "content-type": "application/json",
        "x-request-id": "test-400",
      },
    });
  });
  const request: GatewayRequest = {
    protocol: "openai-responses",
    model: "gpt-5.6-luna",
    system: "Generate a short title.",
    messages: [
      { role: "user", content: [{ type: "text", text: "private prompt" }] },
    ],
    tools: [],
    stream: false,
    maxTokens: 64,
    metadata: {},
    rawHeaders: { authorization: "Bearer private-credential" },
  };

  const response = await handleRequest(request, loadConfig());

  expect(response.status).toBe(400);
  expect(await response.text()).toBe(upstreamError);
  const dumpDir = join(directory, "lore", "upstream-400");
  const [filename] = readdirSync(dumpDir);
  if (!filename) throw new Error("missing upstream 400 capture");
  expect(filename).toMatch(/\.json$/);
  const path = join(dumpDir, filename);
  const dump = JSON.parse(readFileSync(path, "utf8"));
  expect(dump.request.body).toBe(JSON.stringify(forwardedBody));
  expect(dump.request.headers.Authorization).toBe("Bearer private-credential");
  expect(dump.response.body).toBe(upstreamError);
  expect(dump.response.headers["x-request-id"]).toBe("test-400");
  const second = await handleRequest(request, loadConfig());
  expect(second.status).toBe(400);
  expect(readdirSync(dumpDir)).toHaveLength(2);
  if (process.platform !== "win32") {
    expect(statSync(dumpDir).mode & 0o077).toBe(0);
    expect(statSync(path).mode & 0o077).toBe(0);
  }
});
