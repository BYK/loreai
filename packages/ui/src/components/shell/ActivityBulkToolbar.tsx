import type { Component } from "solid-js";
import { For } from "solid-js";

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
}> = (props) => (
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
    <button class="rounded px-1.5 py-1 hover:bg-soft" onClick={props.onUnread}>
      Unread
    </button>
    <button class="rounded px-1.5 py-1 hover:bg-soft" onClick={props.onArchive}>
      Archive
    </button>
    <button class="rounded px-1.5 py-1 hover:bg-soft" onClick={props.onInbox}>
      Inbox
    </button>
    <button class="rounded px-1.5 py-1 hover:bg-soft" onClick={props.onPin}>
      {props.unpin ? "Unpin" : "Pin"}
    </button>
    <details class="relative">
      <summary class="cursor-pointer list-none rounded px-1.5 py-1 hover:bg-soft">
        Move to folder
      </summary>
      <div class="absolute right-0 z-30 mt-1 min-w-40 rounded border border-hairline bg-surface p-1 shadow-sm">
        <For each={props.folders}>
          {(folder) => (
            <button
              type="button"
              class="block w-full rounded px-2 py-1 text-left hover:bg-soft"
              onClick={() => props.onMove(folder.key)}
            >
              {folder.name}
            </button>
          )}
        </For>
        <button
          type="button"
          class="block w-full rounded px-2 py-1 text-left text-accent hover:bg-soft"
          onClick={props.onNewFolder}
        >
          New folder…
        </button>
      </div>
    </details>
    <button
      class="ml-auto rounded px-1.5 py-1 text-muted hover:bg-soft"
      onClick={props.onClear}
    >
      Clear
    </button>
  </div>
);
