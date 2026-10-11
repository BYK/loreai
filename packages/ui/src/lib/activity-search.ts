import { DEFAULT_ACTIVITY_QUERY } from "@loreai/core/activity-query";

const BUILTIN_SEARCH_TITLES: Record<string, string> = {
  [DEFAULT_ACTIVITY_QUERY]: "Inbox",
  "type:session": "Sessions",
  "type:knowledge": "Knowledge",
  "type:contradiction,promotion": "Needs attention",
  "is:unread": "Unread",
};

export function activitySearchTitle(
  query: string,
  count: number,
  savedTitle?: string,
): string {
  const title =
    BUILTIN_SEARCH_TITLES[query] ?? savedTitle ?? `Search "${query}"`;
  return `${title} ${count > 0 ? `1 – ${count}` : "0"}`;
}
