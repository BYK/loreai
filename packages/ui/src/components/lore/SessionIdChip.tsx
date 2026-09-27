import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";

function writeClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error("Clipboard unavailable"));
}

/**
 * Monospace session id + inline copy button (#1921). The id truncates with a
 * `title` attribute carrying the full value; the copy button stops the click
 * so a chip inside a row link never triggers navigation.
 */
export const SessionIdChip: Component<{ id: string; class?: string }> = (
  props,
) => {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const copy = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void writeClipboard(props.id)
      .then(() => {
        setCopied(true);
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <span
      class={`inline-flex max-w-full items-center gap-1 font-mono text-xs text-muted ${props.class ?? ""}`}
    >
      <span class="truncate" title={props.id}>
        {props.id}
      </span>
      <button
        type="button"
        class="shrink-0 text-[11px] text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
        aria-label="Copy session id"
        onClick={copy}
      >
        <Show when={copied()} fallback="copy">
          Copied
        </Show>
      </button>
    </span>
  );
};
