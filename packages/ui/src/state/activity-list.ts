import { createSignal } from "solid-js";

import type { ActivityItem } from "~/contracts";

export function createActivityListState() {
  const [items, setItems] = createSignal<ActivityItem[]>([]);
  const [selectedKeys, setSelectedKeys] = createSignal<string[]>([]);
  const [currentKey, setCurrentKey] = createSignal<string | null>(null);
  const [nextUnread, setNextUnread] = createSignal<(() => boolean) | null>(
    null,
  );
  return {
    items,
    setItems,
    selectedKeys,
    setSelectedKeys,
    currentKey,
    setCurrentKey,
    nextUnread,
    registerNextUnread: (next: () => boolean) => setNextUnread(() => next),
  };
}

export type ActivityListState = ReturnType<typeof createActivityListState>;
