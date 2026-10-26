import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  persistSession: vi.fn(),
  updateSessionProfile: vi.fn(),
  captureLoginRevision: vi.fn(),
  requestIsHosted: vi.fn(),
  signals: [] as Array<(() => AbortSignal | undefined) | undefined>,
}));

vi.mock("../src/supabase", () => ({
  createSupabaseClient: (signal?: () => AbortSignal | undefined) => {
    h.signals.push(signal);
    return { auth: h };
  },
  captureLoginRevision: h.captureLoginRevision,
  persistSession: h.persistSession,
  updateSessionProfile: h.updateSessionProfile,
  sessionToPersisted: (session: unknown) => session,
}));
vi.mock("../src/folk-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/folk-access")>()),
  requestIsHosted: h.requestIsHosted,
}));

import { handleWebLoginRequest } from "../src/web-login";
import { loadConfig } from "../src/config";

const config = loadConfig();
function post(path: string, body: unknown) {
  const url = new URL(`http://127.0.0.1:1234${path}`);
  return handleWebLoginRequest(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    config,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  h.signals.length = 0;
  h.captureLoginRevision.mockReturnValue("revision-a");
  h.updateSessionProfile.mockReturnValue({ user_id: "user" });
  h.signInWithOtp.mockResolvedValue({ error: null });
  h.verifyOtp.mockResolvedValue({
    data: {
      session: { user_id: "user", user: { email: "person@example.com" } },
    },
    error: null,
  });
  h.signInWithOAuth.mockResolvedValue({
    data: { url: "https://auth.example/authorize" },
    error: null,
  });
  h.exchangeCodeForSession.mockResolvedValue({
    data: { session: { user_id: "user" } },
    error: null,
  });
});

