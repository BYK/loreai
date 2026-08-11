/**
 * Settle a Response-producing operation against an AbortSignal even when the
 * underlying implementation ignores that signal. Late responses are drained
 * by cancellation and late rejections stay observed.
 */
export function promiseAgainstAbort<T>(
  start: () => Promise<T>,
  signal?: AbortSignal,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  if (!signal) return start();
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let operation: Promise<T>;
    try {
      operation = start();
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
      return;
    }
    void operation.then(
      (value) => {
        if (settled) {
          try {
            onLateResolve?.(value);
          } catch {
            // Cleanup callbacks must never turn an observed late settlement
            // into an unhandled rejection.
          }
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function responseAgainstAbort(
  start: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  return promiseAgainstAbort(start, signal, (response) => {
    try {
      void response.body?.cancel(signal?.reason).catch(() => {});
    } catch {
      // Best-effort cleanup for an already-consumed/locked late body.
    }
  });
}
