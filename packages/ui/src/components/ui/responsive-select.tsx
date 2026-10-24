// Desktop Select / mobile bottom sheet, built from owned Solid/shadcn controls.
import type { Component } from "solid-js";
import { createMemo, Show } from "solid-js";
import * as Listbox from "@kobalte/core/listbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Dialog, DialogTitle, DialogTrigger } from "./dialog";
import { BottomSheetContent } from "./bottom-sheet";
import { Button } from "./button";
import { Icon, type IconName } from "~/components/shell/Icon";
import { createResponsiveOverlay } from "~/lib/responsive-overlay";
import { cn } from "~/lib/utils";

export const ResponsiveSelect: Component<{
  label: string;
  sheetTitle: string;
  value: string | null;
  options: readonly string[];
  onChange: (value: string | null) => void;
  optionLabel?: (value: string) => string;
  placeholder?: string;
  triggerClass?: string;
  contentClass?: string;
  itemClass?: string;
  icon?: IconName;
  name?: string;
  "data-testid"?: string;
}> = (props) => {
  let trigger: HTMLButtonElement | undefined;
  let listbox: HTMLUListElement | undefined;
  const overlay = createResponsiveOverlay(() => trigger);
  const label = (value: string) =>
    props.optionLabel?.(value) ??
    (value || props.placeholder || "Choose an option");
  const selected = createMemo(() => props.value ?? "");
  const choices = createMemo(() =>
    props.options.map((value) => ({ value, label: label(value) })),
  );
  const desktopOptions = createMemo(() => [...props.options]);
  const selectedKeys = createMemo(() => [selected()]);
  return (
    <Show
      when={overlay.mobile()}
      fallback={
        <Select
          open={overlay.open()}
          onOpenChange={overlay.setOpen}
          name={props.name}
          value={props.value}
          options={desktopOptions()}
          placeholder={props.placeholder}
          onChange={(value) => {
            // Collection refreshes can re-emit the current value without user input.
            if ((value ?? "") !== selected()) props.onChange(value);
          }}
          itemComponent={(item) => (
            <SelectItem item={item.item} class={props.itemClass}>
              {label(item.item.rawValue)}
            </SelectItem>
          )}
        >
          <SelectTrigger
            ref={(element) => {
              trigger = element;
            }}
            aria-label={props.label}
            data-testid={props["data-testid"]}
            class={props.triggerClass}
          >
            <Show when={props.icon}>{(icon) => <Icon name={icon()} />}</Show>
            <SelectValue<string>
              class={
                props.icon ? "min-w-0 flex-1 truncate text-left" : undefined
              }
            >
              {(state) => label(state.selectedOption() ?? "")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            class={props.contentClass}
            onCloseAutoFocus={(event) => {
              if (overlay.mobile()) overlay.restoreFocus(event);
            }}
          />
        </Select>
      }
    >
      <Dialog open={overlay.open()} onOpenChange={overlay.setOpen}>
        <DialogTrigger
          as={Button}
          ref={(element) => {
            trigger = element;
          }}
          variant="outline"
          aria-label={props.label}
          data-testid={props["data-testid"]}
          class={cn(
            "min-w-0 justify-between gap-2 px-3 text-xs",
            props.triggerClass,
            "h-11",
          )}
        >
          <Show when={props.icon}>{(icon) => <Icon name={icon()} />}</Show>
          <span class="min-w-0 flex-1 truncate text-left">
            {label(selected())}
          </span>
          <Icon name="chevrons" class="opacity-50" />
        </DialogTrigger>
        <BottomSheetContent
          data-select-presentation="sheet"
          onOpenAutoFocus={(event) => {
            // Focus once through Dialog; Listbox's deferred autoFocus can overwrite
            // keyboard navigation that happens while the sheet is opening.
            event.preventDefault();
            // The content effect can run before its child refs are mounted.
            queueMicrotask(() => {
              if (!overlay.open() || !listbox?.isConnected) return;
              if (
                listbox
                  .closest('[role="dialog"]')
                  ?.contains(document.activeElement)
              )
                return;
              const option =
                listbox.querySelector<HTMLElement>(
                  '[role="option"][aria-selected="true"]',
                ) ?? listbox.querySelector<HTMLElement>('[role="option"]');
              (option ?? listbox).focus({ preventScroll: true });
            });
          }}
          onCloseAutoFocus={overlay.restoreFocus}
        >
          <DialogTitle class="shrink-0 border-b border-line p-4 pr-16 text-sm">
            {props.sheetTitle}
          </DialogTitle>
          <Listbox.Root<{ value: string; label: string }>
            ref={(element) => {
              listbox = element;
            }}
            aria-label={props.label}
            options={choices()}
            optionValue="value"
            optionTextValue="label"
            value={selectedKeys()}
            selectionMode="single"
            selectionBehavior="replace"
            disallowEmptySelection
            allowDuplicateSelectionEvents
            onChange={(keys) => {
              const value = keys.values().next().value;
              if (value === undefined || !overlay.open()) return;
              overlay.setOpen(false);
              if (value !== selected()) props.onChange(value);
            }}
            class="m-0 min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] outline-none"
            renderItem={(item) => (
              <Listbox.Item
                item={item}
                class="flex min-h-11 cursor-default items-center justify-between gap-3 rounded-md px-3 py-3 text-sm outline-none focus:bg-soft data-[selected]:bg-accent-soft data-[selected]:text-accent-soft-text"
              >
                <Listbox.ItemLabel class="min-w-0 break-words">
                  {item.rawValue.label}
                </Listbox.ItemLabel>
                <Listbox.ItemIndicator>
                  <Icon name="check" />
                </Listbox.ItemIndicator>
              </Listbox.Item>
            )}
          />
        </BottomSheetContent>
      </Dialog>
    </Show>
  );
};
