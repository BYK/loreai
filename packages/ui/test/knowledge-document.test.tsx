import { createSignal } from "solid-js";
import { MemoryRouter } from "@solidjs/router";
import { Route } from "@solidjs/router";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import {
  authorOf,
  KnowledgeDocument,
} from "~/components/lore/KnowledgeDocument";
import type { KnowledgeEntry, KnowledgeVersionHistory } from "~/contracts";
import type { Loader } from "~/lib/loader";
import type { EvidenceResult } from "~/state/sessions";
import { ApiError } from "~/lib/api";

const entry = (created_by: KnowledgeEntry["created_by"]): KnowledgeEntry => ({
  id: "k",
  logical_id: "k",
  project_id: "p",
  category: "decision",
  title: "t",
  content: "c",
  confidence: 1,
  cross_project: 0,
  created_at: 1,
  updated_at: 1,
  created_by,
});

const project = {
  id: "p",
  path: "/tmp/project",
  name: "Project",
  git_remote: null,
  created_at: 1,
  knowledge_count: 1,
  session_count: 1,
  message_count: 1,
  distillation_count: 0,
};

function loader<T>(
  value: T | undefined,
  error?: unknown,
  loading = false,
): Loader<T> {
  const data = createSignal(value);
  const busy = createSignal(loading);
  const failure = createSignal(error);
  return {
    data: data[0],
    error: failure[0],
    loading: busy[0],
    stale: () => false,
    partial: () => false,
    source: () => "server",
    reload: vi.fn(),
  };
}

const version = (
  n: number,
  overrides: Partial<KnowledgeVersionHistory["versions"][number]> = {},
) => ({
  version_id: `v${n}`,
  version: n,
  created_at: n,
  superseded_at: n === 1 ? 2 : null,
  is_current: n === 2,
  is_deleted: false,
  title: n === 1 ? "Old title" : "Current title",
  content: n === 1 ? "Old content" : "Current content",
  category: "decision",
  confidence: 0.8,
  scope: "project" as const,
  cross_project: false,
  source_refs: {
    session_id: "s-1",
    entry_id: "k",
    user_id: null,
    created_by: "Curator",
    updated_by: "Curator",
    worker_provider_id: "provider",
    worker_model_id: "worker-model",
  },
  ...overrides,
});

function renderDocument(
  overrides: {
    entry?: KnowledgeEntry;
    versions?: Loader<KnowledgeVersionHistory>;
    evidence?: Loader<EvidenceResult>;
    project?: typeof project;
  } = {},
) {
  return render(() => (
    <MemoryRouter>
      <Route
        path="*"
        component={() => (
          <KnowledgeDocument
            entry={
              overrides.entry ?? {
                ...entry("Ada"),
                source_session: "s-1",
              }
            }
            project={"project" in overrides ? overrides.project : project}
            versions={
              overrides.versions ??
              loader({
                id: "k",
                current_version_id: "v2",
                versions: [version(1), version(2)],
              })
            }
            evidence={overrides.evidence}
          />
        )}
      />
    </MemoryRouter>
  ));
}

describe("authorOf", () => {
  it("attributes entries without an author to the Curator agent", () => {
    for (const missing of [undefined, null, ""]) {
      expect(authorOf(entry(missing))).toEqual({
        name: "Curator",
        initials: "CU",
        kind: "agent",
      });
    }
  });

  it("treats a whitespace-only author like a missing one, label and avatar alike", () => {
    expect(authorOf(entry("  \t"))).toEqual({
      name: "Curator",
      initials: "CU",
      kind: "agent",
    });
  });

  it("keeps a trimmed person name with a person avatar", () => {
    expect(authorOf(entry(" Ada Lovelace "))).toEqual({
      name: "Ada Lovelace",
      initials: "AL",
      kind: "person",
    });
  });
});

