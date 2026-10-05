import { expect, test, type Page } from "@playwright/test";

type PreviewCandidate = {
  id: string;
  logical_id: string;
  title: string;
  scope: "project" | "shared";
};

type PreviewGroup = {
  scope: "project" | "global";
  pool: "project" | "shared" | "project_shared";
  suggested_keep_id: string;
  candidates: PreviewCandidate[];
};

const fixturePhrases = {
  desktop: {
    replacement: [
      "Qorvex zintara plasmonic velmora thalix nimbostratus orbilith",
      "Brindlequartz hexacove fjordalune opaline cryptomere",
      "Tesseractum glaciovale cindervex periwinkle monadrix",
    ],
    conflict: [
      "Frambulator quivernyx alabastrine pluviosity",
      "Obeliskator myrmidonix calcifugue nebulanth",
      "Vorticelleum crenelune ichoridian mothglass",
    ],
  },
  mobile: {
    replacement: [
      "Xylophane quendrix obsidianite vermilune galvador",
      "Praxolume hallowmere quixoticum azurite fenbrisk",
      "Kestrelune morrowglass zephryx octarine brumestone",
    ],
    conflict: [
      "Klystralum micronymphic iridocane quorvox",
      "Gloamingate thistledrift verdigridium nacreous",
      "Cumbervault anemophilous draconicum prismatic",
    ],
  },
} as const;

function fixtureTitle(
  viewport: "desktop" | "mobile",
  run: number,
  kind: "replacement" | "conflict",
  role: "source" | "keeper",
): string {
  const phrase = fixturePhrases[viewport][kind][run - 1];
  if (!phrase) throw new Error(`missing ${kind} fixture for run ${run}`);
  return `${phrase} ${role} ${viewport}-${run}`;
}

function conflictEntryId(viewport: "desktop" | "mobile", run: number): string {
  return `00000000-0000-4000-8000-${String(
    (viewport === "desktop" ? 100 : 200) + run,
  ).padStart(12, "0")}`;
}

async function projectIdByName(page: Page, name: string): Promise<string> {
  const response = await page.request.get("/api/v1/projects");
  expect(response.ok()).toBe(true);
  const projects = (await response.json()) as {
    id: string;
    name: string;
  }[];
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`seeded apply project ${name} is missing`);
  return project.id;
}

