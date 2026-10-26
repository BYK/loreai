import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
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
  cursor: string | null = null,
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
            cursor={cursor}
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
  it("keeps processing facts in a closed disclosure outside the conversation link", () => {
    const long = "conversation".repeat(40);
    renderList(() => ({
      items: [
        summary({
          title: long,
          title_source: "distillation",
          first_message_at: 1700000000000,
          last_message_at: 1700100000000,
          message_count: 9,
          distilled_count: 7,
          undistilled_count: 2,
        }),
      ],
      next_cursor: null,
    }));
    const link = screen.getByRole("link", { name: new RegExp(long) });
    expect(link.querySelector("button, summary, details")).toBeNull();
    expect(screen.getByText(long)).toHaveClass("[overflow-wrap:anywhere]");
    expect(link).not.toHaveTextContent("distilled");
    expect(link).not.toHaveTextContent("s-1");
    const details = screen.getByText("Processing details").closest("details");
    if (!details) throw new Error("Missing details disclosure");
    expect(details).not.toHaveAttribute("open");
    expect(details.closest("a")).toBeNull();
    expect(details).toHaveTextContent(
      "9 messages · 7 distilled · 2 undistilled",
    );
    expect(details).toHaveTextContent("from summary");
    expect(details).toHaveTextContent("s-1");
    expect(details.querySelectorAll("time")[0]).toHaveAttribute(
      "datetime",
      "2023-11-14T22:13:20.000Z",
    );
    expect(details.querySelectorAll("time")[1]).toHaveAttribute(
      "datetime",
      "2023-11-16T02:00:00.000Z",
    );
    details.open = true;
    expect(
      within(details).getByRole("button", { name: "Copy session id" }),
    ).toBeInTheDocument();
  });

  it("keeps unknown recorded dates unknown without breaking a blank-title session", () => {
    renderList(() => ({
      items: [
        summary({ title: " ", first_message_at: 0, last_message_at: 1e20 }),
      ],
      next_cursor: null,
    }));
    expect(
      screen.getByRole("link", { name: /Untitled session/ }),
    ).toBeInTheDocument();
    const details = screen.getByText("Processing details").closest("details");
    if (!details) throw new Error("Missing details disclosure");
    expect(details).toHaveTextContent("Recorded range: unknown – unknown");
    expect(details.querySelector("time[datetime]")).toBeNull();
  });

  it("renders the fuzzy badge only for approximate rows and the caption only when one exists (#1948)", () => {
    renderList(() => ({
      items: [
        summary({ session_id: "s-ex", title: "Session title search" }),
        summary({
          session_id: "s-fz",
          title: "Session tittle search",
          match: "fuzzy",
        }),
      ],
      next_cursor: null,
    }));
    const badges = screen.getAllByTestId("session-match-fuzzy");
    expect(badges).toHaveLength(1);
    expect(screen.getByTestId("session-list-approximate")).toBeInTheDocument();
  });

  it("renders no badge or caption when every row is an exact hit", () => {
    renderList(() => ({
      items: [
        summary({ session_id: "s-ex", title: "Session title search" }),
        summary({ session_id: "s-e2", title: "Session two", match: "exact" }),
      ],
      next_cursor: null,
    }));
    expect(screen.queryByTestId("session-match-fuzzy")).toBeNull();
    expect(screen.queryByTestId("session-list-approximate")).toBeNull();
  });

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
    expect(
      screen.getByRole("navigation", { name: "Sessions pagination" }),
    ).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Next page" });
    expect(next).toBeEnabled();
    expect(next).toHaveTextContent("Next");
    expect(next.querySelector("svg")).not.toBeNull();
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
    const details = screen.getByText("Processing details").closest("details");
    if (!details) throw new Error("Missing processing disclosure");
    details.open = true;
    expect(
      screen.getByRole("button", { name: "Copy session id" }),
    ).toBeInTheDocument();
  });

  it("renders the id once when the title source is the id itself", () => {
    renderList(() => ({
      items: [summary({ session_id: "s-9", title: "s-9", title_source: "id" })],
      next_cursor: null,
    }));
    expect(
      screen.getByRole("link", { name: /Untitled session/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("s-9")).toHaveLength(1);
    expect(screen.queryByText("Session one")).not.toBeInTheDocument();
  });

  it.each([
    ["explicit", "explicit title"],
    ["first_message", "first message"],
    ["distillation", "from summary"],
    ["id", "session ID"],
  ] as const)(
    "reports %s title provenance truthfully in processing details",
    (title_source, label) => {
      renderList(() => ({
        items: [summary({ title_source })],
        next_cursor: null,
      }));
      const details = screen.getByText("Processing details").closest("details");
      expect(details).not.toHaveAttribute("open");
      expect(details).toHaveTextContent(`Title source: ${label}`);
    },
  );

  it("shows the muted summary tag only for distillation titles", () => {
    renderList(() => ({
      items: [
        summary({ session_id: "s-a", title_source: "distillation" }),
        summary({ session_id: "s-b", title_source: "first_message" }),
      ],
      next_cursor: null,
    }));
    expect(screen.getAllByText("Title source: from summary")).toHaveLength(1);
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
    const details = screen.getByText("Processing details").closest("details");
    if (!details) throw new Error("Missing processing disclosure");
    details.open = true;
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

  it("First page and Next page preserve the active query", async () => {
    const history = renderList(
      () => ({ items: [summary()], next_cursor: "c2" }),
      "outbox",
      "c1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(history.get()).toBe("/projects/p-1/sessions?cursor=c2&q=outbox"),
    );
    fireEvent.click(screen.getByRole("button", { name: "First page" }));
    await waitFor(() =>
      expect(history.get()).toBe("/projects/p-1/sessions?q=outbox"),
    );
  });
});
