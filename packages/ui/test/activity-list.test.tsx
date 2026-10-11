import { MemoryRouter, Route } from "@solidjs/router";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const clientHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);
const boundingClientRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    value: 400,
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    new DOMRect(0, 0, 400, 400);
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = boundingClientRect;
  if (clientHeight) {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  }
});

function mount(query: string, fetchActivity: ReturnType<typeof vi.fn>) {
  const client = {
    listProjects: vi.fn(async () => []),
    fetchActivity,
  } as unknown as ApiClient;
  return render(() => (
    <WorkspaceProvider client={client} db={Promise.resolve(null)}>
      <MemoryRouter>
        <Route path="*" component={() => <ActivityListBody query={query} />} />
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
});
