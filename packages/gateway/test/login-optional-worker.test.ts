import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

let server: Server;
let base: string;
const sockets = new Set<Socket>();
let requests: Array<{ path: string; body: string; authorization?: string }> =
  [];
let stall: "headers" | "body" | undefined;
let redirect = false;
let entered: (() => void) | undefined;
let revision: string;
let holdRefresh: ((respond: () => void) => void) | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        body,
        authorization: req.headers.authorization,
      });
      if (req.url?.startsWith("/auth/v1/token")) {
        const respond = () => {
          if (res.writableEnded) return;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              token_type: "bearer",
              expires_in: 3600,
              user: {
                id: "user-test",
                email: "user@example.test",
                user_metadata: {},
                app_metadata: {},
                aud: "authenticated",
                created_at: "2026-01-01T00:00:00Z",
              },
            }),
          );
        };
        if (holdRefresh) holdRefresh(respond);
        else respond();
        return;
      }
      if (redirect) {
        res.writeHead(307, { location: "/redirected" });
        res.end();
        return;
      }
      if (stall) {
        if (stall === "body") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"teams":');
        }
        entered?.();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        req.url?.startsWith("/rest/v1/profiles")
          ? JSON.stringify({
              email: "user@example.test",
              github_login: "octocat",
            })
          : JSON.stringify({ teams: 2 }),
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv("SUPABASE_URL", base);
  vi.stubEnv("SUPABASE_ANON_KEY", "fake-anon-key");
  const { persistSession } = await import("../src/supabase");
  revision = persistSession(session);
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  vi.unstubAllEnvs();
});

const session = {
  user_id: "user-test",
  access_token: "fake-access-token",
  refresh_token: "fake-refresh-token",
};

test("cold source workers return profile and provisioning results without a loader cache", async () => {
  const { runOptionalLoginWorker } =
    await import("../src/cli/login-optional-worker");
  const previousCacheSetting = process.env.TSX_DISABLE_CACHE;
  // A warm tsx cache hides the memory cost of transforming the built core
  // barrel. CI starts cold, so exercise that path without relying on host caches.
  vi.stubEnv("TSX_DISABLE_CACHE", "1");
  try {
    expect(
      await runOptionalLoginWorker(session, { kind: "profile" }, revision),
    ).toEqual({
      kind: "profile",
      profile: { email: "user@example.test", github_login: "octocat" },
    });
    expect(
      await runOptionalLoginWorker(
        session,
        { kind: "provision", providerToken: "fake-provider-token" },
        revision,
      ),
    ).toEqual({ kind: "provision", teams: 2 });
  } finally {
    vi.stubEnv("TSX_DISABLE_CACHE", previousCacheSetting);
  }
});

test("real worker uses the account token and returns bounded profile and provisioning results", async () => {
  const { runOptionalLoginWorker } =
    await import("../src/cli/login-optional-worker");
  requests = [];
  expect(
    await runOptionalLoginWorker(session, { kind: "profile" }, revision),
  ).toEqual({
    kind: "profile",
    profile: { email: "user@example.test", github_login: "octocat" },
  });
  expect(
    await runOptionalLoginWorker(
      session,
      {
        kind: "provision",
        providerToken: "fake-provider-token",
      },
      revision,
    ),
  ).toEqual({ kind: "provision", teams: 2 });
  expect(requests).toHaveLength(2);
  const profileUrl = new URL(requests[0].path, base);
  expect(profileUrl.pathname).toBe("/rest/v1/profiles");
  expect(profileUrl.searchParams.get("id")).toBe("eq.user-test");
  expect(requests[0].authorization).toBe("Bearer fake-access-token");
  expect(requests[1].path).toBe("/functions/v1/github-provision");
  expect(JSON.parse(requests[1].body)).toEqual({
    provider_token: "fake-provider-token",
  });
});

test("worker never forwards the provider token on redirects", async () => {
  const { runOptionalLoginWorker } =
    await import("../src/cli/login-optional-worker");
  requests = [];
  redirect = true;
  try {
    expect(
      await runOptionalLoginWorker(
        session,
        {
          kind: "provision",
          providerToken: "fake-provider-token",
        },
        revision,
      ),
    ).toBeUndefined();
    expect(requests.map((request) => request.path)).toEqual([
      "/functions/v1/github-provision",
    ]);
  } finally {
    redirect = false;
  }
});

