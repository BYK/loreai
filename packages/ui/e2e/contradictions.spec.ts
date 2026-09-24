import { expect, test } from "@playwright/test";

test.describe("contradictions (UI-08)", () => {
  test("shows a recorded pair and keeps both after explicit dismissal", async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.startsWith("mobile")
      ? "Mobile"
      : "Desktop";
    const titleA = `Prefer deterministic ids (${viewport} run ${testInfo.retry + 1})`;
    const titleB = `Regenerate ids on every read (${viewport} run ${testInfo.retry + 1})`;
    await page.goto("/ui/contradictions");
    await expect(page.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );

    const row = page
      .getByTestId("contradiction-row")
      .filter({ hasText: titleA });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(titleB);
    const ruleLink = row.getByRole("link", {
      name: titleA,
    });
    const otherRuleLink = row.getByRole("link", { name: titleB });
    await expect(ruleLink).toHaveAttribute("href", /\/ui\/knowledge\/[^/]+$/);
    const getKnowledgeId = async (link: typeof ruleLink) => {
      const href = await link.getAttribute("href");
      if (!href) throw new Error("a contradiction knowledge link is missing");
      const pathname = new URL(href, page.url()).pathname;
      return decodeURIComponent(pathname.split("/").at(-1) ?? "");
    };
    const keptIds = [
      await getKnowledgeId(ruleLink),
      await getKnowledgeId(otherRuleLink),
    ];
    await ruleLink.click();
    await expect(page).toHaveURL(/\/ui\/knowledge\/[^/]+$/);
    await page.goBack();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Keep both" }).click();
    await expect(row).toHaveCount(0);

    // Dismissal persists across a page load; the idle detector must not reopen it.
    await page.reload();
    await expect(row).toHaveCount(0);
    for (const id of keptIds) {
      const entry = await page.request.get(
        new URL(`/api/v1/knowledge/${encodeURIComponent(id)}`, page.url()).href,
      );
      expect(entry.status()).toBe(200);
    }
  });
});
