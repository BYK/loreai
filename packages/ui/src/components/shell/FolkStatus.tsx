import type { Component } from "solid-js";
import { For, Match, Show, Switch, createMemo } from "solid-js";
import * as PopoverPrimitive from "@kobalte/core/popover";

import type { AccountStatus } from "~/contracts";
import { formatWhen } from "~/lib/format";
import { summarizeFolkStatus, type FolkTone } from "~/lib/folk-status";
import { cn } from "~/lib/utils";
import { useWorkspace } from "~/routes/workspace";

const DOT: Record<FolkTone, string> = {
  muted: "bg-muted",
  accent: "bg-accent",
  gold: "bg-gold",
  danger: "bg-danger",
};

function accountName(account: AccountStatus): string {
  return (
    account.user?.display_name ?? account.user?.email ?? account.user?.id ?? ""
  );
}

function expiresLabel(account: AccountStatus): string | null {
  if (!account.expires_at) return null;
  const at = Date.parse(account.expires_at);
  if (Number.isNaN(at)) return null;
  return `${account.state === "expired" ? "expired" : "expires"} ${formatWhen(at)}`;
}

/**
 * Shell account/sync badge (FOLK-01). Read-only: it reports what the
 * gateway's status routes say and links to nothing that writes.
 */
export const FolkStatus: Component = () => {
  const ws = useWorkspace();
  const folk = ws.state.folk;
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
    <PopoverPrimitive.Root
      gutter={6}
      placement="bottom-end"
      onOpenChange={(open) => {
        if (open) folk.refresh();
      }}
    >
      <PopoverPrimitive.Trigger
        data-testid="folk-status"
        data-folk-state={summary().state}
        aria-label={`Account and sync: ${summary().label}`}
        class="inline-flex h-8 max-w-[220px] items-center gap-2 rounded-md border border-line bg-chrome px-2.5 text-[13px] text-muted hover:text-heading focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden="true"
          class={cn("size-2 flex-none rounded-full", DOT[summary().tone])}
        />
        <span class="hidden truncate sm:inline">{summary().label}</span>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-testid="folk-status-panel"
          class="z-50 w-[min(320px,calc(100vw-24px))] rounded-lg border border-line bg-surface p-4 text-sm text-text shadow-lg focus-visible:outline-hidden"
        >
          <PopoverPrimitive.Title class="font-semibold text-heading">
            Account & sync
          </PopoverPrimitive.Title>
          <PopoverPrimitive.Description
            class="mt-1 text-[13px] text-muted"
            data-testid="folk-status-detail"
          >
            {summary().detail}
          </PopoverPrimitive.Description>

          <Show when={folk.account.data()}>
            {(account) => (
              <Show when={account().user}>
                <div class="mt-3 border-t border-line pt-3">
                  <div class="eyebrow mb-1">Account</div>
                  <div data-testid="folk-account" class="truncate">
                    {accountName(account())}
                  </div>
                  <div class="text-xs text-muted">
                    <Show when={account().provider}>
                      {(provider) => <span>via {provider()} · </span>}
                    </Show>
                    {expiresLabel(account()) ?? "no expiry recorded"}
                  </div>
                </div>
              </Show>
            )}
          </Show>

          <div class="mt-3 border-t border-line pt-3">
            <div class="eyebrow mb-1">Teams</div>
            <Switch
              fallback={<div class="text-xs text-muted">Loading teams…</div>}
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
            Read-only. Sign-in, sync and team changes happen through the{" "}
            <code>lore</code> CLI.
          </p>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};
