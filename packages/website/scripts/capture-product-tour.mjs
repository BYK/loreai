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
  title: "Deduplicate webhook deliveries",
  content:
    "Check the event ID before applying a webhook. The provider can deliver the same event twice.",
  confidence: 0.9,
};
const versions = fixture("cursor/knowledge-versions");
versions.versions[0] = {
  ...versions.versions[0],
  title: entry.title,
  content: entry.content,
};
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
const messages = fixture("session-detail");
messages.messages[0].content =
  "Keep webhook handlers idempotent. The provider can deliver the same event twice.";
messages.messages[1].content =
  "I’ll reuse the event-id check before applying the update.";
messages.messages[1].role = "assistant";
messages.title = sessions[0].title;
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
      if (name === "knowledge")
        await page.getByText("Source & history", { exact: true }).click();
      await page.screenshot({ path: join(output, `${name}-${scheme}.png`) });
      expect(unexpected).toEqual([]);
      console.log(`Captured ${name}-${scheme}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
