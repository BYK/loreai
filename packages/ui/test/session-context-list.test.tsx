import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { SessionContextList } from "~/components/lore/SessionContextList";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";

it("filters and pages sessions without losing the reader route or anchor, and encodes links", async () => {
  const calls: Array<{ q?: string | null; cursor?: string | null }> = [];
  const history = createMemoryHistory();
  history.set({
    value: "/projects/p-1/sessions/selected?a=source-anchor&cursor=old",
  });
  const client = {
    listProjects: async () => [],
    listProjectSessionsPage: async (
      _id: string,
      opts: { q?: string | null; cursor?: string | null },
    ) => {
      calls.push(opts);
      return {
        items: [
          {
            session_id: "s/?#",
            title: "A session",
            title_source: "first_message",
            message_count: 2,
            last_message_at: 1,
          },
        ],
        next_cursor: "next/?#",
      };
    },
  } as unknown as ApiClient;
  render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={Promise.resolve(null)}>
            <SessionContextList projectId="p-1" sessionId="selected" />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
  await screen.findByTestId("context-session");
  const input = screen.getByRole("searchbox", { name: "Filter session list" });
  fireEvent.input(input, { target: { value: "title & details" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(calls.at(-1)).toMatchObject({ q: "title & details", cursor: null }),
  );
  let route = new URL(history.get(), "http://local");
  expect(route.pathname).toBe("/projects/p-1/sessions/selected");
  expect(route.searchParams.get("a")).toBe("source-anchor");
  expect(route.searchParams.has("cursor")).toBe(false);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(calls.at(-1)).toMatchObject({
      q: "title & details",
      cursor: "next/?#",
    }),
  );
  route = new URL(history.get(), "http://local");
  expect(route.searchParams.get("a")).toBe("source-anchor");
  const link = new URL(
    (await screen.findByTestId("context-session")).getAttribute("href")!,
    "http://local",
  );
  expect(link.pathname).toBe("/projects/p-1/sessions/s%2F%3F%23");
  expect(link.searchParams.get("q")).toBe("title & details");
  expect(link.searchParams.get("cursor")).toBe("next/?#");
  expect(link.searchParams.has("a")).toBe(false);
});

it("offers capture guidance and resets an empty reader filter without losing its anchor", async () => {
  const history = createMemoryHistory();
  history.set({
    value: "/projects/p-1/sessions/selected?a=source&q=missing&cursor=old",
  });
  const client = {
    listProjects: async () => [],
    listProjectSessionsPage: async () => ({ items: [], next_cursor: null }),
  } as unknown as ApiClient;
  render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={Promise.resolve(null)}>
            <SessionContextList projectId="p-1" sessionId="selected" />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
  fireEvent.click(await screen.findByRole("button", { name: "Clear filter" }));
  await waitFor(() =>
    expect(history.get()).toBe("/projects/p-1/sessions/selected?a=source"),
  );
  expect(
    await screen.findByText(/capture an agent conversation/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "View import history" }),
  ).toHaveAttribute("href", "/projects/p-1/imports");
});
