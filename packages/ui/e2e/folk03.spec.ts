import { openAccountMenu, themeColor } from "./workspace-helpers";
import { expect, test, type Page, type Locator } from "@playwright/test";

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
          add_by_id: "available",
          offline_invite: "available",
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
    await expect(page.getByText("Former member")).not.toHaveAttribute("title");
    await page.getByRole("link", { name: "Invitations", exact: true }).click();
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
      name: "Role for Former member",
    });
    await expect(role).toHaveValue("viewer");
    await role.selectOption("editor");
    await expect(role).toHaveValue("viewer");
    await expect(
      page.getByText("Only team admins can change or remove members.", {
        exact: true,
      }),
    ).toBeVisible();
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

  test("a remote-deleted conflict can be restored with Keep mine", async ({
    page,
  }) => {
    const conflict = {
      id: 44,
      table: "knowledge",
      row_id: "knowledge-44",
      detected_at: "2026-09-20T12:00:00.000Z",
      resolution: "remote_delete_wins",
      recoverable: true,
      unrecoverable_reason: null,
      local: {
        title: "Local decision",
        content: "Keep the local copy.",
        category: "decision",
      },
      current: {
        version_id: "death-cert-3",
        version: 3,
        title: "Local decision",
        content: "The deleted local version.",
        deleted: true,
      },
    };
    await page.route("**/api/v1/sync/conflicts", (route) =>
      route.fulfill({
        json: { available: true, complete: true, conflicts: [conflict] },
      }),
    );
    let expectedVersionId: string | undefined;
    await page.route("**/api/v1/sync/conflicts/44/keep-local", (route) => {
      expectedVersionId = route.request().postDataJSON().expected_version_id;
      return route.fulfill({
        json: {
          kept: "local",
          current: {
            version_id: "restored-4",
            version: 4,
            title: "Local decision",
            content: "Keep the local copy.",
          },
        },
      });
    });
    await page.goto("/ui/conflicts");

    const card = page.getByTestId("conflict-card");
    await expect(card).toContainText("The remote entry was deleted.");
    await expect(card).toContainText("deleted remotely");
    await card.getByRole("button", { name: "Keep mine" }).click();
    const dialog = page.getByTestId("conflict-action-confirmation");
    await dialog.getByRole("button", { name: "Keep mine" }).click();

    await expect(page.getByTestId("conflict-recovery-receipt")).toContainText(
      "restored-4",
    );
    expect(expectedVersionId).toBe("death-cert-3");
    await expect(page.getByTestId("conflict-card")).toHaveCount(0);
  });

  test("conflicts route renders the saved local version beside the current one", async ({
    page,
  }) => {
    await page.goto("/ui/conflicts");
    const card = page
      .getByTestId("conflict-card")
      .filter({ hasText: "Keep SQLite as the only store" });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("conflict-changes")).toBeVisible();
    await expect(
      card.getByTestId("conflict-changes").locator("ins"),
    ).not.toHaveCount(0);
    const full = card.getByText("Full local and current text", { exact: true });
    await expect(full.locator("..")).not.toHaveAttribute("open");
    await expect(
      card.getByText("Your discarded version", { exact: true }),
    ).not.toBeVisible();
    await full.click();
    await expect(
      card.getByText("Your discarded version", { exact: true }),
    ).toBeVisible();
    await expect(card).toContainText("Keep the local-first database.");
    await expect(card).toContainText("Current version");
    await expect(card).toContainText("Keep SQLite as the only store");
  });

  test("seeded remote deletion is listed as recoverable in the conflict UI", async ({
    page,
  }) => {
    await page.goto("/ui/conflicts");
    const response = await page.request.get("/api/v1/sync/conflicts");
    expect(response.ok()).toBe(true);
    const result = (await response.json()) as {
      conflicts: Array<{
        resolution: string;
        local: { content: string } | null;
        current: { version_id: string; deleted?: boolean } | null;
      }>;
    };
    const conflict = result.conflicts.find(
      (item) => item.resolution === "remote_delete_wins",
    );
    expect(conflict?.local?.content).toBe("Keep the local-first database.");
    expect(conflict?.current?.deleted).toBe(true);
    if (!conflict?.current) throw new Error("seeded death certificate missing");

    const card = page
      .getByTestId("conflict-card")
      .filter({ hasText: "The remote entry was deleted." });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Keep the local-first database.");
    await expect(card.getByRole("button", { name: "Keep mine" })).toBeEnabled();
  });

  test("project auto-share toggle uses team review policy and keyboard input", async ({
    page,
  }) => {
    await installSignedInTeamRoutes(page);
    const project = await projectByName(page, "sharing-e2e");
    const sharingUrl = `**/api/v1/projects/${project.id}/sharing`;
    await page.route(sharingUrl, (route) =>
      route.fulfill({
        json: {
          linked: true,
          team: { id: "e2e-team-acme", name: "Acme e2e" },
          policy: {
            effective: "auto",
            project_override: "auto",
            team_default: "auto",
          },
          auto_share: true,
          review_required: false,
          state: "linked",
          detail: null,
        },
      }),
    );
    let policyWrites = 0;
    await page.route(`${sharingUrl}/policy`, async (route) => {
      policyWrites += 1;
      const request = route.request().postDataJSON() as {
        policy: "manual" | "auto";
        expected_override: "manual" | "auto" | null;
      };
      expect(request).toEqual({
        policy: "manual",
        expected_override: "auto",
      });
      return route.fulfill({
        json: {
          linked: true,
          team: { id: "e2e-team-acme", name: "Acme e2e" },
          policy: {
            effective: "manual",
            project_override: "manual",
            team_default: "auto",
          },
          auto_share: false,
          review_required: false,
          state: "linked",
          detail: null,
        },
      });
    });
    await page.goto(`/ui/projects/${encodeURIComponent(project.id)}`);

    await page.getByRole("button", { name: "Manage sharing" }).click();
    const toggle = page.getByRole("switch", { name: "Share automatically" });
    await expect(toggle).toBeChecked();
    await expect(page.getByTestId("sharing-team-review")).toHaveText(
      "Team review: optional",
    );
    await toggle.focus();
    await page.keyboard.press("Space");
    const dialog = page.getByTestId("sharing-policy-confirmation");
    await expect(dialog).toContainText(
      "You’ll choose which new entries to propose. Copies already shared with the team are not removed.",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(toggle).toBeChecked();
    expect(policyWrites).toBe(0);

    await toggle.focus();
    await page.keyboard.press("Space");
    await dialog
      .getByRole("button", { name: "Turn off automatic sharing" })
      .click();
    await expect(page.getByTestId("sharing-summary")).toContainText(
      "policy: manual",
    );
    await expect(toggle).not.toBeChecked();
    expect(policyWrites).toBe(1);
  });

  test("team page exposes parity actions and sends invite tokens only in bodies", async ({
    page,
  }) => {
    await installSignedInTeamRoutes(page);
    await page.route("**/api/v1/teams", async (route) => {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({ name: "New Acme" });
        return route.fulfill({
          status: 201,
          json: { team: { id: "team-new", name: "New Acme" } },
        });
      }
      return route.fallback();
    });
    await page.route("**/api/v1/orgs", (route) =>
      route.fulfill({
        json: {
          organizations: [{ id: "org-1", name: "Acme Org", role: "admin" }],
        },
      }),
    );
    await page.route("**/api/v1/teams/team-1/review-policy", async (route) => {
      if (route.request().method() === "PUT") {
        expect(route.request().postDataJSON()).toEqual({
          policy: "optional",
          expected: "required",
        });
        return route.fulfill({ json: { policy: "optional" } });
      }
      return route.fulfill({ json: { policy: "required" } });
    });
    await page.route("**/api/v1/orgs/org-1/domains/requests", (route) =>
      route.fulfill({
        json: {
          requests: [
            {
              id: "domain-request-1",
              domain: "example.test",
              user_id: "user-2",
              label: "Ada Lovelace",
              status: "pending",
              requested_at: "2026-09-20T12:00:00.000Z",
            },
            {
              id: "domain-request-2",
              domain: "other.example.test",
              user_id: "user-3",
              label: "@grace",
              status: "pending",
              requested_at: "2026-09-20T12:00:00.000Z",
            },
            {
              id: "domain-request-approved",
              domain: "approved.example.test",
              user_id: "user-4",
              label: "Katherine Johnson",
              status: "approved",
              requested_at: "2026-09-21T12:00:00.000Z",
            },
            {
              id: "domain-request-rejected",
              domain: "rejected.example.test",
              user_id: "user-5",
              label: null,
              status: "rejected",
              requested_at: "2026-09-22T12:00:00.000Z",
            },
          ],
        },
      }),
    );
    await page.route("**/api/v1/teams/team-1/invites", async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        role: "viewer",
        offline: true,
      });
      return route.fulfill({
        json: {
          invite: {
            team_id: "team-1",
            role: "viewer",
            expires_in_days: 14,
            token: "offline-invite-token",
            accept_command: "lore team accept offline-invite-token",
            emailed: false,
          },
        },
      });
    });
    await page.route("**/api/v1/teams/accept", async (route) => {
      expect(route.request().url()).not.toContain("join-token");
      expect(route.request().postDataJSON()).toEqual({ token: "join-token" });
      return route.fulfill({
        json: { joined: { scope_id: "team-1", role: "editor" } },
      });
    });
    await page.route("**/api/v1/teams/team-1/members", async (route) => {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({
          user_id: "user-by-id",
          role: "editor",
        });
        return route.fulfill({
          json: {
            member: { user_id: "user-by-id", role: "editor", wrapped: true },
          },
        });
      }
      return route.fallback();
    });
    let discoveries = 0;
    await page.route("**/api/v1/teams/team-1/discover", async (route) => {
      discoveries += 1;
      if (discoveries === 1) {
        expect(route.request().postDataJSON()).toEqual({});
        return route.fulfill({
          json: {
            repos: [
              {
                repo: "acme/app",
                contributors: [{ login: "ada", githubId: 17, onLore: false }],
              },
            ],
          },
        });
      }
      expect(route.request().postDataJSON()).toEqual({
        invite_role: "editor",
        invite_logins: ["ada"],
      });
      return route.fulfill({
        json: {
          repos: [
            {
              repo: "acme/app",
              contributors: [{ login: "ada", githubId: 17, onLore: false }],
            },
          ],
          invited: {
            scopeId: "team-1",
            role: "editor",
            total: 1,
            emailed: 1,
            noEmail: 0,
            overCap: 0,
            results: [],
          },
        },
      });
    });
    await page.route("**/api/v1/orgs/org-1/domains/request", (route) =>
      route.fulfill({ json: { request_id: "domain-request-2" } }),
    );
    await page.route("**/api/v1/orgs/org-1/domains/claim", (route) =>
      route.fulfill({ json: { claimed: "example.test" } }),
    );
    await page.route(
      "**/api/v1/orgs/org-1/domains/requests/domain-request-1/approve",
      (route) =>
        route.fulfill({
          json: { request_id: "domain-request-1", status: "approved" },
        }),
    );
    await page.route(
      "**/api/v1/orgs/org-1/domains/requests/domain-request-2/reject",
      (route) =>
        route.fulfill({
          json: { request_id: "domain-request-2", status: "rejected" },
        }),
    );
    await page.goto("/ui/team");

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "New team" }).click();
    await page.getByTestId("team-create-name").fill("New Acme");
    await page.getByRole("button", { name: "Create team" }).click();
    const reviewToggle = page.getByTestId("team-require-review");
    await expect(reviewToggle).toBeChecked();
    await reviewToggle.click();
    const reviewDialog = page.getByTestId("team-review-policy-confirmation");
    await expect(reviewToggle).toBeChecked();
    await reviewDialog.getByRole("button", { name: "Turn off review" }).click();
    await expect(page.getByTestId("team-require-review")).not.toBeChecked();
    await page.getByRole("link", { name: "Invitations", exact: true }).click();
    await page.getByTestId("team-offline-invite").check();
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.getByTestId("team-invite-receipt")).toContainText(
      "offline-invite-token",
    );
    await page.getByRole("button", { name: "Done" }).click();

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Join a team" }).click();
    await page.getByTestId("team-invite-token").fill("join-token");
    await page.getByRole("button", { name: "Join team" }).click();

    await page.getByRole("button", { name: "Add by account ID" }).click();
    await page.getByTestId("team-account-id").fill("user-by-id");
    await page.getByRole("button", { name: "Add member" }).click();

    expect(discoveries).toBe(0);
    await page.getByRole("button", { name: "Find contributors" }).click();
    await page.getByRole("checkbox", { name: /@ada/ }).check();
    await page.getByRole("button", { name: "Invite selected" }).click();
    await expect(
      page.getByText("Invitation attempted for 1 selected contributor(s).", {
        exact: true,
      }),
    ).toBeVisible();
    expect(discoveries).toBe(2);

    await page.getByRole("button", { name: "Load join requests" }).click();
    const firstRequest = page
      .getByTestId("domain-join-request")
      .filter({ hasText: "example.test · Ada Lovelace" });
    await expect(firstRequest).not.toContainText("user-2");
    await firstRequest.getByRole("button", { name: "Approve" }).click();
    const otherRequest = page
      .getByTestId("domain-join-request")
      .filter({ hasText: "other.example.test" });
    await otherRequest.getByRole("button", { name: "Reject" }).click();
    const approvedRequest = page
      .getByTestId("domain-join-request")
      .filter({ hasText: "approved.example.test" });
    await expect(approvedRequest).toContainText("Approved");
    await expect(approvedRequest.getByRole("button")).toHaveCount(0);
    const rejectedRequest = page
      .getByTestId("domain-join-request")
      .filter({ hasText: "rejected.example.test" });
    await expect(rejectedRequest).toContainText("Rejected");
    await expect(rejectedRequest).toContainText("Unknown requester");
    await expect(rejectedRequest).not.toContainText("user-5");
    await expect(rejectedRequest.getByRole("button")).toHaveCount(0);
    await page.getByLabel("Verified email domain").fill("example.test");
    await page.getByRole("button", { name: "Request to join" }).click();
    await page.getByLabel("Verified email domain").fill("example.test");
    await page.getByRole("button", { name: "Claim domain" }).click();
  });

  test("team review policy reload restores the server value after a stale response", async ({
    page,
  }) => {
    await installSignedInTeamRoutes(page);
    let reads = 0;
    let writes = 0;
    await page.route("**/api/v1/teams/team-1/review-policy", async (route) => {
      if (route.request().method() === "PUT") {
        writes += 1;
        expect(route.request().postDataJSON()).toEqual({
          policy: "required",
          expected: "optional",
        });
        return route.fulfill({
          status: 409,
          json: {
            type: "error",
            error: {
              type: "stale_policy",
              message: "Team review policy changed; reload and try again.",
            },
          },
        });
      }
      reads += 1;
      return route.fulfill({ json: { policy: "optional" } });
    });
    await page.goto("/ui/team");

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const toggle = page.getByTestId("team-require-review");
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    const dialog = page.getByTestId("team-review-policy-confirmation");
    await dialog.getByRole("button", { name: "Require review" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Team review policy changed",
    );
    await dialog.getByRole("button", { name: "Reload review policy" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });

  test("team page shows an inline create form when the account has no teams", async ({
    page,
  }) => {
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
    await page.route("**/api/v1/teams", async (route) => {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({ name: "First team" });
        return route.fulfill({
          status: 201,
          json: { team: { id: "team-first", name: "First team" } },
        });
      }
      return route.fulfill({ json: { hosted: false, teams: [] } });
    });
    await page.route("**/api/v1/sync/status", (route) =>
      route.fulfill({
        json: { enabled: true, state: "idle", pending_changes: 0 },
      }),
    );
    await page.route("**/api/v1/orgs", (route) =>
      route.fulfill({ json: { organizations: [] } }),
    );
    await page.goto("/ui/team");

    const form = page.getByTestId("team-create-form");
    await expect(form).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Join a team" }),
    ).toBeVisible();
    await expect(page.getByTestId("organization-domains")).not.toBeVisible();
    const settings = page.getByRole("button", {
      name: "Team settings",
      exact: true,
    });
    await settings.focus();
    await page.keyboard.press("Enter");
    await expect(settings).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("organization-domains")).toBeVisible();
    await expect(settings).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("organization-domains")).not.toBeVisible();
    await expect(form).toBeVisible();
    await form.getByLabel("Team name").fill("First team");
    await form.getByRole("button", { name: "Create team" }).click();
  });

  test("links and unlinks a seeded project and offers Sync now", async ({
    page,
  }) => {
    await installSignedInTeamRoutes(page);
    const project = await projectByName(page, "sharing-e2e");
    const unlinked = {
      linked: false,
      team: null,
      policy: {
        effective: "manual",
        project_override: null,
        team_default: null,
      },
      auto_share: false,
      review_required: null,
      state: "not_linked",
      detail: null,
    };
    const linked = {
      linked: true,
      team: { id: "team-1", name: "Acme e2e" },
      policy: {
        effective: "manual",
        project_override: null,
        team_default: "manual",
      },
      auto_share: false,
      review_required: true,
      state: "linked",
      detail: null,
    };
    await page.route(`**/api/v1/projects/${project.id}/sharing`, (route) =>
      route.fulfill({ json: unlinked }),
    );
    const linkCalls: Array<Record<string, unknown>> = [];
    await page.route(
      `**/api/v1/projects/${project.id}/sharing/link`,
      async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        linkCalls.push(body);
        return route.fulfill({
          json: body.scope_id === null ? unlinked : linked,
        });
      },
    );
    await page.route("**/api/v1/sync/run", async (route) => {
      expect(route.request().postDataJSON()).toEqual({});
      return route.fulfill({
        json: { pushed: 1, pulled: 2, conflicts: 0, skipped: 0 },
      });
    });
    await page.goto(`/ui/projects/${encodeURIComponent(project.id)}`);
    await expect(page.getByTestId("sharing-team-picker")).toBeVisible();
    await page
      .getByRole("combobox", { name: "Link to team" })
      .selectOption("team-1");
    await page.getByRole("button", { name: "Link to team" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Manage sharing" }),
    ).toBeFocused();
    await expect(page.getByTestId("sharing-summary")).toContainText("Linked");
    await page.getByRole("button", { name: "Manage sharing" }).click();
    await page.getByRole("button", { name: "Unlink" }).click();
    await page
      .getByRole("button", { name: "Unlink project", exact: true })
      .click();
    await expect(page.getByTestId("sharing-summary")).toContainText(
      "Not linked",
    );
    expect(linkCalls).toEqual([
      { scope_id: "team-1", expected_scope_id: null },
      { scope_id: null, expected_scope_id: "team-1" },
    ]);

    await openAccountMenu(page);
    await page.getByTestId("sync-now").click();
    await expect(
      page
        .getByTestId("folk-status-panel")
        .getByText("Sync complete: pushed 1, pulled 2.", { exact: true }),
    ).toBeVisible();
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`team forms fit desktop and narrow mobile widths in ${theme}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.addInitScript(
      (choice) => localStorage.setItem("lore.ui.theme", choice),
      theme,
    );
    await installSignedInTeamRoutes(page);
    await page.route("**/api/v1/teams/team-1/review-policy", (route) =>
      route.fulfill({ json: { policy: "required" } }),
    );
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/ui/team");
      const memberRow = page.getByTestId("team-member-row").first();
      const memberAction = memberRow.getByRole("button");
      await expect(memberAction).toBeVisible();
      const actionBox = await memberAction.boundingBox();
      expect(actionBox, "member action has a visible box").not.toBeNull();
      if (!actionBox) throw new Error("Missing member action box");
      expect(actionBox.x).toBeGreaterThanOrEqual(0);
      expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(width);
      if (width < 768) expect(actionBox.height).toBeGreaterThanOrEqual(44);
      await page.goto("/ui/team?section=invitations");
      await expect(
        page.getByLabel("Invite email", { exact: true }),
      ).toBeVisible();
      const size = await page
        .locator("main")
        .evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      expect
        .soft(size.scroll, `team page at ${width}px`)
        .toBeLessThanOrEqual(size.client + 1);
      const email = (await page
        .getByLabel("Invite email", { exact: true })
        .boundingBox())!;
      const mainBox = (await page.locator("main").boundingBox())!;
      expect
        .soft(email.width, "invite email remains readable")
        .toBeGreaterThanOrEqual(140);
      expect
        .soft(email.x + email.width, "invite email stays inside its card")
        .toBeLessThanOrEqual(mainBox.x + mainBox.width - 32);
      await expect(page.getByTestId("team-offline-invite")).toHaveCSS(
        "accent-color",
        await themeColor(page, `--color-amber-${theme === "dark" ? 400 : 700}`),
      );
      await page.getByTestId("team-offline-invite").check();
      const offline = (await page
        .getByLabel("Offline invite", { exact: true })
        .boundingBox())!;
      const createInvite = (await page
        .getByRole("button", { name: "Create invite", exact: true })
        .boundingBox())!;
      expect
        .soft(
          Math.abs(
            offline.y +
              offline.height / 2 -
              (createInvite.y + createInvite.height / 2),
          ),
          "checkbox and invite action share their center line",
        )
        .toBeLessThanOrEqual(1);
      await page
        .getByRole("heading", { name: "Invite a teammate", exact: true })
        .locator("..")
        .screenshot({
          path: testInfo.outputPath(`team-invite-${theme}-${width}.png`),
        });
      await page.screenshot({
        path: testInfo.outputPath(`team-layout-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  });

  test(`populated promotion and conflict pages contain long content at every width in ${theme}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.addInitScript(
      (choice) => localStorage.setItem("lore.ui.theme", choice),
      theme,
    );
    await installSignedInTeamRoutes(page);
    const teamName = "A-long-team-name-with-a-continuous-identifier-".repeat(3);
    await page.route("**/api/v1/teams", (route) =>
      route.fulfill({
        json: {
          hosted: false,
          teams: [
            { id: "team-1", name: teamName, role: "admin", member_count: 2 },
            {
              id: "team-2",
              name: "Another team",
              role: "editor",
              member_count: 1,
            },
          ],
        },
      }),
    );
    await page.route("**/api/v1/promotions?*", (route) =>
      route.fulfill({
        json: {
          remote: "ok",
          complete: true,
          requests: [
            {
              id: "layout-request",
              team: { id: "team-1", name: teamName },
              logical_id: "layout-knowledge",
              entry_version_id: "layout-version",
              entry_version: 1,
              category: "decision",
              title: "Keep the local-first store",
              content: "Use SQLite as the only store.",
              sealed: false,
              proposer: { id: "user-editor", label: "Editor" },
              mine: false,
              status: "pending",
              decided_by: null,
              decided_at: null,
              decision_note: null,
              applied: null,
              applied_at: null,
              created_at: "2026-09-20T12:00:00.000Z",
              can_decide: true,
              decide_blocked_reason: null,
            },
          ],
        },
      }),
    );
    await page.route("**/api/v1/sync/conflicts", (route) =>
      route.fulfill({
        json: {
          available: true,
          complete: true,
          conflicts: [
            {
              id: 43,
              table: "knowledge",
              row_id: "layout-knowledge",
              detected_at: "2026-09-20T12:00:00.000Z",
              resolution: "remote_upsert_wins",
              recoverable: true,
              unrecoverable_reason: null,
              local: {
                title: "LongIdentifier".repeat(15),
                content: "Keep the local copy.",
                category: "decision",
              },
              current: {
                version_id: "version-2",
                version: 2,
                title: "Current decision",
                content: "Keep the current copy.",
              },
            },
          ],
        },
      }),
    );
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ["promotions", "conflicts"]) {
        await page.goto(`/ui/${route}`);
        await expect(
          page.getByTestId(
            route === "promotions" ? "promotion-row" : "conflict-card",
          ),
        ).toBeVisible();
        const main = page.locator('main[data-pane="detail"]');
        const size = await main.evaluate((el) => ({
          client: el.clientWidth,
          scroll: el.scrollWidth,
        }));
        expect
          .soft(size.scroll, `${route} at ${width}px`)
          .toBeLessThanOrEqual(size.client + 1);
        await page.screenshot({
          path: testInfo.outputPath(`${route}-${theme}-${width}.png`),
          fullPage: true,
        });
      }
    }
  });
}

async function expectMobileAction(action: Locator, width: number) {
  await expect(action).toBeVisible();
  await action.scrollIntoViewIfNeeded();
  const box = (await action.boundingBox())!;
  expect.soft(box.height, await action.innerText()).toBeGreaterThanOrEqual(44);
  expect.soft(box.width, await action.innerText()).toBeGreaterThanOrEqual(44);
  expect.soft(box.x).toBeGreaterThanOrEqual(0);
  expect.soft(box.x + box.width).toBeLessThanOrEqual(width);
  await expect(action).toBeInViewport();
}

for (const width of [320, 390]) {
  test(`new team and sharing actions have mobile targets at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.setViewportSize({ width, height: 480 });
    await installSignedInTeamRoutes(page);
    await page.goto("/ui/team");
    const invite = page.getByRole("button", {
      name: "Invite teammate",
      exact: true,
    });
    await expectMobileAction(invite, width);
    await invite.click();
    await expect(page).toHaveURL(/section=invitations/);
    const project = await projectByName(page, "lore");
    await page.route(`**/api/v1/projects/${project.id}/sharing`, (route) =>
      route.fulfill({
        json: {
          linked: true,
          team: { id: "team-1", name: "Acme e2e" },
          policy: {
            effective: "manual",
            project_override: "manual",
            team_default: "auto",
          },
          auto_share: false,
          review_required: false,
          state: "linked",
          detail: null,
        },
      }),
    );
    await page.goto(`/ui/projects/${project.id}`);
    const manage = page.getByRole("button", {
      name: "Manage sharing",
      exact: true,
    });
    await expectMobileAction(manage, width);
    await manage.click();
    const hide = page.getByRole("button", {
      name: "Hide sharing settings",
      exact: true,
    });
    await expectMobileAction(hide, width);
    await hide.click();
    await expect(manage).toHaveAttribute("aria-expanded", "false");
  });

  test(`new recovery actions have mobile targets at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.setViewportSize({ width, height: 480 });
    const project = await projectByName(page, "lore");
    for (const suffix of ["knowledge", "sessions"]) {
      await page.route(
        `**/api/v1/projects/${project.id}/${suffix}?*`,
        (route) =>
          route.fulfill({
            status: 503,
            json: { error: "temporarily unavailable" },
          }),
      );
    }
    await page.goto(`/ui/projects/${project.id}`);
    for (const label of ["Retry knowledge", "Retry sessions"]) {
      await expectMobileAction(
        page.getByRole("button", { name: label, exact: true }),
        width,
      );
    }
    await page.route("**/api/v1/entities?*", (route) =>
      route.fulfill({ json: { entities: [], next_cursor: null, total: 0 } }),
    );
    await page.goto("/ui/entities?type=person");
    const clearEntities = page.getByRole("button", {
      name: "Clear entity filter",
      exact: true,
    });
    await expectMobileAction(clearEntities, width);
    await clearEntities.click();
    await expect(page).toHaveURL(/\/ui\/entities$/);
    await page.unroute(`**/api/v1/projects/${project.id}/sessions?*`);
    await page.route(`**/api/v1/projects/${project.id}/sessions?*`, (route) =>
      route.fulfill({ json: { items: [], next_cursor: null } }),
    );
    await page.goto(
      `/ui/projects/${project.id}/sessions/e2e-reader?a=example&q=missing&cursor=old`,
    );
    const toggle = page.getByTestId("context-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    const clearSessions = page.getByRole("button", {
      name: "Clear filter",
      exact: true,
    });
    await expectMobileAction(clearSessions, width);
    await clearSessions.click();
    await expect(page).toHaveURL(
      new RegExp(`/sessions/e2e-reader\\?a=example$`),
    );
    await page.goto(`/ui/projects/${project.id}/search`);
    await expectMobileAction(
      page.getByRole("link", { name: "Browse project knowledge", exact: true }),
      width,
    );
    await page.route("**/api/v1/recall?*", (route) =>
      route.fulfill({
        json: {
          query: "missing",
          scope: "all",
          projectPath: "/tmp/lore",
          result: "No results found for this query.",
        },
      }),
    );
    await page.goto(`/ui/projects/${project.id}/search?q=missing`);
    await expectMobileAction(
      page.getByRole("link", { name: "Browse project knowledge", exact: true }),
      width,
    );
  });
}

for (const width of [1280, 320, 390]) {
  test(`empty review recovery is separated and reachable at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.setViewportSize({ width, height: 480 });
    await installSignedInTeamRoutes(page);
    await page.route("**/api/v1/promotions?*", (route) =>
      route.fulfill({ json: { remote: "ok", requests: [], complete: true } }),
    );
    await page.route("**/api/v1/sync/conflicts", (route) =>
      route.fulfill({
        json: { available: true, complete: true, conflicts: [] },
      }),
    );
    await page.route("**/api/v1/contradictions", (route) =>
      route.fulfill({ json: { contradictions: [], total: 0 } }),
    );
    for (const [path, sentence] of [
      ["promotions", "No proposals match the selected team and status."],
      [
        "conflicts",
        "No replaced local versions are available in this view. Versions recorded by local sync appear here for review.",
      ],
      [
        "contradictions",
        "New pairs appear here only after the gateway has recorded a likely conflict for you to review.",
      ],
    ]) {
      await page.goto(`/ui/${path}`);
      const action = page.getByRole("link", {
        name: "Browse knowledge",
        exact: true,
      });
      const prose = page.getByText(sentence!, { exact: true });
      await expect(prose).toBeVisible();
      const actionBox = (await action.boundingBox())!;
      const proseBox = (await prose.boundingBox())!;
      expect
        .soft(actionBox.y)
        .toBeGreaterThanOrEqual(proseBox.y + proseBox.height + 8);
      if (width < 768) await expectMobileAction(action, width);
      await expect(action).toHaveAttribute("href", "/ui/knowledge");
    }
    await page.route("**/api/v1/teams", (route) =>
      route.fulfill({ json: { hosted: false, teams: [] } }),
    );
    await page.goto("/ui/promotions");
    const action = page.getByRole("link", {
      name: "Open team settings",
      exact: true,
    });
    const prose = page.getByText(
      "Join a team before reviewing proposal requests.",
      { exact: true },
    );
    await expect(prose).toBeVisible();
    expect
      .soft((await action.boundingBox())!.y)
      .toBeGreaterThanOrEqual(
        (await prose.boundingBox())!.y +
          (await prose.boundingBox())!.height +
          8,
      );
    if (width < 768) await expectMobileAction(action, width);
    await action.click();
    await expect(page).toHaveURL(/\/ui\/team\?section=settings$/);
  });
}