describe("web login", () => {
  test("an unrelated callback leaves the live GitHub attempt cancellable", async () => {
    const start = await post("/api/v1/account/login/github", {});
    const { attempt } = await start!.json();
    const callback = new URL(
      h.signInWithOAuth.mock.calls[0][0].options.redirectTo,
    );
    callback.searchParams.set("code", "oauth-code");
    const unrelated = new URL(callback);
    unrelated.searchParams.set("attempt", "old-attempt");
    expect(
      (
        await handleWebLoginRequest(new Request(unrelated), unrelated, config)
      )?.headers.get("location"),
    ).toBe("/ui?login=failed");
    expect(h.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(
      await (await post("/api/v1/account/login/cancel", { attempt }))!.json(),
    ).toEqual({ ok: true });
    await handleWebLoginRequest(new Request(callback), callback, config);
    expect(h.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  test("rejects empty body chunks and retains capacity until cancellation settles", async () => {
    const releases: Array<() => void> = [];
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const url = new URL("http://127.0.0.1:1234/api/v1/account/login/cancel");
    const results: Array<Promise<Response | null>> = [];
    try {
      for (let i = 0; i < 16; i++) {
        const body = new ReadableStream({
          start(stream) {
            stream.enqueue(new Uint8Array());
          },
          cancel,
        });
        results.push(
          handleWebLoginRequest(
            new Request(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
              duplex: "half",
            } as RequestInit),
            url,
            config,
          ),
        );
      }
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(16), {
        timeout: 500,
      });
      expect(
        (await Promise.all(results)).map((response) => response?.status),
      ).toEqual(Array(16).fill(400));
      expect((await post("/api/v1/account/login/cancel", {}))?.status).toBe(
        400,
      );
    } finally {
      for (const release of releases) release();
      await Promise.all(results);
    }
    await vi.waitFor(async () =>
      expect((await post("/api/v1/account/login/cancel", {}))?.status).toBe(
        200,
      ),
    );
  });
  test("held body cancellation keeps capacity until cleanup settles", async () => {
    const cancellations: Array<() => void> = [];
    const controllers: AbortController[] = [];
    const responses: Array<ReturnType<typeof handleWebLoginRequest>> = [];
    const pull = vi.fn();
    try {
      for (let i = 0; i < 16; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        const url = new URL(
          "http://127.0.0.1:1234/api/v1/account/login/cancel",
        );
        const body = new ReadableStream({
          pull,
          cancel: () =>
            new Promise<void>((resolve) => cancellations.push(resolve)),
        });
        responses.push(
          handleWebLoginRequest(
            new Request(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
              signal: controller.signal,
              duplex: "half",
            } as RequestInit),
            url,
            config,
          ),
        );
      }
      await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(16));
      for (const controller of controllers) controller.abort();
      await Promise.all(responses);
      expect(cancellations).toHaveLength(16);
      expect((await post("/api/v1/account/login/cancel", {}))?.status).toBe(
        400,
      );
    } finally {
      for (const resolve of cancellations) resolve();
    }
    await vi.waitFor(async () => {
      expect((await post("/api/v1/account/login/cancel", {}))?.status).toBe(
        200,
      );
    });
  });
  test.each(["email", "github"])(
    "%s completion checks abort immediately before commit",
    async (kind) => {
      const started = await post(
        `/api/v1/account/login/${kind}`,
        kind === "email" ? { email: "person@example.com" } : {},
      );
      const { attempt } = await started!.json();
      const controller = new AbortController();
      const url = new URL(
        kind === "email"
          ? "http://127.0.0.1:1234/api/v1/account/login/verify"
          : `http://127.0.0.1:1234/api/v1/account/login/callback?attempt=${attempt}&code=example`,
      );
      const request =
        kind === "email"
          ? new Request(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ attempt, code: "123456" }),
              signal: controller.signal,
            })
          : new Request(url, { signal: controller.signal });
      const original = AbortSignal.prototype.removeEventListener;
      let restore = () => {};
      const install = () => {
        const removal = vi
          .spyOn(AbortSignal.prototype, "removeEventListener")
          .mockImplementation(
            function (this: AbortSignal, type, listener, options) {
              original.call(this, type, listener, options);
              if (type === "abort") controller.abort();
            },
          );
        restore = () => removal.mockRestore();
        return Promise.resolve({
          data: {
            session: { user_id: "user", user: { email: "person@example.com" } },
          },
          error: null,
        });
      };
      (kind === "email"
        ? h.verifyOtp
        : h.exchangeCodeForSession
      ).mockImplementationOnce(install);
      try {
        const response = await handleWebLoginRequest(request, url, config);
        expect(controller.signal.aborted).toBe(true);
        expect(h.persistSession).not.toHaveBeenCalled();
        if (kind === "email") expect(response?.status).toBe(400);
        else
          expect(response?.headers.get("location")).toBe(
            `/ui?login=failed&login_attempt=${attempt}`,
          );
      } finally {
        restore();
      }
    },
  );
  test.each(["disconnect", "timeout"])(
    "a %s during verification requires a new email and cannot persist late",
    async (reason) => {
      const start = await post("/api/v1/account/login/email", {
        email: "person@example.com",
      });
      const { attempt } = await start!.json();
      let release!: (value: unknown) => void;
      h.verifyOtp.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const url = new URL("http://127.0.0.1:1234/api/v1/account/login/verify");
      const controller = new AbortController();
      const timeout = new AbortController();
      const timeoutSpy = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(timeout.signal);
      try {
        const result = handleWebLoginRequest(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ attempt, code: "123456" }),
            signal: controller.signal,
          }),
          url,
          config,
        );
        await vi.waitFor(() => expect(h.verifyOtp).toHaveBeenCalledOnce());
        if (reason === "disconnect") controller.abort();
        else timeout.abort();
        const failed = await result;
        expect((await failed!.json()).error.message).toContain(
          "Request a new email",
        );
        timeoutSpy.mockRestore();
        release({
          data: {
            session: { user_id: "user", user: { email: "person@example.com" } },
          },
          error: null,
        });
        await Promise.resolve();
        expect(h.persistSession).not.toHaveBeenCalled();
        expect(
          (
            await post("/api/v1/account/login/verify", {
              attempt,
              code: "123456",
            })
          )?.status,
        ).toBe(400);
        expect(
          (
            await post("/api/v1/account/login/email", {
              email: "person@example.com",
            })
          )?.status,
        ).toBe(200);
      } finally {
        timeoutSpy.mockRestore();
        release?.({ data: { session: null }, error: new Error("cancelled") });
      }
    },
  );
  test("disconnect aborts an in-flight sign-in", async () => {
    let release!: () => void;
    h.signInWithOtp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ error: null });
        }),
    );
    const url = new URL("http://127.0.0.1:1234/api/v1/account/login/email");
    const controller = new AbortController();
    const result = handleWebLoginRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com" }),
        signal: controller.signal,
      }),
      url,
      config,
    );
    await vi.waitFor(() => expect(h.signInWithOtp).toHaveBeenCalledOnce());
    const signal = h.signals[0]?.();
    try {
      controller.abort();
      expect(signal?.aborted).toBe(true);
      expect((await result)?.status).toBe(409);
    } finally {
      release();
    }
  });
  test("supersession aborts the in-flight client signal", async () => {
    let release!: () => void;
    h.signInWithOtp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ error: null });
        }),
    );
    const previous = post("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    await vi.waitFor(() => expect(h.signInWithOtp).toHaveBeenCalledOnce());
    const signal = h.signals[0]?.();
    expect(signal?.aborted).toBe(false);
    try {
      await post("/api/v1/account/login/email", {
        email: "person@example.com",
      });
      expect(signal?.aborted).toBe(true);
      expect((await previous)?.status).toBe(409);
    } finally {
      release();
    }
  });
  test("bounds superseded operations until their underlying work settles", async () => {
    const releases: Array<() => void> = [];
    const requests: Array<ReturnType<typeof post>> = [];
    h.signInWithOtp.mockImplementation(
      () =>
        new Promise((resolve) => releases.push(() => resolve({ error: null }))),
    );
    try {
      for (let i = 0; i < 16; i++) {
        requests.push(
          post("/api/v1/account/login/email", { email: "person@example.com" }),
        );
        await vi.waitFor(() =>
          expect(h.signInWithOtp).toHaveBeenCalledTimes(i + 1),
        );
      }
      const overflowing = post("/api/v1/account/login/email", {
        email: "person@example.com",
      });
      requests.push(overflowing);
      const overflow = await Promise.race([
        overflowing,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      expect(overflow?.status).toBe(409);
      expect(h.signInWithOtp).toHaveBeenCalledTimes(16);
    } finally {
      for (const release of releases) release();
      await Promise.all(requests);
    }
  });
  test.each(["http://[::1]:4321", "http://127.0.0.2:4321"])(
    "GitHub callback preserves loopback origin %s",
    async (origin) => {
      const url = new URL("http://127.0.0.1:1234/api/v1/account/login/github");
      const response = await handleWebLoginRequest(
        new Request(url, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: "{}",
        }),
        url,
        config,
      );
      expect(response?.status).toBe(200);
      const callback = new URL(
        h.signInWithOAuth.mock.calls[0][0].options.redirectTo,
      );
      expect(callback.origin).toBe(origin);
    },
  );
  test.each(["email", "github"])(
    "a superseded %s start never reports success",
    async (kind) => {
      let release!: (result: unknown) => void;
      const operation = kind === "email" ? h.signInWithOtp : h.signInWithOAuth;
      operation.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const older = post(
        `/api/v1/account/login/${kind}`,
        kind === "email" ? { email: "old@example.com" } : {},
      );
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
      const newer = await post("/api/v1/account/login/email", {
        email: "person@example.com",
      });
      expect(newer?.status).toBe(200);
      const { attempt } = await newer!.json();
      release(
        kind === "email"
          ? { error: null }
          : { data: { url: "https://auth.example" }, error: null },
      );
      expect((await older)?.status).toBe(409);
      expect(
        (
          await post("/api/v1/account/login/verify", {
            attempt,
            code: "123456",
          })
        )?.status,
      ).toBe(200);
    },
  );
  test("a delayed older request cannot supersede a newer login", async () => {
    const url = new URL("http://127.0.0.1:1234/api/v1/account/login/email");
    const cancel = vi.fn();
    const body = new ReadableStream({
      cancel,
    });
    const older = handleWebLoginRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
      url,
      config,
    );
    const newer = await post("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    expect(newer?.status).toBe(200);
    const { attempt } = await newer!.json();
    expect((await older)?.status).toBe(409);
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      (await post("/api/v1/account/login/verify", { attempt, code: "123456" }))
        ?.status,
    ).toBe(200);
  });

  test("GitHub start returns its attempt for cancellation", async () => {
    const start = await post("/api/v1/account/login/github", {});
    const { attempt } = await start!.json();
    expect(attempt).toBeTruthy();
    const callback = new URL(
      h.signInWithOAuth.mock.calls[0][0].options.redirectTo,
    );
    await post("/api/v1/account/login/cancel", { attempt });
    callback.searchParams.set("code", "oauth-code");
    const response = await handleWebLoginRequest(
      new Request(callback),
      callback,
      config,
    );
    expect(response?.headers.get("location")).toBe("/ui?login=failed");
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  test("sends a code and persists only the session belonging to the pending attempt", async () => {
    const start = await post("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    expect(start?.status).toBe(200);
    const { attempt } = await start!.json();
    const finish = await post("/api/v1/account/login/verify", {
      attempt,
      code: "123456",
    });
    expect(finish?.status).toBe(200);
    expect(h.verifyOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      token: "123456",
      type: "email",
    });
    expect(h.persistSession).toHaveBeenCalledWith(
      { user_id: "user", user: { email: "person@example.com" } },
      "revision-a",
    );
    expect(
      (await post("/api/v1/account/login/verify", { attempt, code: "123456" }))
        ?.status,
    ).toBe(400);
  });

  test("hosted requests cannot start or finish local-account login", async () => {
    const start = await post("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    const { attempt } = await start!.json();
    h.signInWithOtp.mockClear();
    h.requestIsHosted.mockReturnValue(true);
    expect(
      (
        await post("/api/v1/account/login/email", {
          email: "person@example.com",
        })
      )?.status,
    ).toBe(403);
    expect(h.signInWithOtp).not.toHaveBeenCalled();
    expect(
      (await post("/api/v1/account/login/verify", { attempt, code: "123456" }))
        ?.status,
    ).toBe(403);
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  test("GitHub callback exchanges the code once and fences session persistence", async () => {
    const start = await post("/api/v1/account/login/github", {});
    expect(start?.status).toBe(200);
    const options = h.signInWithOAuth.mock.calls[0][0].options;
    const callback = new URL(options.redirectTo);
    expect(callback.origin).toBe("http://127.0.0.1:1234");
    callback.searchParams.set("code", "oauth-code");
    const response = await handleWebLoginRequest(
      new Request(callback),
      callback,
      config,
    );
    expect(response?.headers.get("location")).toBe(
      `/ui?login=success&login_attempt=${callback.searchParams.get("attempt")}`,
    );
    expect(h.exchangeCodeForSession).toHaveBeenCalledWith("oauth-code");
    expect(h.persistSession).toHaveBeenCalledWith(
      { user_id: "user" },
      "revision-a",
    );
    const replay = await handleWebLoginRequest(
      new Request(callback),
      callback,
      config,
    );
    expect(replay?.headers.get("location")).toBe(
      `/ui?login=failed&login_attempt=${callback.searchParams.get("attempt")}`,
    );
    expect(h.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  test("uses the browser's loopback host and forwarded port for the GitHub callback", async () => {
    const url = new URL("http://127.0.0.1:1234/api/v1/account/login/github");
    const response = await handleWebLoginRequest(
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5678",
        },
        body: "{}",
      }),
      url,
      config,
    );
    expect(response?.status).toBe(200);
    expect(
      new URL(h.signInWithOAuth.mock.calls[0][0].options.redirectTo).origin,
    ).toBe("http://localhost:5678");
  });

  test("a changed login revision rejects a late callback", async () => {
    await post("/api/v1/account/login/github", {});
    const callback = new URL(
      h.signInWithOAuth.mock.calls[0][0].options.redirectTo,
    );
    callback.searchParams.set("code", "oauth-code");
    h.persistSession.mockImplementation(() => {
      throw new Error("revision changed");
    });
    const result = await handleWebLoginRequest(
      new Request(callback),
      callback,
      config,
    );
    expect(result?.headers.get("location")).toBe(
      `/ui?login=failed&login_attempt=${callback.searchParams.get("attempt")}`,
    );
  });

  test("a superseding attempt prevents an in-flight verification from signing in", async () => {
    const start = await post("/api/v1/account/login/email", {
      email: "a@example.com",
    });
    const { attempt } = await start!.json();
    let finish!: (value: unknown) => void;
    h.verifyOtp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = post("/api/v1/account/login/verify", {
      attempt,
      code: "123456",
    });
    await vi.waitFor(() => expect(h.verifyOtp).toHaveBeenCalled());
    await post("/api/v1/account/login/email", { email: "b@example.com" });
    finish({
      data: { session: { user_id: "a", user: { email: "a@example.com" } } },
      error: null,
    });
    expect((await first)?.status).toBe(400);
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  test("canceling an attempt prevents a pending verification from signing in", async () => {
    const start = await post("/api/v1/account/login/email", {
      email: "a@example.com",
    });
    const { attempt } = await start!.json();
    let finish!: (value: unknown) => void;
    h.verifyOtp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = post("/api/v1/account/login/verify", {
      attempt,
      code: "123456",
    });
    await vi.waitFor(() => expect(h.verifyOtp).toHaveBeenCalled());
    expect(
      (await post("/api/v1/account/login/cancel", { attempt }))?.status,
    ).toBe(200);
    finish({
      data: { session: { user_id: "a", user: { email: "a@example.com" } } },
      error: null,
    });
    expect((await first)?.status).toBe(400);
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  test("rejects a link that authenticates a different email", async () => {
    const start = await post("/api/v1/account/login/email", {
      email: "a@example.com",
    });
    const { attempt } = await start!.json();
    h.verifyOtp.mockResolvedValue({
      data: { session: { user_id: "b", user: { email: "b@example.com" } } },
      error: null,
    });
    const result = await post("/api/v1/account/login/verify", {
      attempt,
      code: "https://auth.example/verify?token=hash&type=magiclink",
    });
    expect(result?.status).toBe(400);
    expect(h.persistSession).not.toHaveBeenCalled();
  });
});
