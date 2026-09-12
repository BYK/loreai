/** Own asynchronous retirement operations until they settle. */
export class OwnedRetirements<Owner extends object> {
  private readonly active = new Set<Promise<void>>();
  private readonly owners = new WeakSet<Owner>();
  private readonly errors: unknown[] = [];

  get size(): number {
    return this.active.size;
  }

  track(operation: Promise<void>): Promise<void> {
    const active = this.active;
    const errors = this.errors;
    let tracked: Promise<void>;
    tracked = operation
      .then(
        () => {},
        (error: unknown) => {
          errors.push(error);
        },
      )
      .finally(() => active.delete(tracked));
    active.add(tracked);
    return operation;
  }

  /** Start at most one retirement operation for an owned resource. */
  retireOnce(owner: Owner, retire: () => Promise<void>): Promise<void> | null {
    if (this.owners.has(owner)) return null;
    this.owners.add(owner);
    let operation: Promise<void>;
    try {
      operation = retire();
    } catch (error) {
      operation = Promise.reject(error);
    }
    return this.track(operation);
  }

  async settle(options: {
    failureMessage: string;
    timeoutMs?: number;
    timeoutMessage?: string;
  }): Promise<void> {
    const deadlineAt =
      options.timeoutMs === undefined
        ? undefined
        : Date.now() + Math.max(0, options.timeoutMs);

    while (this.active.size > 0) {
      if (deadlineAt === undefined) {
        await Promise.all(this.active);
        continue;
      }

      const remainingMs = Math.max(0, deadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(this.active),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    options.timeoutMessage ??
                      "owned retirement did not settle before shutdown deadline",
                  ),
                ),
              remainingMs,
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (this.errors.length > 0) {
      throw new AggregateError(this.errors, options.failureMessage);
    }
  }

  /** Clear failures between isolated test/process generations. */
  reset(): void {
    if (this.active.size > 0) {
      throw new Error("cannot reset owned retirements while active");
    }
    this.errors.length = 0;
  }
}
