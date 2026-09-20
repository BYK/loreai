import type { Component } from "solid-js";
import { Match, Show, Switch } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import type { SessionSummary } from "~/contracts";
import { formatWhen } from "~/lib/format";
import { sessionHref, sessionsHref } from "~/routes/Browse";
import { StateCard } from "./StateCard";
import { errorStateFor } from "./ErrorState";

export const SessionList: Component<{
  projectId: string;
  cursor: string | null;
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
  return (
    <div class="p-4 sm:p-6">
      <h1 class="mb-4 text-lg font-semibold">Sessions</h1>
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
        <Match when={data()?.items.length === 0}>
          <StateCard kind="empty" title="No captured sessions">
            Run an agent through <code>lore</code> to capture history.
          </StateCard>
        </Match>
        <Match when={data()}>
          <div class="divide-y divide-line">
            {(data()?.items ?? []).map((session) => (
              <A
                class="block py-3 hover:bg-soft"
                href={sessionHref(props.projectId, session.session_id)}
              >
                <div class="font-mono text-xs">{session.session_id}</div>
                <div class="mt-1 text-xs text-muted">
                  {session.message_count} messages · {session.distilled_count}{" "}
                  distilled · {session.undistilled_count} undistilled ·{" "}
                  {formatWhen(session.first_message_at)} –{" "}
                  {formatWhen(session.last_message_at)}
                </div>
              </A>
            ))}
          </div>
        </Match>
      </Switch>
      <div class="mt-4 flex justify-between text-xs">
        <Show when={props.cursor}>
          <button
            class="text-accent underline"
            onClick={() => navigate(sessionsHref(props.projectId))}
          >
            First page
          </button>
        </Show>
        <button
          disabled={!data()?.next_cursor}
          class="text-accent underline disabled:opacity-40"
          onClick={() => {
            const next = data()?.next_cursor;
            if (next) navigate(sessionsHref(props.projectId, next));
          }}
        >
          Next page
        </button>
      </div>
    </div>
  );
};
