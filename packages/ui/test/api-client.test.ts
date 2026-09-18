import { describe, expect, it } from "vitest";

import { ApiError, createApiClient, isApiError } from "~/lib/api";
import { createConnectionStore } from "~/lib/connection";

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

  it("tolerates a malformed count instead of rejecting the whole list", async () => {
    const { client } = clientFor(() =>
      json([{ ...PROJECT, knowledge_count: -4 }]),
    );
    const [project] = await client.listProjects();
    expect(project?.knowledge_count).toBe(0);
  });
});

describe("api client: error classification", () => {
  it("rejects a 2xx body that does not match the schema as `invalid`", async () => {
    const { client } = clientFor(() => json([{ nope: true }]));
    const error = await failure(client.listProjects());
    expect(error.kind).toBe("invalid");
    expect(error.status).toBe(200);
  });

  it("rejects a knowledge entry without an id as `invalid`", async () => {
    const { client } = clientFor(() => json({ ...ENTRY, id: "" }));
    expect((await failure(client.getKnowledge("x"))).kind).toBe("invalid");
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

  it.each([401, 403])("classifies %s as `unauthorized`", async (status) => {
    const { client } = clientFor(() => new Response(null, { status }));
    const error = await failure(client.listProjects());
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(status);
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