test("worker uses a same-generation token rotation before dispatch", async () => {
  const { setTeamConfig } = await import("@loreai/core");
  const { runOptionalLoginWorker } =
    await import("../src/cli/login-optional-worker");
  setTeamConfig(
    "supabase.session",
    JSON.stringify({ ...session, access_token: "newer-access" }),
  );
  requests = [];
  try {
    await runOptionalLoginWorker(session, { kind: "profile" }, revision);
    expect(requests[0]?.authorization).toBe("Bearer newer-access");
  } finally {
    setTeamConfig("supabase.session", JSON.stringify(session));
  }
});

test("worker refreshes a near-expiry session before dispatch", async () => {
  const { setTeamConfig } = await import("@loreai/core");
  const { runOptionalLoginWorker } =
    await import("../src/cli/login-optional-worker");
  setTeamConfig(
    "supabase.session",
    JSON.stringify({
      ...session,
      expires_at: Math.floor(Date.now() / 1000) + 1,
    }),
  );
  requests = [];
  try {
    await runOptionalLoginWorker(session, { kind: "profile" }, revision);
    expect(requests.map((request) => request.path.split("?")[0])).toEqual([
      "/auth/v1/token",
      "/rest/v1/profiles",
    ]);
    expect(requests[1].authorization).toBe("Bearer rotated-access");
  } finally {
    setTeamConfig("supabase.session", JSON.stringify(session));
  }
});

test("account switch during refresh prevents later worker dispatch", async () => {
  const { setTeamConfig } = await import("@loreai/core");
  const { persistSession } = await import("../src/supabase");
  const { runOptionalLoginWorker } =
    await import("../src/cli/login-optional-worker");
  setTeamConfig(
    "supabase.session",
    JSON.stringify({
      ...session,
      expires_at: Math.floor(Date.now() / 1000) + 1,
    }),
  );
  requests = [];
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  holdRefresh = (respond) => {
    release = respond;
    started();
  };
  try {
    const pending = runOptionalLoginWorker(
      session,
      { kind: "provision", providerToken: "fake-provider-token" },
      revision,
    );
    await entered;
    persistSession({ ...session, user_id: "user-b" });
    release();
    expect(await pending).toBeUndefined();
    expect(requests.map((request) => request.path.split("?")[0])).toEqual([
      "/auth/v1/token",
    ]);
  } finally {
    holdRefresh = undefined;
    release?.();
    revision = persistSession(session);
  }
});

