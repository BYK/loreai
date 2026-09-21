import { expect, test } from "@playwright/test";

function focusName(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return "none";
    if (active.closest('[data-testid="logo"]')) return "logo";
    if (active.matches('a[aria-label="Lore.AI — home"]')) return "logo";
    if (active.matches('[aria-label="Search"]')) return "search";
    const testId = active.closest("[data-testid]")?.getAttribute("data-testid");
    if (testId?.startsWith("theme-")) return testId;
    if (active.matches('[data-testid="nav-projects"]')) return "nav-projects";
    if (active.matches('[data-testid="nav-project"]')) return "nav-project";
    return active.getAttribute("aria-label") ?? active.tagName.toLowerCase();
  });
}

test.describe("keyboard navigation and focus-visible affordances", () => {
  test("shell tab order follows the app bar then workspace navigation", async ({
    page,
  }) => {
    await page.goto("/ui");
    const expected = [
      "logo",
      "search",
      "theme-system",
      "theme-light",
      "theme-dark",
      (await page.getByTestId("open-nav").isVisible())
        ? "Open navigation"
        : "nav-projects",
    ];
    const actual: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      await page.keyboard.press("Tab");
      actual.push(await focusName(page));
    }
    expect(actual).toEqual(expected);
  });

  test("mobile navigation traps focus and Escape returns it to the opener", async ({
    page,
  }) => {
    await page.goto("/ui");
    test.skip(
      !(await page.getByTestId("open-nav").isVisible()),
      "mobile navigation is only rendered in the mobile project",
    );
    const opener = page.getByTestId("open-nav");
    await opener.focus();
    await opener.press("Enter");
    const drawer = page.getByTestId("nav-drawer");
    await expect(drawer).toBeVisible();
    await expect.poll(() => focusName(page)).not.toBe("open-nav");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("knowledge rows support arrow navigation and Enter", async ({
    page,
  }) => {
    const projects = await (await page.request.get("/api/v1/projects")).json();
    const project = projects.find(
      (item: { name: string }) => item.name === "lore",
    );
    await page.goto(`/ui/projects/${project.id}/knowledge`);
    const rows = page.getByTestId("knowledge-row");
    await rows.first().focus();
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    const title = await rows.nth(1).locator("span").first().textContent();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("knowledge-document")).toContainText(
      title ?? "",
    );
  });

  for (const choice of ["light", "dark"] as const) {
    test(`reader rows and theme toggle expose focus rings in ${choice} mode`, async ({
      page,
    }) => {
      const projects = await (
        await page.request.get("/api/v1/projects")
      ).json();
      const project = projects.find(
        (item: { name: string }) => item.name === "lore",
      );
      await page.goto(`/ui/projects/${project.id}/sessions/e2e-reader`);
      await page.getByTestId(`theme-${choice}`).click();
      await page.getByTestId(`theme-${choice}`).focus();
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            if (!active) return "none";
            const style = getComputedStyle(active);
            return `${style.outlineStyle}/${style.boxShadow}`;
          }),
        )
        .not.toBe("none/none");
      const row = page.locator("[data-row-key]").first();
      await page.keyboard.press("Tab");
      await row.focus();
      const rowRing = await row.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          visible: el.matches(":focus-visible"),
          ring: `${style.outlineStyle}/${style.boxShadow}`,
        };
      });
      expect(rowRing.visible).toBe(true);
      expect(rowRing.ring).not.toBe("none/none");
    });
  }
});
