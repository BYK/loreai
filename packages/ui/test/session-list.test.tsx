import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { SessionList } from "~/components/lore/SessionList";
import type { SessionSummary } from "~/contracts";

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  session_id: "s-1",
  message_count: 1,
  distilled_count: 1,
  distillation_count: 1,
  undistilled_count: 0,
  first_message_at: 1,
  last_message_at: 2,
  title: "Session one",
  title_source: "first_message" as const,
  ...over,
});

const renderList = (
  data: () =>
    | { items: SessionSummary[]; next_cursor: string | null }
    | undefined,
  q: string | null = null,
) => {
  const history = createMemoryHistory();
  history.set({ value: "/projects/p-1/sessions" });
  render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <SessionList
            projectId="p-1"
            cursor={null}
            q={q}
            page={{
              loader: {
                data,
                loading: () => false,
                error: () => undefined,
                reload: vi.fn(),
              },
              status: () => ({}),
            }}
          />
        )}
      />
    </MemoryRouter>
  ));
  return history;
};

describe("SessionList", () => {
  it("renders an empty project session state", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <SessionList
              projectId="p-1"
              cursor={null}
              page={{
                loader: {
                  data: () => ({ items: [], next_cursor: null }),
                  loading: () => false,
                  error: () => undefined,
                  reload: vi.fn(),
                },
                status: () => ({}),
              }}
            />
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByText("No captured sessions")).toBeInTheDocument();
  });

  it("renders the next-page control", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <SessionList
              projectId="p-1"
              cursor={null}
              page={{
                loader: {
                  data: () => ({ items: [], next_cursor: "next" }),
                  loading: () => false,
                  error: () => undefined,
                  reload: vi.fn(),
                },
                status: () => ({}),
              }}
            />
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("renders first-page when a cursor is active", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <SessionList
              projectId="p-1"
              cursor="previous"
              page={{
                loader: {
                  data: () => ({ items: [], next_cursor: null }),
                  loading: () => false,
                  error: () => undefined,
                  reload: vi.fn(),
                },
                status: () => ({}),
              }}
            />
          )}
        />
      </MemoryRouter>
    ));
    expect(
      screen.getByRole("button", { name: "First page" }),
    ).toBeInTheDocument();
  });

  it("renders session rows as project links", () => {
    const session = {
      session_id: "s-1",
      message_count: 1,
      distilled_count: 1,
      distillation_count: 1,
      undistilled_count: 0,
      first_message_at: 1,
      last_message_at: 2,
      title: "Session one",
      title_source: "first_message" as const,
    };
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <SessionList
              projectId="p-1"
              cursor={null}
              page={{
                loader: {
                  data: () => ({ items: [session], next_cursor: null }),
                  loading: () => false,
                  error: () => undefined,
                  reload: vi.fn(),
                },
                status: () => ({}),
              }}
            />
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/projects/p-1/sessions/s-1",
    );
  });

  it("renders a shared error state", () => {
    const reload = vi.fn();
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <SessionList
              projectId="p-1"
              cursor={null}
              page={{
                loader: {
                  data: () => undefined,
                  loading: () => false,
                  error: () => new Error("down"),
                  reload,
                },
                status: () => ({}),
              }}
            />
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("shows the derived title as the primary line with the id chip secondary", () => {
    renderList(() => ({
      items: [summary({ title: "Refactor the sync outbox pruning" })],
      next_cursor: null,
    }));
    const link = screen.getByRole("link", { name: /Refactor the sync outbox/ });
    expect(link.querySelector(".font-medium")).toHaveTextContent(
      "Refactor the sync outbox pruning",
    );
    expect(link.querySelector(".font-medium")).toHaveAttribute(
      "title",
      "Refactor the sync outbox pruning",
    );
    // The id appears exactly once, inside the chip.
    expect(screen.getAllByText("s-1")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Copy session id" }),
    ).toBeInTheDocument();
  });

  it("renders the id once when the title source is the id itself", () => {
    renderList(() => ({
      items: [summary({ session_id: "s-9", title: "s-9", title_source: "id" })],
      next_cursor: null,
    }));
    expect(screen.getAllByText("s-9")).toHaveLength(1);
    expect(screen.queryByText("Session one")).not.toBeInTheDocument();
  });

  it("shows the muted summary tag only for distillation titles", () => {
    renderList(() => ({
      items: [
        summary({ session_id: "s-a", title_source: "distillation" }),
        summary({ session_id: "s-b", title_source: "first_message" }),
      ],
      next_cursor: null,
    }));
    expect(screen.getAllByText("from summary")).toHaveLength(1);
  });

  it("copies the session id without navigating", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const history = renderList(() => ({
      items: [summary()],
      next_cursor: null,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Copy session id" }));
    expect(writeText).toHaveBeenCalledWith("s-1");
    expect(history.get()).toBe("/projects/p-1/sessions");
    await screen.findByText("Copied");
  });

  it("navigates with q and no cursor on search submit", async () => {
    const history = renderList(() => ({ items: [], next_cursor: null }));
    const input = screen.getByRole("searchbox", { name: "Search sessions" });
    fireEvent.input(input, { target: { value: "outbox" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() =>
      expect(history.get()).toBe("/projects/p-1/sessions?q=outbox"),
    );
  });

  it("clears q when the search is submitted empty", async () => {
    const history = renderList(
      () => ({ items: [], next_cursor: null }),
      "outbox",
    );
    const input = screen.getByRole("searchbox", { name: "Search sessions" });
    expect(input).toHaveValue("outbox");
    fireEvent.input(input, { target: { value: " " } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(history.get()).toBe("/projects/p-1/sessions"));
  });

  it("honest filtered state: heading, empty message and clear link", () => {
    renderList(() => ({ items: [], next_cursor: null }), "diacritics");
    expect(
      screen.getByText("Sessions matching “diacritics”"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No sessions match “diacritics”/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear search" })).toHaveAttribute(
      "href",
      "/projects/p-1/sessions",
    );
  });
});
