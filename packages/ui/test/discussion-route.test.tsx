import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { ApiError, type ApiClient } from "~/lib/api";
import { DiscussionRoute } from "~/routes/Discussion";
import { WorkspaceProvider } from "~/routes/workspace";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("DiscussionRoute", () => {
  it("ignores the outcome of a load superseded by navigation", async () => {
    const loads = new Map<string, ReturnType<typeof deferred<never>>>();
    const client = {
      listProjects: async () => [],
      getDiscussion: (_projectId: string, id: string) => {
        const d = deferred<never>();
        loads.set(id, d);
        return d.promise;
      },
    } as unknown as ApiClient;
    const history = createMemoryHistory();
    history.set({ value: "/projects/p/discussions/a" });
    render(() => (
      <MemoryRouter history={history}>
        <Route
          path="/projects/:projectId/discussions/:discussionId"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <DiscussionRoute />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    await waitFor(() => expect(loads.has("a")).toBe(true));
    history.set({ value: "/projects/p/discussions/b" });
    await waitFor(() => expect(loads.has("b")).toBe(true));

    loads.get("a")?.reject(new ApiError("not_found", "/x", "gone", 404));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Discussion not found")).toBeNull();
    expect(screen.getByText("Loading discussion")).toBeTruthy();

    loads.get("b")?.reject(new ApiError("not_found", "/x", "gone", 404));
    await screen.findByText("Discussion not found");
  });
});
