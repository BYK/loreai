import { Button } from "~/components/ui/button";
import type { Component } from "solid-js";
import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { createStore } from "solid-js/store";
import * as PopoverPrimitive from "@kobalte/core/popover";

import { summarizeFolkStatus, type FolkTone } from "~/lib/folk-status";
import { cn } from "~/lib/utils";
import { Avatar } from "~/components/lore/Avatar";
import { Icon } from "./Icon";
import { ThemeToggle } from "./Appearance";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "~/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { useWorkspace } from "~/routes/workspace";

const DOT: Record<FolkTone, string> = {
  muted: "bg-muted",
  accent: "bg-accent",
  gold: "bg-gold",
  danger: "bg-danger",
};
const GITHUB_ATTEMPT_KEY = "lore.github-login-attempt";

function useLoginController() {
  const ws = useWorkspace();
  const folk = ws.state.folk;
  return folk.retainLogin(() => {
    const [dialog, setDialog] = createSignal(false);
    const [login, setLogin] = createStore({
      email: "",
      code: "",
      attempt: "",
      githubAttempt: "",
      cancelAttempts: [] as string[],
      pending: false,
      closing: false,
      error: "",
      generation: 0,
    });
    let pendingEmailStart: Promise<{ attempt: string }> | undefined;
    let pendingGitHubStart:
      | Promise<{ url: string; attempt: string }>
      | undefined;
    const showSignIn = () => {
      setLogin({
        email: "",
        code: "",
        attempt: "",
        githubAttempt: "",
        cancelAttempts: [],
        pending: false,
        closing: false,
        error: "",
        generation: login.generation + 1,
      });
      setDialog(true);
    };
    onMount(() => {
      const url = new URL(window.location.href);
      const result = url.searchParams.get("login");
      const restoreAttempt = () => {
        const attempt = (() => {
          try {
            return sessionStorage.getItem(GITHUB_ATTEMPT_KEY);
          } catch {
            return null;
          }
        })();
        if (!attempt) return;
        setLogin({ githubAttempt: attempt, pending: false });
        setDialog(true);
      };
      const onPageShow = (event: PageTransitionEvent) => {
        if (event.persisted) restoreAttempt();
      };
      window.addEventListener("pageshow", onPageShow);
      onCleanup(() => window.removeEventListener("pageshow", onPageShow));
      if (result !== "success" && result !== "failed") {
        restoreAttempt();
        return;
      }
      try {
        // A result for an old or unknown callback cannot retire this tab's
        // different live authorization or erase its cancellation handle.
        const completedAttempt = url.searchParams.get("login_attempt");
        if (
          completedAttempt &&
          sessionStorage.getItem(GITHUB_ATTEMPT_KEY) === completedAttempt
        )
          sessionStorage.removeItem(GITHUB_ATTEMPT_KEY);
      } catch {
        /* Storage may be blocked. */
      }
      restoreAttempt();
      url.searchParams.delete("login");
      url.searchParams.delete("login_attempt");
      window.history.replaceState(window.history.state, "", url);
      if (result === "failed") {
        setDialog(true);
        setLogin("error", "GitHub sign-in did not finish. Please try again.");
      } else {
        folk.refresh();
      }
    });
    const startEmailLogin = async () => {
      if (login.pending) return;
      const generation = login.generation;
      setLogin({ pending: true, error: "" });
      try {
        const request = ws.client.startEmailLogin(login.email);
        pendingEmailStart = request;
        const result = await request;
        if (generation !== login.generation) {
          return;
        }
        setLogin("attempt", result.attempt);
      } catch (error) {
        if (generation === login.generation)
          setLogin(
            "error",
            error instanceof Error
              ? error.message
              : "Could not send a sign-in email.",
          );
      } finally {
        pendingEmailStart = undefined;
        if (generation === login.generation) setLogin("pending", false);
      }
    };
    const dismissLogin = async () => {
      if (login.closing) return;
      const attempts = [
        ...login.cancelAttempts,
        login.attempt,
        login.githubAttempt,
      ].filter(Boolean);
      const start = pendingEmailStart;
      const githubStart = pendingGitHubStart;
      setLogin({
        closing: true,
        pending: true,
        generation: login.generation + 1,
      });
      try {
        // Dismissal owns every pending start, even when an older attempt was restored.
        const pending = start ?? githubStart;
        const result = pending ? await pending.catch(() => null) : null;
        const ids = [
          ...new Set([...attempts, ...(result ? [result.attempt] : [])]),
        ];
        setLogin("cancelAttempts", ids);
        const results = [];
        for (const id of ids) {
          results.push(await ws.client.cancelLogin(id));
          try {
            // Retired work owns only this attempt's key. Clear each completed
            // cancellation before another one can fail and require a retry.
            if (sessionStorage.getItem(GITHUB_ATTEMPT_KEY) === id)
              sessionStorage.removeItem(GITHUB_ATTEMPT_KEY);
          } catch {
            /* Cancellation already succeeded. */
          }
          setLogin("cancelAttempts", (remaining) =>
            remaining.filter((value) => value !== id),
          );
          if (login.attempt === id) setLogin("attempt", "");
          if (login.githubAttempt === id) setLogin("githubAttempt", "");
        }
        setLogin("githubAttempt", "");
        if (results.some((result) => !result.ok)) {
          setLogin(
            "error",
            "Sign-in may already have completed. Check your account.",
          );
          folk.refresh();
          return;
        }
        setDialog(false);
        folk.refresh();
      } catch {
        setLogin("error", "Could not cancel sign-in. Please try again.");
      } finally {
        setLogin({ closing: false, pending: false });
      }
    };
    const verifyLogin = async () => {
      if (login.pending) return;
      const generation = login.generation;
      setLogin({ pending: true, error: "" });
      try {
        await ws.client.verifyEmailLogin(login.attempt, login.code);
        if (generation !== login.generation) {
          folk.refresh();
          return;
        }
        setDialog(false);
        folk.refresh();
      } catch (error) {
        if (generation === login.generation)
          setLogin(
            "error",
            error instanceof Error ? error.message : "Could not sign in.",
          );
      } finally {
        if (generation === login.generation) setLogin("pending", false);
      }
    };
    const changeEmail = async () => {
      if (login.pending) return;
      const generation = login.generation;
      setLogin({ pending: true, error: "" });
      try {
        if (login.attempt) {
          const result = await ws.client.cancelLogin(login.attempt);
          if (!result.ok) {
            if (generation === login.generation) {
              setLogin(
                "error",
                "Sign-in may already have completed. Check your account.",
              );
              // An unknown attempt may have committed; only a fresh anonymous
              // account read permits abandoning it and starting another login.
              try {
                const current = await ws.client.getAccount();
                if (
                  generation === login.generation &&
                  current.state === "anonymous"
                )
                  setLogin({ attempt: "", code: "" });
              } catch {
                // Keep the uncertainty warning when status cannot be confirmed.
              }
              folk.refresh();
            }
            return;
          }
        }
        if (generation === login.generation)
          setLogin({ attempt: "", code: "", error: "" });
      } catch {
        if (generation === login.generation)
          setLogin("error", "Could not cancel sign-in. Please try again.");
      } finally {
        if (generation === login.generation) setLogin("pending", false);
      }
    };
    const startGitHubLogin = async () => {
      if (login.pending) return;
      const generation = login.generation;
      setLogin({ pending: true, error: "" });
      try {
        const request = ws.client.startGitHubLogin();
        pendingGitHubStart = request;
        const result = await request;
        if (generation !== login.generation) return;
        setLogin("githubAttempt", result.attempt);
        const url = new URL(result.url);
        if (
          url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            (url.hostname === "localhost" ||
              url.hostname === "127.0.0.1" ||
              url.hostname === "[::1]")
          )
        )
          throw new Error("Could not start GitHub sign-in.");
        try {
          sessionStorage.setItem(GITHUB_ATTEMPT_KEY, result.attempt);
        } catch {
          // Navigation would lose the attempt needed to cancel on browser return.
          throw new Error(
            "GitHub sign-in requires browser session storage. Use email sign-in instead.",
          );
        }
        window.location.assign(url.href);
      } catch (error) {
        if (generation === login.generation) {
          setLogin(
            "error",
            error instanceof Error
              ? error.message
              : "Could not start GitHub sign-in.",
          );
          setLogin("pending", false);
        }
      } finally {
        pendingGitHubStart = undefined;
      }
    };
    onCleanup(() => {
      // Workspace retirement fences delayed starts before they can navigate or
      // write storage, and owns cancellation even after the last view disappears.
      void dismissLogin();
    });
    return {
      login,
      setLogin,
      dialog,
      showSignIn,
      startEmailLogin,
      startGitHubLogin,
      dismissLogin,
      verifyLogin,
      changeEmail,
    };
  });
}

