import { Button } from "~/components/ui/button";
import type { Component } from "solid-js";
import { Match, Show, Switch } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import type { SessionSummary } from "~/contracts";
import { formatFullDate, formatWhen } from "~/lib/format";
import { importsHref, sessionHref, sessionsHref } from "~/lib/href";
import { StateCard } from "./StateCard";
import { errorStateFor } from "./ErrorState";
import { SessionIdChip } from "./SessionIdChip";
import { SessionSearchBox } from "./SessionSearchBox";

const titleSourceLabels = {
  explicit: "explicit title",
  first_message: "first message",
  distillation: "from summary",
  id: "session ID",
} satisfies Record<SessionSummary["title_source"], string>;

function recordedDateTime(value: number): string | undefined {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? date.toISOString()
    : undefined;
}

export const SessionList: Component<{
  projectId: string;
  cursor: string | null;
  q?: string | null;
  page: {
    loader: {
      data: () =>
        | { items: SessionSummary[]; next_cursor: string | null }
        | undefined;
      loading: () => boolean;
      error: () => unknown;
      reload: () => void;
    };
    status: () => unknown;
  };
}> = (props) => {
  const navigate = useNavigate();
  const data = () => props.page.loader.data();
  const q = () => props.q ?? null;
  return (
    <div class="p-4 sm:p-6">
      <h1 class="mb-4 text-lg font-semibold">
        {q() ? `Sessions matching “${q()}”` : "Sessions"}
      </h1>
      <SessionSearchBox projectId={props.projectId} q={q() ?? ""} />
      <Switch>
        <Match when={props.page.loader.loading() && !data()}>
          <StateCard kind="loading" title="Loading sessions" />
        </Match>
        <Match when={props.page.loader.error() && !data()}>
          {errorStateFor(
            props.page.loader.error(),
            "Sessions",
            props.page.loader.reload,
          )}
        </Match>
        <Match when={q() && data()?.items.length === 0}>
          <StateCard kind="empty" title={`No sessions match “${q()}”`}>
            <A
              class="text-xs text-accent underline"
              href={sessionsHref(props.projectId)}
            >
              Clear search
            </A>
          </StateCard>
        </Match>
        <Match when={data()?.items.length === 0}>
          <StateCard kind="empty" title="No captured sessions">
            Run an agent through <code>lore</code> in this project to capture
            history. To extract knowledge from prior local conversations, run{" "}
            <code>lore import</code> and{" "}
            <A
              class="text-accent underline"
              href={importsHref(props.projectId)}
            >
              view import history
            </A>
            .
          </StateCard>
        </Match>
        <Match when={data()}>
          <Show when={data()!.items.some((s) => s.match === "fuzzy")}>
            <div
              data-testid="session-list-approximate"
              class="mb-2 text-[11px] text-muted"
            >
              Approximate matches shown below exact hits
            </div>
          </Show>
          <div class="divide-y divide-line">
            {(data()?.items ?? []).map((session) => (
              <div class="min-w-0 py-3">
                <A
                  class="block min-h-11 min-w-0 rounded-sm px-2 py-2 outline-none hover:bg-soft focus-visible:ring-2 focus-visible:ring-ring"
                  href={sessionHref(props.projectId, session.session_id)}
                >
                  <div class="flex min-w-0 flex-wrap items-start gap-1.5">
                    <div
                      class="min-w-0 font-medium text-sm [overflow-wrap:anywhere]"
                      title={session.title}
                    >
                      {session.title_source === "id" || !session.title.trim()
                        ? "Untitled session"
                        : session.title}
                    </div>
                    <Show when={session.match === "fuzzy"}>
                      <span
                        data-testid="session-match-fuzzy"
                        title="Approximate match"
                        class="shrink-0 rounded-sm bg-soft px-1 py-px text-[10px] font-normal text-muted"
                      >
                        ≈ approximate
                      </span>
                    </Show>
                  </div>
                  <div class="mt-1 text-xs text-muted">
                    Last message {formatWhen(session.last_message_at)}
                  </div>
                </A>
                <details class="mt-1 min-w-0 text-xs text-muted">
                  <summary class="min-h-11 cursor-pointer rounded-sm px-2 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:py-2">
                    Processing details
                  </summary>
                  <div class="space-y-2 px-2 pb-2 [overflow-wrap:anywhere]">
                    <SessionIdChip id={session.session_id} />
                    <div>
                      Title source: {titleSourceLabels[session.title_source]}
                    </div>
                    <div>
                      {session.message_count} messages ·{" "}
                      {session.distilled_count} distilled ·{" "}
                      {session.undistilled_count} undistilled
                    </div>
                    <div>
                      Recorded range:{" "}
                      <time
                        dateTime={recordedDateTime(session.first_message_at)}
                      >
                        {formatFullDate(session.first_message_at)}
                      </time>{" "}
                      –{" "}
                      <time
                        dateTime={recordedDateTime(session.last_message_at)}
                      >
                        {formatFullDate(session.last_message_at)}
                      </time>
                    </div>
                  </div>
                </details>
              </div>
            ))}
          </div>
        </Match>
      </Switch>
      <div class="mt-4 flex justify-between text-xs">
        <Show when={props.cursor}>
          <Button
            type="button"
            variant="link"
            size="sm"
            class="min-h-11 px-2 text-xs underline sm:min-h-0"
            onClick={() => navigate(sessionsHref(props.projectId, null, q()))}
          >
            First page
          </Button>
        </Show>
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={!data()?.next_cursor}
          class="min-h-11 px-2 text-xs underline sm:min-h-0"
          onClick={() => {
            const next = data()?.next_cursor;
            if (next) navigate(sessionsHref(props.projectId, next, q()));
          }}
        >
          Next page
        </Button>
      </div>
    </div>
  );
};
