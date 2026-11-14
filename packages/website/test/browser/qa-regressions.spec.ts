import { expect, test } from "@playwright/test";
import { themeButton } from "../helpers/theme";

for (const path of ["/", "/docs/install/", "/blog/"]) {
  test(`phone appearance controls reflow with enlarged text: ${path}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(path);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await (await themeButton(page, "Dark")).click();
    const row = page.locator(".mobile-theme-preferences:visible");
    const label = await row.locator("span").first().boundingBox();
    const toggle = await row.locator(".theme-toggle").boundingBox();
    expect(toggle!.x).toBeGreaterThanOrEqual(0);
    expect(toggle!.x + toggle!.width).toBeLessThanOrEqual(320);
    expect(
      label!.x + label!.width <= toggle!.x ||
        label!.y + label!.height <= toggle!.y,
    ).toBe(true);
  });
}

test("advancing the journal keeps its focused chapter clear of the floating nav", async ({
  page,
}) => {
  await page.setViewportSize({
    width: page.viewportSize()!.width,
    height: 568,
  });
  await page.goto("/#journal");
  for (const name of [
    "See saved knowledge",
    "Try a later session",
    "Inspect the supplied rule",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    const heading = page.locator(".journal-chapter:visible > h3");
    await expect(heading).toBeFocused();
    await expect
      .poll(async () => {
        const title = await heading.boundingBox();
        const nav = await page.locator(".top-nav").boundingBox();
        return title!.y - (nav!.y + nav!.height);
      })
      .toBeGreaterThanOrEqual(8);
  }
});

test("enlarged docs menu keeps keyboard links below its wrapped appearance row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/docs/install/");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await (await themeButton(page, "System")).focus();
  const target = page
    .locator("#starlight__sidebar .top-level")
    .getByRole("link", { name: "Team memory", exact: true });
  for (let i = 0; i < 28; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(target).toBeFocused();
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press("Shift+Tab");
    const active = page.locator("#starlight__sidebar a:focus");
    if (!(await active.count())) continue;
    const link = await active.boundingBox();
    const row = await page
      .locator(".docs-group-icons > .mobile-theme-preferences")
      .boundingBox();
    expect(link!.y, await active.innerText()).toBeGreaterThanOrEqual(
      row!.y + row!.height - 1,
    );
  }
});

test("phone docs menu stays inside the floating header at normal and enlarged text sizes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/docs/install/");
  for (const size of ["100%", "200%"]) {
    await page.evaluate((value) => {
      document.documentElement.style.fontSize = value;
    }, size);
    const header = await page.locator(".docs-site-header").boundingBox();
    const menu = await page
      .locator("starlight-menu-button button")
      .boundingBox();
    const contents = await page
      .locator("#starlight__on-this-page--mobile")
      .boundingBox();
    expect(menu!.width, size).toBeGreaterThanOrEqual(44);
    expect(menu!.height, size).toBeGreaterThanOrEqual(44);
    expect(menu!.y, size).toBeGreaterThanOrEqual(header!.y);
    expect(menu!.y + menu!.height, size).toBeLessThanOrEqual(
      header!.y + header!.height,
    );
    expect(
      contents!.y - (header!.y + header!.height),
      size,
    ).toBeLessThanOrEqual(24);
  }
});

for (const path of ["/", "/blog/", "/docs/install/"]) {
  test(`pages without diagrams keep JavaScript below 150 kB: ${path}`, async ({
    page,
  }) => {
    await page.goto(path);
    const bytes = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.endsWith(".js"))
        .reduce(
          (total, entry) =>
            total + (entry as PerformanceResourceTiming).decodedBodySize,
          0,
        ),
    );
    test.info().annotations.push({
      type: "script-size",
      description: `${path}: ${bytes} decoded bytes`,
    });
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(150_000);
  });
}

test("architecture diagrams still render after conditional loading", async ({
  page,
}) => {
  await page.goto("/docs/architecture/");
  await expect(page.locator(".mermaid > svg")).toHaveCount(5);
  await expect(page.locator('pre[data-language="mermaid"]')).toHaveCount(0);
});

test("retained knowledge uses readable green highlights throughout the story", async ({
  page,
}) => {
  for (const path of ["/", "/tour/?view=knowledge&inspect=history#product"]) {
    await page.goto(path);
    for (const theme of ["Light", "Dark"]) {
      await (await themeButton(page, theme)).click();
      const marks = await page.locator("mark").evaluateAll((elements) =>
        elements.map((el) => {
          const styles = getComputedStyle(el);
          const ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
          const pixel = (color: string) => {
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
          };
          const bg = pixel(styles.backgroundColor);
          const luminance = (rgb: number[]) =>
            rgb
              .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4;
              })
              .reduce(
                (sum, value, index) =>
                  sum + value * [0.2126, 0.7152, 0.0722][index],
                0,
              );
          const a = luminance(bg),
            b = luminance(pixel(styles.color));
          return {
            text: el.textContent,
            green: bg[1] > bg[0] && bg[1] > bg[2],
            contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        }),
      );
      expect(marks.length).toBeGreaterThan(0);
      for (const mark of marks) {
        expect(mark.green, `${theme}: ${mark.text}`).toBe(true);
        expect(mark.contrast, `${theme}: ${mark.text}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  }
});
