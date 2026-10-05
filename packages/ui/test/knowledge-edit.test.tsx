import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";

import { KnowledgeEditor } from "~/components/lore/KnowledgeEditor";
import { RestoreKnowledgeAction } from "~/components/lore/RestoreKnowledgeAction";
import type {
  KnowledgeEffects,
  KnowledgeEntry,
  KnowledgeVersionHistory,
} from "~/contracts";
import {
  closeLoreDb,
  createKnowledgeRepo,
  createDraftsStore,
  openLoreDb,
  type LoreUiDb,
} from "~/db";
import { ApiError, type ApiClient } from "~/lib/api";
import type { Loader } from "~/lib/loader";
import { WorkspaceProvider } from "~/routes/workspace";

import { IDBFactory } from "./idb-globals";

const entry = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id: "knowledge-1",
  logical_id: "knowledge-1",
  project_id: "project-1",
  category: "decision",
  title: "Current title",
  content: "Current content",
  confidence: 0.82,
  cross_project: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  ...over,
});

function version(
  n: number,
  over: Partial<KnowledgeVersionHistory["versions"][number]> = {},
): KnowledgeVersionHistory["versions"][number] {
  return {
    version_id: `version-${n}`,
    version: n,
    created_at: 1_700_000_000_000 + n,
    superseded_at: n === 1 ? 1_700_000_000_010 : null,
    is_current: n === 1,
    is_deleted: false,
    title: n === 1 ? "Current title" : `Version ${n}`,
    content: n === 1 ? "Current content" : `Content ${n}`,
    category: "decision",
    confidence: 0.82,
    scope: "project",
    cross_project: false,
    source_refs: {
      session_id: null,
      entry_id: "knowledge-1",
      user_id: null,
      created_by: "Ada",
      updated_by: "Ada",
      worker_provider_id: null,
      worker_model_id: null,
    },
    ...over,
  };
}

function history(head = 1, deleted = false): KnowledgeVersionHistory {
  const versions = [
    version(head, {
      is_current: true,
      is_deleted: deleted,
      superseded_at: null,
      title: deleted
        ? "Current title"
        : head === 1
          ? "Current title"
          : `Version ${head}`,
    }),
  ];
  if (head > 1) {
    versions.push(
      version(1, {
        is_current: false,
        superseded_at: 1_700_000_000_010,
      }),
    );
  }
  return {
    id: "knowledge-1",
    current_version_id: `version-${head}`,
    versions,
  };
}

function effects(over: Partial<KnowledgeEffects> = {}): KnowledgeEffects {
  return {
    scope: "project",
    project_id: "project-1",
    revision: 1,
    is_deleted: false,
    lore_file: {
      enabled: true,
      path: "/tmp/project/.lore.md",
      affected: true,
      regenerated: false,
    },
    agents_file: { enabled: true, mode: "pointer", immediate: false },
    sync: { enabled: false },
    ...over,
  };
}

function editResult(
  revision = 2,
  updated: KnowledgeEntry = entry({ title: "Edited title" }),
  changed: string[] = ["title"],
  effectOverrides: Partial<KnowledgeEffects> = {},
) {
  return {
    id: "knowledge-1",
    revision,
    previous_revision: revision - 1,
    version_id: `version-${revision}`,
    changed,
    effects: effects({ revision, ...effectOverrides }),
    entry: updated,
  };
}

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listProjects: async () => [],
    getKnowledgeEffects: async () => effects(),
    listKnowledgeVersions: async () => history(),
    editKnowledge: async () => editResult(),
    deleteKnowledge: async () => ({
      deleted: true,
      id: "knowledge-1",
      revision: 2,
      previous_revision: 1,
      version_id: "version-2",
      changed: ["is_deleted"],
      effects: effects({ revision: 2, is_deleted: true }),
      entry: null,
    }),
    restoreKnowledge: async () => ({
      ...editResult(3),
      restored_from: { version_id: "version-1", version: 1 },
    }),
    ...overrides,
  } as unknown as ApiClient;
}

