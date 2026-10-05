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
          "Knowledge entry changed",
          409,
          "stale_version",
        );
      },
    });
    renderPanel(client);

    await screen.findByRole("button", { name: "Preview team share" });
    fireEvent.click(screen.getByRole("button", { name: "Preview team share" }));
    fireEvent.click(await screen.findByRole("button", { name: "Propose" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Knowledge entry changed",
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

  it("shows and reloads a preview that cannot reach Lore cloud", async () => {
    const getPromotionPreview = vi
      .fn<ApiClient["getPromotionPreview"]>()
      .mockResolvedValueOnce(
        preview({
          eligibility: { promotable: false, reason: "remote_unavailable" },
        }),
      )
      .mockResolvedValue(preview());
    renderPanel(clientWith({ getPromotionPreview }));

    expect(
      await screen.findByText(
        "Lore cloud could not be reached. Try again later.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    await screen.findByRole("button", { name: "Preview team share" });
    expect(getPromotionPreview).toHaveBeenCalledTimes(2);
  });

  it("labels missing request identities as former members", async () => {
    renderPanel(
      clientWith({
        getPromotionPreview: async () =>
          preview({
            pending_request: request({
              proposer: { id: "user-editor", label: null },
              status: "approved",
              decided_by: { id: "user-admin", label: null },
            }),
          }),
      }),
    );

    const identities = await screen.findAllByText("Former member");
    expect(identities).toHaveLength(2);
    for (const identity of identities)
      expect(identity).not.toHaveAttribute("title");
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
  it("allows an admin to decide their own pending request", async () => {
    renderPage(
      clientWith({
        listPromotions: async () =>
          listResponse([
            request({
              mine: true,
              can_decide: true,
              decide_blocked_reason: null,
            }),
          ]),
      }),
    );

    expect(await screen.findByTestId("promotion-approve")).toBeEnabled();
    expect(screen.getByTestId("promotion-reject")).toBeEnabled();
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

  it("requests the signed-out remote state without a team filter", async () => {
    const listPromotions = vi
      .fn<ApiClient["listPromotions"]>()
      .mockResolvedValue({
        ...listResponse([]),
        remote: "anonymous",
      });
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
    expect(listPromotions).toHaveBeenCalledWith(null, "pending");
  });

  it("shows hosted state from the signed-out promotions response", async () => {
    renderPage(
      clientWith({
        getAccount: async () => ({
          signed_in: false,
          user: null,
          provider: null,
          expires_at: null,
          state: "anonymous",
        }),
        listPromotions: async () => ({
          ...listResponse([]),
          remote: "hosted",
        }),
      }),
    );

    expect(
      await screen.findByText(
        "Team promotion review is not available in hosted mode.",
      ),
    ).toBeInTheDocument();
  });

  it("maps unreachable list errors to the unreachable state", async () => {
    const unreachable = clientWith({
      listPromotions: async () => {
        throw new ApiError("unreachable", "/promotions", "service unavailable");
      },
    });
    renderPage(unreachable);
    expect(
      await screen.findByText(
        "The gateway or promotion service could not be reached.",
      ),
    ).toBeInTheDocument();
  });

  it("maps forbidden list errors to the hosted state", async () => {
    const forbidden = clientWith({
      listPromotions: async () => {
        throw new ApiError("forbidden", "/promotions", "hosted gateway");
      },
    });
    renderPage(forbidden);
    expect(
      await screen.findByText(
        "Team promotion review is not available in hosted mode.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a retryable error instead of anonymous when startup fails", async () => {
    let retry = false;
    const getAccount = vi.fn<ApiClient["getAccount"]>(async () => {
      if (!retry) throw new Error("Account lookup failed");
      return account;
    });
    renderPage(clientWith({ getAccount }));

    expect(await screen.findByTestId("promotions-retry")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Account lookup failed",
    );
    retry = true;
    fireEvent.click(screen.getByTestId("promotions-retry"));
    expect(await screen.findByTestId("promotion-row")).toBeInTheDocument();
    expect(getAccount).toHaveBeenCalled();
  });

  it("shows a retryable error for HTTP failures loading the list", async () => {
    const listPromotions = vi
      .fn<ApiClient["listPromotions"]>()
      .mockRejectedValueOnce(
        new ApiError("http", "/promotions", "Request failed", 500),
      )
      .mockResolvedValue(listResponse());
    renderPage(clientWith({ listPromotions }));

    expect(await screen.findByTestId("promotions-retry")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Request failed");
    fireEvent.click(screen.getByTestId("promotions-retry"));
    expect(await screen.findByTestId("promotion-row")).toBeInTheDocument();
    expect(listPromotions).toHaveBeenCalledTimes(2);
  });

  it("labels missing review identities as former members", async () => {
    renderPage(
      clientWith({
        listPromotions: async () =>
          listResponse([
            request({
              proposer: { id: "user-editor", label: null },
            }),
          ]),
      }),
    );

    const proposer = await screen.findByText("Former member");
    expect(proposer).not.toHaveAttribute("title");
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
