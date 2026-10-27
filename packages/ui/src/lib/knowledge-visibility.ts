import type { KnowledgeScope } from "~/contracts";

// List visibility is independent of recall retrieval scopes.
export const KNOWLEDGE_VISIBILITY: Record<
  KnowledgeScope,
  { label: string; description: string }
> = {
  project: {
    label: "Project-only",
    description: "Entries owned by a project that are not marked as shared.",
  },
  shared: {
    label: "Shared knowledge",
    description: "Shared entries from any project and global knowledge.",
  },
  all: {
    label: "Project + shared",
    description: "This project's entries plus shared and global knowledge.",
  },
};

export function knowledgeVisibilityLabel(
  value: string,
  workspace = false,
): string {
  if (value === "all" && workspace) return "All projects + shared";
  if (value === "project" || value === "shared" || value === "all")
    return KNOWLEDGE_VISIBILITY[value].label;
  return workspace ? "All knowledge" : "This project";
}

export function knowledgeVisibilityDescription(
  value: KnowledgeScope | null,
): string {
  return value
    ? KNOWLEDGE_VISIBILITY[value].description
    : "Entries owned by this project, including ones marked as shared.";
}