function makeLoader<T>(
  initial: T | undefined,
  onReload?: () => void,
): { loader: Loader<T>; set: (value: T | undefined) => void } {
  const [data, set] = createSignal<T | undefined>(initial);
  const [error] = createSignal<unknown>();
  return {
    loader: {
      data,
      error,
      loading: () => false,
      stale: () => false,
      source: () => (data() === undefined ? null : "server"),
      partial: () => false,
      reload: () => onReload?.(),
    },
    set,
  };
}

function mountEditor(
  options: {
    client?: ApiClient;
    db?: Promise<LoreUiDb | null>;
    currentEntry?: KnowledgeEntry;
    currentHistory?: KnowledgeVersionHistory;
    onReload?: () => void;
  } = {},
) {
  const versions = makeLoader(
    "currentHistory" in options ? options.currentHistory : history(),
    options.onReload,
  );
  const view = render(() => (
    <WorkspaceProvider
      client={options.client ?? makeClient()}
      db={options.db ?? Promise.resolve(null)}
    >
      <KnowledgeEditor
        entry={options.currentEntry ?? entry()}
        versions={versions.loader}
        reloadEntry={options.onReload ?? vi.fn()}
      />
    </WorkspaceProvider>
  ));
  return { ...view, versions };
}

afterEach(async () => {
  vi.useRealTimers();
  await closeLoreDb();
});

