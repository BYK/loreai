import { expect, test } from "@playwright/test";

for (const [path, action] of [
  ["/docs/", "Search"],
  ["/missing-field-guide-page/", "Search documentation"],
  ["/docs/", "shortcut"],
]) {
  test(`search opens before the browser has idle time: ${path} (${action})`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      let next = 0;
      const queued = new Map<number, IdleRequestCallback>();
      window.requestIdleCallback = (callback) => {
        queued.set(++next, callback);
        return next;
      };
      window.cancelIdleCallback = (id) => {
        queued.delete(id);
      };
      window.addEventListener("qa:release-idle", () => {
        const callbacks = [...queued.values()];
        queued.clear();
        for (const callback of callbacks)
          callback({ didTimeout: true, timeRemaining: () => 50 });
      });
    });
    await page.goto(path);
    const trigger = page.getByRole("button", {
      name: action === "shortcut" ? "Search" : action,
      exact: true,
    });
    if (action === "shortcut") {
      await expect(trigger).toBeEnabled();
      await trigger.focus();
      await page.keyboard.press("Control+k");
    } else await trigger.click();
    const query = page
      .getByRole("dialog", { name: "Search", exact: true })
      .getByRole("textbox", { name: "Search", exact: true });
    await expect(query).toBeVisible();
    await expect(query).toBeFocused();
    await query.fill("missing session");
    await expect(
      page
        .locator(".pagefind-ui__result-link")
        .filter({ hasText: /session|troubleshoot/i })
        .first(),
    ).toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("qa:release-idle"));
    });
    await expect(query).toHaveValue("missing session");
    await expect(page.locator("site-search input")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(query).toBeFocused();
    await expect(page.locator("site-search input")).toHaveCount(1);
  });
}
