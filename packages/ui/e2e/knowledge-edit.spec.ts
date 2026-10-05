import { expect, test, type Page } from "@playwright/test";

type KnowledgeEntry = {
  id: string;
  title: string;
};

async function projectIdByName(page: Page, name: string): Promise<string> {
  const response = await page.request.get("/api/v1/projects");
  expect(response.ok()).toBe(true);
  const projects = (await response.json()) as { id: string; name: string }[];
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`seeded edit project ${name} is missing`);
  return project.id;
}

async function projectKnowledgeCount(page: Page, projectId: string) {
  const response = await page.request.get("/api/v1/projects");
  expect(response.ok()).toBe(true);
  const projects = (await response.json()) as {
    id: string;
    knowledge_count: number;
  }[];
  const project = projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`project ${projectId} is missing`);
  return project.knowledge_count;
}

test.describe("revision-checked knowledge editing (MEM-03)", () => {
  test("refuses sharing a project title used by shared entries", async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? "mobile"
      : "desktop";
    const run = testInfo.retry + 1;
    const projectId = await projectIdByName(
      page,
      `dd-apply-${viewport}-${run}`,
    );
    const sharedTitle = "Shared title conflict legacy duplicate E2E";
    const entriesResponse = await page.request.get(
      `/api/v1/projects/${projectId}/knowledge`,
    );
    expect(entriesResponse.ok()).toBe(true);
    const entries = (await entriesResponse.json()) as KnowledgeEntry[];
    const entry = entries.find((item) => item.title === sharedTitle);
    if (!entry) throw new Error("seeded shared-title edit entry is missing");

    await page.goto(`/ui/projects/${projectId}/knowledge/${entry.id}`);
    await expect(page.getByTestId("knowledge-document")).toBeVisible();
    const attemptShare = async (knowledgeId: string) => {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const editor = page.getByTestId("knowledge-editor");
      await editor.getByLabel("Shared").check();
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "PATCH" &&
          new URL(candidate.url()).pathname ===
            `/api/v1/knowledge/${knowledgeId}`,
      );
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      return response;
    };

    const firstResponse = await attemptShare(entry.id);
    expect(firstResponse.status()).toBe(409);
    const firstBody = (await firstResponse.json()) as {
      error: { conflicting_entry: { id: string; title: string } };
    };
    const conflict = firstBody.error.conflicting_entry;
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(
      "already uses this title among shared entries",
    );
    const existingEntryLink = alert.getByRole("link", {
      name: `Open “${conflict.title}”`,
    });
    await expect(existingEntryLink).toHaveAttribute(
      "href",
      `/ui/knowledge/${conflict.id}`,
    );
    const duplicatesLink = alert.getByRole("link", {
      name: "Review duplicates",
    });
    await expect(duplicatesLink).toHaveAttribute(
      "href",
      `/ui/projects/${projectId}/duplicates`,
    );

    await existingEntryLink.click();
    await expect(page).toHaveURL(`/ui/knowledge/${conflict.id}`);
    await expect(page.getByTestId("knowledge-document")).toContainText(
      conflict.title,
    );

    const reviewRun = run === 3 ? 1 : run + 1;
    const reviewProjectId = await projectIdByName(
      page,
      `dd-apply-${viewport}-${reviewRun}`,
    );
    const reviewEntriesResponse = await page.request.get(
      `/api/v1/projects/${reviewProjectId}/knowledge`,
    );
    expect(reviewEntriesResponse.ok()).toBe(true);
    const reviewEntries =
      (await reviewEntriesResponse.json()) as KnowledgeEntry[];
    const reviewEntry = reviewEntries.find(
      (item) => item.title === sharedTitle,
    );
    if (!reviewEntry)
      throw new Error("second seeded shared-title edit entry is missing");
    await page.goto(
      `/ui/projects/${reviewProjectId}/knowledge/${reviewEntry.id}`,
    );
    const secondResponse = await attemptShare(reviewEntry.id);
    expect(secondResponse.status()).toBe(409);
    await page
      .getByRole("alert")
      .getByRole("link", { name: "Review duplicates" })
      .click();
    await expect(page).toHaveURL(`/ui/projects/${reviewProjectId}/duplicates`);
    await expect(page.getByTestId("shared-title-conflicts")).toBeVisible();
  });

  test("restores a superseded live history version", async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? "mobile"
      : "desktop";
    const run = testInfo.retry + 1;
    const projectId = await projectIdByName(
      page,
      `dd-apply-${viewport}-${run}`,
    );
    const seedTitle = `Revision checked restore ${viewport} ${run} disposable fixture`;
    const entriesResponse = await page.request.get(
      `/api/v1/projects/${projectId}/knowledge`,
    );
    expect(entriesResponse.ok()).toBe(true);
    const entries = (await entriesResponse.json()) as KnowledgeEntry[];
    const entry = entries.find((item) => item.title === seedTitle);
    if (!entry) throw new Error(`seeded restore entry ${seedTitle} is missing`);

    const edit = await page.request.patch(`/api/v1/knowledge/${entry.id}`, {
      data: {
        expected_revision: 1,
        title: `Updated ${seedTitle}`,
        content: "A newer live version for the restore-history test.",
      },
    });
    expect(edit.ok()).toBe(true);

    await page.goto(`/ui/projects/${projectId}/knowledge/${entry.id}`);
    const history = page.getByTestId("version-history");
    const firstVersion = history.getByTestId("knowledge-version-1");
    await expect(firstVersion).toBeVisible();
    await firstVersion.locator("summary").click();
    await firstVersion.getByRole("button", { name: "Restore v1…" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Current head: v2");
    await expect(dialog).not.toContainText(
      "References removed by deletion are not restored",
    );
    await dialog.getByRole("button", { name: "Restore version" }).click();

    const document = page.getByTestId("knowledge-document");
    await expect(
      document.getByRole("heading", { name: seedTitle }),
    ).toBeVisible();
    await expect(page.getByTestId("version-history")).toContainText("v3");
    await expect(
      page.getByTestId("version-history").getByTestId("knowledge-version-3"),
    ).toContainText("Current");
  });

  test("saves only on request, retains stale drafts, deletes, navigates back and restores", async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? "mobile"
      : "desktop";
    const run = testInfo.retry + 1;
    const projectId = await projectIdByName(
      page,
      `dd-apply-${viewport}-${run}`,
    );
    const seedTitle = `Revision checked edit ${viewport} ${run} disposable fixture`;
    const entriesResponse = await page.request.get(
      `/api/v1/projects/${projectId}/knowledge`,
    );
    expect(entriesResponse.ok()).toBe(true);
    const entries = (await entriesResponse.json()) as KnowledgeEntry[];
    const entry = entries.find((item) => item.title === seedTitle);
    if (!entry) throw new Error(`seeded edit entry ${seedTitle} is missing`);
    const initialKnowledgeCount = await projectKnowledgeCount(page, projectId);
    const historyResponse = await page.request.get(
      `/api/v1/knowledge/${entry.id}/versions`,
    );
    expect(historyResponse.ok()).toBe(true);
    const history = (await historyResponse.json()) as {
      versions: { is_current: boolean; version: number }[];
    };
    const expectedRevision = history.versions.find(
      (version) => version.is_current,
    )?.version;
    if (expectedRevision === undefined)
      throw new Error("seeded edit entry has no live revision");

    await page.addInitScript(() => {
      (window as Window & { __pwned?: number }).__pwned = 0;
    });
    await page.goto(`/ui/projects/${projectId}/knowledge`);
    const tableEntry = page
      .locator('[data-pane="detail"] [data-testid="knowledge-row"]')
      .filter({ hasText: seedTitle });
    await expect(tableEntry).toBeVisible();
    await tableEntry.click();
    await expect(page.getByTestId("knowledge-document")).toBeVisible();
    const apiRequests: Array<{
      url: string;
      method: string;
      body: string | null;
    }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) {
        apiRequests.push({
          url: request.url(),
          method: request.method(),
          body: request.postData(),
        });
      }
    });

    const titleDraft = `Saved edit ${viewport} ${run} unique`;
    const contentDraft = `This draft is local until Save ${viewport} ${run}: <script>window.__pwned=1</script>`;
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByTestId("knowledge-editor");
    await editor.getByLabel("Title").fill(titleDraft);
    await editor.getByLabel("Content").fill(contentDraft);
    await expect(page.getByTestId("knowledge-draft-banner")).toBeVisible();
    const draftRequests = apiRequests.filter(
      (request) =>
        request.url.includes(titleDraft) ||
        request.url.includes(contentDraft) ||
        request.body?.includes(titleDraft) ||
        request.body?.includes(contentDraft),
    );
    expect(draftRequests).toEqual([]);

    const savedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/v1/knowledge/${entry.id}`,
    );
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const patchResponse = await savedResponse;
    expect(patchResponse.ok()).toBe(true);
    const firstPatch = JSON.parse(
      patchResponse.request().postData() ?? "{}",
    ) as Record<string, unknown>;
    expect(firstPatch).toEqual({
      expected_revision: expectedRevision,
      title: titleDraft,
      content: contentDraft,
    });
    expect(
      apiRequests.filter(
        (request) =>
          request.url.includes(titleDraft) ||
          request.url.includes(contentDraft) ||
          request.body?.includes(titleDraft) ||
          request.body?.includes(contentDraft),
      ),
    ).toEqual([
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining(titleDraft),
      }),
    ]);
    await expect(page.getByTestId("knowledge-save-success")).toContainText(
      "Saved as v",
    );
    expect(
      apiRequests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(1);
    await expect(page.locator("main img[onerror]")).toHaveCount(0);
    await expect(page.locator("main script")).toHaveCount(0);
    await expect(page.locator("main")).toContainText(contentDraft);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __pwned?: number }).__pwned ?? 0,
        ),
      )
      .toBe(0);

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const staleDraft = `Draft for conflict ${viewport} ${run}`;
    const concurrentTitle = `Concurrent edit ${viewport} ${run} unique`;
    await page
      .getByTestId("knowledge-editor")
      .getByLabel("Title")
      .fill(staleDraft);
    await expect(page.getByTestId("knowledge-draft-banner")).toBeVisible();
    const concurrent = await page.request.patch(
      `/api/v1/knowledge/${entry.id}`,
      {
        data: {
          expected_revision: expectedRevision + 1,
          title: concurrentTitle,
          actor: "e2e",
        },
      },
    );
    expect(concurrent.ok()).toBe(true);

    await page
      .getByTestId("knowledge-editor")
      .getByRole("button", {
        name: "Save",
        exact: true,
      })
      .click();
    await expect(page.getByTestId("knowledge-edit-conflict")).toContainText(
      "This entry changed since you started editing",
    );
    await expect(page.getByTestId("knowledge-editor")).toContainText(
      "Continue editing on v3",
    );

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const deleteDialog = page.getByRole("alertdialog");
    await expect(deleteDialog).toContainText("AGENTS.md pointer is unchanged");
    await expect(deleteDialog).toContainText("Sync is off");
    await expect(deleteDialog).toContainText("History for recovery");
    await deleteDialog.getByRole("button", { name: "Delete entry" }).click();

    const deleted = page.getByTestId("deleted-knowledge-document");
    await expect(deleted).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(`/ui/projects/${projectId}/knowledge`);
    await expect(
      page
        .locator('[data-pane="list"] [data-testid="knowledge-row"]')
        .filter({ hasText: titleDraft }),
    ).toHaveCount(0);
    const projectNav = page.locator(
      `[data-pane="nav"] [data-testid="nav-project"][href$="/projects/${projectId}"]`,
    );
    await expect(projectNav.locator("span").last()).toHaveText(
      String(initialKnowledgeCount - 1),
    );
    await page.goForward();
    await expect(deleted).toBeVisible();
    await expect(
      deleted.getByRole("button", { name: "Restore…" }),
    ).toBeVisible();
    await deleted.getByRole("button", { name: "Restore…" }).click();
    const restoreDialog = page.getByRole("alertdialog");
    await expect(restoreDialog).toContainText("Current head: v4");
    await expect(restoreDialog).toContainText(
      "References removed by deletion are not restored",
    );
    await restoreDialog
      .getByRole("button", { name: "Restore version" })
      .click();
    await expect(page.getByTestId("knowledge-document")).toBeVisible();
    await expect(
      page.getByTestId("version-history").getByTestId("knowledge-version-5"),
    ).toContainText("Current");
  });
});
