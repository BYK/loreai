import "./config";
import { type } from "arktype";

import { nonNegInt } from "./primitives";
import { knowledgeEntry } from "./knowledge";
import {
  DEFAULT_KNOWLEDGE_QUERY,
  isDefaultKnowledgeQuery,
  parseKnowledgeQuery,
  type KnowledgeQuery,
} from "./knowledge-query";

export const crossProjectKnowledgeEntry = knowledgeEntry.and({
  project_name: "string | null",
});

export type CrossProjectKnowledgeEntry =
  typeof crossProjectKnowledgeEntry.infer;

export const knowledgeSearchHit = crossProjectKnowledgeEntry.and({
  rank: "number | null",
});

export type KnowledgeSearchHit = typeof knowledgeSearchHit.infer;

export const knowledgeSearchResponse = type({
  query: "string",
  mode: "'fts' | 'like' | 'none'",
  total: nonNegInt,
  items: knowledgeSearchHit.array(),
});

export type KnowledgeSearchResponse = typeof knowledgeSearchResponse.infer;

export type AllKnowledgeQuery = KnowledgeQuery & { project: string | null };

export const DEFAULT_ALL_KNOWLEDGE_QUERY: AllKnowledgeQuery = {
  ...DEFAULT_KNOWLEDGE_QUERY,
  project: null,
};

export function parseAllKnowledgeQuery(
  params: Record<string, string | undefined>,
): AllKnowledgeQuery {
  const project = params.project?.trim() ?? "";
  return {
    ...parseKnowledgeQuery(params),
    project: project.length > 0 && project.length <= 200 ? project : null,
  };
}

export function allKnowledgeQueryToSearch(query: AllKnowledgeQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.scope) params.set("scope", query.scope);
  if (query.project) params.set("project", query.project);
  if (query.sort !== "updated_desc") params.set("sort", query.sort);
  if (query.cursor) params.set("cursor", query.cursor);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function isDefaultAllKnowledgeQuery(query: AllKnowledgeQuery): boolean {
  return query.project === null && isDefaultKnowledgeQuery(query);
}

export function allKnowledgeQueryKey(query: AllKnowledgeQuery): string {
  return `all:${new URLSearchParams({
    project: query.project ?? "",
    q: query.q,
    category: query.category ?? "",
    scope: query.scope ?? "",
    sort: query.sort,
    cursor: query.cursor ?? "",
  }).toString()}`;
}
