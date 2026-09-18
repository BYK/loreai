import type { Accessor } from "solid-js";
import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js";

export interface Loader<T> {
  /** Last successfully loaded value; kept while a reload is in flight. */
  data: Accessor<T | undefined>;
  /** Error of the most recent settled attempt; cleared as soon as a new attempt starts. */
  error: Accessor<unknown>;
  loading: Accessor<boolean>;
  reload: () => void;
  /** True while `data` came from the cache and the server has not answered yet. */
  stale: Accessor<boolean>;
  /** Where the current `data` came from. */
  source: Accessor<"cache" | "server" | null>;
}

export interface LoaderOptions<S, T> {
  /** Cache read, raced against the fetcher; its failures are ignored. */
  cached?: (source: S, signal: AbortSignal) => Promise<T | undefined>;
  /** Runs after every successful fetch (e.g. write-through to cache). Errors are swallowed. */
  onServer?: (source: S, value: T) => void | Promise<void>;
}

/**
 * Minimal async loader keyed on a reactive source. Unlike `createResource`
 * it never throws from its accessors (no Suspense/ErrorBoundary contract),
 * ignores stale responses when the source changes mid-flight, and aborts the
 * superseded request. A `null`/`undefined` source clears the state.
 *
 * With `options.cached`, the cache read and the server fetch start
 * concurrently: whichever wins, a cache value renders immediately as
 * `stale` (`source: "cache"`) and the server answer replaces it; if the
 * server answered first, a late cache value never overwrites it.
 */
export function createLoader<S, T>(
  source: Accessor<S | null | undefined>,
  fetcher: (source: S, signal: AbortSignal) => Promise<T>,
  options?: LoaderOptions<S, T>,
): Loader<T> {
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [loading, setLoading] = createSignal(false);
  const [stale, setStale] = createSignal(false);
  const [dataSource, setDataSource] = createSignal<"cache" | "server" | null>(
    null,
  );
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
        setStale(false);
        setDataSource(null);
      }
      setError(undefined);
      if (key == null) {
        setLoading(false);
        return;
      }
      const c = new AbortController();
      controller = c;
      setLoading(true);
      let serverSettled = false;

      if (options?.cached) {
        options.cached(key, c.signal).then(
          (value) => {
            if (current !== generation) return;
            // A server *answer* wins over a late cache read; a server
            // *failure* doesn't — cached data still fills the empty screen.
            if (serverSettled && error() === undefined) return;
            if (value !== undefined) {
              setData(() => value);
              setStale(true);
              setDataSource("cache");
            }
          },
          () => {
            // The cache is disposable; its errors never reach the UI.
          },
        );
      }

      fetcher(key, c.signal).then(
        (value) => {
          if (current !== generation) return;
          serverSettled = true;
          setData(() => value);
          setError(undefined);
          setStale(false);
          setDataSource("server");
          setLoading(false);
          try {
            void options?.onServer?.(key, value)?.catch((reason: unknown) => {
              console.warn("cache write failed", reason);
            });
          } catch (reason) {
            console.warn("cache write failed", reason);
          }
        },
        (reason: unknown) => {
          if (current !== generation || c.signal.aborted) return;
          serverSettled = true;
          setError(() => reason);
          setLoading(false);
          // Cached data stays visible, marked stale.
          if (dataSource() === "cache") setStale(true);
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
    stale,
    source: dataSource,
  };
}
