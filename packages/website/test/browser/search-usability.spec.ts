import { expect, test } from "@playwright/test";

test("documentation search indexes prose and CLI commands without Mermaid styling", async ({
  page,
}) => {
  await page.goto("/docs/");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search", exact: true });
  await search.fill("context");
  await expect(dialog.locator(".pagefind-ui__result").first()).toBeVisible();
  await expect(dialog.locator(".pagefind-ui__results")).not.toContainText(
    /classDef|stroke-width|fill:#/,
  );
  // Pagefind stems classDef to class, so unrelated prose can still match.
  await search.fill("classDef");
  await expect(dialog.locator(".pagefind-ui__message")).toContainText(
    "classDef",
  );
  await expect(dialog.locator(".pagefind-ui__results")).not.toContainText(
    /classDef|stroke-width|fill:#/,
  );
  await search.fill("zzzxqrawdiagramxqzzz");
  await expect(dialog.locator(".pagefind-ui__message")).toContainText(
    "No results",
  );
  await expect(dialog.locator("[data-search-recovery]")).toBeVisible();
  await search.fill("lore start");
  await expect(dialog.locator(".pagefind-ui__result").first()).toBeVisible();
  await expect(dialog.locator("[data-search-recovery]")).toBeHidden();
});

test("empty search offers fixed recovery links and useful new queries", async ({
  page,
}) => {
  await page.goto("/docs/");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search", exact: true });
  await search.fill("zzzz-no-such-lore-document");
  const recovery = dialog.locator("[data-search-recovery]");
  await expect(recovery).toBeVisible();
  await expect(
    recovery.getByRole("link", { name: "Browse settings" }),
  ).toHaveAttribute("href", /\/docs\/configuration\/$/);
  await recovery.getByRole("button", { name: "Search for session" }).click();
  await expect(search).toHaveValue("session");
  await expect(search).toBeFocused();
  await expect(recovery).toBeHidden();
  await expect(dialog.locator(".pagefind-ui__result").first()).toBeVisible();
});

test("setting results retain metadata, copy literal identifiers and stable share links", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/docs/configuration/?from=qa&setting=maxEntries#curator");
  const result = page.locator("#setting-results > li").filter({
    has: page.getByRole("link", { name: "curator.maxEntries", exact: true }),
  });
  await expect(result).toContainText("number");
  await expect(result).toContainText("Default: 200");
  await result
    .getByRole("button", { name: "Copy setting path", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "curator.maxEntries",
  );
  await result
    .getByRole("button", { name: "Copy setting link", exact: true })
    .click();
  const shared = new URL(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(shared.pathname).toBe("/docs/configuration/");
  expect(shared.search).toBe("");
  expect(shared.hash).toBe("#setting-curator.maxEntries");
  await result
    .getByRole("link", { name: "curator.maxEntries", exact: true })
    .click();
  const field = page.locator('[id="setting-curator.maxEntries"]');
  await expect(
    field.getByRole("button", { name: "Copy setting path", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    /from=qa&setting=maxEntries#setting-curator\.maxEntries$/,
  );
  await page.goBack();
  await expect(page).toHaveURL(/#curator$/);
});

test("denied clipboard gives a selectable value and preserves filtering recovery", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new DOMException("Denied", "NotAllowedError");
        },
      },
    });
  });
  await page.goto("/docs/configuration/?setting=curator.maxEntries");
  const result = page.locator("#setting-results > li").filter({
    has: page.getByRole("link", { name: "curator.maxEntries", exact: true }),
  });
  await result
    .getByRole("button", { name: "Copy setting path", exact: true })
    .click();
  await expect(result.getByRole("status")).toContainText("Select and copy");
  const fallback = result.getByRole("textbox", {
    name: "Value to copy manually",
  });
  await expect(fallback).toHaveValue("curator.maxEntries");
  await expect(fallback).toBeFocused();
  const search = page.getByRole("searchbox", { name: "Find a setting" });
  await search.fill("zzzz-impossible-setting");
  const recovery = page.locator("[data-finder-recovery]");
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button", { name: "Find curator settings" }).click();
  await expect(search).toHaveValue("curator");
  await expect(search).toBeFocused();
  await expect(recovery).toBeHidden();
});

test("reference examples are readable and copyable while environment defaults remain honest", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/docs/configuration/");
  const examples = page.getByRole("group", { name: "Common setting examples" });
  await examples.locator("summary").click();
  const example = examples.locator("[data-setting-example]").first();
  await expect(example.locator("pre")).toBeVisible();
  await example
    .getByRole("button", { name: "Copy example", exact: true })
    .click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied)).toEqual({ curator: { maxEntries: 30 } });
  await page.goto("/docs/environment/?setting=LORE_IDLE_TIMEOUT");
  const result = page.locator("#setting-results > li").filter({
    has: page.getByRole("link", { name: "LORE_IDLE_TIMEOUT", exact: true }),
  });
  await expect(result).toContainText("Default: 60");
  await result
    .getByRole("button", { name: "Copy setting path", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "LORE_IDLE_TIMEOUT",
  );
});

