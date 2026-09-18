import type { Accessor } from "solid-js";
import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js";

export interface Loader<T> {
  /** Last successfully loaded value; kept while a reload is in flight. */
  data: Accessor<T | undefined>;
  /** Error of the most recent attempt, cleared when a reload succeeds. */
  error: Accessor<unknown>;
  loading: Accessor<boolean>;
  reload: () => void;
}

/**
 * Minimal async loader keyed on a reactive source. Unlike `createResource`
 * it never throws from its accessors (no Suspense/ErrorBoundary contract),
 * ignores stale responses when the source changes mid-flight, and aborts the
 * superseded request. A `null`/`undefined` source clears the state.
 */
export function createLoader<S, T>(
  source: Accessor<S | null | undefined>,
  fetcher: (source: S, signal: AbortSignal) => Promise<T>,
): Loader<T> {
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [loading, setLoading] = createSignal(false);
  const [tick, setTick] = createSignal(0);

  let controller: AbortController | null = null;
  let generation = 0;
  let lastKey: S | null | undefined;

  const cancel = () => {
    controller?.abort();
    controller = null;
  };

  createEffect(
    on([source, tick], ([key]) => {
      cancel();
      const current = ++generation;
      if (key !== lastKey) {
        // A new key is a different subject: never show the previous one's data.
        lastKey = key;
        setData(undefined);
        setError(undefined);
      }
      if (key == null) {
        setLoading(false);
        return;
      }
      const c = new AbortController();
      controller = c;
      setLoading(true);
      fetcher(key, c.signal).then(
        (value) => {
          if (current !== generation) return;
          setData(() => value);
          setError(undefined);
          setLoading(false);
        },
        (reason: unknown) => {
          if (current !== generation || c.signal.aborted) return;
          setError(() => reason);
          setLoading(false);
        },
      );
    }),
  );

  onCleanup(cancel);

  return {
    data,
    error,
    loading,
    reload: () => setTick(untrack(tick) + 1),
  };
}
