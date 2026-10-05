import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DedupApplyBody,
  DedupApplyReceipt,
  DedupPreviewCandidate,
  DedupPreviewGroup,
  DedupPreviewResponse,
  KnowledgeVersionHistory,
} from "~/contracts";
import {
  closeLoreDb,
  createKnowledgeRepo,
  createReviewDecisionsStore,
  openLoreDb,
  type DedupReviewMark,
  type LoreUiDb,
} from "~/db";
import { DuplicateReview } from "~/components/lore/DuplicateReview";
import { ApiError, type ApiClient } from "~/lib/api";
import { markFrom } from "~/lib/dedup-review";
import { globalKnowledgeHref, knowledgeHref, sessionHref } from "~/lib/href";
import { WorkspaceProvider } from "~/routes/workspace";
import { IDBFactory } from "./idb-globals";

const projectId = "project-1";

function candidate(
  logicalId: string,
  overrides: Partial<DedupPreviewCandidate> = {},
): DedupPreviewCandidate {
  return {
    id: `${logicalId}-version`,
    logical_id: logicalId,
    revision: 1,
    title: `Entry ${logicalId}`,
    content_excerpt: `Excerpt for ${logicalId}`,
    scope: "project",
    project_id: projectId,
    category: "decision",
    confidence: 0.9,
    source_session: null,
    updated_at: 1_700_000_000_000,
    score: 0.93,
    reasons: ["title_overlap"],
    ...overrides,
  };
}

function group(
  groupId = "project:group-1",
  candidates = [candidate("knowledge-a"), candidate("knowledge-b")],
): DedupPreviewGroup {
  const suggested = candidates[0];
  if (!suggested) throw new Error("A duplicate group needs a candidate");
  return {
    group_id: groupId,
    scope: "project",
    project_id: projectId,
    candidates,
    suggested_keep_id: suggested.id,
  };
}

function sharedGroup(
  groupId = "global:group-1",
  candidates = [
    candidate("shared-a", { scope: "shared", project_id: null }),
    candidate("shared-b", { scope: "shared", project_id: null }),
  ],
): DedupPreviewGroup {
  return {
    ...group(groupId, candidates),
    scope: "global",
    project_id: null,
  };
}

function response(groups: DedupPreviewGroup[]): DedupPreviewResponse {
  return {
    dry_run: true,
    groups,
    project: { clusters: [], totalRemoved: 0 },
    global: { clusters: [], totalRemoved: 0 },
  };
}

function receiptFor(
  routeProjectId: string,
  body: DedupApplyBody,
  options: {
    appliedIndices?: number[];
    refused?: DedupApplyReceipt["refused"];
    replayed?: boolean;
  } = {},
): DedupApplyReceipt {
  const indices =
    options.appliedIndices ?? body.decisions.map((_, index) => index);
  return {
    operationId: body.operationId,
    projectId: body.projectId === null ? null : routeProjectId,
    applied: indices.flatMap((groupIndex) => {
      const decision = body.decisions[groupIndex];
      return decision
        ? [
            {
              groupIndex,
              keepId: decision.keepId,
              keepRevision: 2,
              merged: decision.mergeIds.map((id) => ({
                id,
                revision: 2,
                tombstoneVersionId: `${id}-tombstone`,
              })),
              appliedAt: 1_700_000_000_001,
            },
          ]
        : [];
    }),
    refused: options.refused ?? [],
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_000_002,
    replayed: options.replayed ?? false,
  };
}

function history(
  entry: DedupPreviewCandidate,
  overrides: Partial<KnowledgeVersionHistory["versions"][number]> = {},
): KnowledgeVersionHistory {
  return {
    id: entry.logical_id,
    current_version_id: `${entry.logical_id}-version`,
    versions: [
      {
        version_id: `${entry.logical_id}-version`,
        version: entry.revision,
        created_at: 1_700_000_000_000,
        superseded_at: null,
        is_current: true,
        is_deleted: false,
        title: entry.title,
        content: `Full content for ${entry.logical_id}`,
        category: entry.category,
        confidence: entry.confidence,
        scope: entry.scope,
        cross_project: false,
        source_refs: {
          session_id: null,
          entry_id: null,
          user_id: null,
          created_by: null,
          updated_by: null,
          worker_provider_id: null,
          worker_model_id: null,
        },
        ...overrides,
      },
    ],
  };
}

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listProjects: async () => [],
    previewDedup: async () => response([group()]),
    getSyncStatus: async () => ({
      enabled: false,
      state: "disabled",
      pending_changes: 0,
    }),
    applyDedup: async (id: string, body: DedupApplyBody) =>
      receiptFor(id, body),
    listKnowledgeVersions: async (id: string) => {
      const item = group().candidates.find((value) => value.logical_id === id);
      if (!item) throw new Error(`Unknown knowledge id: ${id}`);
      return history(item);
    },
    ...overrides,
  } as unknown as ApiClient;
}

