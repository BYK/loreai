import { describe, expect, it, vi } from "vitest";
import { OwnedRetirements } from "../src/owned-retirements";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OwnedRetirements", () => {
  it("starts at most one retirement for the same owner", async () => {
    const retirements = new OwnedRetirements<object>();
    const owner = {};
    const pending = deferred();
    const retire = vi.fn(() => pending.promise);

    expect(retirements.retireOnce(owner, retire)).toBe(pending.promise);
    expect(retirements.retireOnce(owner, retire)).toBeNull();
    expect(retire).toHaveBeenCalledOnce();
    expect(retirements.size).toBe(1);

    pending.resolve();
    await retirements.settle({ failureMessage: "retirement failed" });
    expect(retirements.size).toBe(0);
  });

  it("drains retirements added while an earlier generation settles", async () => {
    const retirements = new OwnedRetirements<object>();
    const first = deferred();
    const second = deferred();
    void retirements.track(first.promise);
    void first.promise.then(() => retirements.track(second.promise));

    const settled = retirements.settle({ failureMessage: "retirement failed" });
    first.resolve();
    second.resolve();

    await expect(settled).resolves.toBeUndefined();
    expect(retirements.size).toBe(0);
  });

  it("remembers a failed retirement after its promise leaves the active set", async () => {
    const retirements = new OwnedRetirements<object>();
    const failure = new Error("terminate rejected");
    const immediate = retirements.track(Promise.reject(failure));
    await immediate.catch(() => {});
    await Promise.resolve();

    expect(retirements.size).toBe(0);
    await expect(
      retirements.settle({ failureMessage: "worker exit unconfirmed" }),
    ).rejects.toMatchObject({
      message: "worker exit unconfirmed",
      errors: [failure],
    });
  });

  it("bounds settlement without forgetting the still-owned operation", async () => {
    const retirements = new OwnedRetirements<object>();
    const pending = deferred();
    void retirements.track(pending.promise);

    await expect(
      retirements.settle({
        failureMessage: "retirement failed",
        timeoutMs: 0,
        timeoutMessage: "retirement deadline elapsed",
      }),
    ).rejects.toThrow("retirement deadline elapsed");
    expect(retirements.size).toBe(1);

    pending.resolve();
    await retirements.settle({ failureMessage: "retirement failed" });
  });
});
