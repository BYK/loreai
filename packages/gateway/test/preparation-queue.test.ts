import {
  currentTenantId,
  ReadPreparationUnavailableError,
  withTenant,
} from "@loreai/core";
import { afterEach, expect, test, vi } from "vitest";
import { PreparationQueue } from "../src/preparation-queue";

afterEach(() => vi.useRealTimers());

test("a retry joins work after the original request disconnects", async () => {
  const queue = new PreparationQueue(1, 2, 60_000);
  const caller = new AbortController();
  let finish!: (value: string) => void;
  const compute = vi.fn(
    () => new Promise<string>((resolve) => (finish = resolve)),
  );
  const first = queue.run("same-session", compute, caller.signal);
  await vi.waitFor(() => expect(compute).toHaveBeenCalledOnce());
  caller.abort(new DOMException("client left", "AbortError"));
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  const retry = queue.run("same-session", compute);
  finish("ready");
  await expect(retry).resolves.toBe("ready");
  expect(compute).toHaveBeenCalledOnce();
});

test("oversized completed work is delivered but not retained", async () => {
  const queue = new PreparationQueue(1, 2, 60_000, 5, 5_000);
  const compute = vi.fn(async () => "x".repeat(550_000));
  const first = await queue.run("large", compute);
  expect(first).toHaveLength(550_000);
  await queue.run("large", compute);
  expect(compute).toHaveBeenCalledTimes(2);
});

test("transient read pressure backs off within the owned job", async () => {
  const queue = new PreparationQueue(1, 2, 60_000, 10);
  let attempts = 0;
  const compute = vi.fn(async () => {
    if (++attempts === 1)
      throw new ReadPreparationUnavailableError("knowledge", "pressure");
    return "ready";
  });
  const original = new AbortController();
  const first = queue.run("session", compute, original.signal);
  await vi.waitFor(() => expect(compute).toHaveBeenCalledOnce());
  original.abort(new DOMException("deadline", "TimeoutError"));
  await expect(first).rejects.toMatchObject({ name: "TimeoutError" });
  await expect(queue.run("session", compute)).resolves.toBe("ready");
  expect(compute).toHaveBeenCalledTimes(2);
});

test("a bounded queue rejects excess sessions but drains when a slot frees", async () => {
  const queue = new PreparationQueue(1, 2, 60_000);
  let finish!: () => void;
  const first = queue.run(
    "one",
    () => new Promise<string>((resolve) => (finish = () => resolve("one"))),
  );
  const secondCompute = vi.fn(async () => "two");
  const second = queue.run("two", secondCompute);
  await expect(queue.run("three", async () => "three")).rejects.toMatchObject({
    phase: "context",
    reason: "pressure",
  });
  expect(secondCompute).not.toHaveBeenCalled();
  finish();
  await expect(first).resolves.toBe("one");
  await expect(second).resolves.toBe("two");
});

test("a live request displaces abandoned queued work at capacity", async () => {
  const queue = new PreparationQueue(1, 2, 60_000);
  let release!: () => void;
  const abandonedActive = new AbortController();
  const first = queue.run(
    "active",
    () => new Promise<void>((resolve) => (release = resolve)),
    abandonedActive.signal,
  );
  const abandonedWaiting = new AbortController();
  const oldCompute = vi.fn(async () => "old");
  const second = queue.run("queued", oldCompute, abandonedWaiting.signal);
  abandonedActive.abort(new DOMException("left", "AbortError"));
  abandonedWaiting.abort(new DOMException("left", "AbortError"));
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
  const live = queue.run(
    "new",
    async () => "available",
    new AbortController().signal,
  );
  release();
  await expect(live).resolves.toBe("available");
  expect(oldCompute).not.toHaveBeenCalled();
});

test("an abandoned queued job yields to a new live caller", async () => {
  const queue = new PreparationQueue(1, 3, 60_000);
  let release!: () => void;
  const first = queue.run(
    "busy",
    () => new Promise<string>((resolve) => (release = () => resolve("done"))),
  );
  const left = new AbortController();
  const order: string[] = [];
  const abandonedCompute = vi.fn(async () => {
    order.push("old");
    return "old";
  });
  const abandoned = queue.run("abandoned", abandonedCompute, left.signal);
  left.abort(new DOMException("caller left", "AbortError"));
  await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
  const foreground = queue.run(
    "new",
    async () => {
      order.push("new");
      return "fresh";
    },
    new AbortController().signal,
  );
  release();
  await expect(first).resolves.toBe("done");
  await expect(foreground).resolves.toBe("fresh");
  await vi.waitFor(() => expect(abandonedCompute).toHaveBeenCalledOnce());
  expect(order).toEqual(["new", "old"]);
  queue.cancelAll();
});

test("queued work retains its original storage tenant", async () => {
  const queue = new PreparationQueue(1, 2, 60_000);
  let release!: () => void;
  const busy = queue.run(
    "busy",
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const queued = withTenant("tenant-a", () =>
    queue.run("queued", async () => currentTenantId()),
  );
  withTenant("tenant-b", release);
  await busy;
  await expect(queued).resolves.toBe("tenant-a");
});

test("expiry abandons a wedged job and allows a fresh attempt", async () => {
  vi.useFakeTimers();
  const queue = new PreparationQueue(1, 2, 50);
  let workerSignal: AbortSignal | undefined;
  const pending = queue.run("session", async (signal) => {
    workerSignal = signal;
    await new Promise<void>(() => {});
    return "stale";
  });
  const rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" });
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(workerSignal?.aborted).toBe(true);
  await expect(queue.run("session", async () => "fresh")).resolves.toBe(
    "fresh",
  );
});

test("reset rejects all queued callers before another job can start", async () => {
  const queue = new PreparationQueue(1, 2, 60_000);
  let signal: AbortSignal | undefined;
  const first = queue.run("one", async (owner) => {
    signal = owner;
    await new Promise<void>((_, reject) => {
      owner.addEventListener("abort", () => reject(owner.reason), {
        once: true,
      });
    });
  });
  const secondCompute = vi.fn(async () => "two");
  const second = queue.run("two", secondCompute);
  queue.cancelAll();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
  expect(signal?.aborted).toBe(true);
  expect(secondCompute).not.toHaveBeenCalled();
});
