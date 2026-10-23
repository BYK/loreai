import { expect, test } from "@playwright/test";
import { themeColor } from "./workspace-helpers";

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390, 320]) {
    test(`workspace pages contain their layout at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-chromium");
      await page.addInitScript(
        (choice) => localStorage.setItem("lore.ui.theme", choice),
        theme,
      );
      await page.setViewportSize({ width, height: 900 });
      const projects = (await (
        await page.request.get("/api/v1/projects")
      ).json()) as { id: string; name: string }[];
      const project = projects.find((item) => item.name === "lore")!;
      const base = `/ui/projects/${project.id}`;
      const entries = (await (
        await page.request.get(`/api/v1/projects/${project.id}/knowledge`)
      ).json()) as { id: string; title: string }[];
      const entities = (await (
        await page.request.get("/api/v1/entities")
      ).json()) as { entities: { id: string }[] };
      const entry = entries.find(
        (item) => item.title === "Keep SQLite as the only store",
      )!;
      const routes = [
        "/ui",
        "/ui/knowledge",
        "/ui/search",
        "/ui/search?q=SQLite",
        "/ui/entities",
        `/ui/entities/${entities.entities[0]!.id}`,
        `/ui/knowledge/${entry.id}`,
        `${base}/knowledge/${entry.id}`,
        "/ui/not-a-real-route",
        "/ui/contradictions",
        "/ui/promotions",
        "/ui/team",
        "/ui/conflicts",
        "/ui/costs",
        "/ui/warming",
        "/ui/model-usage",
        base,
        `${base}/knowledge`,
        `${base}/search`,
        `${base}/sessions`,
        `${base}/imports`,
        `${base}/duplicates`,
        `${base}/sessions/e2e-reader`,
      ];
      for (const route of routes) {
        await page.goto(route);
        const main = page.locator("main");
        await expect(main).toBeVisible();
        await expect(page.locator("main")).toHaveCount(1);
        await page
          .getByText(/^Loading /)
          .first()
          .waitFor({ state: "hidden" });
        expect
          .soft(
            await page
              .locator("html")
              .evaluate((el) => getComputedStyle(el).colorScheme),
            `${route}: native controls follow the selected theme`,
          )
          .toBe(theme);
        expect
          .soft(
            await main.evaluate((el) => getComputedStyle(el).backgroundColor),
            `${route}: neutral document surface`,
          )
          .toBe(
            route === "/ui/not-a-real-route"
              ? "rgba(0, 0, 0, 0)"
              : await themeColor(
                  page,
                  `--color-olive-${theme === "dark" ? 900 : 50}`,
                ),
          );
        const size = await main.evaluate((el) => ({
          client: el.clientWidth,
          scroll: el.scrollWidth,
        }));
        if (size.scroll > size.client + 1) {
          console.log(
            "Layout overflow",
            route,
            await main.evaluate((el) => {
              const edge = el.getBoundingClientRect().right;
              return [...el.querySelectorAll("*")]
                .filter((node) => node.getBoundingClientRect().right > edge + 1)
                .slice(0, 15)
                .map((node) => ({
                  tag: node.tagName,
                  id: node.getAttribute("data-testid"),
                  class: node.className,
                  right: Math.round(node.getBoundingClientRect().right),
                  width: Math.round(node.getBoundingClientRect().width),
                }));
            }),
          );
          await page.screenshot({
            path: testInfo.outputPath(
              `overflow-${route.split("/").pop()}-${theme}-${width}.png`,
            ),
            fullPage: true,
          });
        }
        expect
          .soft(
            size.scroll,
            `${route}: content must scroll inside its own table or code block`,
          )
          .toBeLessThanOrEqual(size.client + 1);
        if (route === base || route === `${base}/search`) {
          const input = page.getByRole("textbox", {
            name: route === base ? "Search project memory" : "Search query",
            exact: true,
          });
          expect
            .soft(
              (await input.boundingBox())!.width,
              `${route}: readable search field`,
            )
            .toBeGreaterThanOrEqual(160);
        }
        if (route === base) {
          const heading = (await page
            .getByRole("heading", { level: 1 })
            .boundingBox())!;
          const health = (await page.getByTestId("health").boundingBox())!;
          expect
            .soft(
              Math.abs(heading.x - health.x),
              "overview heading aligns with sections",
            )
            .toBeLessThanOrEqual(1);
        }
        await page.screenshot({
          path: testInfo.outputPath(
            `${route === base ? "overview" : route.replace(/[^a-z0-9-]/gi, "_")}-${theme}-${width}.png`,
          ),
          fullPage: true,
        });
      }
    });
    test(`gateway connection form uses olive surfaces at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-chromium");
      await page.addInitScript(
        (choice) => localStorage.setItem("lore.ui.theme", choice),
        theme,
      );
      await page.setViewportSize({ width, height: 900 });
      let authenticated = false;
      await page.route("**/api/v1/projects", (route) => {
        authenticated =
          route.request().headers().authorization ===
          "Bearer ui-theme-test-token";
        return route.fulfill(
          authenticated
            ? { json: [] }
            : { status: 401, json: { error: "unauthorized" } },
        );
      });
      await page.goto("/ui");
      const gate = page.getByTestId("gateway-auth-gate");
      await expect(gate).toBeVisible();
      const field = page.getByLabel("Gateway token", { exact: true });
      const styles = await field.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          border: style.borderTopColor,
          background: style.backgroundColor,
          width: style.borderTopWidth,
        };
      });
      expect
        .soft(styles.border)
        .toBe(
          await themeColor(
            page,
            `--color-olive-${theme === "dark" ? 700 : 200}`,
          ),
        );
      expect
        .soft(styles.background)
        .toBe(
          await themeColor(
            page,
            `--color-olive-${theme === "dark" ? 900 : 50}`,
          ),
        );
      expect.soft(styles.width).toBe("1px");
      const size = await gate.evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
      }));
      expect(size.scroll).toBeLessThanOrEqual(size.client + 1);
      await page.screenshot({
        path: testInfo.outputPath(`gateway-connect-${theme}-${width}.png`),
        fullPage: true,
      });
      await expect(field).toHaveAttribute("type", "password");
      await expect(field).toHaveAttribute("required", "");
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(gate).toBeVisible();
      expect(authenticated).toBe(false);
      await field.fill("  ui-theme-test-token  ");
      await field.press("Enter");
      await expect(gate).toHaveCount(0);
      expect(authenticated).toBe(true);
    });
    test(`project dialog has breathing room at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-chromium");
      await page.addInitScript(
        (choice) => localStorage.setItem("lore.ui.theme", choice),
        theme,
      );
      await page.setViewportSize({ width, height: 740 });
      const projects = (await (
        await page.request.get("/api/v1/projects")
      ).json()) as { id: string; name: string }[];
      await page.goto(
        `/ui/projects/${projects.find((item) => item.name === "lore")!.id}`,
      );
      await page.getByRole("button", { name: "Rename…", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Rename project",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      const box = (await dialog.boundingBox())!;
      expect
        .soft(box.x, "dialog is inset from the viewport")
        .toBeGreaterThanOrEqual(12);
      expect.soft(box.x + box.width).toBeLessThanOrEqual(width - 12);
      const field = (await dialog
        .getByRole("textbox", { name: "Project name", exact: true })
        .boundingBox())!;
      expect
        .soft(field.x + field.width, "dialog field stays inside its panel")
        .toBeLessThanOrEqual(box.x + box.width - 16);
      const dialogSize = await dialog.evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
      }));
      expect
        .soft(dialogSize.scroll, "dialog contents must not clip horizontally")
        .toBeLessThanOrEqual(dialogSize.client + 1);
      const cancel = (await dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .boundingBox())!;
      const save = (await dialog
        .getByRole("button", { name: "Save", exact: true })
        .boundingBox())!;
      const gap =
        width < 640
          ? cancel.y - (save.y + save.height)
          : save.x - (cancel.x + cancel.width);
      expect
        .soft(gap, "dialog actions have a visible gap")
        .toBeGreaterThanOrEqual(8);
      await page.screenshot({
        path: testInfo.outputPath(`rename-dialog-${width}.png`),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
    });
  }
}