/** Shell account/sync badge with an explicit, single-flight sync action. */
export const FolkStatus: Component<{ inDrawer?: boolean }> = (props) => {
  const ws = useWorkspace();
  const folk = ws.state.folk;
  const [open, setOpen] = createSignal(false);
  const [tooltipOpen, setTooltipOpen] = createSignal(false);
  const account = () =>
    ws.connection.state() === "reachable" ? folk.confirmedAccount() : undefined;
  const user = () => {
    const current = account();
    return current?.signed_in && current.state === "signed_in"
      ? current.user
      : null;
  };
  const canSignIn = () =>
    account()?.state === "anonymous" || account()?.state === "expired";
  const name = () =>
    user()?.display_name ||
    user()?.email ||
    user()?.id ||
    (summary().state === "anonymous" ? "Anonymous" : summary().label);
  const initials = () =>
    name()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  const { dialog, showSignIn: openSignIn } = useLoginController();
  const showSignIn = () => {
    openSignIn();
    setOpen(false);
  };
  const { syncing, syncError, syncReceipt, runSync } = folk;
  const summary = createMemo(() =>
    summarizeFolkStatus({
      connection: ws.connection.state(),
      account: account(),
      accountError: folk.account.error(),
      sync: folk.confirmedSync(),
      syncError: folk.sync.error(),
    }),
  );
  const ProfileIdentity: Component<{ interactive?: boolean }> = (props) => (
    <>
      <Show
        when={user()}
        fallback={
          <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-soft text-muted">
            <Icon name="user" />
          </span>
        }
      >
        <Avatar label={initials()} class="size-10 shrink-0 rounded-full" />
      </Show>
      <span class="min-w-0 flex-1">
        <span
          data-testid={user() ? "folk-account" : undefined}
          class="block truncate font-semibold text-heading"
        >
          {name()}
        </span>
        <span class="block text-xs font-normal text-muted">
          {props.interactive ? "Sign in to Lore" : summary().label}
        </span>
        <Show when={user() && account()?.provider}>
          {(provider) => (
            <span class="block text-xs font-normal text-muted">
              via {provider()}
            </span>
          )}
        </Show>
      </span>
    </>
  );
  return (
    <>
      <PopoverPrimitive.Root
        open={open()}
        modal={props.inDrawer ?? false}
        gutter={props.inDrawer ? 8 : 10}
        sameWidth={props.inDrawer}
        placement={props.inDrawer ? "top-start" : "right-end"}
        slide
        overflowPadding={12}
        onOpenChange={(value) => {
          setTooltipOpen(false);
          setOpen(value);
          if (value) folk.refresh();
        }}
      >
        <Tooltip
          open={tooltipOpen() && !props.inDrawer && !open() && !dialog()}
          onOpenChange={setTooltipOpen}
          disabled={props.inDrawer || open() || dialog()}
        >
          <TooltipTrigger
            as={PopoverPrimitive.Trigger}
            data-testid="folk-status"
            data-workspace-navigation-open={open() || dialog() ? "" : undefined}
            data-folk-state={summary().state}
            aria-label={`Account and sync: ${summary().label}${user() ? `, ${name()}` : ""}`}
            class={cn(
              props.inDrawer
                ? "flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-text outline-none hover:bg-soft focus-visible:ring-2 focus-visible:ring-ring"
                : "rail-action relative rounded-full",
            )}
          >
            <span class="relative flex shrink-0 items-center justify-center">
              <Show
                when={user()}
                fallback={
                  <span
                    data-testid="anonymous-avatar"
                    class={cn(
                      "flex items-center justify-center rounded-full bg-soft text-muted",
                      props.inDrawer ? "size-10" : "size-8",
                    )}
                  >
                    <Icon name="user" class="size-[19px]" />
                  </span>
                }
              >
                <span
                  data-testid="account-avatar"
                  role="img"
                  aria-label={`Signed in as ${name()}`}
                >
                  <Avatar
                    label={initials()}
                    class={cn(
                      "rounded-full",
                      props.inDrawer ? "size-10" : "size-8",
                    )}
                  />
                </span>
              </Show>
              <span
                aria-hidden="true"
                class={cn(
                  "absolute bottom-0 right-0 size-2 rounded-full border-2 border-nav",
                  DOT[summary().tone],
                )}
              />
            </span>
            <Show when={props.inDrawer}>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-semibold text-heading">
                  {name()}
                </span>
                <span class="block truncate text-xs text-muted">
                  Account &amp; preferences
                </span>
              </span>
              <Icon
                name="chevron"
                class={cn(
                  "size-4 text-muted",
                  open() ? "rotate-90" : "-rotate-90",
                )}
              />
            </Show>
          </TooltipTrigger>
          <TooltipContent>
            {user() ? name() : "Account & preferences"}
          </TooltipContent>
        </Tooltip>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            data-testid="folk-status-panel"
            data-workspace-navigation-layer=""
            onCloseAutoFocus={(event) => {
              if (dialog()) event.preventDefault();
            }}
            class={cn(
              "z-50 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-3 text-sm text-text shadow-xl focus-visible:outline-hidden",
              props.inDrawer
                ? "max-h-[calc(100dvh-144px)] w-[var(--kb-popper-anchor-width)] max-w-[calc(100vw-24px)]"
                : "max-h-[calc(100dvh-24px)] w-[min(288px,calc(100vw-76px))]",
            )}
          >
            <PopoverPrimitive.Title class="sr-only">
              Account & preferences
            </PopoverPrimitive.Title>
            <Show
              when={canSignIn()}
              fallback={
                <div class="flex items-center gap-3 px-2 py-2">
                  <ProfileIdentity />
                </div>
              }
            >
              <Button
                variant="ghost"
                class="h-auto min-h-16 w-full justify-start gap-3 px-2 py-2 text-left"
                aria-label="Sign in to Lore"
                aria-haspopup="dialog"
                data-testid="account-profile-sign-in"
                onClick={showSignIn}
              >
                <ProfileIdentity interactive />
                <Icon name="chevron" class="ml-auto shrink-0 text-muted" />
              </Button>
            </Show>
            <div class="my-2 border-t border-line" />
            <section
              class="flex items-center justify-between gap-3 px-2 py-2"
              aria-label="Appearance"
            >
              <span class="text-xs text-muted">Theme</span>
              <ThemeToggle compact touch={props.inDrawer} />
            </section>
            <PopoverPrimitive.Description
              class={cn(
                "text-xs text-muted",
                ["anonymous", "checking", "sync_on"].includes(summary().state)
                  ? "sr-only"
                  : "mt-2 border-t border-line px-2 pt-3",
              )}
              data-testid="folk-status-detail"
            >
              {summary().detail}
            </PopoverPrimitive.Description>
            <Show
              when={
                (account()?.signed_in && folk.sync.data()?.enabled) ||
                syncReceipt() ||
                syncError()
              }
            >
              <div class="mt-3 border-t border-line pt-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="eyebrow">Sync</div>
                  <Show when={folk.sync.data()?.enabled}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="sync-now"
                      pending={syncing()}
                      icon="refresh"
                      onClick={() => void runSync()}
                      class={cn(
                        "h-auto px-2 py-1",
                        props.inDrawer && "min-h-11 px-3",
                      )}
                    >
                      {syncing() ? "Syncing…" : "Sync now"}
                    </Button>
                  </Show>
                </div>
                <Show when={syncReceipt()}>
                  {(receipt) => (
                    <p class="mt-2 text-xs text-muted" role="status">
                      {receipt()}
                    </p>
                  )}
                </Show>
                <Show when={syncError()}>
                  {(error) => (
                    <p class="mt-2 text-xs text-danger" role="alert">
                      {error()}
                    </p>
                  )}
                </Show>
              </div>
            </Show>

            <Show
              when={
                user() &&
                ((folk.teams.data()?.teams.length ?? 0) > 0 ||
                  folk.teams.error() !== undefined)
              }
            >
              <div class="mt-2 border-t border-line px-2 pt-3">
                <div class="mb-2 text-xs text-muted">Teams</div>
                <Show
                  when={folk.teams.error() === undefined}
                  fallback={
                    <p class="text-xs text-muted">Teams unavailable.</p>
                  }
                >
                  <ul class="list-none space-y-2 p-0" data-testid="folk-teams">
                    <For each={folk.teams.data()?.teams}>
                      {(team) => (
                        <li class="flex justify-between gap-3 text-xs">
                          <span class="truncate">
                            {team.name ?? "Unnamed team"}
                          </span>
                          <span class="flex-none text-muted">
                            {team.role} · {team.member_count}{" "}
                            {team.member_count === 1 ? "member" : "members"}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </Show>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </>
  );
};

/** Render once under the workspace, never inside a disposable navigation view. */
export const FolkLoginDialog: Component = () => {
  const {
    login,
    setLogin,
    dialog,
    startEmailLogin,
    startGitHubLogin,
    dismissLogin,
    verifyLogin,
    changeEmail,
  } = useLoginController();
  return (
    <Dialog
      open={dialog()}
      onOpenChange={(value) => {
        if (!value) void dismissLogin();
      }}
    >
      <DialogContent
        data-workspace-navigation-layer=""
        class="max-w-sm rounded-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Return to the account control while its navigation view survives;
          // only a breakpoint-disposed view needs the mobile menu fallback.
          const target =
            document.querySelector<HTMLButtonElement>(
              '[data-testid="folk-status"]',
            ) ??
            document.querySelector<HTMLButtonElement>(
              '[data-testid="mobile-menu-trigger"]',
            );
          target?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>Sign in to Lore</DialogTitle>
          <DialogDescription>
            Sign in to use your Lore account and teams.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-3 text-sm">
          <Show
            when={!login.attempt}
            fallback={
              <form
                class="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void verifyLogin();
                }}
              >
                <p class="text-muted">
                  Check {login.email} for a sign-in code or link.
                </p>
                <label class="block space-y-1">
                  <span>Code or sign-in link</span>
                  <input
                    class="w-full rounded-md border border-line bg-surface px-3 py-2"
                    value={login.code}
                    onInput={(event) =>
                      setLogin("code", event.currentTarget.value)
                    }
                    autocomplete="one-time-code"
                    required
                  />
                </label>
                <Button type="submit" pending={login.pending}>
                  Sign in
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={login.pending}
                  onClick={() => void changeEmail()}
                >
                  Use a different email
                </Button>
              </form>
            }
          >
            <Button
              variant="outline"
              class="w-full"
              pending={login.pending}
              onClick={() => void startGitHubLogin()}
            >
              Continue with GitHub
            </Button>
            <p class="text-center text-xs text-muted">or continue with email</p>
            <form
              class="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void startEmailLogin();
              }}
            >
              <label class="block space-y-1">
                <span>Email address</span>
                <input
                  class="w-full rounded-md border border-line bg-surface px-3 py-2"
                  type="email"
                  value={login.email}
                  onInput={(event) =>
                    setLogin("email", event.currentTarget.value)
                  }
                  autocomplete="email"
                  disabled={login.pending}
                  required
                />
              </label>
              <Button type="submit" class="w-full" pending={login.pending}>
                Send sign-in email
              </Button>
            </form>
          </Show>
          <Show when={login.error}>
            <p role="alert" class="text-xs text-danger">
              {login.error}
            </p>
          </Show>
        </div>
      </DialogContent>
    </Dialog>
  );
};
