import { MemoryRouter, Route } from "@solidjs/router";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { SessionList } from "~/components/lore/SessionList";

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
});
