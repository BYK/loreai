import { Show, type Component } from "solid-js";
import { Icon, type IconName } from "~/components/shell/Icon";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

const PageButton: Component<{
  text: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
  trailing?: boolean;
  reverse?: boolean;
}> = (props) => (
  <Tooltip placement="top">
    <TooltipTrigger
      as={Button}
      type="button"
      variant="ghost"
      size={props.compact ? "icon" : "sm"}
      class={
        props.compact
          ? "size-11 shrink-0 p-0"
          : "h-11 min-w-11 gap-1.5 px-3 text-xs sm:h-9 sm:min-w-9"
      }
      aria-label={`${props.text} page`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Show when={!props.trailing}>
        <Icon
          name={props.icon}
          class={props.reverse ? "rotate-180" : undefined}
        />
      </Show>
      <Show when={!props.compact}>{props.text}</Show>
      <Show when={props.trailing}>
        <Icon name={props.icon} />
      </Show>
    </TooltipTrigger>
    <TooltipContent>{props.text} page</TooltipContent>
  </Tooltip>
);

/** Presentation only: callers retain cursor history and navigation ownership. */
export const PaginationControls: Component<{
  label: string;
  onFirst?: () => void;
  onPrevious?: () => void;
  onNext: () => void;
  previousDisabled?: boolean;
  nextDisabled: boolean;
  compact?: boolean;
  class?: string;
}> = (props) => (
  <nav
    aria-label={props.label}
    class={cn("flex flex-wrap items-center justify-end gap-1", props.class)}
  >
    <Show when={props.onFirst}>
      {(first) => (
        <PageButton
          text="First"
          icon="first"
          compact={props.compact}
          onClick={first()}
        />
      )}
    </Show>
    <Show when={props.onPrevious}>
      {(previous) => (
        <PageButton
          text="Previous"
          icon="chevron"
          reverse
          compact={props.compact}
          disabled={props.previousDisabled}
          onClick={previous()}
        />
      )}
    </Show>
    <PageButton
      text="Next"
      icon="chevron"
      trailing
      compact={props.compact}
      disabled={props.nextDisabled}
      onClick={props.onNext}
    />
  </nav>
);
