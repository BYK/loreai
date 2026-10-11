import type {
  ActivityClientStateFilter,
  ParsedActivityQuery,
} from "@loreai/core/activity-query";
import type { ActivityItem } from "~/contracts";
import type { ActivityLocalSnapshot } from "./activity-local";

export const DEFAULT_ACTIVITY_LOCAL_STATE: ActivityLocalSnapshot = {
  records: {},
  folders: [],
};

export function activityItemKey(item: ActivityItem): string {
  return `${item.kind}:${item.project_id}:${item.id}`;
}

export function unreadCount(
  item: ActivityItem,
  localState: ActivityLocalSnapshot,
): number {
  return Math.max(
    0,
    item.total - (localState.records[activityItemKey(item)]?.read_total ?? 0),
  );
}

export function activityUnreadChip(
  item: ActivityItem,
  localState: ActivityLocalSnapshot,
): { label: string; unread: boolean } {
  const unread = unreadCount(item, localState);
  if (unread > 0 && unread < item.total) {
    return { label: `${unread} of ${item.total}`, unread: true };
  }
  return {
    label: `${item.total} ${item.total === 1 ? "msg" : "msgs"}`,
    unread: unread > 0,
  };
}

export function isActivityArchived(
  item: ActivityItem,
  localState: ActivityLocalSnapshot,
): boolean {
  const archivedAt = localState.records[activityItemKey(item)]?.archived_at;
  return archivedAt !== undefined && archivedAt >= item.last_activity_at;
}

export function clientFilter(
  item: ActivityItem,
  client: ParsedActivityQuery["client"],
  localState: ActivityLocalSnapshot,
): boolean {
  const key = activityItemKey(item);
  const record = localState.records[key];
  const archived = isActivityArchived(item, localState);
  const inFolders = client.folders.every((name) => {
    const folder = localState.folders.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    return folder?.keys.includes(key) ?? false;
  });
  if (!inFolders) return false;
  if (
    !client.in.every((folder) => (folder === "archive" ? archived : !archived))
  ) {
    return false;
  }
  const unread = unreadCount(item, localState);
  return client.is.every((state: ActivityClientStateFilter) => {
    if (state === "unread") return unread > 0;
    if (state === "read") return unread === 0;
    return record?.pinned_at !== undefined;
  });
}
