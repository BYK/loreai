import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

async function installSignedInTeamRoutes(page: Page) {
  await page.route("**/api/v1/account", (route) =>
    route.fulfill({
      json: {
        signed_in: true,
        user: { id: "user-admin", email: null, display_name: "Admin" },
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
          { id: "team-1", name: "Acme e2e", role: "admin", member_count: 2 },
        ],
      },
    }),
  );
  await page.route("**/api/v1/sync/status", (route) =>
    route.fulfill({
      json: { enabled: true, state: "idle", pending_changes: 0 },
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
            user_id: "user-member-12345678",
            label: null,
            role: "viewer",
            me: false,
          },
        ],
        actions: {
          invite: "available",
          remove: "available",
          set_role: "available",
          add_by_id: "cli_only",
          offline_invite: "cli_only",
          list_invites: "unsupported",
          revoke_invite: "unsupported",
        },
      },
    }),
  );
}

async function projectByName(page: Page, name: string) {
  const response = await page.request.get("/api/v1/projects");
  expect(response.ok()).toBe(true);
  const projects = (await response.json()) as Array<{
    id: string;
    name: string | null;
  }>;
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`seeded project ${name} not found`);
  return project;
}

test("capture FOLK-03 team, conflicts and review surfaces", async ({
  page,
}, testInfo) => {
  const outputDir = process.env.FOLK03_SCREENSHOT_DIR;
  test.skip(!outputDir, "Screenshot capture is enabled only when requested.");
  mkdirSync(outputDir!, { recursive: true });
  const device = testInfo.project.name.startsWith("mobile")
    ? "mobile"
    : "desktop";
  await installSignedInTeamRoutes(page);

  const scratch = await projectByName(page, "scratch");
  const sharingUrl = `**/api/v1/projects/${scratch.id}/sharing`;
  await page.route(sharingUrl, (route) =>
    route.fulfill({
      json: {
        linked: true,
        team: { id: "e2e-team-acme", name: "Acme e2e" },
        policy: {
          effective: "auto",
          project_override: null,
          team_default: "auto",
        },
        state: "linked",
        detail: null,
      },
    }),
  );
  await page.route(`${sharingUrl}/policy`, (route) =>
    route.fulfill({
      json: {
        linked: true,
        team: { id: "e2e-team-acme", name: "Acme e2e" },
        policy: {
          effective: "manual",
          project_override: "manual",
          team_default: "auto",
        },
        state: "linked",
        detail: null,
      },
    }),
  );

  for (const mode of ["light", "dark"] as const) {
    await page.goto("/ui/team");
    await expect(page.getByTestId("team-members")).toBeVisible();
    await page.getByTestId(`theme-${mode}`).click();
    await page.screenshot({
      path: join(outputDir!, `folk03-team-${device}-${mode}.png`),
      fullPage: true,
    });

    await page.goto("/ui/conflicts");
    await expect(page.getByTestId("conflict-card")).toBeVisible();
    await page.getByTestId(`theme-${mode}`).click();
    await page.screenshot({
      path: join(outputDir!, `folk03-conflicts-${device}-${mode}.png`),
      fullPage: true,
    });

    await page.goto(`/ui/projects/${encodeURIComponent(scratch.id)}`);
    await page.getByTestId(`theme-${mode}`).click();
    await page.getByTestId("sharing-require-review").click();
    await expect(page.getByTestId("sharing-policy-confirmation")).toBeVisible();
    await page.screenshot({
      path: join(outputDir!, `folk03-sharing-review-${device}-${mode}.png`),
      fullPage: true,
    });
  }
});
