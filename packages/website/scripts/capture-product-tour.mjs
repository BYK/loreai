#!/usr/bin/env node
// Captures the real built Solid app using only synthetic fixture responses.
// No gateway, account, provider, production database, or external network is used.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join, extname } from "node:path";
import { chromium, expect } from "@playwright/test";
const ui = fileURLToPath(new URL("../../ui/dist/", import.meta.url)),
  fixtures = fileURLToPath(new URL("../../ui/test/fixtures/", import.meta.url)),
  output = fileURLToPath(new URL("../public/product-tour/", import.meta.url));
if (!existsSync(join(ui, "index.html")))
  throw new Error("Build @loreai/ui first");
const projectId = "00000000-0000-4000-8000-000000000001",
  entryId = "00000000-0000-4000-8000-000000000000";
function fixture(name) {
  return JSON.parse(
    readFileSync(join(fixtures, name + ".json"), "utf8")
      .replaceAll("<uuid-1>", projectId)
      .replaceAll("<uuid-0>", entryId)
      .replaceAll("ui-contracts-session", "sample-session"),
  );
}
const project = {
  ...fixture("projects")[1],
  name: "webhook-service",
  path: "/sample/webhook-service",
  git_remote: null,
  knowledge_count: 2,
  session_count: 1,
  message_count: 2,
};
const entry = {
  ...fixture("knowledge-entry"),
  title: "Keep handlers idempotent",
  content:
    "Check the event ID before applying a webhook. Reuse the existing duplicate-event guard so repeated deliveries never apply the same change twice.",
  confidence: 0.9,
  created_at: Date.parse("2026-10-25T12:00:00Z"),
  updated_at: Date.parse("2026-10-26T12:00:00Z"),
};
const versions = fixture("cursor/knowledge-versions");
const originalVersion = versions.versions[0];
versions.versions = [
  {
    ...originalVersion,
    version: 2,
    title: entry.title,
    content: entry.content,
    created_at: entry.updated_at,
  },
  {
    ...originalVersion,
    version_id: "00000000-0000-4000-8000-000000000002",
    version: 1,
    is_current: false,
    superseded_at: entry.updated_at,
    created_at: entry.created_at,
    title: entry.title,
    content: "Webhook deliveries should not apply the same change twice.",
  },
];
const sessions = fixture("sessions-list");
sessions[0].title = "Handle duplicate webhook deliveries";
sessions.push(
  {
    ...sessions[0],
    session_id: "sample-retry",
    title: "Add retry coverage for the webhook handler",
  },
  {
    ...sessions[0],
    session_id: "sample-setup",
    title: "Choose the shared event-id check",
  },
);
project.session_count = 3;
sessions.forEach((session, index) => {
  session.first_message_at = entry.created_at + index * 86400000;
  session.last_message_at = session.first_message_at + 1000;
});
const messages = fixture("session-detail");
messages.messages[0].content =
  "Keep webhook handlers idempotent. The provider can deliver the same event twice. Reuse the event-id check that’s already there.";
messages.messages[1].content =
  "I’ll reuse the event-id check before applying the update.";
