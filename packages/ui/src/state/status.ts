import type { Accessor } from "solid-js";
import { createMemo } from "solid-js";

import type { Loader } from "~/lib/loader";

/** Per-key rendering status, derived from a loader plus a partial flag. */
export interface KeyStatus {
  loading: boolean;
  /** True while `data` is a cached value the server has not confirmed. */
  stale: boolean;
  /** True while more pages exist (`next_cursor` was non-null). */
  partial: boolean;
  error: unknown;
  source: "cache" | "server" | null;
}

export const IDLE_STATUS: KeyStatus = {
  loading: false,
  stale: false,
  partial: false,
  error: undefined,
  source: null,
};

export function statusOf<T>(
  loader: Loader<T>,
  partial: () => boolean = () => false,
): Accessor<KeyStatus> {
  return createMemo<KeyStatus>(() => ({
    loading: loader.loading(),
    stale: loader.stale(),
    partial: partial() || loader.partial(),
    error: loader.error(),
    source: loader.source(),
  }));
}