describe("KnowledgeDocument", () => {
  it("renders content before the trust and history sections", () => {
    const view = renderDocument();
    const article = view.getByTestId("knowledge-document");
    expect(article.textContent?.indexOf("c")).toBeLessThan(
      article.textContent?.indexOf("Why trust this") ?? 0,
    );
    expect(article.textContent?.indexOf("Why trust this")).toBeLessThan(
      article.textContent?.indexOf("History") ?? 0,
    );
  });

  it.each([
    ["available", { state: "available" as const }, "Source session available"],
    [
      "summary-only",
      {
        state: "summary_only" as const,
        detail: {
          messages: [],
          distillations: [
            {
              id: "d1",
              session_id: "s-1",
              generation: 0,
              token_count: 2,
              r_compression: 0.5,
              c_norm: 0.5,
              archived: true,
              created_at: 1,
              call_type: "observer",
            },
            {
              id: "d2",
              session_id: "s-1",
              generation: 1,
              token_count: 3,
              r_compression: 0.4,
              c_norm: 0.6,
              archived: true,
              created_at: 2,
              call_type: "reflector",
            },
          ],
        },
      },
      "retained summary text",
    ],
    [
      "unavailable",
      { state: "unavailable" as const },
      "Source session no longer available",
    ],
  ] as const)("renders %s source evidence", (_label, evidence, text) => {
    renderDocument({
      evidence: loader(evidence as unknown as EvidenceResult),
    });
    if (_label === "summary-only") {
      expect(screen.getByText(/Original messages expired/)).toBeInTheDocument();
      expect(screen.getByText(/2 distillations/)).toBeInTheDocument();
      expect(screen.getByText(/gen 0/)).toBeInTheDocument();
      expect(screen.getByText(/gen 1/)).toBeInTheDocument();
      expect(screen.getAllByText(/2 distillations/)).toHaveLength(1);
      const readerLink = screen.getByRole("link", { name: "session reader." });
      expect(readerLink).toHaveAttribute("href", "/projects/p/sessions/s-1");
      expect(screen.queryByText("observer")).not.toBeInTheDocument();
    } else {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it("labels linked source sessions when the exact message is unavailable", () => {
    renderDocument();
    expect(
      screen.getByText("· exact message not recorded"),
    ).toBeInTheDocument();
  });

  it("labels unlinked source sessions when the project is unavailable", () => {
    renderDocument({
      project: undefined,
      entry: {
        ...entry("Ada"),
        project_id: null,
        source_session: "s-1",
      },
    });
    expect(screen.getAllByText("s-1").length).toBeGreaterThan(0);
    expect(
      screen.getByText("· exact message not recorded"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Distilled from session" }),
    ).toBeNull();
  });

  it("shows pending states before the loaders' effects mark them loading", () => {
    // createLoader flips `loading` inside a createEffect, so on the very first
    // render data, error and loading are all falsy — never render blank there.
    renderDocument({
      evidence: loader<EvidenceResult>(undefined),
      versions: loader<KnowledgeVersionHistory>(undefined),
    });
    expect(screen.getByText("Checking source…")).toBeInTheDocument();
    expect(screen.getByText("Loading version history")).toBeInTheDocument();
  });

  it("shows the evidence error instead of a pending state", () => {
    renderDocument({
      evidence: loader<EvidenceResult>(
        undefined,
        new ApiError("http", "/sessions/s-1", "evidence failed", 500),
      ),
    });
    expect(screen.queryByText("Checking source…")).toBeNull();
    expect(screen.getByText("Source session unavailable")).toBeInTheDocument();
  });

  it("renders a missing source without a link", () => {
    const noSource = entry("Ada");
    noSource.source_session = null;
    const view = renderDocument({
      entry: noSource,
      versions: loader({
        id: "k",
        current_version_id: "v1",
        versions: [
          version(1, {
            source_refs: { ...version(1).source_refs, session_id: null },
          }),
        ],
      }),
    });
    expect(screen.getByText("No source session recorded.")).toBeInTheDocument();
    expect(view.container.querySelector("a")).toBeNull();
  });

  it("renders sharing, last change, confidence, and technical provenance", () => {
    renderDocument({
      entry: { ...entry("Ada"), cross_project: 1, source_session: "s-1" },
      evidence: loader({ state: "available" }),
    });
    expect(screen.getByText("global")).toBeInTheDocument();
    expect(screen.getByText(/Last change/)).toBeInTheDocument();
    expect(
      screen.getByText(/recorded value, not a probability of correctness/),
    ).toBeInTheDocument();
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.getByText("worker-model")).toBeInTheDocument();
  });

  it("renders newest history first with current, superseded, and deleted labels", () => {
    renderDocument({
      versions: loader({
        id: "k",
        current_version_id: "v3",
        versions: [
          version(1),
          version(2),
          version(3, { is_current: false, is_deleted: true }),
        ],
      }),
    });
    const rows = [
      ...document.querySelectorAll("[data-testid^=knowledge-version-]"),
    ];
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "knowledge-version-3",
      "knowledge-version-2",
      "knowledge-version-1",
    ]);
    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getAllByText(/Superseded/).length).toBe(1);
  });

  it("expands version details and keeps adversarial text inert", () => {
    const malicious = version(2, {
      title: "<script>bad title</script>",
      content: "<img onerror=bad><script>bad content</script>",
    });
    const view = renderDocument({
      versions: loader({
        id: "k",
        current_version_id: "v2",
        versions: [malicious],
      }),
    });
    const details = view.container.querySelector(
      "[data-testid=knowledge-version-2]",
    ) as HTMLDetailsElement;
    details.open = true;
    expect(details.textContent).toContain("<script>bad title</script>");
    expect(details.querySelector("script")).toBeNull();
    expect(details.querySelector("img")).toBeNull();
    expect(screen.getByText("No earlier versions.")).toBeInTheDocument();
  });

  it("renders a history error card", () => {
    renderDocument({
      versions: loader<KnowledgeVersionHistory>(
        undefined,
        new ApiError("http", "/knowledge/k/versions", "history failed", 500),
      ),
    });
    expect(screen.getByText("Version history unavailable")).toBeInTheDocument();
  });
});
