/**
 * Session reader route header (#1921): the DocHeader shows the derived
 * session title plus a copyable id chip instead of the raw session id.
 */
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { Session } from "~/routes/Session";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";
import type { ProjectSummary, SessionPage } from "~/contracts";

const project: ProjectSummary = {
  id: "p-1",
  path: "/tmp/project",
  name: "project",
  git_remote: null,
  created_at: 1,
  knowledge_count: 0,
  session_count: 1,
  message_count: 1,
  distillation_count: 0,
  last_activity: null,
};

const pageWith = (over: Partial<SessionPage>): SessionPage => ({
  messages: [],
  distillations: [],
  next_cursor: null,
  message_count: 1,
  title: "s-1",
  title_source: "id",
  ...over,
});

const clientWith = (page: SessionPage) =>
  ({
    listProjects: async () => [project],
    getSessionPage: async () => page,
  }) as unknown as ApiClient;

const renderSession = (page: SessionPage) => {
  const history = createMemoryHistory();
  history.set({ value: "/projects/p-1/sessions/s-1" });
  render(() => (
    <MemoryRouter history={history}>
      <Route
        path="/projects/:projectId/sessions/:sessionId"
        component={() => (
          <WorkspaceProvider
            client={clientWith(page)}
            db={Promise.resolve(null)}
          >
            <Session />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
};

describe("Session route header", () => {
  it("shows the derived title and the copyable id chip", async () => {
    renderSession(
      pageWith({
        title: "Refactor the sync outbox pruning",
        title_source: "first_message",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Refactor the sync outbox pruning"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Copy session id" }),
    ).toBeInTheDocument();
  });

  it("falls back to the id-based title when the answer carries no title", async () => {
    renderSession(pageWith({}));
    await waitFor(() =>
      expect(screen.getByText("Session s-1")).toBeInTheDocument(),
    );
  });
});
