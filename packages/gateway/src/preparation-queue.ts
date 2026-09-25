/** Gateway-owned, bounded work that can outlive a foreground caller. */

import {
  currentTenantId,
  ReadPreparationUnavailableError,
  withTenant,
} from "@loreai/core";
import { promiseAgainstAbort } from "./abort-race";

type Job = {
  key: string;
  controller: AbortController;
  compute: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  promise: Promise<unknown>;
  deadline: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  active: boolean;
  waiters: number;
  failures: number;
};

/** Stop walking large knowledge results once they exceed the retention cap. */
function resultBytes(value: unknown, limit: number): number {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let bytes = 0;
  while (stack.length && bytes <= limit) {
    const next = stack.pop();
    if (typeof next === "string") bytes += next.length * 2;
    else if (next && typeof next === "object" && !seen.has(next)) {
      seen.add(next);
      bytes += 48;
      if (Array.isArray(next)) for (const item of next) stack.push(item);
      else {
        for (const [key, item] of Object.entries(next)) {
          bytes += key.length * 2;
          stack.push(item);
        }
      }
    } else bytes += 8;
  }
  return bytes;
}

/**
 * Keep read-only preparation alive after a request times out. A retry with the
 * same key joins the existing job; transient worker pressure is retried with
 * backoff. The queue owns a finite lifetime and never sends an upstream prompt.
 */
