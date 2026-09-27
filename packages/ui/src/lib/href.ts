import type { KnowledgeQuery, RecallScope } from "~/contracts";
import {
  apiPath,
  DEFAULT_KNOWLEDGE_QUERY,
  knowledgeQueryToSearch,
} from "~/contracts";

type HrefQuery = Record<string, string | null | undefined>;

/** `/seg/seg?k=v` via the shared `apiPath` encoder; null/undefined/"" values
 *  are omitted. */
export function buildHref(
  segments: readonly string[],
  query?: HrefQuery,
): string {
  const params: HrefQuery = {};
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== "") {
        params[key] = value;
      }
    }
  }
  return apiPath(segments, params);
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
