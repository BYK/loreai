/**
 * Minimal typed fetch client for the gateway management API.
 *
 * Every response is validated at runtime (Zod) before it reaches a view, and
 * every failure is classified into one of a few `ApiErrorKind`s so the shell
 * can show the right connection state:
 *
 *   - `unreachable`  network failure / gateway down / non-JSON body
 *   - `unauthorized` 401 / 403, or the bodyless 404 the gateway uses to hide
 *                    management routes from non-loopback peers
 *   - `not_found`    a JSON 404 (`{ type: "error", error: {...} }`)
 *   - `invalid`      2xx whose body failed validation
 *   - `http`         any other non-2xx
 *
 * Kept intentionally small; UI-03 grows it (IndexedDB cache, more routes).
 */
import type { z } from "zod";

import {
  apiErrorSchema,
  knowledgeEntrySchema,
  knowledgeListSchema,
  projectListSchema,
  type KnowledgeEntry,
  type ProjectSummary,
} from "./schemas";

export const API_BASE = "/api/v1";

export type ApiErrorKind =
  | "unreachable"
  | "unauthorized"
  | "not_found"
  | "invalid"
  | "http";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly path: string;

  constructor(
    kind: ApiErrorKind,
    path: string,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.path = path;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** True for any abort rejection (`DOMException`, `Error`, or a custom `abort(reason)`). */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ApiClientOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Path prefix, defaults to `/api/v1` (same-origin; the Vite dev server proxies it). */
  base?: string;
}

async function readErrorMessage(res: Response): Promise<string | null> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    const parsed = apiErrorSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error.message : text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

export function createApiClient(options: ApiClientOptions = {}) {
  const base = options.base ?? API_BASE;
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function getJson<S extends z.ZodType>(
    path: string,
    schema: S,
    signal?: AbortSignal,
  ): Promise<z.output<S>> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError("unreachable", path, "Gateway unreachable");
    }

    if (res.status === 401 || res.status === 403) {
      throw new ApiError(
        "unauthorized",
        path,
        "Gateway refused this browser",
        res.status,
      );
    }

    if (!res.ok) {
      const message = await readErrorMessage(res);
      if (res.status === 404) {
        // A bodyless 404 is the management-boundary denial; a JSON 404 is a
        // real "no such record".
        if (message === null) {
          throw new ApiError(
            "unauthorized",
            path,
            "Gateway hid this route from the current peer",
            404,
          );
        }
        throw new ApiError("not_found", path, message, 404);
      }
      throw new ApiError(
        "http",
        path,
        message ?? `Gateway responded ${res.status}`,
        res.status,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ApiError(
        "unreachable",
        path,
        "Gateway returned a non-JSON response",
        res.status,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        "invalid",
        path,
        `Unexpected response shape from ${path}`,
        res.status,
      );
    }
    return parsed.data;
  }

  return {
    listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
      return getJson("/projects", projectListSchema, signal);
    },
    listProjectKnowledge(
      projectId: string,
      signal?: AbortSignal,
    ): Promise<KnowledgeEntry[]> {
      return getJson(
        `/projects/${encodeURIComponent(projectId)}/knowledge`,
        knowledgeListSchema,
        signal,
      );
    },
    getKnowledge(id: string, signal?: AbortSignal): Promise<KnowledgeEntry> {
      return getJson(
        `/knowledge/${encodeURIComponent(id)}`,
        knowledgeEntrySchema,
        signal,
      );
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api: ApiClient = createApiClient();
