import type { Component } from "solid-js";
import { createSignal } from "solid-js";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

/**
 * Global search entry point. UI-04 delivers search itself; until then the
 * field is a button that explains where search arrives instead of pretending
 * to accept a query.
 */
export const SearchEntry: Component<{ class?: string }> = (props) => {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button
        type="button"
        data-testid="search-entry"
        aria-label="Search"
        class={cn(
          "rounded-md border border-line bg-bg text-[13px] text-muted hover:border-thread",
          // Compact icon below md; the full field from md up.
          "size-8 md:h-auto md:w-[320px] md:max-w-full md:px-3 md:py-1.75 md:text-left",
          props.class,
        )}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" class="md:hidden">
          ⌕
        </span>
        <span class="hidden md:inline">
          Search projects, knowledge and sessions…
        </span>
      </button>
      <Dialog open={open()} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Search arrives in UI-04</DialogTitle>
            <DialogDescription>
              Global search across projects, knowledge and sessions is the UI-04
              slice of the roadmap. Until then, browse a project's knowledge
              from the navigation on the left.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
};
