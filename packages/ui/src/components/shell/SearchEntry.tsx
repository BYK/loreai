import type { Component } from "solid-js";
import { createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { searchHref } from "~/routes/Browse";
import { cn } from "~/lib/utils";

export const SearchEntry: Component<{
  class?: string;
  searchProjectId?: string;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const navigate = useNavigate();
  return (
    <>
      <form
        class={cn(
          "flex rounded-md border border-line bg-bg text-[13px] text-muted",
          "h-8 md:h-auto md:w-[320px] md:max-w-full",
          props.class,
        )}
        onSubmit={(event) => {
          event.preventDefault();
          const raw = new FormData(event.currentTarget).get("q");
          const q = (typeof raw === "string" ? raw : "").trim();
          if (props.searchProjectId)
            navigate(searchHref(props.searchProjectId, q, "all"));
          else setOpen(true);
        }}
      >
        <input
          name="q"
          aria-label="Search"
          placeholder={
            props.searchProjectId
              ? "Search this project's memory…"
              : "Pick a project to search"
          }
          class="hidden min-w-0 flex-1 bg-transparent px-3 outline-none md:block"
        />
        <button
          type="submit"
          data-testid="search-entry"
          aria-label="Search"
          class="size-8 md:hidden"
        >
          ⌕
        </button>
      </form>
      <Dialog open={open()} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pick a project first</DialogTitle>
            <DialogDescription>
              Pick a project first — recall is scoped to a project.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
};
