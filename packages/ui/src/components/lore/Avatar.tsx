import type { Component } from "solid-js";

import { cn } from "~/lib/utils";

export type AvatarKind = "person" | "agent";

export const Avatar: Component<{
  label: string;
  kind?: AvatarKind;
  size?: "sm" | "md";
  class?: string;
}> = (props) => (
  <span
    aria-hidden="true"
    class={cn(
      "inline-flex flex-none items-center justify-center rounded-md font-bold",
      props.size === "sm" ? "size-6 text-[10px]" : "size-[29px] text-xs",
      props.kind === "agent"
        ? "bg-[var(--avatar-agent-bg)] text-[var(--avatar-agent-text)]"
        : "bg-[var(--avatar-bg)] text-[var(--avatar-text)]",
      props.class,
    )}
  >
    {props.label}
  </span>
);
