// Owned Solid/shadcn-style bottom sheet, using the shared accessible Dialog.
import type { Component, ComponentProps } from "solid-js";
import { splitProps } from "solid-js";
import { DialogContent } from "./dialog";
import { cn } from "~/lib/utils";

export const BottomSheetContent: Component<
  ComponentProps<typeof DialogContent>
> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <DialogContent
      class={cn(
        "mobile-bottom-sheet bottom-0 left-0 top-auto flex max-h-[calc(100dvh-1rem)] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-b-none rounded-t-xl border-x-0 border-b-0 p-0 sm:p-0 [&>button]:right-1 [&>button]:top-1 [&>button]:inline-flex [&>button]:size-11 [&>button]:items-center [&>button]:justify-center",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </DialogContent>
  );
};
