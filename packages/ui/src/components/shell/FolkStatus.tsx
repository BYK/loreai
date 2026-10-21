import { Button } from "~/components/ui/button";
import type { Component } from "solid-js";
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import * as PopoverPrimitive from "@kobalte/core/popover";

import type { AccountStatus } from "~/contracts";
import { formatWhen } from "~/lib/format";
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

function expiresLabel(account: AccountStatus): string | null {
  if (!account.expires_at) return null;
  const at = Date.parse(account.expires_at);
  if (Number.isNaN(at)) return null;
  return `access token ${at <= Date.now() ? "expired" : "expires"} ${formatWhen(at)}`;
}

/**
 * Shell account/sync badge with an explicit, single-flight sync action.
 */
export const FolkStatus: Component = () => {
  const ws = useWorkspace();
  const folk = ws.state.folk;
  let trigger: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [tooltipOpen, setTooltipOpen] = createSignal(false);
  const [dialog, setDialog] = createSignal<"settings" | "sign-in" | null>(null);
  const [copyStatus, setCopyStatus] = createSignal("");
  const user = () => {
    const current = folk.account.data();
    return ws.connection.state() === "reachable" &&
      !folk.account.error() &&
      !folk.account.loading() &&
      current?.signed_in &&
      current.state === "signed_in"
      ? current.user
      : null;
  };
  const name = () =>
    user()?.display_name ||
    user()?.email ||
    user()?.id ||
    (folk.account.loading()
      ? "Checking account…"
      : folk.account.error()
        ? "Account unavailable"
        : "Anonymous");
  const initials = () =>
    name()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  const showDialog = (next: "settings" | "sign-in") => {
    setCopyStatus("");
    setDialog(next);
    setOpen(false);
  };
  const copyLogin = async () => {
    try {
      await navigator.clipboard.writeText("lore login");
      setCopyStatus("Copied command");
    } catch {
      setCopyStatus("Select the command above to copy it.");
    }
  };
  const [syncing, setSyncing] = createSignal(false);
  const [syncError, setSyncError] = createSignal<string | null>(null);
  const [syncReceipt, setSyncReceipt] = createSignal<string | null>(null);
  const runSync = async () => {
    if (syncing()) return;
    setSyncing(true);
    setSyncError(null);
    setSyncReceipt(null);
    try {
      const result = await ws.client.runSync();
      setSyncReceipt(
        `Sync complete: pushed ${result.pushed}, pulled ${result.pulled}.`,
      );
      folk.refresh();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };
  const summary = createMemo(() =>
    summarizeFolkStatus({
      connection: ws.connection.state(),
      account: folk.account.data(),
      accountError: folk.account.error(),
      sync: folk.sync.data(),
      syncError: folk.sync.error(),
    }),
  );
  return (
    <>
      <PopoverPrimitive.Root
        open={open()}
        gutter={10}
        placement="right-end"
        onOpenChange={(value) => {
          setTooltipOpen(false);
          setOpen(value);
          if (value) folk.refresh();
        }}
      >
        <Tooltip
          open={tooltipOpen() && !open() && dialog() === null}
          onOpenChange={setTooltipOpen}
          disabled={open() || dialog() !== null}
        >
          <TooltipTrigger
            as={PopoverPrimitive.Trigger}
            ref={(element: HTMLButtonElement) => {
              trigger = element;
            }}
            data-testid="folk-status"
            data-folk-state={summary().state}
            aria-label={`Account and sync: ${summary().label}${user() ? `, ${name()}` : ""}`}
            class="rail-action relative rounded-full"
          >
            <Show
              when={user()}
              fallback={
                <span
                  data-testid="anonymous-avatar"
                  class="flex size-8 items-center justify-center rounded-full bg-soft text-muted"
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
                <Avatar label={initials()} class="size-8 rounded-full" />
              </span>
            </Show>
            <span
              aria-hidden="true"
              class={cn(
                "absolute bottom-0.5 right-0.5 size-2 rounded-full border-2 border-nav",
                DOT[summary().tone],
              )}
            />
          </TooltipTrigger>
          <TooltipContent>
            {user() ? name() : "Account & preferences"}
          </TooltipContent>
        </Tooltip>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            data-testid="folk-status-panel"
            onCloseAutoFocus={(event) => {
              if (dialog()) event.preventDefault();
            }}
            class="z-50 max-h-[calc(100dvh-24px)] w-[min(320px,calc(100vw-76px))] overflow-y-auto rounded-xl border border-line bg-surface p-3 text-sm text-text shadow-xl focus-visible:outline-hidden"
          >
            <PopoverPrimitive.Title class="sr-only">
              Account & preferences
            </PopoverPrimitive.Title>
            <div class="flex items-center gap-3 px-1 py-2">
              <Show
                when={user()}
                fallback={
                  <span class="flex size-10 items-center justify-center rounded-full bg-soft text-muted">
                    <Icon name="user" />
                  </span>
                }
              >
                <Avatar label={initials()} class="size-10 rounded-full" />
              </Show>
              <div class="min-w-0">
                <div
                  data-testid={user() ? "folk-account" : undefined}
                  class="truncate font-semibold text-heading"
                >
                  {name()}
                </div>
                <div class="text-xs text-muted">{summary().label}</div>
              </div>
            </div>
            <div class="my-2 border-t border-line" />
            <Show
              when={
                !user() &&
                (!folk.account.loading() ||
                  folk.account.data()?.state === "anonymous")
              }
            >
              <Button
                variant="ghost"
                class="h-9 w-full justify-start px-2"
                onClick={() => showDialog("sign-in")}
              >
                <Icon name="user" />
                Sign in
              </Button>
            </Show>
            <Button
              variant="ghost"
              class="h-9 w-full justify-start px-2"
              onClick={() => showDialog("settings")}
            >
              <Icon name="settings" />
              Settings
              <Icon name="chevron" class="ml-auto" />
            </Button>
            <section
              class="flex items-center justify-between gap-3 px-2 py-2"
              aria-label="Appearance"
            >
              <span class="text-xs text-muted">Theme</span>
              <ThemeToggle compact />
            </section>
            <PopoverPrimitive.Description
              class="mt-2 border-t border-line px-2 pt-3 text-xs text-muted"
              data-testid="folk-status-detail"
            >
              {summary().detail}
            </PopoverPrimitive.Description>
            <Show when={user() && folk.account.data()}>
              {(account) => (
                <div class="mt-3 px-2 text-xs text-muted">
                  <Show when={account().provider}>
                    {(provider) => <span>via {provider()} · </span>}
                  </Show>
                  {expiresLabel(account()) ?? "no expiry recorded"}
                </div>
              )}
            </Show>

            <div class="mt-3 border-t border-line pt-3">
              <div class="flex items-center justify-between gap-3">
                <div class="eyebrow">Sync</div>
                <Show when={folk.sync.data()?.enabled}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="sync-now"
                    disabled={syncing()}
                    onClick={() => void runSync()}
                    class="h-auto px-2 py-1"
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

            <div class="mt-3 border-t border-line pt-3">
              <div class="eyebrow mb-1">Teams</div>
              <Switch
                fallback={
                  <div class="text-xs text-muted">
                    {folk.account.loading()
                      ? "Checking account…"
                      : folk.teams.loading()
                        ? "Loading teams…"
                        : "Teams unavailable."}
                  </div>
                }
              >
                <Match when={folk.teams.data()}>
                  {(list) => (
                    <Show
                      when={list().teams.length > 0}
                      fallback={
                        <div class="text-xs text-muted">
                          No team memberships are known on this device.
                        </div>
                      }
                    >
                      <ul
                        class="list-none space-y-1 p-0"
                        data-testid="folk-teams"
                      >
                        <For each={list().teams}>
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
                  )}
                </Match>
                <Match when={folk.teams.error() !== undefined}>
                  <div class="text-xs text-muted">Teams unavailable.</div>
                </Match>
              </Switch>
            </div>
            <p class="mt-3 text-xs text-muted">
              Sign-in and sync enablement use the <code>lore</code> CLI.
            </p>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <Dialog
        open={dialog() !== null}
        onOpenChange={(value) => {
          if (!value) setDialog(null);
        }}
      >
        <DialogContent
          class="max-w-sm rounded-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {dialog() === "settings" ? "Settings" : "Sign in to Lore"}
            </DialogTitle>
            <DialogDescription>
              {dialog() === "settings"
                ? "Make this workspace feel like yours."
                : "Sign in through the Lore CLI on the machine running your gateway."}
            </DialogDescription>
          </DialogHeader>
          <Show
            when={dialog() === "settings"}
            fallback={
              <div class="space-y-3 text-sm">
                <Show when={folk.account.data()?.state === "hosted"}>
                  <p class="text-muted">
                    This gateway is running in hosted mode. For local account
                    access, restart it with <code>lore start --local</code>,
                    then sign in.
                  </p>
                </Show>
                <p>
                  Run this command in your terminal and follow the sign-in
                  prompts:
                </p>
                <pre class="select-text rounded-md border border-line bg-chrome px-3 py-3">
                  <code>lore login</code>
                </pre>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copyLogin()}
                >
                  Copy command
                </Button>
                <p class="text-xs text-muted" role="status">
                  {copyStatus()}
                </p>
                <p class="text-xs text-muted">
                  Return here after signing in. Your account updates
                  automatically.
                </p>
              </div>
            }
          >
            <section class="space-y-3 py-2">
              <h3 class="text-sm font-medium">Appearance</h3>
              <p class="text-xs text-muted">
                Choose a theme, or follow your system setting.
              </p>
              <ThemeToggle class="w-full justify-between" />
            </section>
          </Show>
        </DialogContent>
      </Dialog>
    </>
  );
};
