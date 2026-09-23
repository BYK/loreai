import { describe, expect, it } from "vitest";

import { apiPath, query } from "~/contracts";
import {
  ApiError,
  createApiClient,
  isAbortError,
  isApiError,
  isContractError,
} from "~/lib/api";
import { createConnectionStore } from "~/lib/connection";

describe("apiPath / query", () => {
  it("encodes each segment as one path component and drops unset params", () => {
    expect(apiPath(["sessions", "a/b c?d", "search"])).toBe(
      "/sessions/a%2Fb%20c%3Fd/search",
    );
    expect(
      apiPath(["recall"], {
        q: "a&b=c",
        path: "/home/x y",
        limit: 1,
        expand: false,
        cursor: null,
        page: undefined,
      }),
    ).toBe("/recall?q=a%26b%3Dc&path=%2Fhome%2Fx+y&limit=1&expand=false");
    expect(query({})).toBe("");
    expect(query({ a: null })).toBe("");
  });
});

const PROJECT = {
  id: "p1",
  path: "/home/me/lore",
  name: "lore",
  git_remote: "github.com/BYK/loreai",
  created_at: Date.UTC(2026, 8, 1, 10),
  knowledge_count: 3,
  session_count: 2,
  message_count: 40,
  distillation_count: 1,
};

const ENTRY = {
  id: "019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
  logical_id: "019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
  project_id: "p1",
  category: "decision",
  title: "Keep SQLite",
  content: "Portability is a requirement.",
  confidence: 0.9,
  cross_project: 0,
  created_at: Date.UTC(2026, 8, 1, 10),
  updated_at: Date.UTC(2026, 8, 2, 10),
  metadata: null,
  tenant_id: "local",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientFor(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const client = createApiClient({
    fetch: async (url) => {
      calls.push(url);
      return handler(url);
    },
  });
  return { client, calls };
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error)) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("api client: happy path", () => {
  it("recalls with expansion disabled and project identity", async () => {
    const { client, calls } = clientFor(() =>
      json({
        query: "sqlite",
        scope: "knowledge",
        projectPath: "/p",
        result: "## Results",
      }),
    );
    await client.recall({
      q: "sqlite",
      project: { path: "/p", git_remote: null },
      scope: "knowledge",
      limit: 100,
      session: "s 1",
    });
    expect(calls[0]).toBe(
      "/api/v1/recall?q=sqlite&scope=knowledge&expand=false&limit=50&path=%2Fp&session=s+1",
    );
  });

  it("lists projects from /api/v1/projects and validates the rows", async () => {
    const { client, calls } = clientFor(() => json([PROJECT]));
    const projects = await client.listProjects();
    expect(calls).toEqual(["/api/v1/projects"]);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.knowledge_count).toBe(3);
  });

  it("URL-encodes ids and keeps unknown fields (core stays authoritative)", async () => {
    const { client, calls } = clientFor(() =>
      json({ ...ENTRY, some_future_field: "kept" }),
    );
    const entry = await client.getKnowledge("a/b c");
    expect(calls).toEqual(["/api/v1/knowledge/a%2Fb%20c"]);
    expect(entry.id).toBe(ENTRY.id);
    expect((entry as Record<string, unknown>).some_future_field).toBe("kept");
  });

  it("lists project knowledge with the project id encoded", async () => {
    const { client, calls } = clientFor(() => json([ENTRY]));
    await client.listProjectKnowledge("p 1");
    expect(calls).toEqual(["/api/v1/projects/p%201/knowledge"]);
  });

  // Spec change (UI-03): mistyped fields are contract violations, not
  // silently repaired — the old `.catch(0)` coercion is gone.
  it("rejects a malformed count as a contract error", async () => {
    const { client } = clientFor(() =>
      json([{ ...PROJECT, knowledge_count: -4 }]),
    );
    const error = await failure(client.listProjects());
    expect(error.kind).toBe("invalid");
    expect(isContractError(error)).toBe(true);
    if (isContractError(error)) {
      expect(error.issues.length).toBeGreaterThan(0);
      expect(error.issues[0]?.path).toContain("knowledge_count");
      expect(error.route).toBe("/projects");
    }
  });
});