test("base paths cannot redirect worker credentials to another origin", async () => {
  const received: string[] = [];
  const other = createServer((req, res) => {
    received.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  try {
    const port = (other.address() as AddressInfo).port;
    vi.stubEnv("SUPABASE_URL", `${base}//127.0.0.1:${port}`);
    vi.resetModules();
    const { runOptionalLoginWorker } =
      await import("../src/cli/login-optional-worker");
    requests = [];
    await runOptionalLoginWorker(session, { kind: "profile" }, revision);
    await runOptionalLoginWorker(
      session,
      {
        kind: "provision",
        providerToken: "fake-provider-token",
      },
      revision,
    );
    expect(received).toEqual([]);
    expect(requests.map((item) => item.path.split("?")[0])).toEqual([
      `//127.0.0.1:${port}/rest/v1/profiles`,
      `//127.0.0.1:${port}/functions/v1/github-provision`,
    ]);
  } finally {
    vi.stubEnv("SUPABASE_URL", base);
    vi.resetModules();
    other.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      other.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("worker retains a normal non-root Supabase base path", async () => {
  vi.stubEnv("SUPABASE_URL", `${base}/prefix`);
  vi.resetModules();
  try {
    const { runOptionalLoginWorker } =
      await import("../src/cli/login-optional-worker");
    requests = [];
    await runOptionalLoginWorker(session, { kind: "profile" }, revision);
    await runOptionalLoginWorker(
      session,
      {
        kind: "provision",
        providerToken: "fake-provider-token",
      },
      revision,
    );
    expect(requests.map((item) => item.path.split("?")[0])).toEqual([
      "/prefix/rest/v1/profiles",
      "/prefix/functions/v1/github-provision",
    ]);
  } finally {
    vi.stubEnv("SUPABASE_URL", base);
    vi.resetModules();
  }
});

test.each(["headers", "body"] as const)(
  "deadline terminates a worker stalled on response %s and permits later work",
  async (phase) => {
    const { runOptionalLoginWorker } =
      await import("../src/cli/login-optional-worker");
    stall = phase;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.useFakeTimers();
    try {
      const pending = runOptionalLoginWorker(
        session,
        { kind: "profile" },
        revision,
      );
      await started;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
      stall = undefined;
      entered = undefined;
    }
    await vi.waitFor(() => expect(sockets.size).toBe(0));
    expect(
      await runOptionalLoginWorker(session, { kind: "profile" }, revision),
    ).toMatchObject({ kind: "profile" });
  },
);

test("worker admission stays bounded until stalled workers are retired", async () => {
  // Give this saturation scenario its own worker registry; preceding tests may
  // still be observing asynchronous worker exits after their callers settle.
  vi.resetModules();
  const { runOptionalLoginWorker } =
    await import("../src/cli/login-optional-worker");
  const terminations: Array<Promise<number>> = [];
  const terminate = Worker.prototype.terminate;
  const terminationSpy = vi
    .spyOn(Worker.prototype, "terminate")
    .mockImplementation(function (this: Worker) {
      const exited = terminate.call(this);
      terminations.push(exited);
      return exited;
    });
  stall = "headers";
  vi.useFakeTimers();
  try {
    const pending: Array<ReturnType<typeof runOptionalLoginWorker>> = [];
    // Start each worker after the previous one enters its request. This avoids
    // making SQLite startup contention part of the capacity assertion.
    for (let count = 0; count < 16; count++) {
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const item = runOptionalLoginWorker(
        session,
        { kind: "profile" },
        revision,
      );
      pending.push(item);
      const admission = await Promise.race([
        started.then(() => true),
        item.then(() => false),
      ]);
      expect(admission, `only ${count} workers reached the server`).toBe(true);
    }
    expect(
      await runOptionalLoginWorker(session, { kind: "profile" }, revision),
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await Promise.all(pending)).toEqual(Array(16).fill(undefined));
    expect(terminations).toHaveLength(16);
  } finally {
    vi.useRealTimers();
    stall = undefined;
    entered = undefined;
    terminationSpy.mockRestore();
  }
  // A closed socket does not mean the worker has exited or released its slot.
  await Promise.all(terminations);
  await vi.waitFor(() => expect(sockets.size).toBe(0));
  expect(
    await runOptionalLoginWorker(session, { kind: "profile" }, revision),
  ).toMatchObject({ kind: "profile" });
});

test("a child process stays alive for the deadline and exits after a stalled request", async () => {
  stall = "headers";
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { runOptionalLoginWorker } from './packages/gateway/src/cli/login-optional-worker.ts';
    await runOptionalLoginWorker({ user_id: 'user-test', access_token: 'fake-access-token', refresh_token: 'fake-refresh-token' }, { kind: 'profile' }, ${JSON.stringify(revision)});
    console.log('worker deadline completed');
  `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SUPABASE_URL: base,
        SUPABASE_ANON_KEY: "fake-anon-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      exit.then((result) => {
        throw new Error(
          `Child exited before request: ${JSON.stringify(result)} ${output} ${errors}`,
        );
      }),
    ]);
    watchdog = setTimeout(() => child.kill(), 32_000);
    expect({ ...(await exit), output, errors }).toEqual({
      code: 0,
      signal: null,
      output: "worker deadline completed\n",
      errors: "",
    });
    expect(output).toContain("worker deadline completed");
  } finally {
    if (watchdog) clearTimeout(watchdog);
    child.kill();
    stall = undefined;
    entered = undefined;
  }
}, 45_000);
