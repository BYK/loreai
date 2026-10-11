import { createSignal } from "solid-js";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { KnowledgeFiles } from "~/components/lore/KnowledgeFiles";
import type { KnowledgeFiles as KnowledgeFilesData } from "~/contracts";
import type { Loader } from "~/lib/loader";

function loader(
  value: KnowledgeFilesData | undefined,
  error?: unknown,
): Loader<KnowledgeFilesData> {
  const data = createSignal(value);
  const failure = createSignal(error);
  return {
    data: data[0],
    error: failure[0],
    loading: () => false,
    stale: () => false,
    partial: () => false,
    source: () => "server",
    reload: vi.fn(),
  };
}

const result = (
  overrides: Partial<KnowledgeFilesData> = {},
): KnowledgeFilesData => ({
  id: "k",
  git_remote: "github.com/BYK/loreai",
  commit: "0123456789abcdef0123456789abcdef01234567",
  files: [],
  omitted: 0,
  ...overrides,
});

describe("KnowledgeFiles", () => {
  it("shows a pending state when data and error are both absent", () => {
    render(() => <KnowledgeFiles loader={loader(undefined)} />);
    expect(screen.getByText("Loading files")).toBeTruthy();
  });

  it("renders the shared error state and reload action", () => {
    const files = loader(undefined, new Error("gateway offline"));
    render(() => <KnowledgeFiles loader={files} />);
    expect(screen.getByText("Files unavailable")).toBeTruthy();
    expect(screen.getByText("Error: gateway offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(files.reload).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state", () => {
    render(() => <KnowledgeFiles loader={loader(result())} />);
    expect(
      screen.getByText("No files recorded for this entry on this gateway."),
    ).toBeTruthy();
    expect(
      screen.queryByText("Repository links are available for GitHub remotes."),
    ).toBeNull();
    expect(
      screen.queryByText(/Links point at the commit|No commit recorded/),
    ).toBeNull();
  });

  it("renders both evidence badges and a safe external link", () => {
    render(() => (
      <KnowledgeFiles
        loader={loader(
          result({
            files: [{ path: "src/file.ts", recorded: true, verified: true }],
          }),
        )}
      />
    ));
    expect(screen.getByText("recorded with entry")).toBeTruthy();
    expect(
      screen.getByText("cited in content · verified on last check"),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: /GitHub at 0123456/ });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/BYK/loreai/blob/0123456789abcdef0123456789abcdef01234567/src/file.ts",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByText(/:42/)).toBeNull();
  });

  it("shows one note instead of links for non-GitHub remotes", () => {
    render(() => (
      <KnowledgeFiles
        loader={loader(
          result({
            git_remote: "gitlab.com/BYK/loreai",
            files: [{ path: "src/file.ts", recorded: true, verified: false }],
          }),
        )}
      />
    ));
    expect(
      screen.getByText("Repository links are available for GitHub remotes."),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.queryByText(/Links point at the commit|No commit recorded/),
    ).toBeNull();
  });

  it("explains that links without a commit use the default branch", () => {
    render(() => (
      <KnowledgeFiles
        loader={loader(
          result({
            commit: null,
            files: [{ path: "src/file.ts", recorded: true, verified: false }],
          }),
        )}
      />
    ));
    expect(
      screen.getByText(
        "No commit recorded — links open the default branch, which may have changed.",
      ),
    ).toBeTruthy();
  });

  it("shows the omitted-path note", () => {
    render(() => <KnowledgeFiles loader={loader(result({ omitted: 2 }))} />);
    expect(
      screen.getByText(
        "2 recorded paths not shown — outside this repository or not a repository-relative path.",
      ),
    ).toBeTruthy();
  });

  it("renders hostile paths as inert code text", () => {
    const path = '<img src=x onerror="alert(1)">';
    const view = render(() => (
      <KnowledgeFiles
        loader={loader(
          result({
            git_remote: null,
            files: [{ path, recorded: true, verified: false }],
          }),
        )}
      />
    ));
    expect(view.getByText(path)).toBeTruthy();
    expect(view.container.querySelector("img")).toBeNull();
  });
});
