import { MemoryRouter, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { createAppRoot, routes } from "~/app";
import type { AccountStatus, SyncStatus, TeamList } from "~/contracts";
import { ApiError, type ApiClient } from "~/lib/api";

const ANONYMOUS: AccountStatus = {
  signed_in: false,
  user: null,
  provider: null,
  expires_at: null,
  state: "anonymous",
};

const IDLE: SyncStatus = {
  enabled: true,
  state: "idle",
  pending_changes: 2,
};

const NO_TEAMS: TeamList = { teams: [] };

type ClientOverrides = Partial<ApiClient>;

function client(overrides: ClientOverrides = {}): ApiClient {
  return {
    async listProjects() {
      return [];
    },
    async getAccount() {
      return ANONYMOUS;
    },
    async getSyncStatus() {
      return IDLE;
    },
    async getTeams() {
      return NO_TEAMS;
    },
    ...overrides,
  } as ApiClient;
}

function mount(apiClient: ApiClient) {
  const history = createMemoryHistory();
  history.set({ value: "/" });
  return render(() => (
    <MemoryRouter
      history={history}
      root={createAppRoot(apiClient, Promise.resolve(null))}
    >
      {routes}
    </MemoryRouter>
  ));
}

describe("Folk shell status", () => {
  it("shows anonymous status and lazily loads teams when opened", async () => {
    mount(client());

    const badge = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(badge).toHaveAttribute("data-folk-state", "anonymous"),
    );
    expect(badge.getAttribute("aria-label")).toContain("Not signed in");
    fireEvent.click(badge);

    expect(await screen.findByTestId("folk-status-panel")).toBeInTheDocument();
    expect(screen.getByTestId("folk-status-detail")).toHaveTextContent(
      "lore login",
    );
    expect(
      await screen.findByText("No team memberships are known on this device."),
    ).toBeInTheDocument();
  });

  it("shows account identity, provider and team membership", async () => {
    const account: AccountStatus = {
      signed_in: true,
      user: {
        id: "user-1",
        email: "person@example.com",
        display_name: "Ada Lovelace",
      },
      provider: "github",
      expires_at: null,
      state: "signed_in",
    };
    mount(
      client({
        async getAccount() {
          return account;
        },
        async getTeams() {
          return {
            teams: [
              {
                id: "team-acme",
                name: "Acme",
                role: "editor",
                member_count: 2,
              },
            ],
          };
        },
      }),
    );

    const badge = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(badge).toHaveAttribute("data-folk-state", "sync_on"),
    );
    fireEvent.click(badge);

    expect(await screen.findByTestId("folk-account")).toHaveTextContent(
      "Ada Lovelace",
    );
    expect(screen.getByTestId("folk-status-panel")).toHaveTextContent(
      "via github",
    );
    expect(await screen.findByTestId("folk-teams")).toHaveTextContent(
      "editor · 2 members",
    );
  });

  it("shows expired accounts", async () => {
    mount(
      client({
        async getAccount() {
          return { ...ANONYMOUS, state: "expired" };
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("folk-status")).toHaveAttribute(
        "data-folk-state",
        "expired",
      ),
    );
  });

  it.each([
    ["offline", "unreachable"],
    ["hidden", "unauthorized"],
  ] as const)("maps a %s account failure", async (state, errorKind) => {
    mount(
      client({
        async getAccount() {
          throw new ApiError(
            errorKind,
            "/api/v1/account",
            "status unavailable",
          );
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("folk-status")).toHaveAttribute(
        "data-folk-state",
        state,
      ),
    );
  });

  it("renders checking immediately while the account request is pending", () => {
    mount(
      client({
        getAccount() {
          return new Promise<AccountStatus>(() => {});
        },
      }),
    );

    expect(screen.getByTestId("folk-status")).toHaveAttribute(
      "data-folk-state",
      "checking",
    );
  });

  it("re-reads account status when the panel opens", async () => {
    let accountCalls = 0;
    mount(
      client({
        async getAccount() {
          accountCalls++;
          return ANONYMOUS;
        },
      }),
    );

    const badge = await screen.findByTestId("folk-status");
    await waitFor(() => expect(accountCalls).toBe(1));
    fireEvent.click(badge);
    await waitFor(() => expect(accountCalls).toBeGreaterThan(1));
  });

  it("does not change connection status when an account read fails generically", async () => {
    mount(
      client({
        async getAccount() {
          throw new Error("account endpoint unavailable");
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("connection-status")).toHaveAttribute(
        "data-connection",
        "reachable",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("folk-status")).toHaveAttribute(
        "data-folk-state",
        "unavailable",
      ),
    );
    expect(screen.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );
  });
});
