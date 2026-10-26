import { MemoryRouter, createMemoryHistory } from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

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

const NO_TEAMS: TeamList = { hosted: false, teams: [] };

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
  it("does not ask for a gateway token when management access is denied", async () => {
    sessionStorage.clear();
    const listProjects = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          "unauthorized",
          "/api/v1/projects",
          "Gateway hid this route from the current peer",
          404,
        ),
      );
    mount(client({ listProjects }));

    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(screen.queryByLabelText("Gateway token")).not.toBeInTheDocument();
  });

  it("keeps anonymous status compact without empty team or sync sections", async () => {
    mount(client());

    const badge = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(badge).toHaveAttribute("data-folk-state", "anonymous"),
    );
    expect(badge.getAttribute("aria-label")).toContain("Not signed in");
    expect(screen.queryByText("You", { exact: true })).not.toBeInTheDocument();
    fireEvent.click(badge);

    expect(await screen.findByTestId("folk-status-panel")).toBeInTheDocument();
    expect(screen.getByTestId("folk-status-detail")).toHaveTextContent(
      "Sign in to continue",
    );
    expect(screen.queryByTestId("folk-teams")).toBeNull();
    expect(screen.queryByText("Teams", { exact: true })).toBeNull();
    expect(screen.queryByTestId("sync-now")).toBeNull();
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
            hosted: false,
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
    expect(screen.getByTestId("account-avatar")).toHaveTextContent("AL");
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

  it("runs a guarded sync from the status popover and shows its receipt", async () => {
    const runSync = vi.fn(async () => ({
      pushed: 2,
      pulled: 3,
      conflicts: 0,
      skipped: 1,
    }));
    mount(
      client({
        async getAccount() {
          return {
            signed_in: true,
            user: { id: "user-1", email: null, display_name: "Ada" },
            provider: "github",
            expires_at: null,
            state: "signed_in",
          };
        },
        async getSyncStatus() {
          return IDLE;
        },
        runSync,
      }),
    );

    fireEvent.click(await screen.findByTestId("folk-status"));
    fireEvent.click(await screen.findByTestId("sync-now"));
    expect(
      await screen.findByText(
        "Sync needs attention: pushed 2, pulled 3. 1 change skipped.",
        {
          exact: true,
        },
      ),
    ).toBeInTheDocument();
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it("keeps Sync now errors visible inside the status popover", async () => {
    mount(
      client({
        async getAccount() {
          return {
            signed_in: true,
            user: { id: "user-1", email: null, display_name: "Ada" },
            provider: null,
            expires_at: null,
            state: "signed_in",
          };
        },
        async getSyncStatus() {
          return IDLE;
        },
        async runSync() {
          throw new Error("Sync service is unavailable.");
        },
      }),
    );

    fireEvent.click(await screen.findByTestId("folk-status"));
    fireEvent.click(await screen.findByTestId("sync-now"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sync service is unavailable.",
    );
  });

  it("shows expired accounts", async () => {
    mount(
      client({
        async getAccount() {
          return {
            ...ANONYMOUS,
            state: "expired",
            user: { id: "user-1", email: null, display_name: "Ada Lovelace" },
          };
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("folk-status")).toHaveAttribute(
        "data-folk-state",
        "expired",
      ),
    );
    expect(screen.queryByText("You", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByTestId("account-avatar")).not.toBeInTheDocument();
  });

  it("explains hosted mode without pretending there is no local login", async () => {
    mount(
      client({
        async getAccount() {
          return { ...ANONYMOUS, state: "hosted" };
        },
      }),
    );
    const badge = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(badge).toHaveAttribute("data-folk-state", "hosted"),
    );
    expect(screen.queryByText("You", { exact: true })).not.toBeInTheDocument();
    fireEvent.click(badge);
    expect(await screen.findByTestId("folk-status-detail")).toHaveTextContent(
      "lore start --local",
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

  it("removes the signed-in avatar after a CLI logout when the tab regains focus", async () => {
    let account: AccountStatus = {
      ...ANONYMOUS,
      signed_in: true,
      state: "signed_in",
      user: { id: "user-1", email: null, display_name: "Ada Lovelace" },
    };
    mount(
      client({
        async getAccount() {
          return account;
        },
      }),
    );
    expect(await screen.findByTestId("account-avatar")).toHaveTextContent("AL");
    account = ANONYMOUS;
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.queryByTestId("account-avatar")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("folk-status")).toHaveAttribute(
        "data-folk-state",
        "anonymous",
      ),
    );
  });

  it("re-reads teams for a new CLI account while the panel stays open", async () => {
    let owner = "Ada";
    mount(
      client({
        async getAccount() {
          return {
            ...ANONYMOUS,
            signed_in: true,
            state: "signed_in",
            user: { id: owner, email: null, display_name: owner },
          };
        },
        async getTeams() {
          return {
            hosted: false,
            teams: [
              {
                id: `team-${owner}`,
                name: `${owner} team`,
                role: "editor",
                member_count: 1,
              },
            ],
          };
        },
      }),
    );
    fireEvent.click(await screen.findByTestId("folk-status"));
    await screen.findByText("Ada team");
    owner = "Grace";
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.getByTestId("folk-account")).toHaveTextContent("Grace"),
    );
    expect(await screen.findByText("Grace team")).toBeInTheDocument();
    expect(screen.queryByText("Ada team")).not.toBeInTheDocument();
  });

  it.each(["hosted", "expired", "refreshing", "unavailable"] as const)(
    "does not claim teams are loading for an account in %s state",
    async (state) => {
      const getTeams = vi.fn(async () => NO_TEAMS);
      mount(
        client({
          async getAccount() {
            return { ...ANONYMOUS, state };
          },
          getTeams,
        }),
      );
      const badge = await screen.findByTestId("folk-status");
      await waitFor(() =>
        expect(badge).toHaveAttribute("data-folk-state", state),
      );
      fireEvent.click(badge);
      expect(screen.queryByText("Teams unavailable.")).toBeNull();
      expect(screen.queryByText("Loading teams…")).not.toBeInTheDocument();
      expect(getTeams).not.toHaveBeenCalled();
    },
  );

  it("clears the previous account's teams after CLI logout with the panel open", async () => {
    let loggedIn = true;
    mount(
      client({
        async getAccount() {
          return loggedIn
            ? {
                ...ANONYMOUS,
                signed_in: true,
                state: "signed_in",
                user: { id: "Ada", email: null, display_name: "Ada" },
              }
            : ANONYMOUS;
        },
        async getTeams() {
          return loggedIn
            ? {
                hosted: false,
                teams: [
                  {
                    id: "team-ada",
                    name: "Ada team",
                    role: "editor",
                    member_count: 1,
                  },
                ],
              }
            : NO_TEAMS;
        },
      }),
    );
    fireEvent.click(await screen.findByTestId("folk-status"));
    await screen.findByText("Ada team");
    loggedIn = false;
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.getByTestId("folk-status")).toHaveAttribute(
        "data-folk-state",
        "anonymous",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Ada team")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("folk-teams")).toBeNull();
    expect(screen.queryByText("Teams", { exact: true })).toBeNull();
    expect(screen.queryByTestId("sync-now")).toBeNull();
  });

  it("cancels an old account's team request and ignores its late response", async () => {
    let owner = "Ada";
    let finishOld!: (teams: TeamList) => void;
    let oldSignal: AbortSignal | undefined;
    const getTeams = vi.fn((signal?: AbortSignal) => {
      if (owner === "Ada") {
        oldSignal = signal;
        return new Promise<TeamList>((resolve) => {
          finishOld = resolve;
        });
      }
      return Promise.resolve({
        hosted: false,
        teams: [
          {
            id: "team-grace",
            name: "Grace team",
            role: "editor",
            member_count: 1,
          },
        ],
      });
    });
    mount(
      client({
        async getAccount() {
          return {
            ...ANONYMOUS,
            signed_in: true,
            state: "signed_in",
            user: { id: owner, email: null, display_name: owner },
          };
        },
        getTeams,
      }),
    );
    fireEvent.click(await screen.findByTestId("folk-status"));
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    owner = "Grace";
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.getByTestId("folk-account")).toHaveTextContent("Grace"),
    );
    finishOld({
      hosted: false,
      teams: [
        { id: "team-ada", name: "Ada team", role: "editor", member_count: 1 },
      ],
    });
    expect(await screen.findByText("Grace team")).toBeInTheDocument();
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.queryByText("Ada team")).not.toBeInTheDocument();
  });

  it("hides a stale avatar when the account service stops answering", async () => {
    let offline = false;
    mount(
      client({
        async getAccount() {
          if (offline) throw new Error("account unavailable");
          return {
            ...ANONYMOUS,
            signed_in: true,
            state: "signed_in",
            user: { id: "user-1", email: null, display_name: "Ada" },
          };
        },
      }),
    );
    await screen.findByTestId("account-avatar");
    offline = true;
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.queryByTestId("account-avatar")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("folk-status")).toHaveAttribute(
        "data-folk-state",
        "unavailable",
      ),
    );
  });

  it("keeps a stale avatar hidden while an unavailable account is being retried", async () => {
    let state: "signed_in" | "offline" | "pending" = "signed_in";
    let finish!: (account: AccountStatus) => void;
    mount(
      client({
        async getAccount() {
          if (state === "offline") throw new Error("account unavailable");
          if (state === "pending")
            return new Promise<AccountStatus>((resolve) => {
              finish = resolve;
            });
          return {
            ...ANONYMOUS,
            signed_in: true,
            state: "signed_in",
            user: { id: "user-1", email: null, display_name: "Ada" },
          };
        },
      }),
    );
    await screen.findByTestId("account-avatar");
    state = "offline";
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.queryByTestId("account-avatar")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("folk-status")).toHaveAttribute(
        "data-folk-state",
        "unavailable",
      ),
    );
    state = "pending";
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.queryByTestId("account-avatar")).not.toBeInTheDocument();
    finish(ANONYMOUS);
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

