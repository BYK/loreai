import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";

import { cn } from "~/lib/utils";

export type StateKind = "empty" | "error" | "locked" | "loading";

const ICON: Record<StateKind, string> = {
  empty: "○",
  error: "!",
  locked: "🔒",
  loading: "…",
};

/**
 * Empty / error / locked / loading placeholder used by list and detail panes.
 * `locked` is the management-boundary state: the gateway hid or refused the
 * API for this browser, which is different from "nothing stored yet".
 */
export const StateCard: Component<{
  kind: StateKind;
  title: string;
  children?: JSX.Element;
  action?: JSX.Element;
  class?: string;
  compact?: boolean;
}> = (props) => (
  <div
    role={props.kind === "error" ? "alert" : "status"}
    data-state={props.kind}
    class={cn(
      "rounded-lg border text-sm",
      props.kind === "error"
        ? "border-danger/40 bg-danger-soft"
        : props.kind === "locked"
          ? "border-dashed border-line bg-bg"
          : "border-line bg-soft",
      props.compact ? "px-3.5 py-3" : "px-5 py-6",
      props.class,
    )}
  >
    <div class="flex items-start gap-3">
      <span
        aria-hidden="true"
        class={cn(
          "inline-flex size-6 flex-none items-center justify-center rounded-full text-[11px] font-bold",
          props.kind === "error"
            ? "bg-danger text-accent-contrast"
            : "bg-chrome text-muted",
        )}
      >
        {ICON[props.kind]}
      </span>
      <div class="min-w-0">
        <div
          class={cn("font-semibold", props.kind === "error" && "text-danger")}
        >
          {props.title}
        </div>
        <Show when={props.children}>
          <div class="mt-1 text-[13px] text-muted">{props.children}</div>
        </Show>
        <Show when={props.action}>
          <div class="mt-3">{props.action}</div>
        </Show>
      </div>
    </div>
  </div>
);
