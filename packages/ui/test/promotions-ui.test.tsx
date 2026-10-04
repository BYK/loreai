import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import type {
  AccountStatus,
  PromotionListResponse,
  PromotionPreview,
  PromotionRequest,
  TeamList,
} from "~/contracts";
import { PromotionPanel } from "~/components/lore/PromotionPanel";
import { PromotionsPage } from "~/components/lore/PromotionsPage";
import { ApiError, type ApiClient } from "~/lib/api";
import { WorkspaceProvider } from "~/routes/workspace";

const account: AccountStatus = {
  signed_in: true,
  user: {
    id: "user-admin",
    email: null,
    display_name: "Admin",
  },
  provider: "github",
  expires_at: null,
  state: "signed_in",
};

const teams: TeamList = {
  teams: [{ id: "team-1", name: "Acme", role: "admin", member_count: 3 }],
};

function request(overrides: Partial<PromotionRequest> = {}): PromotionRequest {
  return {
    id: "request-1",
    team: { id: "team-1", name: "Acme" },
    logical_id: "knowledge-1",
    entry_version_id: "version-1",
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
    ...overrides,
  };
}

function preview(overrides: Partial<PromotionPreview> = {}): PromotionPreview {
  return {
    entry: {
      id: "knowledge-1",
      version_id: "version-1",
      version: 1,
      title: "Keep the local-first store",
      content: "Use SQLite as the only store.",
      category: "decision",
      project_id: "project-1",
      sensitivity: "normal",
      approval_status: "pending",
    },
    team: { id: "team-1", name: "Acme" },
    policy: {
      effective: "manual",
      project_override: null,
      team_default: "manual",
    },
    eligibility: { promotable: true, reason: null },
    previous_team_version: null,
    pending_request: null,
    remote: "ok",
    ...overrides,
  };
}

function listResponse(
  requests: PromotionRequest[] = [request()],
): PromotionListResponse {
  return { remote: "ok", requests, complete: true };
}

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return {
    listProjects: async () => [],
    getAccount: async () => account,
    getTeams: async () => teams,
    getProjectSharing: async () => ({
      linked: false,
      team: null,
      policy: {
        effective: "manual",
        project_override: null,
        team_default: null,
      },
      state: "not_linked",
      detail: null,
    }),
    getPromotionPreview: async () => preview(),
    promoteKnowledge: async () => ({ request: request({ mine: true }) }),
    listPromotions: async () => listResponse(),
    decidePromotion: async () => ({ request: request({ status: "approved" }) }),
    withdrawPromotion: async () => ({
      request: request({ status: "withdrawn" }),
    }),
    ...partial,
  } as unknown as ApiClient;
}

function renderPanel(client: ApiClient) {
  return render(() => (
    <PromotionPanel knowledgeId="knowledge-1" client={client} />
  ));
}

function renderPage(client: ApiClient) {
  return render(() => (
    <WorkspaceProvider client={client} db={Promise.resolve(null)}>
      <PromotionsPage />
    </WorkspaceProvider>
  ));
}