for (const width of [1280, 390, 320]) {
  test(`responsive team table retains column semantics at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium");
    await page.setViewportSize({ width, height: 480 });
    await installSignedInTeamRoutes(page);
    await page.goto("/ui/team");
    const table = page.getByTestId("team-members");
    await expect(table).toHaveRole("table");
    const headers = ["Member", "Role", "Actions"];
    for (const label of headers) {
      // Browser role queries exclude hidden headers; responsive styling must
      // retain all three accessible column names.
      await expect(
        table.getByRole("columnheader", { name: label, exact: true }),
      ).toHaveCount(1);
    }
    await expect(table.getByRole("rowgroup")).toHaveCount(2);
    await expect(table.getByRole("row")).toHaveCount(3);
    for (const row of await table.getByTestId("team-member-row").all()) {
      await expect(row).toHaveRole("row");
      const cells = row.getByRole("cell");
      await expect(cells).toHaveCount(3);
      for (const [index, label] of headers.entries()) {
        const header = table.getByRole("columnheader", {
          name: label,
          exact: true,
        });
        const id = await header.getAttribute("id");
        expect(id).toBeTruthy();
        await expect(cells.nth(index)).toHaveAttribute("headers", id!);
        await expect(header).toHaveAttribute("scope", "col");
      }
    }
    await expect(
      table.getByRole("combobox", { name: "Role for Admin", exact: true }),
    ).toHaveValue("admin");
    await expect(
      table.getByRole("combobox", {
        name: "Role for Former member",
        exact: true,
      }),
    ).toHaveValue("viewer");
    // Both roles and actions remain reachable in the same DOM and handlers.
    await expect(
      table.getByRole("button", { name: "Leave team", exact: true }),
    ).toBeVisible();
    const remove = table.getByRole("button", { name: "Remove", exact: true });
    await expect(remove).toBeVisible();
    if (width < 768) {
      await expectMobileAction(remove, width);
      await expectMobileAction(
        table.getByRole("combobox", {
          name: "Role for Former member",
          exact: true,
        }),
        width,
      );
    }
    await remove.click();
    await expect(page.getByTestId("team-remove-confirmation")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(3);
  });
}
