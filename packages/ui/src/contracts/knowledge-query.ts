export const KNOWLEDGE_CATEGORIES = [
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
] as const;
export const KNOWLEDGE_SCOPES = ["project", "global", "all"] as const;
export const KNOWLEDGE_SORTS = [
  "updated_desc",
  "created_desc",
  "confidence_desc",
  "title_asc",
] as const;

import type { KnowledgeCategory } from "./knowledge";
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];
export type KnowledgeSort = (typeof KNOWLEDGE_SORTS)[number];

export interface KnowledgeQuery {
  q: string;
  category: KnowledgeCategory | null;
  scope: KnowledgeScope | null;
  sort: KnowledgeSort;
  cursor: string | null;
}

export const DEFAULT_KNOWLEDGE_QUERY: KnowledgeQuery = {
  q: "",
  category: null,
  scope: null,
  sort: "updated_desc",
  cursor: null,
};
export const KNOWLEDGE_PAGE_SIZE = 50;

function oneOf<T extends readonly string[]>(
  value: string | undefined,
  choices: T,
): T[number] | null {
  return value && (choices as readonly string[]).includes(value) ? value : null;
}

export function parseKnowledgeQuery(
  params: Record<string, string | undefined>,
): KnowledgeQuery {
  const sort = oneOf(params.sort, KNOWLEDGE_SORTS) ?? "updated_desc";
  return {
    q: (params.q ?? "").trim().slice(0, 500),
    category: oneOf(params.category, KNOWLEDGE_CATEGORIES),
    scope: oneOf(params.scope, KNOWLEDGE_SCOPES),
    sort,
    cursor: params.cursor || null,
  };
}

export function knowledgeQueryToSearch(query: KnowledgeQuery): string {
  const fields: string[] = [];
  if (query.q) fields.push(`q=${encodeURIComponent(query.q)}`);
  if (query.category)
    fields.push(`category=${encodeURIComponent(query.category)}`);
  if (query.scope) fields.push(`scope=${encodeURIComponent(query.scope)}`);
  if (query.sort !== "updated_desc")
    fields.push(`sort=${encodeURIComponent(query.sort)}`);
  if (query.cursor) fields.push(`cursor=${encodeURIComponent(query.cursor)}`);
  return fields.length ? `?${fields.join("&")}` : "";
}

export function isDefaultKnowledgeQuery(query: KnowledgeQuery): boolean {
  return (
    query.q === "" &&
    query.category === null &&
    query.scope === null &&
    query.sort === "updated_desc" &&
    query.cursor === null
  );
}

export function knowledgeQueryKey(
  projectId: string,
  query: KnowledgeQuery,
): string {
  return `${projectId}${knowledgeQueryToSearch(query)}`;
}
