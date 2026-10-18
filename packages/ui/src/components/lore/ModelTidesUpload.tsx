/**
 * "Share on Model Tides" section (#2026 PR3): review-then-confirm upload of
 * the weekly snapshot to modeltides.dev. Nothing is uploaded automatically —
 * every remote mutation needs the exact `YES` typed by the user and carries
 * the hash/revision they just reviewed.
 */
import type { Component, JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";

import type { WeeklyUsageSnapshot } from "~/contracts";
import { isApiError } from "~/lib/api";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
import { TextField, TextFieldInput } from "~/components/ui/text-field";

const PRIVACY_TEXT =
  "If uploaded, the displayed weeks, models, counts, and uploading OS " +
  "are sent. The server also records the uploading network's country " +
  "if available. These describe the upload, not past activity. No " +
  "prompts, replies, paths, exact times, or session IDs.";

const fmt = new Intl.NumberFormat();

function privacyText(uploadOs: string): string {
  return PRIVACY_TEXT.replace("are sent.", `(${uploadOs}) are sent.`);
}

/** The full week×model grid, rendered as a scrollable table. */
const SnapshotTable: Component<{ snapshot: WeeklyUsageSnapshot }> = (props) => (
  <div class="mt-3 max-h-64 overflow-y-auto rounded-md border border-border">
    <table class="w-full text-left text-xs">
      <For each={props.snapshot.weeks}>
        {(week) => (
          <>
            <thead>
              <tr class="border-b border-border bg-muted/40">
                <th class="px-3 py-1.5 font-semibold" colspan="2">
                  Week of {week.week}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={Object.entries(week.models)}>
                {([model, count]) => (
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="px-3 py-1 font-mono">{model}</td>
                    <td class="px-3 py-1 text-right tabular-nums">
                      {fmt.format(count)}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </>
        )}
      </For>
    </table>
  </div>
);

/**
 * A domain-specific confirmation gated on typing exactly `YES`. The caller
 * renders the reviewed snapshot and state lines above the input.
 */
const YesDialog: Component<{
  open: boolean;
  title: string;
  description: JSX.Element;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  error?: string | null;
  children?: JSX.Element;
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => {
  const [value, setValue] = createSignal("");
  createEffect(
    on(
      () => props.open,
      (open) => {
        // Reset the input whenever the dialog re-opens.
        if (open) setValue("");
      },
    ),
  );
  return (
    <ConfirmDialog
      open={props.open}
      title={props.title}
      description={props.description}
      confirmLabel={props.confirmLabel}
      destructive={props.destructive}
      pending={props.pending}
      confirmDisabled={value() !== "YES"}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      {props.children}
      <TextField class="mt-3">
        <TextFieldInput
          aria-label={`Type YES to confirm`}
          placeholder="Type YES to confirm"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      </TextField>
      <Show when={props.error}>
        <p class="mt-2 text-xs text-danger">{props.error}</p>
      </Show>
    </ConfirmDialog>
  );
};

type PendingAction =
  | "upload"
  | "share"
  | "unshare"
  | "contribute"
  | "withdraw"
  | "delete"
  | "rotate"
  | null;

const ACTION_TITLES: Record<Exclude<PendingAction, null>, string> = {
  upload: "Review upload",
  share: "Share report publicly",
  unshare: "Hide public link",
  contribute: "Contribute to the community aggregate",
  withdraw: "Withdraw from the community aggregate",
  delete: "Delete Model Tides report",
  rotate: "Rotate the private key",
};

export const ModelTidesUpload: Component = () => {
  const ws = useWorkspace();
  const [state, { refetch }] = createResource(() =>
    ws.client.getModelUsageUpload(),
  );
  const [action, setAction] = createSignal<PendingAction>(null);
  const [pending, setPending] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);

  const report = createMemo(() => state()?.report ?? null);
  const reportError = createMemo(() => state()?.report_error ?? null);

  function errorMessage(err: unknown): string {
    if (isApiError(err)) return err.message;
    return err instanceof Error ? err.message : "Request failed.";
  }

  async function run(
    act: Exclude<PendingAction, null>,
    reviewedSha: string,
    reviewedRevision: number | undefined,
  ): Promise<void> {
    setPending(true);
    setActionError(null);
    try {
      if (act === "upload") {
        await ws.client.postModelUsageUpload({
          confirm: "YES",
          snapshot_sha256: reviewedSha,
          ...(reviewedRevision === undefined
            ? {}
            : { reviewed_revision: reviewedRevision }),
        });
      } else if (act === "delete") {
        await ws.client.deleteModelUsageUpload({ confirm: "YES" });
      } else {
        await ws.client.postModelUsageUploadAction(act, {
          confirm: "YES",
          ...(reviewedRevision === undefined
            ? {}
            : { reviewed_revision: reviewedRevision }),
        });
      }
      setAction(null);
      await refetch();
    } catch (err) {
      if (isApiError(err) && err.code === "stale_review") {
        setActionError("Counts changed since you reviewed them");
        await refetch();
      } else {
        setActionError(errorMessage(err));
      }
    } finally {
      setPending(false);
    }
  }

  const openReview = (act: PendingAction) => {
    setActionError(null);
    setAction(act);
  };

  const isReviewedAction = (act: PendingAction): boolean =>
    act === "upload" || act === "share" || act === "contribute";

  const confirm = () => {
    const act = action();
    if (!act || !state()) return;
    void run(
      act,
      state()!.snapshot_sha256,
      isReviewedAction(act) ? report()?.revision : undefined,
    );
  };

  const dialogSnapshot = (): WeeklyUsageSnapshot | null => {
    const act = action();
    if (act === "upload") return state()?.snapshot ?? null;
    if (act === "share" || act === "contribute") {
      return report()?.snapshot ?? null;
    }
    return null;
  };

  const stateLines = (): string[] => {
    const act = action();
    const r = report();
    if (act === "upload") {
      if (!r) {
        return [
          "Your personal chart will be viewable by anyone with its link.",
          "These counts will not enter the community aggregate.",
        ];
      }
      const lines = [
        r.published
          ? "The report stays public at its existing link."
          : "The report stays private.",
        r.inAggregate
          ? "These counts remain in the community aggregate."
          : "These counts will not enter the community aggregate.",
      ];
      if (r.metricVersion === 1) {
        lines.push("Replaces your earlier v1 report (migrate).");
      }
      return lines;
    }
    if (act === "share")
      return ["Your personal chart becomes public at its link."];
    if (act === "contribute")
      return ["The stored counts enter the community aggregate."];
    if (act === "unshare") return ["The public link is hidden."];
    if (act === "withdraw")
      return ["Stored counts leave the community aggregate."];
    if (act === "delete")
      return [
        "The stored report is deleted remotely, then the local private key is removed.",
      ];
    if (act === "rotate")
      return ["Issues a new private key and stores it locally."];
    return [];
  };

  const dialogDescription = (): JSX.Element => {
    const act = action();
    if (act === "upload") {
      return privacyText(state()?.upload_os ?? "");
    }
    if (act === "share" || act === "contribute") {
      return privacyText(state()?.upload_os ?? "");
    }
    return `Type YES to confirm ${ACTION_TITLES[act ?? "delete"].toLowerCase()}.`;
  };

  return (
    <section class="mt-6" aria-label="Share on Model Tides">
      <h2 class="text-sm font-semibold text-foreground">
        Share on Model Tides
      </h2>
      <p class="mt-1 text-xs text-muted-foreground">
        Optionally contribute your weekly model usage to{" "}
        <a
          href="https://modeltides.dev"
          target="_blank"
          rel="noreferrer"
          class="underline"
        >
          modeltides.dev
        </a>
        . Nothing is uploaded automatically — every change happens only after
        you review the exact counts and type YES.
      </p>
      <Show
        when={state() !== undefined}
        fallback={<p class="mt-2 text-xs text-muted-foreground">Loading…</p>}
      >
        <Show when={state()?.snapshot.weeks.length}>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <Show
              when={report()}
              fallback={
                <Button variant="outline" onClick={() => openReview("upload")}>
                  Review upload…
                </Button>
              }
            >
              {(r) => (
                <>
                  <Show when={r().published && r().url}>
                    <a
                      href={r().url}
                      target="_blank"
                      rel="noreferrer"
                      class="text-xs underline"
                    >
                      Your public report
                    </a>
                  </Show>
                  <Button
                    variant="outline"
                    disabled={Boolean(reportError())}
                    onClick={() => openReview("upload")}
                  >
                    Review upload…
                  </Button>
                  <Button
                    variant="outline"
                    disabled={Boolean(reportError())}
                    onClick={() =>
                      openReview(r().published ? "unshare" : "share")
                    }
                  >
                    {r().published ? "Unshare" : "Share"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={Boolean(reportError())}
                    onClick={() =>
                      openReview(r().inAggregate ? "withdraw" : "contribute")
                    }
                  >
                    {r().inAggregate ? "Withdraw" : "Contribute"}
                  </Button>
                </>
              )}
            </Show>
            <Show when={report()}>
              <Button variant="outline" onClick={() => openReview("rotate")}>
                Rotate key
              </Button>
              <Button variant="outline" onClick={() => openReview("delete")}>
                Delete report
              </Button>
            </Show>
          </div>
          <Show when={reportError()}>
            <p class="mt-2 text-xs text-danger">
              Could not confirm your stored report: {reportError()}
            </p>
          </Show>
          <Show
            when={state() !== undefined && !state()!.report_error && report()}
          >
            <p class="mt-2 text-xs text-muted-foreground">
              Report {report()!.id} · revision {report()!.revision} ·{" "}
              {report()!.published ? "public" : "private"} ·{" "}
              {report()!.inAggregate === null
                ? "aggregate unknown"
                : report()!.inAggregate
                  ? "in aggregate"
                  : "not in aggregate"}
            </p>
          </Show>
        </Show>
        <Show when={state() !== undefined && !state()!.snapshot.weeks.length}>
          <p class="mt-2 text-xs text-muted-foreground">
            No weekly counts to share yet.
          </p>
        </Show>
      </Show>

      <YesDialog
        open={action() !== null}
        title={action() ? ACTION_TITLES[action()!] : ""}
        description={dialogDescription()}
        confirmLabel="Confirm"
        destructive={action() === "delete" || action() === "withdraw"}
        pending={pending()}
        error={actionError()}
        onConfirm={confirm}
        onCancel={() => setAction(null)}
      >
        <Show when={dialogSnapshot()}>
          {(snap) => <SnapshotTable snapshot={snap()} />}
        </Show>
        <For each={stateLines()}>
          {(line) => <p class="mt-2 text-xs text-muted-foreground">{line}</p>}
        </For>
      </YesDialog>
    </section>
  );
};

export default ModelTidesUpload;