describe("rail account menu", () => {
  it("keeps the submitted email fixed while the sign-in email is being sent", async () => {
    let finish!: (value: { attempt: string }) => void;
    const send = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount(client({ startEmailLogin: send }));
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    const input = within(dialog).getByLabelText("Email address");
    fireEvent.input(input, { target: { value: "a@example.com" } });
    fireEvent.submit(
      within(dialog)
        .getByRole("button", { name: "Send sign-in email" })
        .closest("form")!,
    );
    expect(input).toBeDisabled();
    finish({ attempt: "attempt-a" });
    expect(
      await within(dialog).findByText(/Check a@example.com/),
    ).toBeVisible();
  });
  it("signs in with an emailed code and refreshes the account", async () => {
    const send = vi.fn().mockResolvedValue({ attempt: "attempt-1" });
    const verify = vi.fn().mockResolvedValue({ ok: true });
    const getAccount = vi.fn().mockResolvedValue(ANONYMOUS);
    mount(
      client({ startEmailLogin: send, verifyEmailLogin: verify, getAccount }),
    );
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.input(within(dialog).getByLabelText("Email address"), {
      target: { value: "person@example.com" },
    });
    fireEvent.submit(
      within(dialog)
        .getByRole("button", { name: "Send sign-in email" })
        .closest("form")!,
    );
    expect(
      await within(dialog).findByText(/Check person@example.com/),
    ).toBeVisible();
    expect(send).toHaveBeenCalledWith("person@example.com");
    fireEvent.input(within(dialog).getByLabelText("Code or sign-in link"), {
      target: { value: "123456" },
    });
    fireEvent.submit(
      within(dialog).getByRole("button", { name: "Sign in" }).closest("form")!,
    );
    await waitFor(() =>
      expect(verify).toHaveBeenCalledWith("attempt-1", "123456"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Sign in to Lore" }),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(getAccount.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("cancels the pending attempt when changing email", async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: true });
    mount(
      client({
        startEmailLogin: vi.fn().mockResolvedValue({ attempt: "attempt-1" }),
        cancelLogin: cancel,
      }),
    );
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.input(within(dialog).getByLabelText("Email address"), {
      target: { value: "person@example.com" },
    });
    fireEvent.submit(
      within(dialog)
        .getByRole("button", { name: "Send sign-in email" })
        .closest("form")!,
    );
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Use a different email",
      }),
    );
    expect(cancel).toHaveBeenCalledWith("attempt-1");
  });

  it("waits for cancellation before starting another email attempt", async () => {
    let finishCancel!: (result: { ok: boolean }) => void;
    const cancel = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
    );
    mount(
      client({
        startEmailLogin: vi.fn().mockResolvedValue({ attempt: "attempt-a" }),
        cancelLogin: cancel,
      }),
    );
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.input(within(dialog).getByLabelText("Email address"), {
      target: { value: "a@example.com" },
    });
    fireEvent.submit(
      within(dialog)
        .getByRole("button", { name: "Send sign-in email" })
        .closest("form")!,
    );
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Use a different email",
      }),
    );
    expect(cancel).toHaveBeenCalledWith("attempt-a");
    expect(within(dialog).queryByLabelText("Email address")).toBeNull();
    finishCancel({ ok: true });
    expect(await within(dialog).findByLabelText("Email address")).toBeVisible();
  });

  it("recovers an uncertain cancellation after confirming the account is anonymous", async () => {
    let finishAccount!: (value: typeof ANONYMOUS) => void;
    let checkingAccount = false;
    const cancel = vi.fn().mockResolvedValue({ ok: false });
    mount(
      client({
        startEmailLogin: vi.fn().mockResolvedValue({ attempt: "attempt-a" }),
        cancelLogin: cancel,
        getAccount: () =>
          checkingAccount
            ? new Promise((resolve) => {
                finishAccount = resolve;
              })
            : Promise.resolve(ANONYMOUS),
      }),
    );
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.input(within(dialog).getByLabelText("Email address"), {
      target: { value: "a@example.com" },
    });
    fireEvent.submit(
      within(dialog)
        .getByRole("button", { name: "Send sign-in email" })
        .closest("form")!,
    );
    const changeEmail = await within(dialog).findByRole("button", {
      name: "Use a different email",
    });
    checkingAccount = true;
    fireEvent.click(changeEmail);
    expect(
      await within(dialog).findByText(
        "Sign-in may already have completed. Check your account.",
      ),
    ).toBeVisible();
    expect(within(dialog).queryByLabelText("Email address")).toBeNull();
    await waitFor(() => expect(finishAccount).toBeTypeOf("function"));
    checkingAccount = false;
    finishAccount(ANONYMOUS);
    expect(await within(dialog).findByLabelText("Email address")).toBeVisible();
    expect(
      within(dialog).getByText(
        "Sign-in may already have completed. Check your account.",
      ),
    ).toBeVisible();
  });

  it("keeps the attempt when the account status cannot be confirmed", async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: false });
    let failAccount = false;
    mount(
      client({
        startEmailLogin: vi.fn().mockResolvedValue({ attempt: "attempt-a" }),
        cancelLogin: cancel,
        getAccount: () =>
          failAccount
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(ANONYMOUS),
      }),
    );
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.input(within(dialog).getByLabelText("Email address"), {
      target: { value: "a@example.com" },
    });
    fireEvent.submit(
      within(dialog)
        .getByRole("button", { name: "Send sign-in email" })
        .closest("form")!,
    );
    const changeEmail = await within(dialog).findByRole("button", {
      name: "Use a different email",
    });
    failAccount = true;
    fireEvent.click(changeEmail);
    expect(
      await within(dialog).findByText(
        "Sign-in may already have completed. Check your account.",
      ),
    ).toBeVisible();
    await waitFor(() => expect(changeEmail).not.toBeDisabled());
    expect(within(dialog).queryByLabelText("Email address")).toBeNull();
  });

  it("cancels an in-flight verification when the dialog is dismissed", async () => {
    let finishCancel!: (value: { ok: boolean }) => void;
    const cancel = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
    );
    const verify = vi.fn().mockImplementation(() => new Promise(() => {}));
    mount(
      client({
        startEmailLogin: vi.fn().mockResolvedValue({ attempt: "attempt-1" }),
        verifyEmailLogin: verify,
        cancelLogin: cancel,
      }),
    );
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.input(within(dialog).getByLabelText("Email address"), {
      target: { value: "person@example.com" },
    });
    fireEvent.submit(
      within(dialog)
        .getByRole("button", { name: "Send sign-in email" })
        .closest("form")!,
    );
    const code = await within(dialog).findByLabelText("Code or sign-in link");
    fireEvent.input(code, { target: { value: "123456" } });
    fireEvent.submit(
      within(dialog).getByRole("button", { name: "Sign in" }).closest("form")!,
    );
    await waitFor(() => expect(verify).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("attempt-1"));
    expect(
      screen.getByRole("dialog", { name: "Sign in to Lore" }),
    ).toBeVisible();
    finishCancel({ ok: true });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Sign in to Lore" }),
      ).toBeNull(),
    );
  });

  it("waits for a delayed email start to be cancelled before dismissing", async () => {
    let finishStart!: (value: { attempt: string }) => void;
    let finishCancel!: (value: { ok: boolean }) => void;
    const start = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    const cancel = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
    );
    mount(client({ startEmailLogin: start, cancelLogin: cancel }));
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.input(within(dialog).getByLabelText("Email address"), {
      target: { value: "a@example.com" },
    });
    fireEvent.submit(
      within(dialog)
        .getByRole("button", { name: "Send sign-in email" })
        .closest("form")!,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Sign in to Lore" }),
    ).toBeVisible();
    finishStart({ attempt: "attempt-a" });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("attempt-a"));
    expect(
      screen.getByRole("dialog", { name: "Sign in to Lore" }),
    ).toBeVisible();
    finishCancel({ ok: true });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Sign in to Lore" }),
      ).toBeNull(),
    );
  });

  it("cancels a delayed GitHub start before dismissing", async () => {
    let finishStart!: (value: { url: string; attempt: string }) => void;
    let finishCancel!: (value: { ok: boolean }) => void;
    const start = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    const cancel = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
    );
    mount(client({ startGitHubLogin: start, cancelLogin: cancel }));
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Continue with GitHub" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Sign in to Lore" }),
    ).toBeVisible();
    finishStart({
      url: "https://github.example/authorize",
      attempt: "github-a",
    });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("github-a"));
    expect(
      screen.getByRole("dialog", { name: "Sign in to Lore" }),
    ).toBeVisible();
    finishCancel({ ok: true });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Sign in to Lore" }),
      ).toBeNull(),
    );
  });

  it("restores and cancels GitHub sign-in after returning from authorization", async () => {
    sessionStorage.setItem("lore.github-login-attempt", "github-returned");
    const cancel = vi.fn().mockResolvedValue({ ok: true });
    mount(client({ cancelLogin: cancel }));
    await screen.findByRole("dialog", { name: "Sign in to Lore" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("github-returned"));
    expect(sessionStorage.getItem("lore.github-login-attempt")).toBeNull();
  });

  it.each(["failed", "success"])(
    "retains a live GitHub cancellation handle after an unrelated %s callback",
    async (result) => {
      const previous = window.location.href;
      window.history.replaceState(
        {},
        "",
        `/ui?login=${result}&login_attempt=old-attempt`,
      );
      sessionStorage.setItem("lore.github-login-attempt", "live-attempt");
      let finish!: (result: { ok: boolean }) => void;
      const cancel = vi.fn(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            finish = resolve;
          }),
      );
      try {
        mount(client({ cancelLogin: cancel }));
        const dialog = await screen.findByRole("dialog", {
          name: "Sign in to Lore",
        });
        expect(sessionStorage.getItem("lore.github-login-attempt")).toBe(
          "live-attempt",
        );
        fireEvent.keyDown(document, { key: "Escape" });
        await waitFor(() =>
          expect(cancel).toHaveBeenCalledWith("live-attempt"),
        );
        expect(dialog).toBeVisible();
        finish({ ok: true });
        await waitFor(() =>
          expect(
            screen.queryByRole("dialog", { name: "Sign in to Lore" }),
          ).toBeNull(),
        );
        expect(sessionStorage.getItem("lore.github-login-attempt")).toBeNull();
      } finally {
        window.history.replaceState({}, "", previous);
      }
    },
  );

  it.each(["failed", "success"])(
    "clears only the matching completed %s GitHub attempt",
    async (result) => {
      const previous = window.location.href;
      window.history.replaceState(
        {},
        "",
        `/ui?login=${result}&login_attempt=completed-attempt`,
      );
      sessionStorage.setItem("lore.github-login-attempt", "completed-attempt");
      const cancel = vi.fn().mockResolvedValue({ ok: true });
      try {
        mount(client({ cancelLogin: cancel }));
        await waitFor(() =>
          expect(
            sessionStorage.getItem("lore.github-login-attempt"),
          ).toBeNull(),
        );
        if (result === "failed") {
          await screen.findByRole("dialog", { name: "Sign in to Lore" });
          fireEvent.keyDown(document, { key: "Escape" });
          await waitFor(() =>
            expect(
              screen.queryByRole("dialog", { name: "Sign in to Lore" }),
            ).toBeNull(),
          );
        }
        expect(cancel).not.toHaveBeenCalled();
        expect(
          new URL(window.location.href).searchParams.has("login_attempt"),
        ).toBe(false);
      } finally {
        window.history.replaceState({}, "", previous);
      }
    },
  );

  it("reports when sign-in completed before dismissal", async () => {
    sessionStorage.setItem("lore.github-login-attempt", "github-returned");
    const cancel = vi.fn().mockResolvedValue({ ok: false });
    mount(client({ cancelLogin: cancel }));
    await screen.findByRole("dialog", { name: "Sign in to Lore" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      await screen.findByText(
        "Sign-in may already have completed. Check your account.",
      ),
    ).toBeVisible();
    expect(cancel).toHaveBeenCalledWith("github-returned");
  });

  it("keeps email sign-in available when reading GitHub attempt storage fails", async () => {
    const original = Storage.prototype.getItem;
    const storage = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (this: Storage, key) {
        if (key === "lore.github-login-attempt")
          throw new DOMException("blocked", "SecurityError");
        return original.call(this, key);
      });
    try {
      mount(client());
      const trigger = await screen.findByTestId("folk-status");
      await waitFor(() =>
        expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
      );
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
      expect(await screen.findByLabelText("Email address")).toBeVisible();
    } finally {
      storage.mockRestore();
    }
  });

  it("closes after successful cancellation when removing stored GitHub attempt fails", async () => {
    sessionStorage.setItem("lore.github-login-attempt", "github-returned");
    const original = Storage.prototype.removeItem;
    const storage = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key) {
        if (key === "lore.github-login-attempt")
          throw new DOMException("blocked", "SecurityError");
        return original.call(this, key);
      });
    const cancel = vi.fn().mockResolvedValue({ ok: true });
    try {
      mount(client({ cancelLogin: cancel }));
      await screen.findByRole("dialog", { name: "Sign in to Lore" });
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() =>
        expect(cancel).toHaveBeenCalledWith("github-returned"),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Sign in to Lore" }),
        ).toBeNull(),
      );
    } finally {
      storage.mockRestore();
      sessionStorage.removeItem("lore.github-login-attempt");
    }
  });

  it("explains when GitHub sign-in cannot retain its cancellation attempt", async () => {
    const original = Storage.prototype.setItem;
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "lore.github-login-attempt")
          throw new DOMException("blocked", "SecurityError");
        return original.call(this, key, value);
      });
    try {
      mount(
        client({
          startGitHubLogin: vi.fn().mockResolvedValue({
            url: "https://example.com",
            attempt: "github-a",
          }),
          cancelLogin: vi.fn().mockResolvedValue({ ok: true }),
        }),
      );
      const trigger = await screen.findByTestId("folk-status");
      await waitFor(() =>
        expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
      );
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Sign in to Lore",
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Continue with GitHub" }),
      );
      expect(
        await within(dialog).findByText(
          "GitHub sign-in requires browser session storage. Use email sign-in instead.",
        ),
      ).toBeVisible();
    } finally {
      storage.mockRestore();
    }
  });

  it.each(["email", "github"])(
    "cancels a delayed %s start after a restored GitHub attempt, including retry",
    async (kind) => {
      sessionStorage.setItem("lore.github-login-attempt", "github-old");
      let finish!: (result: { attempt: string; url: string }) => void;
      const start = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const cancel = vi
        .fn()
        .mockImplementation((id: string) =>
          id === "new-attempt" &&
          cancel.mock.calls.filter(([value]) => value === id).length === 1
            ? Promise.reject(new Error("failed"))
            : Promise.resolve({ ok: true }),
        );
      mount(
        client({
          startEmailLogin: start,
          startGitHubLogin: start,
          cancelLogin: cancel,
        }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Sign in to Lore",
      });
      if (kind === "email") {
        fireEvent.input(within(dialog).getByLabelText("Email address"), {
          target: { value: "person@example.com" },
        });
        fireEvent.submit(
          within(dialog)
            .getByRole("button", { name: "Send sign-in email" })
            .closest("form")!,
        );
      } else {
        fireEvent.click(
          within(dialog).getByRole("button", { name: "Continue with GitHub" }),
        );
      }
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
      fireEvent.keyDown(document, { key: "Escape" });
      finish({ attempt: "new-attempt", url: "https://example.com/authorize" });
      await waitFor(() => expect(cancel).toHaveBeenCalledWith("new-attempt"));
      expect(
        await within(dialog).findByText(
          "Could not cancel sign-in. Please try again.",
        ),
      ).toBeVisible();
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() =>
        expect(
          cancel.mock.calls.filter(([id]) => id === "new-attempt"),
        ).toHaveLength(2),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Sign in to Lore" }),
        ).toBeNull(),
      );
      expect(cancel).toHaveBeenCalledWith("github-old");
      expect(sessionStorage.getItem("lore.github-login-attempt")).toBeNull();
      const trigger = await screen.findByTestId("folk-status");
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
      const reopened = await screen.findByRole("dialog", {
        name: "Sign in to Lore",
      });
      expect(
        within(reopened).queryByLabelText("Code or sign-in link"),
      ).toBeNull();
    },
  );

  it.each([
    ["http://localhost:54321/auth/v1/authorize", true],
    ["http://127.0.0.1:54321/auth/v1/authorize", true],
    ["http://example.com/authorize", false],
  ])("validates GitHub authorization URL %s", async (url, allowed) => {
    const start = vi
      .fn()
      .mockResolvedValue({ url, attempt: "github-url-test" });
    mount(client({ startGitHubLogin: start }));
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Lore" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Continue with GitHub" }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    if (allowed) {
      await waitFor(() =>
        expect(sessionStorage.getItem("lore.github-login-attempt")).toBe(
          "github-url-test",
        ),
      );
      sessionStorage.removeItem("lore.github-login-attempt");
    } else {
      expect(
        await within(dialog).findByText("Could not start GitHub sign-in."),
      ).toBeVisible();
      expect(sessionStorage.getItem("lore.github-login-attempt")).toBeNull();
    }
  });

  it("keeps an anonymous avatar and preferences available without signing in", async () => {
    mount(client());
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    expect(
      screen
        .getByTestId("anonymous-avatar")
        .closest('[data-testid="icon-rail"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('header [data-testid="folk-status"]'),
    ).toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.getByTestId("theme-toggle")).toBeVisible();
    const profile = screen.getByRole("button", { name: "Sign in to Lore" });
    await waitFor(() => expect(profile).toHaveTextContent("Anonymous"));
    expect(profile).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    fireEvent.click(profile);
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    expect(
      within(dialog).getByRole("button", { name: "Continue with GitHub" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("textbox", { name: "Email address" }),
    ).toBeVisible();
  });

  it.each(["refreshing", "unavailable", "hosted"] as const)(
    "keeps %s account states read-only instead of offering sign-in",
    async (state) => {
      mount(client({ getAccount: async () => ({ ...ANONYMOUS, state }) }));
      const trigger = await screen.findByTestId("folk-status");
      await waitFor(() =>
        expect(trigger).toHaveAttribute("data-folk-state", state),
      );
      fireEvent.click(trigger);
      const panel = await screen.findByTestId("folk-status-panel");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        within(panel).queryByRole("button", { name: "Sign in to Lore" }),
      ).toBeNull();
      expect(panel).not.toHaveTextContent("Anonymous");
      expect(within(panel).getByTestId("theme-toggle")).toBeVisible();
    },
  );

  it("keeps expired accounts identifiable and offers explicit reauthentication", async () => {
    mount(
      client({ getAccount: async () => ({ ...ANONYMOUS, state: "expired" }) }),
    );
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "expired"),
    );
    fireEvent.click(trigger);
    const profile = await screen.findByRole("button", {
      name: "Sign in to Lore",
    });
    expect(profile).toHaveTextContent("Session expired");
    fireEvent.click(profile);
    expect(
      await screen.findByRole("dialog", { name: "Sign in to Lore" }),
    ).toHaveTextContent("Continue with GitHub");
  });

  it("retains confirmed identity and teams throughout healthy account reloads", async () => {
    const signedIn: AccountStatus = {
      ...ANONYMOUS,
      signed_in: true,
      state: "signed_in",
      user: { id: "ada", display_name: "Ada Lovelace", email: null },
      provider: "github",
    };
    let finish!: (account: AccountStatus) => void;
    const getAccount = vi
      .fn()
      .mockResolvedValueOnce(signedIn)
      .mockImplementation(
        () =>
          new Promise<AccountStatus>((resolve) => {
            finish = resolve;
          }),
      );
    mount(
      client({
        getAccount,
        getTeams: async () => ({
          hosted: false,
          teams: [
            {
              id: "team-ada",
              name: "Ada team",
              role: "editor",
              member_count: 1,
            },
          ],
        }),
      }),
    );
    await screen.findByTestId("account-avatar");
    fireEvent.click(screen.getByTestId("folk-status"));
    await waitFor(() => expect(getAccount).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("account-avatar")).toHaveTextContent("AL");
    expect(screen.getByTestId("folk-account")).toHaveTextContent(
      "Ada Lovelace",
    );
    expect(await screen.findByTestId("folk-teams")).toHaveTextContent(
      "Ada team",
    );
    finish(signedIn);
    await waitFor(() =>
      expect(screen.getByTestId("folk-account")).toHaveTextContent(
        "Ada Lovelace",
      ),
    );
    // Let the first reload settle before starting a second pending poll.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(getAccount).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("account-avatar")).toHaveTextContent("AL");
    expect(screen.getByTestId("folk-account")).toHaveTextContent(
      "Ada Lovelace",
    );
    expect(screen.getByTestId("folk-teams")).toHaveTextContent("Ada team");
    finish(ANONYMOUS);
    await waitFor(() =>
      expect(screen.queryByTestId("account-avatar")).toBeNull(),
    );
    expect(screen.queryByTestId("folk-teams")).toBeNull();
  });

  it("keeps cached anonymous sign-in hidden after an error and during retry", async () => {
    let state: "anonymous" | "error" | "pending" = "anonymous";
    let finish!: (account: AccountStatus) => void;
    mount(
      client({
        getAccount: async () => {
          if (state === "error") throw new Error("account unavailable");
          if (state === "pending")
            return new Promise<AccountStatus>((resolve) => {
              finish = resolve;
            });
          return ANONYMOUS;
        },
      }),
    );
    const trigger = await screen.findByTestId("folk-status");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "anonymous"),
    );
    fireEvent.click(trigger);
    await screen.findByRole("button", { name: "Sign in to Lore" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    state = "error";
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(trigger).toHaveAttribute("data-folk-state", "unavailable"),
    );
    expect(
      screen.queryByRole("button", { name: "Sign in to Lore" }),
    ).toBeNull();
    state = "pending";
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(
      screen.queryByRole("button", { name: "Sign in to Lore" }),
    ).toBeNull();
    finish(ANONYMOUS);
    expect(
      await screen.findByRole("button", { name: "Sign in to Lore" }),
    ).toBeVisible();
  });

  it("keeps the signed-in avatar in the rail with preferences", async () => {
    mount(
      client({
        getAccount: async () => ({
          ...ANONYMOUS,
          signed_in: true,
          state: "signed_in",
          user: { id: "ada", display_name: "Ada Lovelace", email: null },
        }),
      }),
    );
    const avatar = await screen.findByTestId("account-avatar");
    expect(avatar).toHaveTextContent("AL");
    expect(avatar.closest('[data-testid="folk-status"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId("folk-status"));
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.getByTestId("theme-toggle")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Sign in to Lore" }),
    ).toBeNull();
  });
});