test.describe("duplicate apply (MEM-02)", () => {
  test("applies one scope, refuses a removed shared entry, and recovers history", async ({
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
    const projectCandidateTitles = [
      `Applyable ${viewport} ${run} atomic amber keeper`,
      `Applyable ${viewport} ${run} atomic amethyst keeper`,
    ];
    const refusalTitle =
      viewport === "desktop"
        ? [
            "Cobalt geodesic lantern astronomy beacon silver",
            "Papaya acoustic kettle geometry artisan violet",
            "Thimble glacier rainfall magnetism particle amber",
          ][run - 1]
        : [
            "Quasar maple jukebox fossil moonlit engine",
            "Velvet otter cathedral bacteria canvas monsoon",
            "Saffron bicycle fjord tessellation trumpet eclipse",
          ][run - 1];
    const refusalKeepTitle = `${refusalTitle} keeper`;
    const refusalMergeTitle = `${refusalTitle} remove-me`;

    const previewResponse = await page.request.post(
      `/api/v1/projects/${projectId}/dedup`,
      { data: {} },
    );
    expect(previewResponse.ok()).toBe(true);
    const preview = (await previewResponse.json()) as {
      groups: PreviewGroup[];
    };
    const projectGroup = preview.groups.find(
      (group) =>
        group.scope === "project" &&
        group.candidates.some((candidate) =>
          projectCandidateTitles.includes(candidate.title),
        ),
    );
    const refusalGroup = preview.groups.find(
      (group) =>
        group.scope === "global" &&
        group.candidates.some(
          (candidate) => candidate.title === refusalKeepTitle,
        ),
    );
    if (!projectGroup) {
      throw new Error("the project apply group is missing from preview");
    }
    expect(projectGroup.candidates.map((candidate) => candidate.title)).toEqual(
      expect.arrayContaining(projectCandidateTitles),
    );
    const keepCandidate = projectGroup.candidates.find(
      (candidate) => candidate.id === projectGroup.suggested_keep_id,
    );
    const mergeCandidate = projectGroup.candidates.find(
      (candidate) => candidate.id !== projectGroup.suggested_keep_id,
    );
    if (!keepCandidate || !mergeCandidate) {
      throw new Error("the project apply candidates are missing from preview");
    }
    const applyableKeepTitle = keepCandidate.title;
    const applyableMergeTitle = mergeCandidate.title;
    expect(
      refusalGroup?.candidates.map((candidate) => candidate.title),
    ).toEqual(expect.arrayContaining([refusalKeepTitle, refusalMergeTitle]));
    const removedCandidate = refusalGroup?.candidates.find(
      (candidate) => candidate.title === refusalMergeTitle,
    );
    if (!removedCandidate) {
      throw new Error("the shared refusal candidate is missing from preview");
    }

    await page.goto(`/ui/projects/${projectId}/duplicates`);
    const review = page.getByTestId("duplicate-review");
    const applyable = review
      .getByTestId("duplicate-group")
      .filter({ hasText: applyableKeepTitle });
    const refusal = review
      .getByTestId("duplicate-group")
      .filter({ hasText: refusalKeepTitle });
    await expect(applyable).toHaveCount(1);
    await expect(refusal).toHaveCount(1);

    await applyable.click();
    await expect(
      review
        .getByTestId("duplicate-candidate")
        .filter({ hasText: applyableKeepTitle }),
    ).toBeVisible();
    await expect(review.getByTestId("duplicate-candidate")).toHaveCount(2);
    await review.getByTestId("accept-merge").click();
    await expect(review.getByTestId("review-summary")).toContainText(
      "1 accepted",
    );

    await refusal.click();
    await expect(
      review
        .getByTestId("duplicate-candidate")
        .filter({ hasText: refusalKeepTitle }),
    ).toBeVisible();
    await expect(review.getByText("Shared").first()).toBeVisible();
    await review.getByTestId("accept-merge").click();
    await expect(review.getByTestId("review-summary")).toContainText(
      "2 accepted",
    );

    await review.getByTestId("apply-accepted").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      "Regenerates .lore.md for this project (when .lore.md export is enabled)",
    );
    await expect(dialog).toContainText(
      ".lore.md files are not affected (the removed entries belong to no project)",
    );
    await expect(dialog).toContainText("Sync is off — this device only");

    const applyPath = `/api/v1/projects/${projectId}/dedup/apply`;
    const requestBodies: Record<string, unknown>[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === applyPath
      ) {
        requestBodies.push(
          JSON.parse(request.postData() ?? "{}") as Record<string, unknown>,
        );
      }
    });
    let deletedBeforeSharedApply = false;
    await page.route(`**${applyPath}`, async (route) => {
      const body = route.request().postDataJSON() as {
        projectId?: string | null;
      };
      if (body.projectId === undefined && !deletedBeforeSharedApply) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        const deleted = await page.request.delete(
          `/api/v1/knowledge/${encodeURIComponent(removedCandidate.logical_id)}`,
        );
        expect(deleted.ok()).toBe(true);
        deletedBeforeSharedApply = true;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    await dialog.getByRole("button", { name: "Apply 2 accepted" }).click();

    const receipt = page.getByTestId("dedup-apply-receipt");
    await expect(receipt.getByTestId("applied-group")).toContainText(
      applyableMergeTitle,
    );
    await expect(receipt.getByTestId("refused-group")).toContainText(
      "An entry was removed since the scan",
    );
    expect(deletedBeforeSharedApply).toBe(true);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).not.toHaveProperty("projectId");
    expect(requestBodies[1]?.projectId).toBeNull();

    const knowledgeResponse = await page.request.get(
      `/api/v1/projects/${projectId}/knowledge`,
    );
    expect(knowledgeResponse.ok()).toBe(true);
    const remainingProjectEntries = (await knowledgeResponse.json()) as {
      id: string;
    }[];
    const appliedMergeId = projectGroup.candidates.find(
      (candidate) => candidate.title === applyableMergeTitle,
    )?.logical_id;
    expect(appliedMergeId).toBeTruthy();
    expect(
      remainingProjectEntries.some((entry) => entry.id === appliedMergeId),
    ).toBe(false);

    await receipt.getByRole("link", { name: applyableMergeTitle }).click();
    await expect(page).toHaveURL(
      new RegExp(`/ui/projects/${projectId}/knowledge/[^/]+$`),
    );
    const deletedView = page.getByTestId("deleted-knowledge-document");
    await expect(deletedView).toBeVisible();
    await expect(deletedView).toContainText(applyableMergeTitle);
    await expect(deletedView).toContainText(
      `${
        applyableMergeTitle.endsWith("amber keeper") ? "Keep" : "Merge"
      } the primary apply fixture for dd-apply-${viewport}-${run}.`,
    );
    await expect(deletedView).toContainText("Deleted");
    await expect(deletedView.getByText(/^Deleted /)).toBeVisible();
    await expect(
      deletedView.getByRole("button", { name: "Restore…" }),
    ).toBeVisible();
    await expect(page.getByTestId("knowledge-version-2")).toContainText(
      "Deleted",
    );
  });

  test("keeps private content as a new version of the shared entry", async ({
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
    const privateTitle = fixtureTitle(viewport, run, "replacement", "source");
    const sharedTitle = fixtureTitle(viewport, run, "replacement", "keeper");
    const previewResponse = await page.request.post(
      `/api/v1/projects/${projectId}/dedup`,
      { data: {} },
    );
    expect(previewResponse.ok()).toBe(true);
    const preview = (await previewResponse.json()) as {
      groups: PreviewGroup[];
    };
    const replacement = preview.groups.find(
      (group) =>
        group.pool === "project_shared" &&
        group.candidates.some((candidate) => candidate.title === privateTitle),
    );
    if (!replacement) {
      throw new Error("the private-content replacement group is missing");
    }
    const privateCopy = replacement.candidates.find(
      (candidate) => candidate.title === privateTitle,
    );
    const sharedKeeper = replacement.candidates.find(
      (candidate) => candidate.scope === "shared",
    );
    if (!privateCopy || !sharedKeeper || sharedKeeper.title !== sharedTitle) {
      throw new Error("the private-content replacement candidates are missing");
    }

    await page.goto(`/ui/projects/${projectId}/duplicates`);
    const review = page.getByTestId("duplicate-review");
    const groupCard = review
      .getByTestId("duplicate-group")
      .filter({ hasText: privateTitle });
    await expect(groupCard).toHaveCount(1);
    await groupCard.click();
    const privateIndex =
      replacement.candidates.findIndex(
        (candidate) => candidate.logical_id === privateCopy.logical_id,
      ) + 1;
    const sharedIndex =
      replacement.candidates.findIndex(
        (candidate) => candidate.logical_id === sharedKeeper.logical_id,
      ) + 1;
    await expect(
      review.getByLabel(`Keep this one (${privateIndex})`),
    ).toHaveCount(0);
    await expect(
      review.getByLabel(`Keep this one (${sharedIndex})`),
    ).toBeChecked();
    await review.getByLabel(`the private copy: “${privateTitle}”`).check();
    await review.getByTestId("accept-merge").click();
    await expect(review.getByTestId("review-summary")).toContainText(
      "1 accepted",
    );
    await review.getByTestId("apply-accepted").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      `“${sharedTitle}” takes the title and content of “${privateTitle}” as a new version, remains shared, and the prior version stays in history.`,
    );
    await dialog.getByRole("button", { name: "Apply 1 accepted" }).click();
    await expect(page.getByTestId("applied-group")).toContainText(privateTitle);

    await page.goto(
      `/ui/projects/${projectId}/knowledge/${sharedKeeper.logical_id}`,
    );
    const document = page.getByTestId("knowledge-document");
    await expect(document).toContainText(privateTitle);
    await expect(document).toContainText(
      `Private copy content for dd-apply-${viewport}-${run}.`,
    );
    await expect(document).toContainText("Shared");
    const previousVersion = page.getByTestId("knowledge-version-1");
    await previousVersion.locator("summary").click();
    await expect(previousVersion).toContainText(sharedTitle);
    await expect(previousVersion).toContainText(
      `Original promoted content for dd-apply-${viewport}-${run}.`,
    );
  });

  test("refuses a replacement that would conflict with another live shared title", async ({
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
    const privateTitle = fixtureTitle(viewport, run, "conflict", "source");
    const sharedTitle = fixtureTitle(viewport, run, "conflict", "keeper");
    const previewResponse = await page.request.post(
      `/api/v1/projects/${projectId}/dedup`,
      { data: {} },
    );
    expect(previewResponse.ok()).toBe(true);
    const preview = (await previewResponse.json()) as {
      groups: PreviewGroup[];
    };
    const conflictGroup = preview.groups.find(
      (group) =>
        group.pool === "project_shared" &&
        group.candidates.some((candidate) => candidate.title === privateTitle),
    );
    if (!conflictGroup) {
      throw new Error("the title-conflict group is missing");
    }
    const privateCopy = conflictGroup.candidates.find(
      (candidate) => candidate.title === privateTitle,
    );
    const sharedKeeper = conflictGroup.candidates.find(
      (candidate) => candidate.scope === "shared",
    );
    if (!privateCopy || !sharedKeeper || sharedKeeper.title !== sharedTitle) {
      throw new Error("the title-conflict candidates are missing");
    }
    const beforeResponse = await page.request.get(
      `/api/v1/knowledge/${encodeURIComponent(sharedKeeper.logical_id)}`,
    );
    expect(beforeResponse.ok()).toBe(true);
    const before = (await beforeResponse.json()) as {
      title: string;
      content: string;
    };
    const sourceBeforeResponse = await page.request.get(
      `/api/v1/knowledge/${encodeURIComponent(privateCopy.logical_id)}`,
    );
    expect(sourceBeforeResponse.ok()).toBe(true);
    const sourceBefore = (await sourceBeforeResponse.json()) as {
      title: string;
      content: string;
    };
    const collidingEntryResponse = await page.request.get(
      `/api/v1/knowledge/${conflictEntryId(viewport, run)}`,
    );
    expect(collidingEntryResponse.ok()).toBe(true);
    const collidingEntry = (await collidingEntryResponse.json()) as {
      id: string;
      title: string;
      content: string;
      project_id: string | null;
    };
    expect(collidingEntry.title).toBe(privateTitle);
    expect(collidingEntry.project_id).toBeNull();

    await page.goto(`/ui/projects/${projectId}/duplicates`);
    const review = page.getByTestId("duplicate-review");
    const groupCard = review
      .getByTestId("duplicate-group")
      .filter({ hasText: privateTitle });
    await expect(groupCard).toHaveCount(1);
    await groupCard.click();
    const privateIndex =
      conflictGroup.candidates.findIndex(
        (candidate) => candidate.logical_id === privateCopy.logical_id,
      ) + 1;
    const sharedIndex =
      conflictGroup.candidates.findIndex(
        (candidate) => candidate.logical_id === sharedKeeper.logical_id,
      ) + 1;
    await expect(
      review.getByLabel(`Keep this one (${privateIndex})`),
    ).toHaveCount(0);
    await expect(
      review.getByLabel(`Keep this one (${sharedIndex})`),
    ).toBeChecked();
    await review.getByLabel(`the private copy: “${privateTitle}”`).check();
    await review.getByTestId("accept-merge").click();
    await expect(review.getByTestId("review-summary")).toContainText(
      "1 accepted",
    );
    await review.getByTestId("apply-accepted").click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Apply 1 accepted" }).click();
    const refusal = page.getByTestId("refused-group");
    await expect(refusal).toContainText(
      "The private copy's title is already used by another shared entry. Rename one of them, then review the group again.",
    );
    await expect(page.getByTestId("applied-group")).toHaveCount(0);
    const afterResponse = await page.request.get(
      `/api/v1/knowledge/${encodeURIComponent(sharedKeeper.logical_id)}`,
    );
    expect(afterResponse.ok()).toBe(true);
    const after = (await afterResponse.json()) as {
      title: string;
      content: string;
    };
    expect(after).toMatchObject(before);
    expect(after.title).toBe(sharedTitle);
    const sourceAfterResponse = await page.request.get(
      `/api/v1/knowledge/${encodeURIComponent(privateCopy.logical_id)}`,
    );
    expect(sourceAfterResponse.ok()).toBe(true);
    expect(await sourceAfterResponse.json()).toMatchObject(sourceBefore);
    const collidingAfterResponse = await page.request.get(
      `/api/v1/knowledge/${encodeURIComponent(collidingEntry.id)}`,
    );
    expect(collidingAfterResponse.ok()).toBe(true);
    expect(await collidingAfterResponse.json()).toMatchObject(collidingEntry);
  });
});