messages.messages[1].role = "assistant";
messages.title = sessions[0].title;
messages.messages.forEach((message, index) => {
  message.created_at = entry.created_at + index * 1000;
});
messages.distillations.forEach((item) => {
  item.created_at = entry.created_at + 2000;
});
const effects = {
  scope: "project",
  project_id: projectId,
  revision: 1,
  is_deleted: false,
  lore_file: {
    enabled: true,
    path: "/sample/webhook-service/.lore.md",
    affected: true,
  },
  agents_file: { enabled: true, mode: "pointer", immediate: false },
  sync: { enabled: false },
};
const responses = {
  "/projects": [project],
  "/account": fixture("folk-account"),
  "/teams": fixture("folk-teams"),
  "/orgs": [],
  "/sync/status": fixture("folk-sync-status"),
  [`/projects/${projectId}/knowledge`]: {
    items: [
      entry,
      {
        ...entry,
        id: "sample-pattern",
        logical_id: "sample-pattern",
        category: "pattern",
        title: "Use the shared event-id check",
        content: "Keep duplicate detection in the existing helper.",
      },
    ],
    next_cursor: null,
  },
  [`/knowledge/${entryId}`]: entry,
  [`/knowledge/${entryId}/versions`]: versions,
  [`/knowledge/${entryId}/effects`]: effects,
  [`/knowledge/${entryId}/promotion`]: {
    entry: {
      id: entryId,
      version_id: entryId,
      version: 1,
      title: entry.title,
      content: entry.content,
      category: "decision",
      project_id: projectId,
      sensitivity: "normal",
      approval_status: "auto",
    },
    team: null,
    policy: { effective: "manual", project_override: null, team_default: null },
    eligibility: { promotable: false, reason: "account_required" },
    previous_team_version: null,
    pending_request: null,
    remote: "anonymous",
  },
  [`/knowledge/${entryId}/files`]: {
    id: entryId,
    git_remote: null,
    commit: null,
    files: [],
    omitted: 0,
  },
  [`/projects/${projectId}/sessions`]: { items: sessions, next_cursor: null },
  "/sessions/sample-session": {
    ...messages,
    next_cursor: null,
    message_count: 2,
  },
  "/sessions/sample-session/context": {
    session_id: "sample-session",
    layer: 0,
    history: { message_count: 2, token_estimate: 60 },
    distilled_prefix: { token_count: 0, distillations: [] },
    knowledge: {
      cache_text: null,
      cache_tokens: null,
      pin_tokens: null,
      stable_tokens: null,
      injections: [],
    },
    prompt_deltas: [],
    turns: [],
  },
  "/model-usage": {
    format: "model-tides-daily",
    version: 2,
    source: "lore",
    days: [
      {
        day: "2026-10-25",
        models: { "anthropic/claude-sonnet-4": 2, "openai/gpt-5": 1 },
      },
      {
        day: "2026-10-26",
        models: { "anthropic/claude-sonnet-4": 1, "openai/gpt-5": 2 },
      },
      { day: "2026-10-27", models: { "anthropic/claude-sonnet-4": 1 } },
    ],
  },
  "/model-usage/upload": fixture("model-usage-upload"),
};
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".html": "text/html",
};
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = resolve(ui, "." + decodeURIComponent(path).replace(/^\/ui/, ""));
  if (!file.startsWith(ui)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const target =
    existsSync(file) && extname(file) ? file : join(ui, "index.html");
  try {
    res.setHeader(
      "content-type",
      types[extname(target)] ?? "application/octet-stream",
    );
    res.end(readFileSync(target));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
mkdirSync(output, { recursive: true });
const browser = await chromium.launch();
try {
  const unexpected = [];
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1120, height: 760 },
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/v1/")) return route.continue();
      const path = url.pathname.slice("/api/v1".length);
      let data = responses[path];
      if (path === "/knowledge")
        data = {
          items: [{ ...entry, project_name: project.name, match: "exact" }],
          next_cursor: null,
        };
      if (path.endsWith("/sessions") && !url.searchParams.has("page"))
        data = sessions;
      if (data === undefined) {
        unexpected.push(`Unhandled sample API: ${path}`);
        return route.fulfill({
          status: 404,
          json: {
            type: "error",
            error: { message: "Not included in this read-only sample" },
          },
        });
      }
      return route.fulfill({ json: data });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => unexpected.push(error.message));
    await page.clock.setFixedTime(new Date("2026-10-27T12:00:00Z"));
    await page.addInitScript(
      (scheme) => localStorage.setItem("lore.ui.theme", scheme),
      scheme,
    );
    for (const [name, path, heading] of [
      ["sessions", `/projects/${projectId}/sessions`, "Sessions"],
      ["knowledge", `/projects/${projectId}/knowledge/${entryId}`, entry.title],
      ["usage", "/model-usage", "Model usage"],
    ]) {
      await page.goto(origin + "/ui" + path);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (name === "knowledge") {
        await page.getByText("Source & history", { exact: true }).click();
        await expect(page.getByTestId("knowledge-version-2")).toHaveCount(1);
        await expect(page.getByTestId("knowledge-version-1")).toHaveCount(1);
      }
      await page.screenshot({ path: join(output, `${name}-${scheme}.png`) });
      if (name === "knowledge") {
        await page
          .getByTestId("knowledge-document")
          .screenshot({ path: join(output, `knowledge-detail-${scheme}.png`) });
        await page
          .getByRole("link", { name: "Distilled from session", exact: true })
          .click();
        await expect(
          page.getByText(messages.messages[0].content, { exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: join(output, `session-detail-${scheme}.png`),
        });
      }
      expect(unexpected).toEqual([]);
      console.log(`Captured ${name}-${scheme}`);
    }
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(origin + `/ui/projects/${projectId}/knowledge/${entryId}`);
    const knowledgeHeading = page.getByRole("heading", {
      name: entry.title,
      exact: true,
    });
    await expect(knowledgeHeading).toBeVisible();
    await page.getByText("Source & history", { exact: true }).click();
    await knowledgeHeading.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, `knowledge-mobile-${scheme}.png`),
    });
    expect(unexpected).toEqual([]);
    console.log(`Captured knowledge-mobile-${scheme}`);
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
