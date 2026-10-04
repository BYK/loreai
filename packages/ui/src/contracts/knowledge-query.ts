import type { KnowledgeCategory } from "./knowledge";

export const KNOWLEDGE_CATEGORIES = [
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
] as const;
export const KNOWLEDGE_SCOPES = ["project", "shared", "all"] as const;

export type KnowledgeSortField =
  | "updated_at"
  | "created_at"
  | "confidence"
  | "title";
export type KnowledgeSortKey = {
  field: KnowledgeSortField;
  dir: "asc" | "desc";
};
export type KnowledgeSort = readonly KnowledgeSortKey[];

export const DEFAULT_KNOWLEDGE_SORT: KnowledgeSort = [
  { field: "updated_at", dir: "desc" },
];
const DEFAULT_KNOWLEDGE_SORT_TEXT = "updated_at:desc";
const SORT_FIELDS = new Set<KnowledgeSortField>([
  "updated_at",
  "created_at",
  "confidence",
  "title",
]);

export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

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
  sort: DEFAULT_KNOWLEDGE_SORT,
  cursor: null,
};
export const KNOWLEDGE_PAGE_SIZE = 50;

function oneOf<T extends readonly string[]>(
  value: string | undefined,
  choices: T,
): T[number] | null {
  return value && (choices as readonly string[]).includes(value) ? value : null;
}

export function parseKnowledgeSort(raw: string): KnowledgeSort | null {
  const terms = raw.split(",");
  if (raw.length === 0 || terms.length > 3) return null;
  const seen = new Set<KnowledgeSortField>();
  const sort: KnowledgeSortKey[] = [];
  for (const term of terms) {
    const match = /^(updated_at|created_at|confidence|title):(asc|desc)$/.exec(
      term,
    );
    if (!match) return null;
    const field = match[1] as KnowledgeSortField;
    if (!SORT_FIELDS.has(field) || seen.has(field)) return null;
    seen.add(field);
    sort.push({ field, dir: match[2] as KnowledgeSortKey["dir"] });
  }
  return sort;
}

export function formatKnowledgeSort(sort: KnowledgeSort): string {
  return sort.map(({ field, dir }) => `${field}:${dir}`).join(",");
}

export function parseKnowledgeQuery(
  params: Record<string, string | undefined>,
): KnowledgeQuery {
  const sort = parseKnowledgeSort(params.sort ?? "") ?? DEFAULT_KNOWLEDGE_SORT;
  return {
    q: (params.q ?? "").trim().slice(0, 500),
    category: oneOf(params.category, KNOWLEDGE_CATEGORIES),
    scope: oneOf(params.scope, KNOWLEDGE_SCOPES),
    sort,
    cursor: params.cursor || null,
  };
}

export function knowledgeQueryToSearch(query: KnowledgeQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.scope) params.set("scope", query.scope);
  const sort = formatKnowledgeSort(query.sort);
  if (sort !== DEFAULT_KNOWLEDGE_SORT_TEXT) params.set("sort", sort);
  if (query.cursor) params.set("cursor", query.cursor);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function isDefaultKnowledgeQuery(query: KnowledgeQuery): boolean {
  return (
    query.q === "" &&
    query.category === null &&
    query.scope === null &&
    formatKnowledgeSort(query.sort) === DEFAULT_KNOWLEDGE_SORT_TEXT &&
    query.cursor === null
  );
}

export function knowledgeQueryKey(
  projectId: string,
  query: KnowledgeQuery,
): string {
  const params = new URLSearchParams({
    projectId,
    q: query.q,
    category: query.category ?? "",
    scope: query.scope ?? "",
    sort: formatKnowledgeSort(query.sort),
    cursor: query.cursor ?? "",
  });
  return params.toString();
}