function mount(
  client: ApiClient = makeClient(),
  db: Promise<LoreUiDb | null> = Promise.resolve(null),
  withInput = false,
  withNavLink = false,
) {
  const historyRouter = createMemoryHistory();
  historyRouter.set({ value: `/ui/projects/${projectId}/duplicates` });
  return render(() => (
    <MemoryRouter base="/ui" history={historyRouter}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={db}>
            <>
              {withNavLink && (
                <nav>
                  <a href="/ui/projects/project-1" data-testid="keyboard-nav">
                    Project navigation
                  </a>
                </nav>
              )}
              <DuplicateReview projectId={projectId} />
              {withInput && <input aria-label="Keyboard test input" />}
            </>
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

afterEach(async () => {
  await closeLoreDb();
});

describe("DuplicateReview", () => {
  it("shows the initial scanning state, then full inert evidence and metadata", async () => {
    let resolvePreview: ((value: DedupPreviewResponse) => void) | undefined;
    const hostile = "<img src=x onerror=alert(1)>";
    const first = candidate("knowledge-a", {
      title: hostile,
      score: 0.83,
      reasons: ["title_overlap"],
      confidence: 0.86,
    });
    const previewDedup = vi.fn(
      () =>
        new Promise<DedupPreviewResponse>((resolve) => {
          resolvePreview = resolve;
        }),
    );
    const listKnowledgeVersions = vi.fn(async (id: string) => {
      const item = id === first.logical_id ? first : candidate(id);
      return history(
        item,
        id === first.logical_id ? { title: hostile, content: hostile } : {},
      );
    });

    mount(makeClient({ previewDedup, listKnowledgeVersions }));
    expect(screen.getByText("Scanning for duplicates")).toBeInTheDocument();
    resolvePreview?.(
      response([
        {
          ...group("global:hostile", [
            first,
            candidate("knowledge-b", {
              scope: "shared",
              project_id: "project-2",
              source_session: "session-1",
              score: 0.86,
              reasons: ["embedding_similarity"],
              confidence: 0.71,
            }),
          ]),
          scope: "global",
          project_id: null,
        },
      ]),
    );

    expect(
      await screen.findByText("Full content for knowledge-b"),
    ).toBeInTheDocument();
    expect(screen.getByText("Shared scope")).toBeInTheDocument();
    expect(screen.getAllByText("Shared (no project)").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("session-1")).toBeInTheDocument();
    const candidates = screen.getAllByTestId("duplicate-candidate");
    expect(screen.getByText("86% match")).toHaveAttribute(
      "aria-label",
      "Best match score 86%",
    );
    expect(within(candidates[0]!).getByText("Match 83%")).toBeInTheDocument();
    expect(
      within(candidates[0]!).getByText("Title overlap"),
    ).toBeInTheDocument();
    expect(
      within(candidates[0]!).getByText("Confidence 86%"),
    ).toBeInTheDocument();
    expect(within(candidates[1]!).getByText("Match 86%")).toBeInTheDocument();
    expect(
      within(candidates[1]!).getByText("Embedding similarity"),
    ).toBeInTheDocument();
    expect(
      within(candidates[1]!).getByText("Confidence 71%"),
    ).toBeInTheDocument();
    expect(candidates[0]).toHaveTextContent(hostile);
    expect(candidates[0]?.querySelector("img")).toBeNull();
    expect(screen.getAllByText("v1")).toHaveLength(2);
    expect(screen.getByLabelText("Keep this one (1)")).toBeChecked();
    expect(screen.getByTestId("duplicate-review")).not.toHaveTextContent(
      "global",
    );
    expect(previewDedup).toHaveBeenCalledTimes(1);
    expect(listKnowledgeVersions).toHaveBeenCalledTimes(2);
  });

  it("links to each candidate's owning project or global document", async () => {
    const otherProject = candidate("knowledge-other-project", {
      project_id: "project-2",
      source_session: "session-other-project",
    });
    const projectless = candidate("knowledge-projectless", {
      project_id: null,
      scope: "shared",
      source_session: "session-projectless",
    });
    mount(
      makeClient({
        previewDedup: async () =>
          response([group("global:link-targets", [otherProject, projectless])]),
        listKnowledgeVersions: async (id) => {
          const item = [otherProject, projectless].find(
            (value) => value.logical_id === id,
          );
          if (!item) throw new Error(`Unknown knowledge id: ${id}`);
          return history(item);
        },
      }),
    );
    await screen.findByText("Full content for knowledge-other-project");

    const cards = screen.getAllByTestId("duplicate-candidate");
    expect(
      within(cards[0]!).getByRole("link", { name: "Open knowledge document" }),
    ).toHaveAttribute(
      "href",
      `/ui${knowledgeHref("project-2", "knowledge-other-project")}`,
    );
    expect(
      within(cards[0]!).getByRole("link", { name: "session-other-project" }),
    ).toHaveAttribute(
      "href",
      `/ui${sessionHref("project-2", "session-other-project")}`,
    );
    expect(
      within(cards[1]!).getByRole("link", { name: "Open knowledge document" }),
    ).toHaveAttribute(
      "href",
      `/ui${globalKnowledgeHref("knowledge-projectless")}`,
    );
    expect(
      within(cards[1]!).queryByRole("link", { name: "session-projectless" }),
    ).not.toBeInTheDocument();
    expect(
      within(cards[1]!).getByText("session-projectless"),
    ).toBeInTheDocument();
  });

  it("renders empty and retryable error states", async () => {
    const emptyClient = makeClient({
      previewDedup: async () => response([]),
    });
    const emptyMount = mount(emptyClient);
    expect(
      await screen.findByText("No duplicate candidates"),
    ).toBeInTheDocument();
    emptyMount.unmount();

    const previewDedup = vi
      .fn<ApiClient["previewDedup"]>()
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValueOnce(response([]));
    mount(makeClient({ previewDedup }));
    expect(
      await screen.findByText("Duplicate preview unavailable"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("No duplicate candidates"),
    ).toBeInTheDocument();
    expect(previewDedup).toHaveBeenCalledTimes(2);
  });

  it("persists decisions and keeper selection, then marks changed revisions stale", async () => {
    const factory = new IDBFactory();
    const db = await openLoreDb({ factory });
    expect(db).not.toBeNull();
    let revision = 1;
    const previewDedup = vi.fn(async () =>
      response([
        group("project:stable", [
          candidate("knowledge-a", { revision }),
          candidate("knowledge-b", { revision }),
        ]),
      ]),
    );
    const client = makeClient({ previewDedup });
    const firstMount = mount(client, Promise.resolve(db));
    await screen.findByText("Full content for knowledge-a");
    fireEvent.click(screen.getByRole("button", { name: "Accept merge" }));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    fireEvent.click(screen.getByLabelText("Keep this one (2)"));
    await waitFor(async () => {
      const mark = await createReviewDecisionsStore(db).get(
        `${projectId}/project:stable`,
      );
      expect(mark?.kind).toBe("dedup");
      if (mark?.kind === "dedup") {
        expect(mark.keepId).toBe("knowledge-b");
      }
    });
    firstMount.unmount();

    mount(client, Promise.resolve(db));
    await screen.findByText("Full content for knowledge-a");
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    expect(screen.getByLabelText("Keep this one (2)")).toBeChecked();

    revision = 2;
    fireEvent.click(screen.getByTestId("dedup-rescan"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent("1 stale"),
    );
    expect(screen.getByTestId("apply-accepted")).toBeDisabled();
    expect(screen.getByTestId("duplicate-group")).toHaveAttribute(
      "data-testid",
      "duplicate-group",
    );
  });

  it("keeps Apply disabled when the only mark is skipped", async () => {
    mount();
    await screen.findByText("Full content for knowledge-a");

    fireEvent.click(screen.getByTestId("skip-group"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 skipped",
      ),
    );
    expect(screen.getByTestId("apply-accepted")).toBeDisabled();
  });

  it("confirms both scopes with honest sync consequences and separate operations", async () => {
    const projectGroup = group("project:apply", [
      candidate("project-keep"),
      candidate("project-merge"),
    ]);
    const shared = sharedGroup("global:apply");
    const allCandidates = [...projectGroup.candidates, ...shared.candidates];
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("IndexedDB fixture did not open");
    const getSyncStatus = vi.fn(async () => ({
      enabled: true,
      state: "idle" as const,
      pending_changes: 3,
    }));
    const applyDedup = vi.fn<ApiClient["applyDedup"]>(async (id, body) =>
      receiptFor(id, body),
    );
    const client = makeClient({
      previewDedup: async () => response([projectGroup, shared]),
      listKnowledgeVersions: async (id) => {
        const item = allCandidates.find(
          (candidateItem) => candidateItem.logical_id === id,
        );
        if (!item) throw new Error(`Unknown knowledge id: ${id}`);
        return history(item);
      },
      getSyncStatus,
      applyDedup,
    });
    mount(client, Promise.resolve(db));
    await screen.findByText("Full content for project-keep");
    fireEvent.click(screen.getByTestId("accept-merge"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    fireEvent.click(screen.getAllByTestId("duplicate-group")[1]!);
    await screen.findByText("Full content for shared-a");
    fireEvent.click(screen.getByTestId("accept-merge"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "2 accepted",
      ),
    );

    // The workspace's shell status loader also reads sync status; count only
    // the read the confirmation itself makes.
    const syncReadsBeforeConfirm = getSyncStatus.mock.calls.length;
    fireEvent.click(screen.getByTestId("apply-accepted"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      "Regenerates .lore.md for this project (when .lore.md export is enabled)",
    );
    expect(dialog).toHaveTextContent(
      ".lore.md files are not affected (the removed entries belong to no project)",
    );
    await within(dialog).findByText(
      "Deletions are synced (3 changes already pending)",
    );
    const savedMarks = (
      await createReviewDecisionsStore(db).list(projectId)
    ).filter((record): record is DedupReviewMark => record.kind === "dedup");
    const expectedProjectReviewedAt = savedMarks.find(
      (mark) => mark.groupId === projectGroup.group_id,
    )?.markedAt;
    const expectedSharedReviewedAt = savedMarks.find(
      (mark) => mark.groupId === shared.group_id,
    )?.markedAt;
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Apply 2 accepted" }),
    );

    await waitFor(() => expect(applyDedup).toHaveBeenCalledTimes(2));
    const projectBody = applyDedup.mock.calls[0]?.[1];
    const sharedBody = applyDedup.mock.calls[1]?.[1];
    expect(applyDedup.mock.calls[0]?.[0]).toBe(projectId);
    expect(applyDedup.mock.calls[1]?.[0]).toBe(projectId);
    expect(projectBody).not.toHaveProperty("projectId");
    expect(sharedBody?.projectId).toBeNull();
    expect(projectBody?.reviewedAt).toBe(expectedProjectReviewedAt);
    expect(sharedBody?.reviewedAt).toBe(expectedSharedReviewedAt);
    expect(projectBody?.actor).toBe("lore-ui");
    expect(sharedBody?.actor).toBe("lore-ui");
    expect(projectBody?.operationId).not.toBe(sharedBody?.operationId);
    const operations = await screen.findAllByTestId("dedup-apply-operation");
    expect(operations).toHaveLength(2);
    expect(
      within(operations[0]!).getByText("Project", { exact: true }),
    ).toBeInTheDocument();
    expect(
      within(operations[1]!).getByText("Shared (no project)", { exact: true }),
    ).toBeInTheDocument();
    await waitFor(async () =>
      expect(await createReviewDecisionsStore(db).list(projectId)).toEqual([]),
    );
    expect(getSyncStatus).toHaveBeenCalledTimes(syncReadsBeforeConfirm + 1);
  });

  it("applies only fresh accepted marks and retains the stale mark", async () => {
    const staleSnapshot = group("project:stale", [
      candidate("stale-keep"),
      candidate("stale-merge"),
    ]);
    const staleFresh = group("project:stale", [
      candidate("stale-keep", { revision: 2 }),
      candidate("stale-merge"),
    ]);
    const fresh = group("project:fresh", [
      candidate("fresh-keep"),
      candidate("fresh-merge"),
    ]);
    const currentGroups = [staleFresh, fresh];
    const allCandidates = currentGroups.flatMap((item) => item.candidates);
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("IndexedDB fixture did not open");
    const decisions = createReviewDecisionsStore(db);
    const staleMark = markFrom(
      staleSnapshot,
      "accept",
      "stale-keep",
      projectId,
    );
    const freshMark = markFrom(fresh, "accept", "fresh-keep", projectId);
    await decisions.put(staleMark);
    await decisions.put(freshMark);

    const applyDedup = vi.fn<ApiClient["applyDedup"]>(async (id, body) =>
      receiptFor(id, body),
    );
    const client = makeClient({
      previewDedup: async () => response(currentGroups),
      listKnowledgeVersions: async (id) => {
        const item = allCandidates.find(
          (candidateItem) => candidateItem.logical_id === id,
        );
        if (!item) throw new Error(`Unknown knowledge id: ${id}`);
        return history(item);
      },
      applyDedup,
    });
    mount(client, Promise.resolve(db));
    await screen.findByText("Full content for stale-keep");
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    expect(screen.getByTestId("apply-accepted")).toHaveTextContent(
      "Apply 1 accepted…",
    );

    fireEvent.click(screen.getByTestId("apply-accepted"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Apply 1 accepted" }),
    );

    await screen.findByTestId("dedup-apply-receipt");
    expect(applyDedup).toHaveBeenCalledTimes(1);
    expect(applyDedup.mock.calls[0]?.[1].decisions).toEqual([
      {
        keepId: "fresh-keep",
        mergeIds: ["fresh-merge"],
        expectedRevisions: { "fresh-keep": 1, "fresh-merge": 1 },
      },
    ]);
    await waitFor(async () =>
      expect(await decisions.list(projectId)).toEqual([staleMark]),
    );
  });

  it("shows the project export consequence and device-only sync state", async () => {
    mount(
      makeClient({
        getSyncStatus: async () => ({
          enabled: false,
          state: "disabled",
          pending_changes: null,
        }),
      }),
    );
    await screen.findByText("Full content for knowledge-a");
    fireEvent.click(screen.getByTestId("accept-merge"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    fireEvent.click(screen.getByTestId("apply-accepted"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      "Regenerates .lore.md for this project (when .lore.md export is enabled)",
    );
    await within(dialog).findByText("Sync is off — this device only");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  });

  it("clears only applied marks and evicts merged knowledge cache rows", async () => {
    const firstGroup = group("project:first", [
      candidate("first-keep"),
      candidate("first-merge"),
    ]);
    const refusedGroup = group("project:refused", [
      candidate("refused-keep"),
      candidate("knowledge-b"),
    ]);
    const allCandidates = [
      ...firstGroup.candidates,
      ...refusedGroup.candidates,
    ];
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("IndexedDB fixture did not open");
    const knowledgeRepo = createKnowledgeRepo(db);
    await knowledgeRepo.put(
      {
        id: "first-merge",
        project_id: projectId,
        category: "decision",
        title: "Cached merged entry",
        content: "Cached content",
        confidence: 0.9,
      },
      projectId,
    );
    await knowledgeRepo.setCollection(projectId, {
      complete: true,
      count: 1,
      nextCursor: null,
      fetchedAt: Date.now(),
    });
    const applyDedup = vi.fn<ApiClient["applyDedup"]>(async (id, body) => {
      const refusedDecision = body.decisions[1];
      if (!refusedDecision) throw new Error("Expected a second group");
      return receiptFor(id, body, {
        appliedIndices: [0],
        refused: [
          {
            groupIndex: 1,
            keepId: refusedDecision.keepId,
            mergeIds: refusedDecision.mergeIds,
            error: {
              code: "stale_revision",
              message: "The entry changed after review.",
              details: [
                {
                  id: refusedDecision.mergeIds[0]!,
                  reason: "stale_revision",
                  expectedRevision: 1,
                  actualRevision: 2,
                },
              ],
            },
          },
        ],
      });
    });
    const client = makeClient({
      previewDedup: async () => response([firstGroup, refusedGroup]),
      listKnowledgeVersions: async (id) => {
        const item = allCandidates.find(
          (candidateItem) => candidateItem.logical_id === id,
        );
        if (!item) throw new Error(`Unknown knowledge id: ${id}`);
        return history(item);
      },
      applyDedup,
    });
    mount(client, Promise.resolve(db));
    await screen.findByText("Full content for first-keep");
    fireEvent.click(screen.getByTestId("accept-merge"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    fireEvent.click(screen.getAllByTestId("duplicate-group")[1]!);
    await screen.findByText("Full content for refused-keep");
    fireEvent.click(screen.getByTestId("accept-merge"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "2 accepted",
      ),
    );
    fireEvent.click(screen.getByTestId("apply-accepted"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Apply 2 accepted" }),
    );

    expect(await screen.findByTestId("applied-group")).toHaveTextContent(
      "Entry first-merge",
    );
    expect(await screen.findByTestId("refused-group")).toHaveTextContent(
      "Changed since you reviewed it — rescan and review again",
    );
    expect(screen.getAllByTestId("applied-group")).toHaveLength(1);
    expect(screen.getAllByTestId("refused-group")).toHaveLength(1);
    await waitFor(async () => {
      const records = await createReviewDecisionsStore(db).list(projectId);
      expect(records).toHaveLength(1);
      expect(records[0]?.kind).toBe("dedup");
    });
    const remaining = await createReviewDecisionsStore(db).list(projectId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.kind).toBe("dedup");
    if (remaining[0]?.kind === "dedup") {
      expect(remaining[0].groupId).toBe(refusedGroup.group_id);
    }
    expect(await knowledgeRepo.get("first-merge")).toBeUndefined();
    expect(await knowledgeRepo.collection(projectId)).toBeUndefined();
  });

  it("retries an unconfirmed apply after remount with the identical body", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("IndexedDB fixture did not open");
    const applyDedup = vi
      .fn<ApiClient["applyDedup"]>()
      .mockRejectedValueOnce(new Error("The connection closed"))
      .mockImplementationOnce(async (id, body) =>
        receiptFor(id, body, { replayed: true }),
      );
    const client = makeClient({ applyDedup });
    const firstMount = mount(client, Promise.resolve(db));
    await screen.findByText("Full content for knowledge-a");
    fireEvent.click(screen.getByTestId("accept-merge"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    fireEvent.click(screen.getByTestId("apply-accepted"));
    const firstDialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      await within(firstDialog).findByRole("button", {
        name: "Apply 1 accepted",
      }),
    );

    expect(
      await screen.findByText("The last apply didn't confirm — Retry"),
    ).toBeInTheDocument();
    const storedRecords = await createReviewDecisionsStore(db).list(projectId);
    const pending = storedRecords.find(
      (record) => record.kind === "dedup-apply",
    );
    expect(pending).toBeDefined();
    if (!pending || pending.kind !== "dedup-apply") {
      throw new Error("Pending apply record was not persisted");
    }
    const exactBody = pending.body;
    expect(exactBody.operationId).toBe(pending.operationId);
    firstMount.unmount();

    mount(client, Promise.resolve(db));
    expect(
      await screen.findByTestId("pending-dedup-applies"),
    ).toHaveTextContent("Retry");
    fireEvent.click(screen.getByTestId("retry-dedup-apply"));

    await screen.findByTestId("dedup-apply-receipt");
    expect(applyDedup).toHaveBeenNthCalledWith(1, projectId, exactBody);
    expect(applyDedup).toHaveBeenNthCalledWith(2, projectId, exactBody);
    expect(applyDedup.mock.calls[0]?.[1].operationId).toBe(
      applyDedup.mock.calls[1]?.[1].operationId,
    );
    expect(
      (await createReviewDecisionsStore(db).list(projectId)).some(
        (record) => record.kind === "dedup-apply",
      ),
    ).toBe(false);
    const operation = screen.getByTestId("dedup-apply-operation");
    const header = within(operation).getByTestId(
      "dedup-apply-operation-header",
    );
    expect(
      within(header).getByText("Project", { exact: true }),
    ).toBeInTheDocument();
    expect(header).not.toHaveTextContent(/replayed/i);
    const technicalDetails = within(operation)
      .getByText("Technical details")
      .closest("details");
    if (!technicalDetails) throw new Error("Missing technical details");
    fireEvent.click(within(operation).getByText("Technical details"));
    expect(technicalDetails).toHaveTextContent(/Replayed:\s*true/);
  });

  it("drops pending state after an operation conflict without clearing marks", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("IndexedDB fixture did not open");
    const applyDedup = vi
      .fn<ApiClient["applyDedup"]>()
      .mockRejectedValue(
        new ApiError(
          "http",
          "/api/v1/projects/p1/dedup/apply",
          "operation_conflict",
          409,
        ),
      );
    mount(makeClient({ applyDedup }), Promise.resolve(db));
    await screen.findByText("Full content for knowledge-a");
    fireEvent.click(screen.getByTestId("accept-merge"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    fireEvent.click(screen.getByTestId("apply-accepted"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Apply 1 accepted" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Operation ID conflict",
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    const remaining = await createReviewDecisionsStore(db).list(projectId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.kind).toBe("dedup");
  });

  it("closes the dialog and removes pending state when hosted apply is forbidden", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("IndexedDB fixture did not open");
    const applyDedup = vi
      .fn<ApiClient["applyDedup"]>()
      .mockRejectedValue(
        new ApiError(
          "forbidden",
          "/api/v1/projects/p1/dedup/apply",
          "Hosted mode forbids apply",
          403,
        ),
      );
    mount(makeClient({ applyDedup }), Promise.resolve(db));
    await screen.findByText("Full content for knowledge-a");
    fireEvent.click(screen.getByTestId("accept-merge"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    fireEvent.click(screen.getByTestId("apply-accepted"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Apply 1 accepted" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Not available in hosted mode",
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(
      (await createReviewDecisionsStore(db).list(projectId)).some(
        (record) => record.kind === "dedup-apply",
      ),
    ).toBe(false);
  });

  it("keeps orphaned marks until explicitly discarded", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    const orphan: DedupReviewMark = {
      key: `${projectId}/project:removed`,
      kind: "dedup",
      projectId,
      groupId: "project:removed",
      decision: "skip",
      keepId: "knowledge-a",
      mergeIds: ["knowledge-b"],
      expectedRevisions: { "knowledge-a": 1, "knowledge-b": 1 },
      markedAt: 1,
    };
    await createReviewDecisionsStore(db).put(orphan);

    mount(makeClient(), Promise.resolve(db));
    expect(await screen.findByTestId("orphaned-marks")).toHaveTextContent(
      "1 saved mark",
    );
    expect(await createReviewDecisionsStore(db).get(orphan.key)).toEqual(
      orphan,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Discard orphaned marks" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-marks")).not.toBeInTheDocument(),
    );
    expect(
      await createReviewDecisionsStore(db).get(orphan.key),
    ).toBeUndefined();
  });

  it("shows changed and removed candidates without treating either as current evidence", async () => {
    const previewGroup = group();
    const client = makeClient({
      previewDedup: async () => response([previewGroup]),
      listKnowledgeVersions: async (id) => {
        const item = previewGroup.candidates.find(
          (value) => value.logical_id === id,
        );
        if (!item) throw new Error(`Unknown knowledge id: ${id}`);
        if (id === "knowledge-b") {
          throw new ApiError(
            "not_found",
            "/api/v1/knowledge/knowledge-b/versions",
            "entry removed",
            404,
          );
        }
        return history(item, { version: 2 });
      },
    });
    mount(client);
    expect(
      await screen.findByText(/Changed since this scan/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Removed since this scan"),
    ).toBeInTheDocument();
    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByTestId("accept-merge")).toBeDisabled();
    expect(screen.getByTestId("changed-group-notice")).toHaveTextContent(
      "Rescan before marking — this group changed since the scan",
    );
    fireEvent.keyDown(screen.getByTestId("duplicate-review"), { key: "a" });
    expect(screen.getByTestId("review-summary")).toHaveTextContent(
      "0 accepted · 0 skipped · 1 pending",
    );
    fireEvent.click(screen.getByTestId("skip-group"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "0 accepted · 1 skipped · 0 pending",
      ),
    );
  });

  it("handles review shortcuts but ignores key events from typing fields", async () => {
    mount(makeClient(), Promise.resolve(null), true, true);
    await screen.findByText("Full content for knowledge-a");

    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 skipped",
      ),
    );
    fireEvent.keyDown(screen.getByLabelText("Keyboard test input"), {
      key: "a",
    });
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    const navLink = screen.getByTestId("keyboard-nav");
    navLink.focus();
    expect(navLink).toHaveFocus();
    fireEvent.keyDown(navLink, { key: "a" });
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    const review = screen.getByTestId("duplicate-review");
    const combobox = document.createElement("div");
    combobox.setAttribute("role", "combobox");
    combobox.tabIndex = 0;
    review.append(combobox);
    combobox.focus();
    fireEvent.keyDown(combobox, { key: "a" });
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    listbox.tabIndex = 0;
    review.append(listbox);
    listbox.focus();
    fireEvent.keyDown(listbox, { key: "a" });
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { key: "a" });
    dialog.remove();
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    fireEvent.keyDown(document.body, { key: "u" });
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 pending",
      ),
    );
  });

  it("moves between groups and selects a keeper with numbered shortcuts", async () => {
    const second = group("global:second", [
      candidate("knowledge-c", { scope: "shared", project_id: null }),
      candidate("knowledge-d", { scope: "shared", project_id: null }),
    ]);
    const candidates = [...group().candidates, ...second.candidates];
    mount(
      makeClient({
        previewDedup: async () => response([group(), second]),
        listKnowledgeVersions: async (id: string) => {
          const item = candidates.find((item) => item.logical_id === id);
          if (!item) throw new Error(`Unknown knowledge id: ${id}`);
          return history(item);
        },
      }),
    );
    await screen.findByText("Full content for knowledge-a");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(screen.getByTestId("focused-duplicate-group")).toHaveTextContent(
      "Group 2 of 2",
    );
    fireEvent.keyDown(document.body, { key: "2" });
    expect(screen.getByLabelText("Keep this one (2)")).toBeChecked();
    fireEvent.keyDown(document.body, { key: "k" });
    expect(screen.getByTestId("focused-duplicate-group")).toHaveTextContent(
      "Group 1 of 2",
    );
  });

  it("explains that decisions are session-only when IndexedDB is unavailable", async () => {
    mount(makeClient(), Promise.resolve(null));
    expect(
      await screen.findByTestId("review-storage-notice"),
    ).toHaveTextContent("not saved on this device");
  });

  it("does not send an apply when IndexedDB is unavailable", async () => {
    const applyDedup = vi.fn<ApiClient["applyDedup"]>(async (id, body) =>
      receiptFor(id, body),
    );
    mount(makeClient({ applyDedup }), Promise.resolve(null));
    await screen.findByText("Full content for knowledge-a");

    fireEvent.click(screen.getByTestId("accept-merge"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    expect(screen.getByTestId("duplicate-group")).toHaveTextContent("Accepted");

    fireEvent.click(screen.getByTestId("apply-accepted"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Apply 1 accepted" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the apply operation on this device — no changes were sent.",
    );
    expect(applyDedup).not.toHaveBeenCalled();
    expect(screen.getByTestId("review-summary")).toHaveTextContent(
      "1 accepted",
    );
    expect(screen.getByTestId("duplicate-group")).toHaveTextContent("Accepted");
  });

  it("reports failed mark writes and deletes", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("IndexedDB fixture did not open");
    let failNextReviewPut = true;
    let failNextReviewDelete = true;
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === "put") {
          return async (...args: Parameters<typeof target.put>) => {
            const [store] = args;
            if (store === "reviewDecisions" && failNextReviewPut) {
              failNextReviewPut = false;
              throw new Error("simulated storage failure");
            }
            return Reflect.apply(target.put, target, args);
          };
        }
        if (property === "delete") {
          return async (...args: Parameters<typeof target.delete>) => {
            const [store] = args;
            if (store === "reviewDecisions" && failNextReviewDelete) {
              failNextReviewDelete = false;
              throw new Error("simulated delete failure");
            }
            return Reflect.apply(target.delete, target, args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    mount(makeClient(), Promise.resolve(failingDb));
    await screen.findByText("Full content for knowledge-a");

    fireEvent.click(screen.getByTestId("accept-merge"));
    expect(
      await screen.findByTestId("review-persistence-error"),
    ).toHaveTextContent("Could not save this mark on this device");
    expect(screen.getByTestId("review-summary")).toHaveTextContent(
      "0 accepted",
    );

    fireEvent.click(screen.getByTestId("skip-group"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 skipped",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("review-persistence-error"),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear mark" }));
    expect(
      await screen.findByTestId("review-persistence-error"),
    ).toHaveTextContent("Could not save this mark on this device");
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
  });
});
