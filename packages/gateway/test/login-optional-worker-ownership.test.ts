import { afterEach, expect, test, vi } from "vitest";

type WorkerControl = {
  emit: (event: string, ...values: unknown[]) => boolean;
  stdout: { resume: ReturnType<typeof vi.fn> };
  stderr: { resume: ReturnType<typeof vi.fn> };
  unref: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  exit: () => void;
};
const h = vi.hoisted(() => ({ workers: [] as WorkerControl[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      stdout = { resume: vi.fn() };
      stderr = { resume: vi.fn() };
      unref = vi.fn();
      private termination = Promise.withResolvers<number>();
      terminate = vi.fn(() => this.termination.promise);
      exit = () => {
        this.emit("exit", 0);
        this.termination.resolve(0);
      };
      constructor() {
        super();
        h.workers.push(this);
      }
    },
  };
});
afterEach(() => {
  for (const worker of h.workers.splice(0)) worker.exit();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each(["deadline", "message", "error"] as const)(
  "%s settlement keeps capacity owned until an actual worker exit",
  async (settlement) => {
    vi.resetModules();
    vi.stubGlobal("__LORE_LOGIN_WORKER_SOURCE__", "fixture");
    vi.useFakeTimers();
    const { runOptionalLoginWorker } =
      await import("../src/cli/login-optional-worker");
    const start = () =>
      runOptionalLoginWorker(
        {
          user_id: "fixture-user",
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
        },
        { kind: "profile" },
        "fixture-revision",
      );
    const pending = Array.from({ length: 16 }, start);
    expect(h.workers).toHaveLength(16);
    if (settlement === "deadline") await vi.advanceTimersByTimeAsync(30_000);
    else
      for (const worker of h.workers)
        worker.emit(
          settlement,
          settlement === "message"
            ? { kind: "done" }
            : new Error("private-worker-sentinel"),
        );
    expect(await Promise.all(pending)).toEqual(Array(16).fill(undefined));
    for (const worker of h.workers) {
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(worker.unref).toHaveBeenCalledTimes(1);
      expect(worker.stdout.resume).toHaveBeenCalledTimes(1);
      expect(worker.stderr.resume).toHaveBeenCalledTimes(1);
    }
    const rejected = start();
    expect(h.workers).toHaveLength(16);
    expect(await rejected).toBeUndefined();
    // Termination promises are deliberately still pending. Only the exit event
    // releases ownership, admitting exactly one replacement worker.
    h.workers[0].exit();
    const replacement = start();
    expect(h.workers).toHaveLength(17);
    h.workers[16].emit("message", { kind: "done" });
    expect(await replacement).toBeUndefined();
    const replacementRejected = start();
    expect(h.workers).toHaveLength(17);
    expect(await replacementRejected).toBeUndefined();
  },
);
