import type { ActivityKind } from "@loreai/core/activity-query";
import type { ActivityItem } from "~/contracts";
import { globalKnowledgeHref, knowledgeHref, sessionHref } from "~/lib/href";

export const ACTIVITY_KIND_UI: Record<
  ActivityKind,
  { label: string; href: (item: ActivityItem) => string }
> = {
  session: {
    label: "Session",
    href: (item) => sessionHref(item.project_id, item.id),
  },
  knowledge: {
    label: "Knowledge",
    href: (item) =>
      item.project_id
        ? knowledgeHref(item.project_id, item.id)
        : globalKnowledgeHref(item.id),
  },
  contradiction: {
    label: "Contradiction",
    href: () => "/contradictions",
  },
  promotion: {
    label: "Promotion",
    href: (item) =>
      item.project_id
        ? knowledgeHref(item.project_id, item.id)
        : globalKnowledgeHref(item.id),
  },
};
