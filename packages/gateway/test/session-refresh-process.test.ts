import { fork } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { getTeamConfig } from "@loreai/core";
import {
  clearSession,
  loadPersistedSession,
  persistSession,
} from "../src/supabase";

const child = fileURLToPath(
  new URL("./helpers/session-refresh-child.ts", import.meta.url),
);
const jwt = (exp: number) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify({ exp, sub: "test-user" })).toString(
      "base64url",
    ),
    "test-signature",
  ].join(".");

test("independent CLI/gateway processes rotate once and both use the refreshed session", async () => {
  clearSession();
  persistSession({
    access_token: jwt(1),
    refresh_token: "test-refresh-original",
    expires_at: 1,
    user_id: "test-user",
  });
  const generation = getTeamConfig("supabase.session.revision");
  let rotations = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    started = resolve;
  });
  const user = {
    id: "test-user",
    aud: "authenticated",
    email: "test@example.com",
    user_metadata: {},
    app_metadata: {},
  };
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/auth/v1/token")) {
        rotations++;
        started();
        await gate;
        res.end(
          JSON.stringify({
            access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
            refresh_token: "test-refresh-rotated",
            expires_in: 3600,
            token_type: "bearer",
            user,
          }),
        );
      } else if (req.url === "/auth/v1/user") {
        res.end(JSON.stringify(user));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    })().catch((error: unknown) =>
      res.destroy(
        error instanceof Error ? error : new Error("Test auth server failed"),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener");
  const run = () => {
    const childProcess = fork(child, [], {
      execArgv: ["--import", "tsx"],
      silent: true,
      timeout: 45_000,
      env: {
        ...process.env,
        SUPABASE_URL: `http://127.0.0.1:${address.port}`,
        SUPABASE_ANON_KEY: "test-publishable-key",
        NODE_ENV: "test",
        SENTRY_ENABLED: "0",
      },
    });
    const ready = new Promise<void>((resolve) =>
      childProcess.on("message", (message) => {
        if (message === "ready") resolve();
      }),
    );
    const attempted = new Promise<void>((resolve) =>
      childProcess.on("message", (message) => {
        if (message === "attempted") resolve();
      }),
    );
    let stdout = "";
    let stderr = "";
    childProcess.stdout!.on("data", (data) => {
      stdout += String(data);
    });
    childProcess.stderr!.on("data", (data) => {
      stderr += String(data);
    });
    const result = new Promise<string>((resolve, reject) => {
      childProcess.on("error", reject);
      childProcess.on("exit", (code, signal) =>
        code === 0
          ? resolve(stdout)
          : reject(
              new Error(
                `Test child failed (code=${code}, signal=${signal}): ${stderr}`,
              ),
            ),
      );
    });
    // Observe failures immediately even while the parent awaits readiness.
    void result.catch(() => {});
    return {
      ready,
      attempted,
      result,
      start: () => childProcess.send("run"),
      stop: () => {
        if (childProcess.exitCode === null) childProcess.kill();
      },
    };
  };
  const first = run();
  const second = run();
  try {
    await Promise.all([
      Promise.race([first.ready, first.result]),
      Promise.race([second.ready, second.result]),
    ]);
    first.start();
    await Promise.race([firstRequest, first.result]);
    second.start();
    // Both coordinators have started against the old snapshot, before rotation.
    await Promise.race([second.attempted, second.result]);
    release();
    const results = await Promise.all([first.result, second.result]);
    expect(results.map((result) => JSON.parse(result.trim()))).toEqual([
      { user_id: "test-user" },
      { user_id: "test-user" },
    ]);
    expect(rotations).toBe(1);
    expect(loadPersistedSession()?.refresh_token).toBe("test-refresh-rotated");
    expect(getTeamConfig("supabase.session.revision")).toBe(generation);
    expect(getTeamConfig("supabase.refresh.lease")).toBeNull();
  } finally {
    release();
    first.stop();
    second.stop();
    await Promise.allSettled([first.result, second.result]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearSession();
  }
}, 60_000);
