import { openAccountMenu, setWorkspaceTheme } from "./workspace-helpers";
import { expect, test } from "@playwright/test";

function focusName(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return "none";
    if (active.closest('[data-testid="logo"]')) return "logo";
    if (active.matches('a[aria-label="Lore.AI — home"]')) return "logo";
    if (active.matches('[aria-label="Search"]')) return "search";
    const closestTestId = active
      .closest("[data-testid]")
      ?.getAttribute("data-testid");
    if (closestTestId?.startsWith("theme-")) return closestTestId;
    if (active.matches('[data-testid="rail-projects"]')) return "rail-projects";
    if (active.matches('[data-testid="nav-project"]')) return "nav-project";
    return active.getAttribute("aria-label") ?? active.tagName.toLowerCase();
  });
}

test.describe("keyboard navigation and focus-visible affordances", () => {
  test("shell controls are keyboard reachable in the redesigned workspace", async ({
    page,
  }) => {
    await page.goto("/ui");
    const seen: string[] = [];
    for (let i = 0; i < 32; i++) {
      await page.keyboard.press("Tab");
      seen.push(await focusName(page));
    }
    expect(seen.some((name) => name.startsWith("Switch project:"))).toBe(true);
    expect(seen).toContain("search");
    expect(seen.some((name) => name.startsWith("Account and sync:"))).toBe(
      true,
    );
    expect(seen).not.toContain("theme-light");
  });

  test("context Escape returns focus to the toolbar with the rail still reachable", async ({
    page,
  }) => {
    const projects = await (await page.request.get("/api/v1/projects")).json();
    const project = projects.find((p: { name: string }) => p.name === "lore");
    const entries = await (
      await page.request.get(`/api/v1/projects/${project.id}/knowledge`)
    ).json();
    await page.goto(`/ui/projects/${project.id}/knowledge/${entries[0].id}`);
    const toggle = page.getByTestId("context-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    const link = page
      .getByTestId("context-pane")
      .getByTestId("knowledge-row")
      .first();
    await link.focus();
    await link.press("Escape");
    await expect(page.getByTestId("context-pane")).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(page.getByTestId("icon-rail")).toBeVisible();
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

  for (const [path, navId, marker] of [
    ["/ui/entities", "rail-entities", "entities-page"],
    ["/ui/contradictions", "rail-contradictions", "contradictions-page"],
    ["/ui/team", "rail-team", "team-page"],
    ["/ui/conflicts", "rail-conflicts", "conflicts-page"],
  ] as const) {
    test(`shell keyboard navigation reaches ${navId} content`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name.includes("mobile"),
        "desktop shell has persistent navigation",
      );
      if (navId === "rail-team") {
        await page.route("**/api/v1/account", (route) =>
          route.fulfill({
            json: {
              signed_in: true,
              user: {
                id: "user-admin",
                email: null,
                display_name: "Admin",
              },
              provider: "github",
              expires_at: null,
              state: "signed_in",
            },
          }),
        );
        await page.route("**/api/v1/teams", (route) =>
          route.fulfill({
            json: {
              hosted: false,
              teams: [
                {
                  id: "team-1",
                  name: "Acme e2e",
                  role: "admin",
                  member_count: 2,
                },
              ],
            },
          }),
        );
        await page.route("**/api/v1/teams/team-1/members", (route) =>
          route.fulfill({
            json: {
              remote: "ok",
              team: { id: "team-1", name: "Acme e2e" },
              my_role: "admin",
              can_manage: true,
              members: [
                {
                  user_id: "user-admin",
                  label: "Admin",
                  role: "admin",
                  me: true,
                },
                {
                  user_id: "user-member",
                  label: "Member",
                  role: "viewer",
                  me: false,
                },
              ],
              actions: {
                invite: "available",
                remove: "available",
                set_role: "available",
                add_by_id: "available",
                offline_invite: "available",
                list_invites: "unsupported",
                revoke_invite: "unsupported",
              },
            },
          }),
        );
        await page.route("**/api/v1/sync/status", (route) =>
          route.fulfill({
            json: { enabled: true, state: "idle", pending_changes: 0 },
          }),
        );
      }
      await page.goto(path);
      await expect(page.getByTestId(marker)).toBeVisible();
      await setWorkspaceTheme(page, "dark");
      const toggle = page.getByTestId("context-toggle");
      if (
        (await toggle.count()) &&
        (await toggle.getAttribute("aria-expanded")) === "false"
      )
        await toggle.click();
      const nav = page.getByTestId(navId);
      await nav.focus();
      await expect(nav).toBeFocused();
      let reachedMain = false;
      for (let i = 0; i < 32; i++) {
        await page.keyboard.press("Tab");
        reachedMain = await page.evaluate(
          () => document.activeElement?.closest("main") !== null,
        );
        if (reachedMain) break;
      }
      expect(reachedMain).toBe(true);
      const focus = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active) return { visible: false, ring: "none/none" };
        const style = getComputedStyle(active);
        return {
          visible: active.matches(":focus-visible"),
          ring: `${style.outlineStyle}/${style.boxShadow}`,
        };
      });
      expect(focus.visible).toBe(true);
      expect(focus.ring).not.toBe("none/none");
    });
  }

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
      await openAccountMenu(page);
      await page.getByTestId(`theme-${choice}`).click();
      await page.getByTestId(`theme-${choice}`).focus();
      await page.keyboard.press("Shift+Tab");
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
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("folk-status-panel")).toHaveCount(0);
      await expect(page.getByTestId("folk-status")).toBeFocused();
      // Establish keyboard modality before choosing a row: Tab may scroll the
      // reader and unmount the virtualized row that was previously visible.
      await page.keyboard.press("Tab");
      // Rows outside the viewport are unmounted; focus a visible one — the
      // landed reader mounts overscan rows beyond the viewport edge (#1923).
      const visibleRowKey = () =>
        page.evaluate(() => {
          for (const el of document.querySelectorAll("[data-row-key]")) {
            const rect = el.getBoundingClientRect();
            if (rect.bottom > 0 && rect.top < window.innerHeight) {
              return el.getAttribute("data-row-key");
            }
          }
          return null;
        });
      await expect.poll(visibleRowKey).toBeTruthy();
      const rowKey = await visibleRowKey();
      const row = page.locator(`[data-row-key="${rowKey}"]`);
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
