import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "~/components/discussions/Composer";
import { SelectionActions } from "~/components/discussions/SelectionActions";
import type { ApiClient } from "~/lib/api";
import { useWorkspace, WorkspaceProvider } from "~/routes/workspace";

type Drafts = ReturnType<typeof useWorkspace>["state"]["discussions"]["drafts"];
type Discussions = ReturnType<typeof useWorkspace>["state"]["discussions"];

const client = { listProjects: async () => [] } as unknown as ApiClient;

/** Renders `ui` in a workspace whose discussion state is patched by `patch`. */
function mount(patch: (d: Discussions) => void, ui: () => JSX.Element) {
  const Patched = () => {
    patch(useWorkspace().state.discussions);
    return ui();
  };
  return render(() => (
    <WorkspaceProvider client={client} db={Promise.resolve(null)}>
      <Patched />
    </WorkspaceProvider>
  ));
}

function stubDrafts(d: Discussions, over: Partial<Drafts>): void {
  Object.assign(d.drafts, {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...over,
  });
}

const textarea = () =>
  screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;

afterEach(() => vi.restoreAllMocks());

describe("Composer", () => {
  it("clears the sent text even when deleting the draft fails", async () => {
    const onSubmit = vi.fn(async () => undefined);
    mount(
      (d) =>
        stubDrafts(d, {
          delete: vi.fn(async () => {
            throw new Error("idb down");
          }),
        }),
      () => (
        <Composer
          draftKey="k"
          projectId="p"
          target={null}
          submitLabel="Send"
          onSubmit={onSubmit}
        />
      ),
    );
    fireEvent.input(textarea(), { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Sent, but the saved draft wasn't cleared",
      ),
    );
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("hello");
    expect(textarea().value).toBe("");
  });

  it("drops the restored indicator once the restored draft is sent", async () => {
    mount(
      (d) =>
        stubDrafts(d, {
          get: vi.fn(async (key: string) => ({
            key,
            kind: "discussion" as const,
            projectId: "p",
            target: null,
            body: { text: "from before" },
            updatedAt: 1,
          })),
        }),
      () => (
        <Composer
          draftKey="k"
          projectId="p"
          target={null}
          submitLabel="Send"
          onSubmit={async () => undefined}
        />
      ),
    );
    await screen.findByTestId("draft-restored");
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(textarea().value).toBe(""));
    expect(screen.queryByTestId("draft-restored")).toBeNull();
  });

  it("saves a pending edit as soon as the page is hidden", async () => {
    const put = vi.fn(async () => undefined);
    mount(
      (d) => stubDrafts(d, { put }),
      () => (
        <Composer
          draftKey="k"
          projectId="p"
          target={null}
          submitLabel="Send"
          onSubmit={async () => undefined}
        />
      ),
    );
    fireEvent.input(textarea(), { target: { value: "half typed" } });
    expect(put).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(put).toHaveBeenCalledExactlyOnceWith({
      key: "k",
      projectId: "p",
      target: null,
      body: { text: "half typed" },
    });
  });
});

describe("SelectionActions", () => {
  it("clears a failed Save note error when starting a thread", async () => {
    mount(
      (d) => {
        stubDrafts(d, {});
        d.create = vi.fn(async () => {
          throw new Error("note failed");
        });
      },
      () => (
        <SelectionActions
          projectId="p"
          source={{ kind: "session", id: "s" }}
          anchor={{ blockId: "m.1", start: 0, end: 3, contentHash: "abc" }}
          quote="abc"
          overlapping={[]}
          onReplyIn={() => undefined}
          onCreated={() => undefined}
        />
      ),
    );
    fireEvent.click(screen.getByTestId("save-note"));
    await screen.findByText("note failed");
    fireEvent.click(screen.getByTestId("start-thread"));
    expect(screen.queryByText("note failed")).toBeNull();
    expect(screen.getByTestId("start-thread-composer")).toBeTruthy();
  });
});
