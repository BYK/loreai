// Owned Solid UI/shadcn-style wrapper, backed by Kobalte's accessible popover.
import type { Component, ComponentProps } from "solid-js";
import { splitProps } from "solid-js";
import * as PopoverPrimitive from "@kobalte/core/popover";
import { cn } from "~/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverContent: Component<
  ComponentProps<typeof PopoverPrimitive.Content>
> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        class={cn(
          "z-50 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-line bg-surface text-text shadow-xl outline-none",
          local.class,
        )}
        {...rest}
      >
        {local.children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
};

export { Popover, PopoverTrigger, PopoverContent };
