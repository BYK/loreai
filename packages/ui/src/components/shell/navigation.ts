import {
  knowledgeListHref,
  sessionsHref,
  importsHref,
  duplicatesHref,
  searchHref,
  projectHref,
} from "~/lib/href";
import type { IconName } from "./Icon";

export const REVIEW_DESTINATIONS = {
  proposals: {
    label: "Team proposals",
    description: "Review knowledge proposed for your team.",
  },
  instructions: {
    label: "Conflicting instructions",
    description: "Review knowledge entries that give opposing instructions.",
  },
  recovery: {
    label: "Sync recovery",
    description: "Review local knowledge versions replaced by cloud sync.",
  },
} as const;

export const SECONDARY_LINKS: {
  href: string;
  label: string;
  icon: IconName;
  id: string;
  group: string;
}[] = [
  {
    href: "/entities",
    label: "Entities",
    icon: "nodes",
    id: "nav-entities",
    group: "Knowledge tools",
  },
  {
    href: "/contradictions",
    label: REVIEW_DESTINATIONS.instructions.label,
    icon: "warning",
    id: "nav-contradictions",
    group: "Knowledge tools",
  },
  {
    href: "/promotions",
    label: REVIEW_DESTINATIONS.proposals.label,
    icon: "promote",
    id: "nav-promotions",
    group: "Knowledge tools",
  },
  {
    href: "/team",
    label: "Team",
    icon: "users",
    id: "nav-team",
    group: "Collaboration",
  },
  {
    href: "/conflicts",
    label: REVIEW_DESTINATIONS.recovery.label,
    icon: "conflict",
    id: "nav-conflicts",
    group: "Collaboration",
  },
  {
    href: "/warming",
    label: "Cache warming",
    icon: "activity",
    id: "nav-warming",
    group: "Operations",
  },
  {
    href: "/costs",
    label: "Cost intelligence",
    icon: "cost",
    id: "nav-costs",
    group: "Operations",
  },
  {
    href: "/model-usage",
    label: "Model usage",
    icon: "chart",
    id: "nav-model-usage",
    group: "Operations",
  },
];
export const workspacePath = (pathname: string) =>
  pathname.replace(/^\/ui(?=\/|$)/, "") || "/";
export const secondaryPage = (pathname: string) =>
  SECONDARY_LINKS.find(({ href }) => {
    const path = workspacePath(pathname);
    return path === href || path.startsWith(`${href}/`);
  });

/** One destination policy shared by the rail, project picker and context rows. */
export function projectDestination(
  pathname: string,
  search: string,
  projectId: string,
) {
  const path = workspacePath(pathname);
  const params = new URLSearchParams(search);
  if (path.includes("/knowledge")) return knowledgeListHref(projectId);
  if (
    path.includes("/sessions") ||
    (path === "/" && params.get("section") === "sessions")
  )
    return sessionsHref(projectId);
  if (path.includes("/imports")) return importsHref(projectId);
  if (path.includes("/duplicates")) return duplicatesHref(projectId);
  if (path.includes("/search")) {
    const scope = params.get("scope");
    return searchHref(
      projectId,
      params.get("q") ?? "",
      scope === "knowledge" || scope === "session" || scope === "project"
        ? scope
        : "all",
    );
  }
  return projectHref(projectId);
}