test("late clipboard denial does not move focus away from a new reference query", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          new Promise((_resolve, reject) => {
            window.addEventListener(
              "qa:deny-copy",
              () => reject(new DOMException("Denied", "NotAllowedError")),
              { once: true },
            );
          }),
      },
    });
  });
  await page.goto("/docs/configuration/?setting=curator.maxEntries");
  const result = page.locator("#setting-results > li").filter({
    has: page.getByRole("link", { name: "curator.maxEntries", exact: true }),
  });
  await result
    .getByRole("button", { name: "Copy setting path", exact: true })
    .click();
  const search = page.getByRole("searchbox", { name: "Find a setting" });
  await search.fill("cache");
  await page.evaluate(() => window.dispatchEvent(new Event("qa:deny-copy")));
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("cache");
  await expect(result).toBeHidden();
});

test("reference examples and exact field links remain readable without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(
      baseURL + "/docs/configuration/#setting-cache.warming.enabled",
    );
    await expect(
      page.locator('[id="setting-cache.warming.enabled"]'),
    ).toBeVisible();
    const examples = page.getByRole("group", {
      name: "Common setting examples",
    });
    await examples.locator("summary").click();
    await expect(examples.locator("pre").first()).toContainText(
      '"maxEntries": 30',
    );
    await expect(
      examples
        .getByRole("button", { name: "Copy example", exact: true })
        .first(),
    ).toBeHidden();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("copied field links preserve same-origin paths with doubled leading slashes", async ({
  page,
}) => {
  await page.goto("/docs/configuration/?setting=curator.maxEntries");
  const current = await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          document.body.dataset.copied = text;
          return Promise.resolve();
        },
      },
    });
    const url = new URL(location.href);
    url.pathname = "/" + url.pathname;
    history.replaceState(history.state, "", url.href);
    return { origin: url.origin, pathname: url.pathname };
  });
  await page
    .locator("#setting-results li:visible")
    .first()
    .getByRole("button", { name: "Copy setting link", exact: true })
    .click();
  const copied = new URL(
    (await page.locator("body").getAttribute("data-copied"))!,
  );
  expect({
    username: copied.username,
    password: copied.password,
    origin: copied.origin,
    pathname: copied.pathname,
    search: copied.search,
    hash: copied.hash,
  }).toEqual({
    ...current,
    username: "",
    password: "",
    search: "",
    hash: "#setting-curator.maxEntries",
  });
});

test("generic types remain literal in both search results and full field records", async ({
  page,
}) => {
  await page.goto("/docs/configuration/");
  const search = page.getByRole("searchbox", { name: "Find a setting" });
  for (const [key, type] of [
    ["knowledge.contextSources", "array<enum>"],
    ["user.aliases", "array<{ type, value }>"],
    ["user.metadata", "Record<string, unknown>"],
  ]) {
    await search.fill(key);
    const result = page.locator("#setting-results li:visible").first();
    await expect(
      result.locator(".reference-result-meta span").first(),
    ).toHaveText(type);
    await expect(
      page.locator('[id="setting-' + key + '"] .reference-metadata dd').first(),
    ).toHaveText(type);
  }
});

test("root settings share real heading links and metadata, while environment categories stay groups", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/docs/configuration/");
  const search = page.getByRole("searchbox", { name: "Find a setting" });
  for (const [key, type, value] of [
    ["crossProject", "boolean", "true"],
    ["idleResumeMinutes", "number", "5"],
    ["workspaces", "array<string>", "[]"],
  ]) {
    await search.fill(key);
    const result = page.locator("#setting-results li:visible").first();
    const hash = "#" + key.toLowerCase();
    await expect(
      result.getByRole("link", { name: key, exact: true }),
    ).toHaveAttribute("href", hash);
    await expect(result.locator(".reference-result-meta span")).toHaveText([
      type,
      "Default: " + value,
    ]);
    const record = page.getByRole("region", { name: key, exact: true });
    for (const actions of [result, record]) {
      await actions.getByRole("button", { name: "Copy setting path" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        key,
      );
      await actions.getByRole("button", { name: "Copy setting link" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        new URL("/docs/configuration/" + hash, page.url()).href,
      );
    }
    await result.getByRole("link", { name: key, exact: true }).click();
    await expect(page.locator(hash)).toHaveText(key);
  }
  await page.goto("/docs/environment/?setting=Cache%20usage");
  const group = page.locator("#setting-results li:visible").first();
  await expect(
    group.getByRole("link", { name: "Cache usage", exact: true }),
  ).toBeVisible();
  await expect(group.getByRole("button")).toHaveCount(0);
});

test("example cards disclose eviction and both warming overrides before copy", async ({
  page,
}) => {
  await page.goto("/docs/configuration/");
  const examples = page.getByRole("group", { name: "Common setting examples" });
  await examples.locator("summary").click();
  const cap = examples.locator("[data-setting-example]").filter({
    has: page.getByRole("link", { name: "Read curator.maxEntries" }),
  });
  const warming = examples.locator("[data-setting-example]").filter({
    has: page.getByRole("link", { name: "Read cache.warming.enabled" }),
  });
  await expect(cap).toContainText(/remove.*active entries/i);
  await expect(cap).toContainText(/200/);
  await expect(warming).toContainText(/LORE_WARMING_ENABLED/);
  await expect(warming).toContainText(/saved dashboard preference/i);
  await expect(warming).toContainText(/normal provider calls/i);
});
