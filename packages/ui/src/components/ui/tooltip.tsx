// Locally authored Solid UI/shadcn-style wrapper around Kobalte's tooltip.
import type { Component, ComponentProps } from "solid-js";
import { splitProps } from "solid-js";
import * as TooltipPrimitive from "@kobalte/core/tooltip";
import { cn } from "~/lib/utils";

const Tooltip: Component<ComponentProps<typeof TooltipPrimitive.Root>> = (
  props,
) => (
  <TooltipPrimitive.Root
    placement="right"
    gutter={10}
    openDelay={300}
    closeDelay={100}
    skipDelayDuration={300}
    {...props}
  />
);
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipContent: Component<
  ComponentProps<typeof TooltipPrimitive.Content>
> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        class={cn(
          "z-50 max-w-[calc(100vw-1.5rem)] rounded-md border border-line bg-surface px-3 py-2 text-xs text-text shadow-md outline-none",
          local.class,
        )}
        {...rest}
      >
        {local.children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
};
export { Tooltip, TooltipTrigger, TooltipContent };