export class PreparationQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly completed = new Map<
    string,
    { value: unknown; until: number; bytes: number }
  >();
  private readonly waiting: Job[] = [];
  private active = 0;
  private clearing = false;
  private retainedBytes = 0;
  private readonly maxRetainedBytes = 8_000_000;
  private readonly maxResultBytes = 1_000_000;

  constructor(
    private readonly maxActive = 2,
    private readonly maxJobs = 32,
    private readonly lifetimeMs = 5 * 60_000,
    private readonly retryMs = 5_000,
    private readonly completedTtlMs = 0,
  ) {}

  run<T>(
    key: string,
    compute: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    callerSignal?.throwIfAborted();
    const completed = this.completed.get(key);
    if (completed) {
      if (completed.until > Date.now())
        return Promise.resolve(completed.value as T);
      this.dropCompleted(key);
    }
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= this.maxJobs && callerSignal) {
        // Detached work is opportunistic. Under load, reserve admission for a
        // live turn before its preparation deadline runs out.
        const victim =
          [...this.jobs.values()].find(
            (candidate) => candidate.waiters === 0 && !candidate.active,
          ) ??
          [...this.jobs.values()].find((candidate) => candidate.waiters === 0);
        if (victim) {
          this.clearing = true;
          this.cancel(
            victim.key,
            new ReadPreparationUnavailableError("context", "pressure"),
          );
          this.clearing = false;
        }
      }
      if (this.jobs.size >= this.maxJobs) {
        return Promise.reject(
          new ReadPreparationUnavailableError("context", "pressure"),
        );
      }
      let resolve!: (value: unknown) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // The last caller may leave before the job finishes; its rejection must
      // still be observed while the gateway owns it.
      void promise.catch(() => {});
      const controller = new AbortController();
      const tenantId = currentTenantId();
      job = {
        key,
        controller,
        compute: (signal) => withTenant(tenantId, () => compute(signal)),
        resolve,
        reject,
        promise,
        deadline: undefined as unknown as ReturnType<typeof setTimeout>,
        active: false,
        waiters: 0,
        failures: 0,
      };
      job.deadline = setTimeout(
        () =>
          this.cancel(
            key,
            new ReadPreparationUnavailableError("context", "timeout"),
          ),
        this.lifetimeMs,
      );
      job.deadline.unref?.();
      this.jobs.set(key, job);
      this.waiting.push(job);
      this.pump();
    } else if (job.waiters === 0) {
      // A foreground retry promotes an idle precompute without starting
      // duplicate work or bypassing the active-work limit.
      if (!job.active && !job.retry) {
        const index = this.waiting.indexOf(job);
        if (index !== -1) {
          this.waiting.splice(index, 1);
          this.waiting.unshift(job);
        }
      }
    }
    // Idle warming has no caller signal and must not outrank live turns.
    if (callerSignal) job.waiters++;
    return promiseAgainstAbort(
      () => job.promise as Promise<T>,
      callerSignal,
    ).finally(() => {
      if (callerSignal) job.waiters--;
    });
  }

  cancel(
    key: string,
    reason: unknown = new DOMException("preparation reset", "AbortError"),
  ): void {
    this.dropCompleted(key);
    const job = this.jobs.get(key);
    if (!job) return;
    this.jobs.delete(key);
    clearTimeout(job.deadline);
    if (job.retry) clearTimeout(job.retry);
    const index = this.waiting.indexOf(job);
    if (index !== -1) this.waiting.splice(index, 1);
    job.controller.abort(reason);
    job.reject(reason);
    this.pump();
  }

  cancelAll(): void {
    this.clearing = true;
    this.completed.clear();
    this.retainedBytes = 0;
    for (const key of this.jobs.keys()) this.cancel(key);
    this.clearing = false;
  }

  /** A successful live turn consumes a completed result. Detached results
   * remain available for a matching retry until their TTL expires. */
  consume(key: string): void {
    this.dropCompleted(key);
  }

  cancelPrefix(prefix: string): void {
    for (const key of this.jobs.keys())
      if (key.startsWith(prefix)) this.cancel(key);
    for (const key of this.completed.keys())
      if (key.startsWith(prefix)) this.dropCompleted(key);
  }

  private dropCompleted(key: string): void {
    const stored = this.completed.get(key);
    if (!stored) return;
    this.retainedBytes -= stored.bytes;
    this.completed.delete(key);
  }

  private finish(
    job: Job,
    result: { value: unknown } | { error: unknown },
  ): void {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    clearTimeout(job.deadline);
    if ("value" in result) {
      if (this.completedTtlMs > 0) {
        const bytes = resultBytes(result.value, this.maxResultBytes);
        if (bytes <= this.maxResultBytes) {
          this.dropCompleted(job.key);
          while (
            this.completed.size >= this.maxJobs ||
            this.retainedBytes + bytes > this.maxRetainedBytes
          )
            this.dropCompleted(this.completed.keys().next().value!);
          this.completed.set(job.key, {
            value: result.value,
            until: Date.now() + this.completedTtlMs,
            bytes,
          });
          this.retainedBytes += bytes;
        }
      }
      job.resolve(result.value);
    } else job.reject(result.error);
  }

  private pump(): void {
    if (this.clearing) return;
    while (this.active < this.maxActive && this.waiting.length) {
      const index = this.waiting.findIndex((job) => job.waiters > 0);
      const [job] = this.waiting.splice(index === -1 ? 0 : index, 1);
      if (this.jobs.get(job.key) !== job) continue;
      this.active++;
      job.active = true;
      void this.attempt(job);
    }
  }

  private async attempt(job: Job): Promise<void> {
    try {
      // A worker may ignore cancellation entirely. Release the queue slot at
      // expiry even if its underlying promise never settles.
      const value = await promiseAgainstAbort(
        () => job.compute(job.controller.signal),
        job.controller.signal,
      );
      if (!job.controller.signal.aborted) this.finish(job, { value });
    } catch (error) {
      if (this.jobs.get(job.key) !== job) return;
      if (
        error instanceof ReadPreparationUnavailableError &&
        !job.controller.signal.aborted
      ) {
        job.failures++;
        job.retry = setTimeout(
          () => {
            job.retry = undefined;
            if (this.jobs.get(job.key) !== job) return;
            this.waiting.push(job);
            this.pump();
          },
          Math.min(30_000, this.retryMs * 2 ** Math.min(10, job.failures - 1)),
        );
        job.retry.unref?.();
      } else {
        this.finish(job, { error });
      }
    } finally {
      job.active = false;
      this.active--;
      this.pump();
    }
  }
}
