import { MemoryRouter, Route } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { batch, createSignal } from "solid-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ActivityListBody } from "~/components/shell/ActivityListBody";
import type { ActivityPage } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import { WorkspaceProvider } from "~/routes/workspace";

const PAGE: ActivityPage = {
  items: [
    {
      kind: "knowledge",
      id: "entry-1",
      project_id: "project-1",
      project_name: "Project",
      title: "Workspace contract",
      snippet: "Activity lists preserve their row identity.",
      participants: [],
      last_activity_at: 1_700_000_000_000,
      total: 1,
      match: "exact",
    },
  ],
  next_cursor: null,
};

const LAYOUT_PROPS = [
  "offsetHeight",
  "clientHeight",
  "scrollHeight",
  "getBoundingClientRect",
  "scrollTo",
] as const;
const realLayout = LAYOUT_PROPS.map(
  (name): [(typeof LAYOUT_PROPS)[number], PropertyDescriptor | undefined] => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ??
      Object.getOwnPropertyDescriptor(Element.prototype, name),
  ],
);
const sizeOf = (element: HTMLElement) =>
  element.dataset.testid === "activity-list-body" ? 400 : 76;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "activity-list-body" ? 1e7 : sizeOf(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      const height = sizeOf(this);
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: height,
        width: 800,
        height,
        toJSON: () => ({}),
      };
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollToOptions | number) {
      const top = typeof options === "number" ? options : options?.top;
      if (typeof top !== "number") return;
      this.scrollTop = Math.max(0, Math.floor(top));
      this.dispatchEvent(new Event("scroll"));
    },
  });
});

afterAll(() => {
  for (const [name, descriptor] of realLayout) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  }
});

function mount(
  query: string | (() => string),
  fetchActivity: ReturnType<typeof vi.fn>,
) {
  const getQuery = typeof query === "function" ? query : () => query;
  const client = {
    listProjects: vi.fn(async () => []),
    fetchActivity,
  } as unknown as ApiClient;
  return render(() => (
    <WorkspaceProvider client={client} db={Promise.resolve(null)}>
      <MemoryRouter>
        <Route
          path="*"
          component={() => <ActivityListBody query={getQuery()} />}
        />
      </MemoryRouter>
    </WorkspaceProvider>
  ));
}

describe("ActivityListBody", () => {
  it("does not fetch an invalid query and exposes its parse-error chip", async () => {
    const fetchActivity = vi.fn();
    mount("unknown:value", fetchActivity);

    expect(await screen.findByTestId("activity-query-error")).toHaveTextContent(
      "unknown:value",
    );
    expect(fetchActivity).not.toHaveBeenCalled();
  });

  it("renders validated rows with stable list keys", async () => {
    const fetchActivity = vi.fn(async () => PAGE);
    mount("type:knowledge", fetchActivity);

    const row = await screen.findByTestId("activity-item");
    expect(row).toHaveAttribute("data-list-key", "knowledge:project-1:entry-1");
    expect(row).toHaveTextContent("Workspace contract");
    await waitFor(() =>
      expect(fetchActivity).toHaveBeenCalledWith({
        q: "type:knowledge",
        cursor: null,
        limit: 50,
      }),
    );
  });

  it("fetches at most five extra pages when client filtering hides all rows", async () => {
    let page = 0;
    const fetchActivity = vi.fn(async () => {
      page += 1;
      return {
        items: PAGE.items,
        next_cursor: page < 10 ? String(page) : null,
      };
    });
    mount("in:archive", fetchActivity);

    await waitFor(() => expect(fetchActivity).toHaveBeenCalledTimes(6));
  });

  it("never sends a page cursor with a different query", async () => {
    const oldItems = Array.from({ length: 50 }, (_, index) => ({
      ...PAGE.items[0]!,
      id: `old-entry-${index}`,
    }));
    let resolveNewPage: ((page: ActivityPage) => void) | undefined;
    const fetchActivity = vi.fn(
      ({ q, cursor }: { q: string; cursor: string | null }) => {
        if (q === "type:knowledge" && cursor === null) {
          return Promise.resolve({ items: oldItems, next_cursor: "cursor-A" });
        }
        if (q === "in:archive" && cursor === null) {
          return new Promise<ActivityPage>((resolve) => {
            resolveNewPage = resolve;
          });
        }
        return Promise.resolve(PAGE);
      },
    );
    const [query, setQuery] = createSignal("type:knowledge");
    mount(query, fetchActivity);

    await waitFor(() => expect(fetchActivity).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText("Workspace contract")).not.toHaveLength(
      0,
    );

    const scroller = screen.getByTestId("activity-list-body");
    batch(() => {
      setQuery("in:archive");
      scroller.scrollTop = scroller.scrollHeight;
      fireEvent.scroll(scroller);
    });
    await waitFor(() =>
      expect(fetchActivity).toHaveBeenCalledWith(
        expect.objectContaining({ q: "in:archive", cursor: null }),
      ),
    );
    expect(screen.queryByText("Workspace contract")).toBeNull();
    const cursorCalls = fetchActivity.mock.calls
      .map(([request]) => request)
      .filter((request) => request.cursor !== null);
    expect(cursorCalls.every((request) => request.q === "type:knowledge")).toBe(
      true,
    );

    if (!resolveNewPage) throw new Error("new query request did not start");
    resolveNewPage(PAGE);
    await waitFor(() =>
      expect(screen.queryByText("Workspace contract")).toBeNull(),
    );
  });

  it("ignores a failed page from an obsolete query while the new query loads", async () => {
    const oldPage: ActivityPage = {
      ...PAGE,
      items: PAGE.items.map((item) => ({
        ...item,
        id: "old-entry",
        title: "Old query row",
      })),
      next_cursor: "old-cursor",
    };
    const newPage: ActivityPage = {
      ...PAGE,
      items: PAGE.items.map((item) => ({
        ...item,
        id: "new-entry",
        title: "New query row",
      })),
    };
    let rejectOldPage: ((cause: Error) => void) | undefined;
    let resolveNewPage: ((page: ActivityPage) => void) | undefined;
    const fetchActivity = vi.fn(
      ({ q, cursor }: { q: string; cursor: string | null }) => {
        if (q === "old query" && cursor === null)
          return Promise.resolve(oldPage);
        if (q === "old query") {
          return new Promise<ActivityPage>((_resolve, reject) => {
            rejectOldPage = reject;
          });
        }
        if (q === "new query") {
          return new Promise<ActivityPage>((resolve) => {
            resolveNewPage = resolve;
          });
        }
        return Promise.resolve(PAGE);
      },
    );
    const [query, setQuery] = createSignal("old query");
    mount(query, fetchActivity);

    await waitFor(() => expect(fetchActivity).toHaveBeenCalledTimes(2));
    if (!rejectOldPage) throw new Error("old page request did not start");

    setQuery("new query");
    await waitFor(() =>
      expect(fetchActivity).toHaveBeenCalledWith(
        expect.objectContaining({ q: "new query", cursor: null }),
      ),
    );
    if (!resolveNewPage) throw new Error("new query request did not start");

    rejectOldPage(new Error("obsolete page failed"));
    expect(await screen.findByText("Loading activity…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    resolveNewPage(newPage);
    expect(await screen.findByText("New query row")).toBeInTheDocument();
    expect(screen.queryByText("Old query row")).not.toBeInTheDocument();
  });
});
