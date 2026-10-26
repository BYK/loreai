import { RECALL_SCOPES, type RecallScope } from "~/contracts";

export const LIST_FILTER_LABEL = "Filter this list";
export const PROJECT_MEMORY_SEARCH_LABEL = "Search this project's memory";
export const WORKSPACE_KNOWLEDGE_SEARCH_LABEL =
  "Search knowledge across projects";
export const WORKSPACE_KNOWLEDGE_SEARCH_DESCRIPTION =
  "Knowledge only. Search a project's memory to include its conversations and summaries.";

// Recall retrieval scopes differ from KnowledgeScope's list visibility filters.
// The UI supplies no session ID, so session searches all this project's history.
export const RECALL_SCOPE_DETAILS: Record<
  RecallScope,
  { label: string; description: string }
> = {
  all: {
    label: "All memory",
    description:
      "Project conversations, summaries, knowledge, entities and recorded memory files, plus knowledge and repository discovery from other projects.",
  },
  session: {
    label: "Conversation history",
    description:
      "Messages and summaries across this project's sessions. No single session is selected.",
  },
  project: {
    label: "Project memory",
    description:
      "This project's conversations and summaries, visible knowledge and entities, and recorded memory files. Excludes other-project discovery.",
  },
  knowledge: {
    label: "Knowledge and memory files",
    description:
      "Knowledge visible to this project and recorded memory files. Excludes conversation history and entities.",
  },
};

export function recallScopeLabel(value: string): string {
  return RECALL_SCOPES.includes(value as RecallScope)
    ? RECALL_SCOPE_DETAILS[value as RecallScope].label
    : "All memory";
}
