import type { Component } from "solid-js";
import { createMemo, Show } from "solid-js";
import type { SharingStatus } from "~/contracts";
import { createClipboard } from "~/lib/clipboard";
import { useWorkspace } from "~/routes/workspace";
import { Icon } from "~/components/shell/Icon";
import { Button } from "~/components/ui/button";

/** Device sync is separate from a project's choice of what to share. */
export const SharingSync: Component<{
  status: SharingStatus;
  ready: boolean;
  busy: boolean;
  onRefresh: () => void;
}> = (props) => {
  const folk = useWorkspace().state.folk;
  const setup = createMemo(() => {
    const account = folk.confirmedAccount();
    if (folk.account.error() !== undefined)
      return {
        title: "Account status unavailable",
        detail: "Check the gateway connection, then try again.",
        command: null,
      };
    if (!account)
      return {
        title: "Checking your account…",
        detail: "Reading the account settings from this gateway.",
        command: null,
      };
    if (folk.syncBlocker() === "gateway_access")
      return {
        title: "Restore browser access",
        detail:
          "This gateway refused the request. Reconnect this browser to the gateway, then try syncing again.",
        command: null,
      };
    if (account.state === "hosted")
      return {
        title: "Use a local gateway",
        detail:
          "For a background gateway, stop it and restart in local mode. If it’s running in a terminal, press Ctrl+C there, then run lore start --local.",
        command: "lore stop && lore start --local --bg",
      };
    if (account.state === "refreshing")
      return {
        title: "Restoring your account…",
        detail: "Lore is refreshing your saved login. Your settings are kept.",
        command: null,
      };
    if (account.state === "unavailable")
      return {
        title: "Account service unavailable",
        detail:
          "Your saved login is kept. Check again when the service is reachable.",
        command: null,
      };
    if (
      !account.signed_in ||
      account.state !== "signed_in" ||
      folk.syncBlocker() === "unauthorized"
    )
      return {
        title: "Sign in to start sharing",
        detail:
          "Sign in on the machine running your gateway, then return here.",
        command: "lore login",
      };
    if (folk.sync.error() !== undefined)
      return {
        title: "Sync status unavailable",
        detail:
          "We couldn’t read the sync status. Check again before making changes.",
        command: null,
      };
    if (!folk.confirmedSync())
      return {
        title: "Checking sync settings…",
        detail: "Reading the sync settings from this gateway.",
        command: null,
      };
    if (folk.syncBlocker() === "encryption_locked")
      return {
        title: "Unlock sync on this device",
        detail:
          "Enter your encryption passphrase in the terminal, then try syncing again.",
        command: "lore sync enable",
      };
    if (
      !folk.confirmedSync()?.enabled ||
      folk.syncBlocker() === "sync_disabled"
    )
      return {
        title: "Enable background sync",
        detail:
          "Run this once and follow the encryption prompts in your terminal. Then check the settings here.",
        command: "lore sync enable",
      };
    if (props.status.state === "locked")
      return {
        title: "Unlock sync on this device",
        detail:
          "Enter your encryption passphrase in the terminal to resume sync.",
        command: "lore sync enable",
      };
    if (props.status.state === "degraded")
      return {
        title: "Sync needs attention",
        detail:
          props.status.detail ??
          "Check your account and team membership, then try again.",
        command: null,
      };
    return null;
  });
  const clipboard = createClipboard(() => setup()?.command);
  const canSync = () => props.ready && !props.busy && !setup();
  return (
    <div
      data-testid="sharing-sync"
      class="border-t border-line bg-bg/50 px-4 py-4 sm:px-5"
    >
      <div class="flex items-start gap-3">
        <span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-soft text-muted">
          <Icon
            name={setup() ? "lock" : "refresh"}
            class={folk.syncing() ? "motion-safe:animate-spin" : ""}
          />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 class="text-sm font-medium">
                {setup()?.title ?? "Background sync is enabled"}
              </h3>
              <p class="mt-1 max-w-lg text-xs leading-relaxed text-muted">
                {setup()?.detail ??
                  "Automatic syncing is enabled for this device. Use Sync now to check for changes and view the result."}
              </p>
            </div>
            <Show when={!setup()}>
              <Button
                size="sm"
                class="h-11 md:h-9"
                variant="outline"
                icon="refresh"
                pending={folk.syncing()}
                disabled={!canSync()}
                onClick={() => void folk.runSync()}
              >
                {folk.syncing() ? "Syncing…" : "Sync now"}
              </Button>
            </Show>
          </div>
          <Show when={setup()}>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Show when={setup()?.command}>
                {(command) => (
                  <>
                    <code class="max-w-full break-all rounded-md border border-line bg-surface px-2.5 py-2 text-xs">
                      {command()}
                    </code>
                    <Button
                      size="sm"
                      class="h-11 md:h-9"
                      variant="outline"
                      icon={clipboard.copied() ? "check" : "copy"}
                      pending={clipboard.pending()}
                      onClick={() => void clipboard.copy(command())}
                    >
                      {clipboard.copied() ? "Copied" : "Copy command"}
                    </Button>
                  </>
                )}
              </Show>
              <Show when={folk.syncBlocker()}>
                <Button
                  size="sm"
                  class="h-11 md:h-9"
                  variant="outline"
                  icon="refresh"
                  pending={folk.syncing()}
                  disabled={!props.ready || props.busy}
                  onClick={() => void folk.runSync()}
                >
                  Try sync again
                </Button>
              </Show>
              <Button
                size="sm"
                class="h-11 md:h-9"
                variant="ghost"
                icon="refresh"
                onClick={props.onRefresh}
              >
                Check again
              </Button>
            </div>
            <Show when={clipboard.copied()}>
              <p role="status" class="mt-2 text-xs text-muted">
                Command copied. Return here after running it.
              </p>
            </Show>
            <Show when={clipboard.error()}>
              <p role="alert" class="mt-2 text-xs text-danger">
                {clipboard.error()}
              </p>
            </Show>
          </Show>
          <Show when={!setup()}>
            <p class="mt-2 text-xs text-muted">
              {folk.confirmedSync()?.pending_changes == null
                ? "The pending-change count is unavailable."
                : folk.confirmedSync()?.pending_changes === 0
                  ? "No local changes waiting to upload."
                  : `${folk.confirmedSync()?.pending_changes} pending changes across this device`}
            </p>
          </Show>
          <Show when={folk.syncReceipt()}>
            <p
              role="status"
              class={
                folk.syncAttention()
                  ? "mt-2 text-xs leading-relaxed text-gold"
                  : "mt-2 text-xs leading-relaxed text-muted"
              }
            >
              {folk.syncReceipt()}
            </p>
            <Show when={(folk.syncResult()?.conflicts ?? 0) > 0}>
              <a
                href="/ui/conflicts"
                class="mt-1 inline-block text-xs text-accent underline"
              >
                Review conflicts
              </a>
            </Show>
          </Show>
          <Show when={folk.syncError()}>
            <p role="alert" class="mt-2 text-xs text-danger">
              {folk.syncError()}
            </p>
          </Show>
        </div>
      </div>
    </div>
  );
};
