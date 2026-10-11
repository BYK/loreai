import type {
  ActivityClientStateFilter,
  ParsedActivityQuery,
} from "@loreai/core/activity-query";
import type { ActivityItem } from "~/contracts";

export type ActivityLocalState = {
  archived: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  read: Readonly<Record<string, boolean>>;
};

export const DEFAULT_ACTIVITY_LOCAL_STATE: ActivityLocalState = {
  archived: new Set(),
  pinned: new Set(),
  read: {},
};

export function activityItemKey(item: ActivityItem): string {
  return `${item.kind}:${item.project_id}:${item.id}`;
}

export function clientFilter(
  item: ActivityItem,
  client: ParsedActivityQuery["client"],
  localState: ActivityLocalState,
): boolean {
  const key = activityItemKey(item);
  if (client.in.includes("archive") && !localState.archived.has(key)) {
    return false;
  }
  if (client.in.includes("inbox") && localState.archived.has(key)) {
    return false;
  }
  if (client.folders.length > 0) return false;
  return client.is.every((state: ActivityClientStateFilter) => {
    if (state === "unread")
      return item.total > 0 && localState.read[key] !== true;
    if (state === "read") return localState.read[key] === true;
    return localState.pinned.has(key);
  });
}
