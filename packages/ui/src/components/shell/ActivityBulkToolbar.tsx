import type { Component } from "solid-js";
import { createSignal, For } from "solid-js";
import * as PopoverPrimitive from "@kobalte/core/popover";

import type { ActivityFolderRecord } from "~/db";

export const ActivityBulkToolbar: Component<{
  allSelected: boolean;
  folders: readonly ActivityFolderRecord[];
  onSelectAll: (checked: boolean) => void;
  onRead: () => void;
  onUnread: () => void;
  onArchive: () => void;
  onInbox: () => void;
  onPin: () => void;
  unpin: boolean;
  onMove: (folderId: string) => void;
  onNewFolder: () => void;
  onClear: () => void;
}> = (props) => {
  const [folderMenuOpen, setFolderMenuOpen] = createSignal(false);
  return (
    <div class="mx-2 mb-2 flex h-8 flex-none items-center gap-1 overflow-x-auto rounded-md border border-hairline px-2 text-[10px]">
      <input
        type="checkbox"
        aria-label="Select all visible activity"
        checked={props.allSelected}
        class="accent-accent"
        onChange={(event) => props.onSelectAll(event.currentTarget.checked)}
      />
      <button class="rounded px-1.5 py-1 hover:bg-soft" onClick={props.onRead}>
        Read
      </button>
      <button
        class="rounded px-1.5 py-1 hover:bg-soft"
        onClick={props.onUnread}
      >
        Unread
      </button>
      <button
        class="rounded px-1.5 py-1 hover:bg-soft"
        onClick={props.onArchive}
      >
        Archive
      </button>
      <button class="rounded px-1.5 py-1 hover:bg-soft" onClick={props.onInbox}>
        Inbox
      </button>
      <button class="rounded px-1.5 py-1 hover:bg-soft" onClick={props.onPin}>
        {props.unpin ? "Unpin" : "Pin"}
      </button>
      <PopoverPrimitive.Root
        open={folderMenuOpen()}
        onOpenChange={setFolderMenuOpen}
        gutter={4}
        placement="bottom-end"
      >
        <PopoverPrimitive.Trigger
          type="button"
          class="whitespace-nowrap rounded px-1.5 py-1 hover:bg-soft"
        >
          Move to folder
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            data-testid="activity-folder-menu"
            class="z-50 min-w-40 rounded border border-hairline bg-surface p-1 text-text shadow-lg"
          >
            <For each={props.folders}>
              {(folder) => (
                <button
                  type="button"
                  class="block w-full rounded px-2 py-1 text-left hover:bg-soft"
                  onClick={() => {
                    props.onMove(folder.key);
                    setFolderMenuOpen(false);
                  }}
                >
                  {folder.name}
                </button>
              )}
            </For>
            <button
              type="button"
              class="block w-full rounded px-2 py-1 text-left text-accent hover:bg-soft"
              onClick={() => {
                props.onNewFolder();
                setFolderMenuOpen(false);
              }}
            >
              New folder…
            </button>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <button
        class="ml-auto rounded px-1.5 py-1 text-muted hover:bg-soft"
        onClick={props.onClear}
      >
        Clear
      </button>
    </div>
  );
};
