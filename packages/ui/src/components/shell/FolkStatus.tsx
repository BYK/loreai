import { Button } from "~/components/ui/button";
import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
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

/**
 * Shell account/sync badge with an explicit, single-flight sync action.
 */
export const FolkStatus: Component = () => {
  const ws = useWorkspace();
  const folk = ws.state.folk;
  let trigger: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [tooltipOpen, setTooltipOpen] = createSignal(false);
  const [dialog, setDialog] = createSignal(false);
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
  const showSignIn = () => {
    setCopyStatus("");
    setDialog(true);
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
        <Show when={user() && folk.account.data()?.provider}>
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
        gutter={10}
        placement="right-end"
        onOpenChange={(value) => {
          setTooltipOpen(false);
          setOpen(value);
          if (value) folk.refresh();
        }}
      >
        <Tooltip
          open={tooltipOpen() && !open() && !dialog()}
          onOpenChange={setTooltipOpen}
          disabled={open() || dialog()}
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
            class="z-50 max-h-[calc(100dvh-24px)] w-[min(288px,calc(100vw-76px))] overflow-y-auto rounded-xl border border-line bg-surface p-3 text-sm text-text shadow-xl focus-visible:outline-hidden"
          >
            <PopoverPrimitive.Title class="sr-only">
              Account & preferences
            </PopoverPrimitive.Title>
            <Show
              when={
                !user() &&
                (!folk.account.loading() ||
                  folk.account.data()?.state === "anonymous")
              }
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
              <ThemeToggle compact />
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
                (folk.account.data()?.signed_in && folk.sync.data()?.enabled) ||
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
      <Dialog
        open={dialog()}
        onOpenChange={(value) => {
          if (!value) setDialog(false);
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
            <DialogTitle>Sign in to Lore</DialogTitle>
            <DialogDescription>
              Sign in through the Lore CLI on the machine running your gateway.
            </DialogDescription>
          </DialogHeader>
          <div class="space-y-3 text-sm">
            <Show when={folk.account.data()?.state === "hosted"}>
              <p class="text-muted">
                This gateway is running in hosted mode. For local account
                access, restart it with <code>lore start --local</code>, then
                sign in.
              </p>
            </Show>
            <p>
              Run this command in your terminal and follow the sign-in prompts:
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
              Return here after signing in. Your account updates automatically.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