describe("KnowledgeEditor", () => {
  it("waits for the current revision and keeps projectless entries shared", async () => {
    const mounted = mountEditor({
      currentEntry: entry({ project_id: null }),
      currentHistory: undefined,
    });
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).toBeDisabled();

    mounted.versions.set(history());
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    expect(screen.getByRole("radio", { name: "Shared" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Project" })).toBeDisabled();
    expect(screen.getAllByRole("option")).toHaveLength(5);
  });

  it("debounces draft writes and resumes an older row without optional fields", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("fake IndexedDB did not open");
    const drafts = createDraftsStore(db);
    await drafts.put({
      key: "knowledge/knowledge-1",
      kind: "knowledge",
      target: "knowledge-1",
      body: {
        title: "Older local draft",
        content: "Persisted content",
        category: "gotcha",
      },
      updatedAt: 10,
    });

    mountEditor({ db: Promise.resolve(db) });
    const banner = await screen.findByTestId("knowledge-draft-banner");
    expect(banner).toHaveTextContent("Unsaved draft from");
    expect(banner).toHaveTextContent("(based on an unknown revision)");
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Older local draft");
    expect(screen.getByLabelText("Content")).toHaveValue("Persisted content");
    expect(screen.getByLabelText(/^Confidence/)).toHaveValue(0.82);
    expect(screen.getByTestId("knowledge-edit-conflict")).toHaveTextContent(
      "Current on server · v1",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue editing on v1" }),
    );

    fireEvent.input(screen.getByLabelText("Title"), {
      target: { value: "Debounced replacement" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await drafts.get("knowledge/knowledge-1")).toMatchObject({
      body: { title: "Older local draft" },
    });
    await waitFor(async () =>
      expect(await drafts.get("knowledge/knowledge-1")).toMatchObject({
        body: { title: "Debounced replacement", confidence: 0.82 },
        baseRevision: 1,
      }),
    );
  });

  it("does not treat an empty confidence field as zero or save it", async () => {
    const editKnowledge = vi.fn();
    mountEditor({
      client: makeClient({ editKnowledge }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const confidenceInput = screen.getByLabelText(/^Confidence/);
    expect(confidenceInput).toBeRequired();
    fireEvent.input(confidenceInput, { target: { value: "" } });
    expect(confidenceInput).toHaveValue(null);
    fireEvent.submit(screen.getByTestId("knowledge-editor"));

    expect(editKnowledge).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Confidence must be a number from 0 to 1.",
    );
  });

  it("persists edits when Cancel is clicked before the debounce fires", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("fake IndexedDB did not open");
    const drafts = createDraftsStore(db);

    mountEditor({ db: Promise.resolve(db) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.input(screen.getByLabelText("Title"), {
      target: { value: "Canceled but retained" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(async () =>
      expect(await drafts.get("knowledge/knowledge-1")).toMatchObject({
        body: { title: "Canceled but retained" },
        baseRevision: 1,
      }),
    );
  });

  it("compares a resumed stale draft with the current server version", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("fake IndexedDB did not open");
    await createDraftsStore(db).put({
      key: "knowledge/knowledge-1",
      kind: "knowledge",
      target: "knowledge-1",
      body: {
        title: "Draft title",
        content: "Draft content",
        category: "decision",
      },
      baseRevision: 1,
      updatedAt: Date.now(),
    });

    mountEditor({ db: Promise.resolve(db), currentHistory: history(2) });
    const banner = await screen.findByTestId("knowledge-draft-banner");
    expect(banner).toHaveTextContent("(based on v1)");
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));

    const conflict = screen.getByTestId("knowledge-edit-conflict");
    expect(conflict).toHaveTextContent("Current on server · v2");
    expect(conflict).toHaveTextContent("Version 2");
    expect(conflict).toHaveTextContent("Content 2");
    expect(conflict).toHaveTextContent("Draft title");
    expect(conflict).toHaveTextContent("Draft content");
    fireEvent.click(
      screen.getByRole("button", { name: "Continue editing on v2" }),
    );
    expect(
      screen.queryByTestId("knowledge-edit-conflict"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("reports when local draft storage is unavailable", async () => {
    mountEditor({ db: Promise.resolve(null) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.input(screen.getByLabelText("Title"), {
      target: { value: "Unsaved local change" },
    });

    const notice = await screen.findByText(
      /Could not save this draft on this device/,
    );
    expect(notice).toHaveAttribute("role", "status");
  });

  it("preserves content beyond 1200 characters", async () => {
    const content = "Long content. ".repeat(100);
    const edit = vi.fn(async () => editResult(2, entry({ content })));
    mountEditor({ client: makeClient({ editKnowledge: edit }) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const contentField = screen.getByLabelText("Content");
    expect(contentField).not.toHaveAttribute("maxLength");
    fireEvent.input(contentField, { target: { value: content } });
    fireEvent.submit(screen.getByTestId("knowledge-editor"));

    await waitFor(() =>
      expect(edit).toHaveBeenCalledWith(
        "knowledge-1",
        expect.objectContaining({ content }),
      ),
    );
  });

  it("reports the project export when changing scope to shared", async () => {
    const changed = vi.fn(async () =>
      editResult(2, entry({ cross_project: 1 }), ["scope"], {
        scope: "shared",
        lore_file: {
          enabled: true,
          path: "/tmp/project/.lore.md",
          affected: false,
          regenerated: true,
        },
      }),
    );
    mountEditor({ client: makeClient({ editKnowledge: changed }) });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("radio", { name: "Shared" }));
    fireEvent.submit(screen.getByTestId("knowledge-editor"));

    await waitFor(() =>
      expect(screen.getByTestId("knowledge-save-success")).toHaveTextContent(
        "Project .lore.md regenerated",
      ),
    );
  });

  it("retains a stale draft and requires an explicit rebase onto the latest revision", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("fake IndexedDB did not open");
    const edit = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          "http",
          "/api/v1/knowledge/knowledge-1",
          "stale",
          409,
          "stale_revision",
        ),
      )
      .mockResolvedValue(editResult(3));
    const newest = history(2);
    let reloadVersions = () => {};
    const versions = makeLoader(history(), () => reloadVersions());
    reloadVersions = () => versions.set(newest);
    const client = makeClient({
      editKnowledge: edit,
      listKnowledgeVersions: async () => newest,
    });
    render(() => (
      <WorkspaceProvider client={client} db={Promise.resolve(db)}>
        <KnowledgeEditor
          entry={entry()}
          versions={versions.loader}
          reloadEntry={vi.fn()}
        />
      </WorkspaceProvider>
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByTestId("knowledge-editor");
    fireEvent.input(screen.getByLabelText("Title"), {
      target: { value: "Retained stale draft" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-draft-banner")).toBeVisible(),
    );
    fireEvent.submit(editor);
    await screen.findByTestId("knowledge-edit-conflict");
    expect(
      await createDraftsStore(db).get("knowledge/knowledge-1"),
    ).toMatchObject({
      body: { title: "Retained stale draft" },
      baseRevision: 1,
    });

    fireEvent.click(
      within(editor).getByRole("button", { name: "Continue editing on v2" }),
    );
    fireEvent.submit(editor);
    await waitFor(() =>
      expect(edit).toHaveBeenLastCalledWith(
        "knowledge-1",
        expect.objectContaining({
          expected_revision: 2,
          title: "Retained stale draft",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-save-success")).toHaveTextContent(
        "Saved as v3",
      ),
    );
    expect(screen.getByTestId("knowledge-save-success")).toHaveTextContent(
      "AGENTS.md pointer unchanged",
    );
    expect(screen.getByTestId("knowledge-save-success")).toHaveTextContent(
      "Sync is off",
    );
  });

  it("loads delete effects before confirmation and sends the checked revision", async () => {
    let resolveEffects: ((value: KnowledgeEffects) => void) | undefined;
    const getEffects = vi.fn(
      () =>
        new Promise<KnowledgeEffects>((resolve) => {
          resolveEffects = resolve;
        }),
    );
    const deleteKnowledge = vi.fn(async () => ({
      deleted: true as const,
      id: "knowledge-1",
      revision: 2,
      previous_revision: 1,
      version_id: "version-2",
      changed: ["is_deleted"],
      effects: effects({ revision: 2, is_deleted: true }),
      entry: null,
    }));
    const onDeleted = vi.fn();
    const versions = makeLoader(history());
    render(() => (
      <WorkspaceProvider
        client={makeClient({
          getKnowledgeEffects: getEffects,
          deleteKnowledge,
        })}
        db={Promise.resolve(null)}
      >
        <KnowledgeEditor
          entry={entry()}
          versions={versions.loader}
          reloadEntry={vi.fn()}
          onDeleted={onDeleted}
        />
      </WorkspaceProvider>
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(
      screen.getByRole("button", { name: "Loading effects…" }),
    ).toBeVisible();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    resolveEffects?.(
      effects({
        revision: 1,
        agents_file: { enabled: true, mode: "inline", immediate: false },
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      "This project's .lore.md is regenerated (when .lore.md export is enabled)",
    );
    expect(dialog).toHaveTextContent(
      "The inline AGENTS.md section is rewritten only by the next idle exporter",
    );
    expect(dialog).toHaveTextContent("Sync is off");
    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    await waitFor(() =>
      expect(deleteKnowledge).toHaveBeenCalledWith("knowledge-1", 1),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  });

  it("reloads a stale entry before opening delete confirmation", async () => {
    const latest = history(2);
    const listKnowledgeVersions = vi.fn(async () => latest);
    const getEffects = vi.fn(async () => effects({ revision: 2 }));
    const reloadEntry = vi.fn();
    const reloadVersions = vi.fn();
    const versions = makeLoader(history(), reloadVersions);
    render(() => (
      <WorkspaceProvider
        client={makeClient({
          getKnowledgeEffects: getEffects,
          listKnowledgeVersions,
        })}
        db={Promise.resolve(null)}
      >
        <KnowledgeEditor
          entry={entry()}
          versions={versions.loader}
          reloadEntry={reloadEntry}
        />
      </WorkspaceProvider>
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This entry changed while deletion consequences were loading",
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(reloadVersions).toHaveBeenCalledOnce();
    expect(reloadEntry).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete “Version 2” at revision 2");
    expect(dialog).not.toHaveTextContent("Delete “Current title”");
    expect(listKnowledgeVersions).toHaveBeenCalledOnce();
  });

  it("shows title conflicts inline", async () => {
    const titleConflict = makeClient({
      editKnowledge: async () => {
        throw new ApiError(
          "http",
          "/api/v1/knowledge/knowledge-1",
          "title conflict",
          409,
          "title_conflict",
        );
      },
    });
    mountEditor({ client: titleConflict });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.submit(screen.getByTestId("knowledge-editor"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Another entry in this scope already uses this title.",
      ),
    );
  });

  it("locks the editor after a hosted-mode refusal", async () => {
    const hosted = makeClient({
      editKnowledge: async () => {
        throw new ApiError(
          "forbidden",
          "/api/v1/knowledge/knowledge-1",
          "hosted writes are disabled",
          403,
        );
      },
    });
    mountEditor({ client: hosted });
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    fireEvent.submit(screen.getByTestId("knowledge-editor"));
    await waitFor(() =>
      expect(screen.getByText("Editing unavailable")).toBeVisible(),
    );
    expect(screen.getByRole("button", { name: /^Edit$/ })).toBeDisabled();
  });

  it("persists the current draft before locking after a hosted refusal", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("fake IndexedDB did not open");
    mountEditor({
      db: Promise.resolve(db),
      client: makeClient({
        editKnowledge: async () => {
          throw new ApiError(
            "forbidden",
            "/api/v1/knowledge/knowledge-1",
            "hosted writes are disabled",
            403,
          );
        },
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    fireEvent.input(screen.getByLabelText("Title"), {
      target: { value: "Hosted-mode unsaved draft" },
    });
    fireEvent.submit(screen.getByTestId("knowledge-editor"));

    await screen.findByText("Editing unavailable");
    expect(
      await createDraftsStore(db).get("knowledge/knowledge-1"),
    ).toMatchObject({
      body: { title: "Hosted-mode unsaved draft" },
      baseRevision: 1,
    });
  });
});

describe("RestoreKnowledgeAction", () => {
  it("reloads stale deleted history before opening restore confirmation", async () => {
    const latest = history(3, true);
    const lastLive = latest.versions.find(
      (candidate) => candidate.version === 1,
    );
    if (lastLive) {
      lastLive.scope = "shared";
      lastLive.cross_project = true;
    }
    const reloadHistory = vi.fn();
    let onReload = () => {};
    const versions = makeLoader(history(2, true), () => onReload());
    onReload = () => {
      reloadHistory();
      versions.set(latest);
    };
    const listKnowledgeVersions = vi.fn(async () => latest);
    const getEffects = vi.fn(async () =>
      effects({
        revision: 3,
        is_deleted: true,
        scope: "shared",
        lore_file: {
          enabled: true,
          path: "/tmp/project/.lore.md",
          affected: false,
          regenerated: false,
        },
      }),
    );
    render(() => (
      <WorkspaceProvider
        client={makeClient({
          getKnowledgeEffects: getEffects,
          listKnowledgeVersions,
        })}
        db={Promise.resolve(null)}
      >
        <RestoreKnowledgeAction id="knowledge-1" history={versions.loader} />
      </WorkspaceProvider>
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Restore…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The entry changed before restore confirmation opened",
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(reloadHistory).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Restore…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Current head: v3");
    expect(dialog).toHaveTextContent(
      ".lore.md files are not affected (shared entries are not exported)",
    );
  });

  it("disables restore when no live history version remains", async () => {
    const deletedHistory: KnowledgeVersionHistory = {
      id: "knowledge-1",
      current_version_id: "version-1",
      versions: [version(1, { is_current: true, is_deleted: true })],
    };
    const versions = makeLoader(deletedHistory);
    render(() => (
      <WorkspaceProvider client={makeClient()} db={Promise.resolve(null)}>
        <RestoreKnowledgeAction id="knowledge-1" history={versions.loader} />
      </WorkspaceProvider>
    ));

    expect(
      await screen.findByRole("button", { name: "Restore…" }),
    ).toBeDisabled();
  });

  it("omits deletion recovery copy when restoring a live history version", async () => {
    const versions = makeLoader(history(2));
    render(() => (
      <WorkspaceProvider
        client={makeClient({
          getKnowledgeEffects: async () => effects({ revision: 2 }),
        })}
        db={Promise.resolve(null)}
      >
        <RestoreKnowledgeAction
          id="knowledge-1"
          history={versions.loader}
          versionId="version-1"
        />
      </WorkspaceProvider>
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Restore v1…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Current head: v2");
    expect(
      screen.queryByText("References removed by deletion are not restored"),
    ).not.toBeInTheDocument();
  });

  it("confirms effects and reloads the head after a stale restore", async () => {
    const restore = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          "http",
          "/api/v1/knowledge/knowledge-1/restore",
          "stale",
          409,
          "stale_revision",
        ),
      )
      .mockResolvedValue({
        ...editResult(4, entry({ cross_project: 1 }), ["restored"], {
          scope: "shared",
          lore_file: {
            enabled: true,
            path: "/tmp/project/.lore.md",
            affected: false,
            regenerated: true,
          },
        }),
        restored_from: { version_id: "version-1", version: 1 },
      });
    const sharedHistory = (head: number) => {
      const result = history(head, true);
      const prior = result.versions.find((version) => version.version === 1);
      if (prior) {
        prior.scope = "shared";
        prior.cross_project = true;
      }
      return result;
    };
    const latest = sharedHistory(3);
    let reloadVersions = () => {};
    const versions = makeLoader(sharedHistory(2), () => reloadVersions());
    reloadVersions = () => versions.set(latest);
    const getEffects = vi
      .fn()
      .mockResolvedValueOnce(effects({ revision: 2, is_deleted: true }))
      .mockResolvedValue(effects({ revision: 3, is_deleted: true }));
    const client = makeClient({
      restoreKnowledge: restore,
      listKnowledgeVersions: async () => latest,
      getKnowledgeEffects: getEffects,
    });
    const onRestored = vi.fn();
    render(() => (
      <WorkspaceProvider client={client} db={Promise.resolve(null)}>
        <RestoreKnowledgeAction
          id="knowledge-1"
          history={versions.loader}
          versionId="version-1"
          onRestored={onRestored}
        />
      </WorkspaceProvider>
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Restore v1…" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Current head: v2");
    expect(dialog).toHaveTextContent(
      "This project's .lore.md is regenerated (when .lore.md export is enabled)",
    );
    expect(dialog).toHaveTextContent(
      "References removed by deletion are not restored",
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore version" }));
    await waitFor(() =>
      expect(dialog).toHaveTextContent(
        "The entry changed after this confirmation opened",
      ),
    );
    await waitFor(() => expect(dialog).toHaveTextContent("Current head: v3"));
    fireEvent.click(screen.getByRole("button", { name: "Restore version" }));
    await waitFor(() =>
      expect(restore).toHaveBeenLastCalledWith("knowledge-1", {
        expected_revision: 3,
        version_id: "version-1",
      }),
    );
    await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Restored as v4"),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Project .lore.md regenerated",
    );
  });

  it("invalidates all project collections when restoring from shared scope", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("fake IndexedDB did not open");
    const repo = createKnowledgeRepo(db);
    const collection = {
      complete: true,
      count: 0,
      nextCursor: null,
      fetchedAt: Date.now(),
    };
    await repo.setCollection("project-1", collection);
    await repo.setCollection("project-2", collection);
    const deletedSharedHistory: KnowledgeVersionHistory = {
      id: "knowledge-1",
      current_version_id: "version-2",
      versions: [
        version(2, {
          is_current: true,
          is_deleted: true,
          scope: "shared",
          cross_project: true,
        }),
        version(1, { scope: "project", cross_project: false }),
      ],
    };
    const versions = makeLoader(deletedSharedHistory);
    const client = makeClient({
      listProjects: async () => [
        {
          id: "project-1",
          name: "Project one",
          path: "/project-one",
          git_remote: null,
          created_at: 1,
          knowledge_count: 0,
          session_count: 0,
          message_count: 0,
          distillation_count: 0,
          last_activity: null,
        },
        {
          id: "project-2",
          name: "Project two",
          path: "/project-two",
          git_remote: null,
          created_at: 1,
          knowledge_count: 0,
          session_count: 0,
          message_count: 0,
          distillation_count: 0,
          last_activity: null,
        },
      ],
      getKnowledgeEffects: async () =>
        effects({ revision: 2, is_deleted: true, scope: "shared" }),
      restoreKnowledge: async () => ({
        ...editResult(3, entry({ cross_project: 0 }), ["restored"], {
          scope: "project",
        }),
        restored_from: { version_id: "version-1", version: 1 },
      }),
    });
    render(() => (
      <WorkspaceProvider client={client} db={Promise.resolve(db)}>
        <RestoreKnowledgeAction id="knowledge-1" history={versions.loader} />
      </WorkspaceProvider>
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Restore…" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restore version" }),
    );
    await screen.findByText(/Restored as v3/);
    await waitFor(async () => {
      expect(await repo.collection("project-1")).toBeUndefined();
      expect(await repo.collection("project-2")).toBeUndefined();
    });
  });
});
