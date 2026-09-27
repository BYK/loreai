import type { KnowledgeQuery, RecallScope } from "~/contracts";
import { DEFAULT_KNOWLEDGE_QUERY, knowledgeQueryToSearch } from "~/contracts";

type HrefQuery = Record<string, string | null | undefined>;

/** `/seg/seg?k=v` with every segment and value `encodeURIComponent`-encoded;
 *  null/undefined/"" values are omitted. */
export function buildHref(
  segments: readonly string[],
  query?: HrefQuery,
): string {
  const path = `/${segments.map(encodeURIComponent).join("/")}`;
  if (!query) return path;
  const params = Object.entries(query)
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== null && entry[1] !== undefined && entry[1] !== "",
    )
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return params ? `${path}?${params}` : path;
}

export const projectHref = (projectId: string) =>
  buildHref(["projects", projectId]);

export const knowledgeListHref = (
  projectId: string,
  query: KnowledgeQuery = DEFAULT_KNOWLEDGE_QUERY,
) =>
  buildHref(["projects", projectId, "knowledge"]) +
  knowledgeQueryToSearch(query);

export const knowledgeHref = (
  projectId: string,
  knowledgeId: string,
  query?: KnowledgeQuery,
) =>
  buildHref(["projects", projectId, "knowledge", knowledgeId]) +
  (query ? knowledgeQueryToSearch(query) : "");

export const sessionsHref = (projectId: string, cursor?: string | null) =>
  buildHref(["projects", projectId, "sessions"], { cursor });

export const importsHref = (projectId: string, cursor?: string | null) =>
  buildHref(["projects", projectId, "imports"], { cursor });

export const sessionHref = (projectId: string, sessionId: string) =>
  buildHref(["projects", projectId, "sessions", sessionId]);

export const searchHref = (
  projectId: string,
  q: string,
  scope: RecallScope = "all",
) => buildHref(["projects", projectId, "search"], { q, scope });

export const entityHref = (id: string) => buildHref(["entities", id]);

export const entitiesHref = (type?: string | null, cursor?: string | null) =>
  buildHref(["entities"], { type, cursor });
