import type { ProjectSummary } from "~/contracts";
import { byRecency } from "~/components/shell/nav-projects";

export type DirectorySort = "recent" | "name" | "knowledge";
export interface DirectoryProjects {
  repositories: { remote: string; projects: ProjectSummary[] }[];
  local: ProjectSummary[];
  unattributed: ProjectSummary[];
}

/** Presentation only: exact recorded remotes group checkouts without merging records. */
export function directoryProjects(
  projects: readonly ProjectSummary[],
  filter: string,
  sort: DirectorySort,
): DirectoryProjects {
  const query = filter.trim().toLowerCase();
  const name = (p: ProjectSummary) => p.name || p.path;
  const compare = (a: ProjectSummary, b: ProjectSummary) =>
    (sort === "name"
      ? name(a).localeCompare(name(b))
      : sort === "knowledge"
        ? b.knowledge_count - a.knowledge_count || byRecency(a, b)
        : byRecency(a, b)) || a.id.localeCompare(b.id);
  // Filter every checkout, including older children, before building any groups.
  const visible = projects
    .filter(
      (p) =>
        !query ||
        `${p.name ?? ""} ${p.path} ${p.git_remote ?? ""}`
          .toLowerCase()
          .includes(query),
    )
    .sort(compare);
  const result: DirectoryProjects = {
    repositories: [],
    local: [],
    unattributed: [],
  };
  const remotes = new Map<string, ProjectSummary[]>();
  for (const project of visible) {
    // Mirrors core's recorded synthetic-path convention; names are never identity.
    if (
      project.path === "/__lore_unattributed__" ||
      project.path.startsWith("/__lore_unattributed__/")
    ) {
      result.unattributed.push(project);
    } else if (project.git_remote?.trim()) {
      const children = remotes.get(project.git_remote);
      if (children) children.push(project);
      else remotes.set(project.git_remote, [project]);
    } else result.local.push(project);
  }
  // Insertion order follows the first matching checkout in the chosen sort.
  result.repositories = [...remotes].map(([remote, children]) => ({
    remote,
    projects: children,
  }));
  return result;
}