describe("PromotionPanel", () => {
  it("waits for the promotion receipt before showing the proposed status", async () => {
    let resolve: ((value: { request: PromotionRequest }) => void) | undefined;
    const client = clientWith({
      promoteKnowledge: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    renderPanel(client);

    await screen.findByRole("button", { name: "Preview team share" });
    fireEvent.click(screen.getByRole("button", { name: "Preview team share" }));
    const dialog = await screen.findByTestId("promotion-preview-dialog");
    expect(dialog).toHaveTextContent("Use SQLite as the only store.");
    expect(dialog).toHaveTextContent(
      "Approving makes this visible to every member of Acme after your Lore syncs. A team admin other than you must approve.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Propose" }));
    expect(
      screen.getByRole("button", { name: "Sending…" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Proposed · waiting for review"),
    ).not.toBeInTheDocument();

    resolve?.({ request: request({ mine: true }) });
    expect(
      await screen.findByText("Proposed · waiting for review"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("promotion-request-status")).toHaveTextContent(
      "request-1",
    );
  });

  it("shows errors without success wording and offers a reload for stale previews", async () => {
    const client = clientWith({
      promoteKnowledge: async () => {
        throw new ApiError(
          "http",
          "/knowledge/knowledge-1/promote",
          "Knowledge entry changed; reload the preview",
          409,
        );
      },
    });
    renderPanel(client);

    await screen.findByRole("button", { name: "Preview team share" });
    fireEvent.click(screen.getByRole("button", { name: "Preview team share" }));
    fireEvent.click(await screen.findByRole("button", { name: "Propose" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Knowledge entry changed; reload the preview",
    );
    expect(
      screen.getAllByRole("button", { name: "Reload preview" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Proposed · waiting/)).not.toBeInTheDocument();
  });

  it("explains account eligibility in plain language", async () => {
    const client = clientWith({
      getPromotionPreview: async () =>
        preview({
          eligibility: { promotable: false, reason: "account_required" },
        }),
    });
    renderPanel(client);

    expect(
      await screen.findByText("Sign in with `lore login` to propose."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("promotion-propose")).toBeDisabled();
  });

  it("explains when team encryption is locked", async () => {
    const client = clientWith({
      getPromotionPreview: async () =>
        preview({
          eligibility: { promotable: false, reason: "encryption_locked" },
        }),
    });
    renderPanel(client);

    expect(
      await screen.findByText(
        "Unlock team encryption with `lore sync enable`.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("promotion-propose")).toBeDisabled();
  });

  it("shows the previous approved team version beside the new preview", async () => {
    renderPanel(
      clientWith({
        getPromotionPreview: async () =>
          preview({
            previous_team_version: {
              version_id: "version-0",
              version: 1,
              title: "Previous title",
              content: "Previous content",
            },
          }),
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Preview team share" }),
    );
    const previous = await screen.findByTestId("previous-team-version");
    expect(previous).toHaveTextContent("Previous team version · v1");
    expect(previous).toHaveTextContent("Previous content");
    expect(screen.getByTestId("promotion-preview-content")).toHaveTextContent(
      "Use SQLite as the only store.",
    );
  });
});

describe("PromotionsPage", () => {
  it("shows a visible disabled reason for a proposer's own request", async () => {
    renderPage(
      clientWith({
        listPromotions: async () =>
          listResponse([
            request({
              mine: true,
              can_decide: false,
              decide_blocked_reason: "own_proposal",
            }),
          ]),
      }),
    );

    expect(
      await screen.findByText("You proposed this; another admin must review."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("promotion-approve")).toBeDisabled();
    expect(screen.getByTestId("promotion-reject")).toBeDisabled();
  });

  it("shows the not-admin reason and sealed-content guidance", async () => {
    renderPage(
      clientWith({
        listPromotions: async () =>
          listResponse([
            request({
              title: null,
              content: null,
              sealed: true,
              can_decide: false,
              decide_blocked_reason: "not_admin",
            }),
          ]),
      }),
    );

    expect(
      await screen.findByText("Only team admins can review."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("promotions-sealed")).toHaveTextContent(
      "Encrypted, unlock with `lore sync enable`",
    );
    expect(screen.getByTestId("promotion-row")).toHaveTextContent(
      "Encrypted request",
    );
  });

  it("shows a notice when the server truncates the newest requests", async () => {
    renderPage(
      clientWith({
        listPromotions: async () => ({
          ...listResponse(),
          complete: false,
        }),
      }),
    );

    expect(await screen.findByTestId("promotions-truncated")).toHaveTextContent(
      "Showing the newest 100 promotion requests.",
    );
  });

  it("shows the sign-in unavailable state without trying to list requests", async () => {
    const listPromotions = vi.fn<ApiClient["listPromotions"]>();
    renderPage(
      clientWith({
        getAccount: async () => ({
          ...account,
          signed_in: false,
          user: null,
          state: "anonymous",
        }),
        listPromotions,
      }),
    );

    expect(
      await screen.findByTestId("promotions-unavailable"),
    ).toHaveTextContent("Sign in with `lore login`");
    expect(listPromotions).not.toHaveBeenCalled();
  });

  it("distinguishes hosted mode for signed-out users", async () => {
    renderPage(
      clientWith({
        listProjects: async () => [
          {
            id: "project-1",
            path: "/scratch",
            name: "scratch",
            git_remote: null,
            created_at: 1,
            knowledge_count: 0,
            session_count: 0,
            message_count: 0,
            distillation_count: 0,
            last_activity: null,
          },
        ],
        getAccount: async () => ({
          signed_in: false,
          user: null,
          provider: null,
          expires_at: null,
          state: "anonymous",
        }),
        getProjectSharing: async () => ({
          linked: false,
          team: null,
          policy: {
            effective: "manual",
            project_override: null,
            team_default: null,
          },
          state: "not_linked",
          detail: "Folk Lore is unavailable in hosted/remote gateway mode",
        }),
      }),
    );

    expect(
      await screen.findByText(
        "Team promotion review is not available in hosted mode.",
      ),
    ).toBeInTheDocument();
  });

  it("confirms team impact and updates a row only from the server receipt", async () => {
    let resolve: ((value: { request: PromotionRequest }) => void) | undefined;
    renderPage(
      clientWith({
        decidePromotion: () =>
          new Promise((done) => {
            resolve = done;
          }),
      }),
    );

    const approve = await screen.findByTestId("promotion-approve");
    fireEvent.click(approve);
    expect(
      await screen.findByTestId("promotion-decision-dialog"),
    ).toHaveTextContent("visible to every member of Acme");
    fireEvent.click(screen.getByTestId("promotion-confirm-decision"));
    expect(screen.getByTestId("promotion-row")).toHaveTextContent("Pending");
    resolve?.({
      request: request({
        status: "approved",
        decided_by: { id: "user-admin", label: "Admin" },
        decided_at: "2026-09-20T12:01:00.000Z",
        can_decide: false,
        decide_blocked_reason: "decided",
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("promotion-row")).toHaveTextContent(
        "Approved, applying on next sync",
      ),
    );
  });
});
