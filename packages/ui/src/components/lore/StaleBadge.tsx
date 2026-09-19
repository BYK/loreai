import type { Component } from "solid-js";
import { Show } from "solid-js";

import type { KeyStatus } from "~/state/status";

/**
 * Small "serving from cache" indicator. Renders nothing unless the shown
 * data is stale (came from IndexedDB and the server has not confirmed it).
 */
export const StaleBadge: Component<{ status: KeyStatus }> = (props) => {
  const label = () => {
    const s = props.status;
    if (!s.stale) return null;
    if (s.error) return "Cached · gateway unavailable";
    if (s.loading) return "Cached · refreshing…";
    return "Cached";
  };
  return (
    <Show when={label()}>
      {(text) => (
        <span
          data-testid="stale-indicator"
          role="status"
          class="inline-flex items-center rounded-full border border-line bg-soft px-2 py-0.5 text-[10px] font-medium text-muted"
        >
          {text()}
        </span>
      )}
    </Show>
  );
};
