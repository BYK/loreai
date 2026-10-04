import { expect, test, type Page } from "@playwright/test";

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

test.describe("FOLK-03 team and conflict surfaces", () => {
  test("hosted team status is shown even when the account is anonymous", async ({
    page,
  }) => {
    await page.route("**/api/v1/account", (route) =>
      route.fulfill({
        json: {
          signed_in: false,
          user: null,
          provider: null,
          expires_at: null,
          state: "anonymous",
        },
      }),
    );
    await page.route("**/api/v1/teams", (route) =>
      route.fulfill({ json: { hosted: true, teams: [] } }),
    );
    await page.goto("/ui/team");
    await expect(
      page.getByText(
        "Team membership changes are not available in hosted mode.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Sign in with `lore login`")).toHaveCount(0);
  });

  test("signed-in team route shows the member table and scopes invite tokens to its dialog", async ({
    page,
  }) => {
    await installSignedInTeamRoutes(page);
    await page.route("**/api/v1/teams/team-1/invites", (route) =>
      route.fulfill({
        json: {
          invite: {
            team_id: "team-1",
            role: "viewer",
            expires_in_days: 14,
            token: "e2e-invite-token",
            accept_command: "lore team accept e2e-invite-token",
            emailed: false,
          },
        },
      }),
    );
    await page.goto("/ui/team");

    await expect(page.getByTestId("team-members")).toBeVisible();
    await expect(page.getByText("Teammate user-mem")).toHaveAttribute(
      "title",
      "user-member-12345678",
    );
    await page.getByRole("button", { name: "Create invite" }).click();
    const receipt = page.getByTestId("team-invite-receipt");
    await expect(receipt).toContainText("e2e-invite-token");
    await receipt.getByRole("button", { name: "Done" }).click();
    await expect(page.locator("body")).not.toContainText("e2e-invite-token");
  });

  test("failed role updates restore the server role", async ({ page }) => {
    await installSignedInTeamRoutes(page);
    await page.route(
      "**/api/v1/teams/team-1/members/user-member-12345678/role",
      (route) =>
        route.fulfill({
          status: 403,
          json: {
            type: "error",
            error: {
              type: "not_admin",
              message: "Only team admins can change or remove members.",
            },
          },
        }),
    );
    await page.goto("/ui/team");

    const role = page.getByRole("combobox", {
      name: "Role for Teammate user-mem",
    });
    await expect(role).toHaveValue("viewer");
    await role.selectOption("editor");
    await expect(role).toHaveValue("viewer");
    await expect(page.getByRole("alert")).toContainText(
      "Only team admins can change or remove members.",
    );
  });

  test("stale conflict errors stay in the dialog and reload the list", async ({
    page,
  }) => {
    const conflict = {
      id: 43,
      table: "knowledge",
      row_id: "knowledge-43",
      detected_at: "2026-09-20T12:00:00.000Z",
      resolution: "remote_upsert_wins",
      recoverable: true,
      unrecoverable_reason: null,
      local: {
        title: "Local decision",
        content: "Keep the local copy.",
        category: "decision",
      },
      current: {
        version_id: "version-2",
        version: 2,
        title: "Current decision",
        content: "The newer remote copy.",
      },
    };
    let conflictListRequests = 0;
    await page.route("**/api/v1/sync/conflicts", (route) => {
      if (route.request().method() === "GET") conflictListRequests += 1;
      return route.fulfill({
        json: { available: true, complete: true, conflicts: [conflict] },
      });
    });
    await page.route("**/api/v1/sync/conflicts/43/keep-local", (route) =>
      route.fulfill({
        status: 409,
        json: {
          type: "error",
          error: {
            type: "stale_version",
            message: "Knowledge entry changed; reload conflicts.",
          },
        },
      }),
    );
    await page.goto("/ui/conflicts");

    const card = page.getByTestId("conflict-card");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Keep mine" }).click();
    const dialog = page.getByTestId("conflict-action-confirmation");
    await dialog.getByRole("button", { name: "Keep mine" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("Knowledge entry changed");
    await expect(alert).toBeFocused();
    await expect(
      dialog.getByRole("button", { name: "Keep mine" }),
    ).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await dialog.getByRole("button", { name: "Reload conflicts" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => conflictListRequests).toBe(2);
    await expect(page.getByTestId("conflict-card")).toBeVisible();
  });

  test("conflicts route renders the saved local version beside the current one", async ({
    page,
  }) => {
    await page.goto("/ui/conflicts");
    const card = page.getByTestId("conflict-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Your discarded version");
    await expect(card).toContainText("Keep the local-first database.");
    await expect(card).toContainText("Current version");
    await expect(card).toContainText("Keep SQLite as the only store");
  });

  test("linked project can require review from the sharing panel", async ({
    page,
  }) => {
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
    await page.goto(`/ui/projects/${encodeURIComponent(scratch.id)}`);

    await page.getByTestId("sharing-require-review").click();
    const dialog = page.getByTestId("sharing-policy-confirmation");
    await expect(dialog).toContainText("Automatic sharing can only be enabled");
    await dialog.getByRole("button", { name: "Require review" }).click();
    await expect(page.getByTestId("sharing-summary")).toContainText(
      "policy: manual",
    );
    await expect(page.getByTestId("sharing-require-review")).toHaveCount(0);
  });
});