it.each(["email", "github"] as const)(
  "retires a delayed %s start when the workspace unmounts",
  async (kind) => {
    sessionStorage.clear();
    let finish!: (value: { attempt: string; url: string }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ attempt: string; url: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const cancel = vi.fn().mockResolvedValue({ ok: true });
    const view = mount(
      client({
        startEmailLogin: start,
        startGitHubLogin: start,
        cancelLogin: cancel,
      }),
    );
    fireEvent.click(await screen.findByTestId("folk-status"));
    fireEvent.click(await screen.findByText("Sign in to Lore"));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    if (kind === "email") {
      fireEvent.input(within(dialog).getByLabelText("Email address"), {
        target: { value: "fixture@example.test" },
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Send sign-in email" }),
      );
    } else
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Continue with GitHub" }),
      );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    view.unmount();
    sessionStorage.setItem("lore.github-login-attempt", "newer-owner-attempt");
    finish({
      attempt: "retired-attempt",
      url: "https://github.com/login/oauth/authorize",
    });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("retired-attempt"));
    expect(sessionStorage.getItem("lore.github-login-attempt")).toBe(
      "newer-owner-attempt",
    );
    sessionStorage.clear();
  },
);

it("retains email input, verification and cancellation controls across a breakpoint remount", async () => {
  const media = {
    matches: true,
    addEventListener: vi.fn<(event: string, listener: () => void) => void>(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => media);
  let finish!: (value: { ok: boolean }) => void;
  const verify = vi.fn(
    () =>
      new Promise<{ ok: boolean }>((resolve) => {
        finish = resolve;
      }),
  );
  const cancel = vi.fn().mockResolvedValue({ ok: true });
  try {
    mount(
      client({
        startEmailLogin: vi
          .fn()
          .mockResolvedValue({ attempt: "email-attempt" }),
        verifyEmailLogin: verify,
        cancelLogin: cancel,
      }),
    );
    fireEvent.click(await screen.findByTestId("folk-status"));
    fireEvent.click(await screen.findByText("Sign in to Lore"));
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in to Lore",
    });
    fireEvent.input(within(dialog).getByLabelText("Email address"), {
      target: { value: "fixture@example.test" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send sign-in email" }),
    );
    fireEvent.input(await screen.findByLabelText("Code or sign-in link"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(verify).toHaveBeenCalledWith("email-attempt", "123456"),
    );
    media.matches = false;
    for (const [, listener] of media.addEventListener.mock.calls) listener();
    expect(await screen.findByTestId("mobile-menu-trigger")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(dialog).toBeVisible();
    expect(await screen.findByLabelText("Code or sign-in link")).toHaveValue(
      "123456",
    );
    fireEvent.keyDown(screen.getByLabelText("Code or sign-in link"), {
      key: "Escape",
    });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("email-attempt"));
    finish({ ok: true });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("retains a confirmed account through drawer remounts during a healthy poll", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const account: AccountStatus = {
    ...ANONYMOUS,
    signed_in: true,
    state: "signed_in",
    user: { id: "ada", display_name: "Ada Lovelace", email: null },
  };
  let finish!: (account: AccountStatus) => void;
  const getAccount = vi
    .fn()
    .mockResolvedValueOnce(account)
    .mockImplementation(
      () =>
        new Promise<AccountStatus>((resolve) => {
          finish = resolve;
        }),
    );
  try {
    mount(client({ getAccount }));
    fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
    await screen.findByTestId("account-avatar");
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(getAccount).toHaveBeenCalledTimes(2));
    const drawer = screen.getByRole("dialog", { name: /^Navigation$/ });
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByTestId("nav-drawer")).toBeNull());
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(await screen.findByTestId("account-avatar")).toHaveTextContent("AL");
    expect(screen.getByTestId("folk-status")).toHaveTextContent("Ada Lovelace");
    finish(ANONYMOUS);
    await waitFor(() =>
      expect(screen.queryByTestId("account-avatar")).toBeNull(),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("retains a pending sync and its receipt across mobile drawer remounts", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  let finish!: (result: Awaited<ReturnType<ApiClient["runSync"]>>) => void;
  const runSync = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<ApiClient["runSync"]>>>((resolve) => {
        finish = resolve;
      }),
  );
  mount(
    client({
      getAccount: async () => ({
        ...ANONYMOUS,
        signed_in: true,
        state: "signed_in",
        user: { id: "user-1", email: null, display_name: "Ada" },
      }),
      runSync,
    }),
  );
  const open = async () => {
    fireEvent.click(await screen.findByTestId("mobile-menu-trigger"));
    fireEvent.click(await screen.findByTestId("folk-status"));
    return screen.findByTestId("sync-now");
  };
  fireEvent.click(await open());
  expect(runSync).toHaveBeenCalledTimes(1);
  const drawer = screen.getByRole("dialog", { name: /^Navigation$/ });
  // Close the nested layer first, then the drawer, as a user does.
  fireEvent.keyDown(screen.getByTestId("sync-now"), { key: "Escape" });
  fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByTestId("nav-drawer")).toBeNull());
  expect(await open()).toBeDisabled();
  fireEvent.click(screen.getByTestId("sync-now"));
  expect(runSync).toHaveBeenCalledTimes(1);
  finish({ pushed: 2, pulled: 3, conflicts: 0, skipped: 0 });
  expect(
    await screen.findByText("Sync complete: pushed 2, pulled 3."),
  ).toBeVisible();
  vi.unstubAllGlobals();
});

it("does not describe a quota-paused sync as complete", async () => {
  mount(
    client({
      getAccount: async () => ({
        signed_in: true,
        user: { id: "user-1", email: null, display_name: "Ada" },
        provider: "github",
        expires_at: null,
        state: "signed_in",
      }),
      getSyncStatus: async () => IDLE,
      runSync: async () => ({
        pushed: 0,
        pulled: 2,
        conflicts: 1,
        skipped: 3,
        quotaHit: { table: "knowledge", message: "Quota reached" },
      }),
    }),
  );
  fireEvent.click(await screen.findByTestId("folk-status"));
  fireEvent.click(await screen.findByTestId("sync-now"));
  expect(
    await screen.findByText(/Uploads paused by your sync quota/),
  ).toHaveTextContent("1 conflict needs review");
  expect(screen.queryByText(/Sync complete:/)).not.toBeInTheDocument();
});

it("forgets an in-flight sync receipt after the account changes", async () => {
  let owner = "owner-a";
  let resolveSync!: (result: Awaited<ReturnType<ApiClient["runSync"]>>) => void;
  mount(
    client({
      getAccount: async () => ({
        signed_in: true,
        user: { id: owner, email: null, display_name: owner },
        provider: "github",
        expires_at: null,
        state: "signed_in",
      }),
      getSyncStatus: async () => IDLE,
      runSync: () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    }),
  );
  const badge = await screen.findByTestId("folk-status");
  fireEvent.click(badge);
  fireEvent.click(await screen.findByTestId("sync-now"));
  owner = "owner-b";
  fireEvent.click(badge);
  fireEvent.click(badge);
  await waitFor(() =>
    expect(screen.getByTestId("folk-account")).toHaveTextContent("owner-b"),
  );
  resolveSync({ pushed: 99, pulled: 88, conflicts: 0, skipped: 0 });
  await waitFor(() => expect(screen.getByTestId("sync-now")).toBeEnabled());
  expect(screen.queryByText(/pushed 99/)).not.toBeInTheDocument();
});