describe("api client: error classification", () => {
  it("rejects a 2xx body that does not match the contract as `invalid`", async () => {
    const { client } = clientFor(() => json([{ nope: true }]));
    const error = await failure(client.listProjects());
    expect(error.kind).toBe("invalid");
    expect(error.status).toBe(200);
    expect(isContractError(error)).toBe(true);
    if (isContractError(error)) {
      expect(error.issues.length).toBeGreaterThan(0);
      expect(error.route).toBe("/projects");
    }
  });

  it("rejects a knowledge entry without an id as `invalid`", async () => {
    const { client } = clientFor(() => json({ ...ENTRY, id: "" }));
    const error = await failure(client.getKnowledge("x"));
    expect(error.kind).toBe("invalid");
    expect(isContractError(error)).toBe(true);
  });

  it("classifies network failures as `unreachable`", async () => {
    const { client } = clientFor(() => {
      throw new TypeError("Failed to fetch");
    });
    const error = await failure(client.listProjects());
    expect(error.kind).toBe("unreachable");
    expect(error.status).toBeNull();
  });

  it("classifies a non-JSON 200 (e.g. a captive portal) as `unreachable`", async () => {
    const { client } = clientFor(
      () => new Response("<html>login</html>", { status: 200 }),
    );
    expect((await failure(client.listProjects())).kind).toBe("unreachable");
  });

  it.each([502, 503, 504])(
    "classifies proxy status %s as `unreachable`",
    async (status) => {
      const { client } = clientFor(() => new Response(null, { status }));
      const error = await failure(client.listProjects());
      expect(error.kind).toBe("unreachable");
      expect(error.status).toBe(status);
    },
  );

  it.each([401, 403])("classifies %s as `unauthorized`", async (status) => {
    const { client } = clientFor(() => new Response(null, { status }));
    const error = await failure(client.listProjects());
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(status);
  });

  it("treats a JSON-bodied 403 as `forbidden` (hosted-mode refusal)", async () => {
    const { client } = clientFor(() =>
      json(
        {
          type: "error",
          error: { type: "forbidden", message: "Not available in hosted mode" },
        },
        403,
      ),
    );
    const error = await failure(client.deleteEntity("e1"));
    expect(error.kind).toBe("forbidden");
    expect(error.status).toBe(403);
    expect(error.message).toBe("Not available in hosted mode");
  });

  it("sends PATCH with a JSON body for entity metadata updates", async () => {
    const seen: { method?: string; body?: string; ct?: string } = {};
    const detail = {
      entity: {
        id: "e1",
        entity_type: "person",
        canonical_name: "Ada",
        project_id: null,
        cross_project: true,
        aliases: [],
        created_at: 1700000000000,
        updated_at: 1700000000000,
        metadata: { role: "x" },
      },
      relations: [],
      knowledge: [],
    };
    const client = createApiClient({
      fetch: async (_url, init) => {
        seen.method = init?.method;
        seen.body = init?.body as string;
        seen.ct = new Headers(init?.headers).get("content-type") ?? undefined;
        return json(detail);
      },
    });
    const updated = await client.updateEntityMetadata("e1", { role: "x" });
    expect(seen.method).toBe("PATCH");
    expect(seen.body).toBe(JSON.stringify({ role: "x" }));
    expect(seen.ct).toBe("application/json");
    expect(updated.entity.metadata).toEqual({ role: "x" });
  });

  it("treats the gateway's bodyless 404 (hidden management route) as `unauthorized`", async () => {
    const { client } = clientFor(() => new Response(null, { status: 404 }));
    expect((await failure(client.listProjects())).kind).toBe("unauthorized");
  });

  it("treats a JSON 404 as `not_found` with the gateway's message", async () => {
    const { client } = clientFor(() =>
      json(
        {
          type: "error",
          error: { type: "not_found", message: "Knowledge entry not found" },
        },
        404,
      ),
    );
    const error = await failure(client.getKnowledge("missing"));
    expect(error.kind).toBe("not_found");
    expect(error.message).toBe("Knowledge entry not found");
  });

  it("reports other statuses as `http` with the body message when present", async () => {
    const { client } = clientFor(() =>
      json(
        { type: "error", error: { type: "api_error", message: "db locked" } },
        500,
      ),
    );
    const error = await failure(client.listProjects());
    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
    expect(error.message).toBe("db locked");
  });

  it("requests the cursor page with ?page=cursor and ?cursor=…", async () => {
    const page = { items: [ENTRY], next_cursor: null };
    const { client, calls } = clientFor(() => json(page));
    const first = await client.listProjectKnowledgePage("p 1", {});
    expect(calls).toEqual(["/api/v1/projects/p%201/knowledge?page=cursor"]);
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toBeNull();

    await client.listProjectKnowledgePage("p1", { cursor: "tok en" });
    expect(calls[1]).toBe(
      "/api/v1/projects/p1/knowledge?page=cursor&cursor=tok+en",
    );
  });

  it("requests knowledge versions with include_deleted", async () => {
    const history = {
      id: "logical-1",
      current_version_id: "v-2",
      versions: [
        {
          version_id: "v-1",
          version: 1,
          created_at: Date.UTC(2026, 8, 1, 10),
          superseded_at: Date.UTC(2026, 8, 2, 10),
          is_current: false,
          is_deleted: false,
          title: "Keep SQLite",
          content: "Portability is a requirement.",
          category: "decision",
          confidence: 0.9,
          scope: "project",
          cross_project: false,
          source_refs: {
            session_id: "s-42",
            entry_id: null,
            user_id: null,
            created_by: null,
            updated_by: null,
            worker_provider_id: null,
            worker_model_id: null,
          },
        },
      ],
    };
    const { client, calls } = clientFor(() => json(history));
    const result = await client.listKnowledgeVersions("a/b", {
      includeDeleted: true,
    });
    expect(calls).toEqual([
      "/api/v1/knowledge/a%2Fb/versions?include_deleted=true",
    ]);
    expect(result.versions[0]?.version_id).toBe("v-1");
  });

  it("lists project sessions and fetches a session detail via ?path=", async () => {
    const session = {
      session_id: "s-1",
      message_count: 2,
      first_message_at: Date.UTC(2026, 8, 1, 10),
      last_message_at: Date.UTC(2026, 8, 1, 11),
      distilled_count: 1,
      undistilled_count: 1,
      distillation_count: 0,
    };
    const detail = {
      messages: [
        {
          id: "m-1",
          project_id: "p1",
          session_id: "s-1",
          role: "user",
          content: "hi",
          tokens: 3,
          distilled: 0,
          created_at: Date.UTC(2026, 8, 1, 10),
          metadata: "{}",
        },
      ],
      distillations: [],
    };
    const { client, calls } = clientFor((url) =>
      json(url.includes("/sessions/") ? detail : [session]),
    );
    const sessions = await client.listProjectSessions("p 1");
    expect(calls[0]).toBe("/api/v1/projects/p%201/sessions");
    expect(sessions[0]?.session_id).toBe("s-1");
    const got = await client.getSession("/home/me/lore", "s 1");
    expect(calls[1]).toBe("/api/v1/sessions/s%201?path=%2Fhome%2Fme%2Flore");
    expect(got.messages).toHaveLength(1);
  });

  it("reads the folk status routes", async () => {
    const { client, calls } = clientFor((url) => {
      if (url.endsWith("/account")) {
        return json({
          signed_in: false,
          user: null,
          provider: null,
          expires_at: null,
          state: "anonymous",
        });
      }
      if (url.endsWith("/teams")) return json({ teams: [] });
      if (url.endsWith("/sync/status")) {
        return json({
          enabled: false,
          state: "disabled",
          pending_changes: null,
        });
      }
      return json({
        linked: false,
        team: null,
        policy: {
          effective: "manual",
          project_override: null,
          team_default: null,
        },
        state: "not_linked",
        detail: null,
      });
    });
    expect((await client.getAccount()).state).toBe("anonymous");
    expect((await client.getTeams()).teams).toEqual([]);
    expect((await client.getSyncStatus()).enabled).toBe(false);
    expect((await client.getProjectSharing("p1")).state).toBe("not_linked");
    expect(calls).toEqual([
      "/api/v1/account",
      "/api/v1/teams",
      "/api/v1/sync/status",
      "/api/v1/projects/p1/sharing",
    ]);
  });

  it("lists project distillations and fetches one detail", async () => {
    const summary = {
      id: "d-1",
      session_id: "s-1",
      generation: 0,
      token_count: 1200,
      r_compression: 0.4,
      c_norm: null,
      archived: 0,
      created_at: Date.UTC(2026, 8, 1, 10),
      call_type: "observer",
    };
    const detail = {
      ...summary,
      project_id: "p1",
      observations: "obs",
      source_ids: "m-1,m-2",
    };
    const { client, calls } = clientFor((url) =>
      json(url.includes("/distillations/d") ? detail : [summary]),
    );
    expect((await client.listProjectDistillations("p1"))[0]?.id).toBe("d-1");
    expect((await client.getDistillation("d-1")).observations).toBe("obs");
    expect(calls).toEqual([
      "/api/v1/projects/p1/distillations",
      "/api/v1/distillations/d-1",
    ]);
  });

  it("propagates aborts untouched so callers can ignore them", async () => {
    const controller = new AbortController();
    const { client } = clientFor(() => {
      throw new DOMException("aborted", "AbortError");
    });
    controller.abort();
    await expect(client.listProjects(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("propagates a custom abort reason untouched instead of calling it unreachable", async () => {
    const controller = new AbortController();
    const reason = { name: "AbortError", why: "navigated away" };
    const { client } = clientFor(() => {
      throw reason;
    });
    controller.abort(reason);
    await expect(client.listProjects(controller.signal)).rejects.toBe(reason);
  });

  it("recognises aborts by name regardless of the error class", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    const named = new Error("aborted");
    named.name = "AbortError";
    expect(isAbortError(named)).toBe(true);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe("connection store", () => {
  it("starts as checking and follows read outcomes", () => {
    const store = createConnectionStore();
    expect(store.state()).toBe("checking");
    store.markReachable();
    expect(store.state()).toBe("reachable");
    store.markError(new ApiError("unreachable", "/projects", "down"));
    expect(store.state()).toBe("unreachable");
    expect(store.detail()).toBe("down");
    store.markError(new ApiError("unauthorized", "/projects", "hidden", 404));
    expect(store.state()).toBe("unauthorized");
  });

  it("does not flip to an error state for a single missing record", () => {
    const store = createConnectionStore();
    store.markError(new ApiError("not_found", "/knowledge/x", "nope", 404));
    expect(store.state()).toBe("reachable");
    store.markError(new ApiError("invalid", "/knowledge/x", "shape", 200));
    expect(store.state()).toBe("reachable");
  });

  it("treats unknown errors as unreachable", () => {
    const store = createConnectionStore();
    store.markError(new Error("boom"));
    expect(store.state()).toBe("unreachable");
    expect(store.detail()).toBe("boom");
  });
});
