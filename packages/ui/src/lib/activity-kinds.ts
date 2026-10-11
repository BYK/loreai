import type { ActivityKind } from "@loreai/core/activity-query";
import type { ActivityItem } from "~/contracts";
import { globalKnowledgeHref, knowledgeHref, sessionHref } from "~/lib/href";

function isCurrentPath(href: string, pathname: string): boolean {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const routePath = new URL(href, window.location.href).pathname;
  const appPath =
    base && base !== "/" && pathname.startsWith(`${base}/`)
      ? pathname.slice(base.length)
      : pathname;
  return routePath === appPath;
}

export const ACTIVITY_KIND_UI: Record<
  ActivityKind,
  {
    label: string;
    href: (item: ActivityItem) => string;
    readMode: "item" | "session";
    isCurrent: (item: ActivityItem, pathname: string) => boolean;
  }
> = {
  session: {
    label: "Session",
    href: (item) => sessionHref(item.project_id, item.id),
    readMode: "session",
    isCurrent: (item, pathname) =>
      isCurrentPath(sessionHref(item.project_id, item.id), pathname),
  },
  knowledge: {
    label: "Knowledge",
    href: (item) =>
      item.project_id
        ? knowledgeHref(item.project_id, item.id)
        : globalKnowledgeHref(item.id),
    readMode: "item",
    isCurrent: (item, pathname) =>
      isCurrentPath(
        item.project_id
          ? knowledgeHref(item.project_id, item.id)
          : globalKnowledgeHref(item.id),
        pathname,
      ),
  },
  contradiction: {
    label: "Contradiction",
    href: () => "/contradictions",
    readMode: "item",
    isCurrent: () => false,
  },
  promotion: {
    label: "Promotion",
    href: (item) =>
      item.project_id
        ? knowledgeHref(item.project_id, item.id)
        : globalKnowledgeHref(item.id),
    readMode: "item",
    isCurrent: (item, pathname) =>
      isCurrentPath(
        item.project_id
          ? knowledgeHref(item.project_id, item.id)
          : globalKnowledgeHref(item.id),
        pathname,
      ),
  },
};
