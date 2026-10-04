import type { Component } from "solid-js";
import { Match, Show, Switch } from "solid-js";

import type { KnowledgeVersionHistory } from "~/contracts";
import type { Loader } from "~/lib/loader";
import { formatFullDate } from "~/lib/format";
import { isApiError } from "~/lib/api";
import { errorStateFor } from "~/components/lore/ErrorState";
import { StateCard } from "~/components/lore/StateCard";

import { DocHeader, ScopeLabel } from "./Document";
import { VersionHistory } from "./VersionHistory";

export const DeletedKnowledgeDocument: Component<{
  history: Loader<KnowledgeVersionHistory>;
  projectId?: string;
}> = (props) => {
  const head = () => {
    const history = props.history.data();
    return history?.versions.find(
      (version) => version.version_id === history.current_version_id,
    );
  };
  const lastLive = () =>
    props.history
      .data()
      ?.versions.filter((version) => !version.is_deleted)
      .sort((a, b) => b.version - a.version)[0];
  const historyNotFound = () => {
    const error = props.history.error();
    return isApiError(error) && error.kind === "not_found";
  };

  return (
    <Switch>
      <Match when={head()?.is_deleted}>
        <article data-testid="deleted-knowledge-document">
          <DocHeader
            crumb={[
              props.projectId ? "Project knowledge" : "All knowledge",
              "Deleted entry",
            ]}
            title={lastLive()?.title ?? head()?.title ?? "Deleted entry"}
            scope={
              <ScopeLabel
                scope={lastLive()?.scope ?? head()?.scope ?? "shared"}
              />
            }
          />
          <div class="mx-auto max-w-[940px] px-5 py-6 sm:px-7.5">
            <StateCard kind="locked" title="This entry was merged or deleted">
              The entry is no longer live. Its version history is preserved
              below.
            </StateCard>
            <section
              class="mt-5 rounded-lg border border-line bg-bg px-4 py-4"
              data-testid="deleted-entry-last-live"
            >
              <div class="eyebrow mb-2">Last live version</div>
              <Show
                when={lastLive()}
                fallback={
                  <p class="m-0 text-sm text-muted">
                    The last live version is unavailable.
                  </p>
                }
              >
                {(version) => (
                  <>
                    <h2 class="mb-2 text-base font-semibold">
                      {version().title}
                    </h2>
                    <pre class="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                      {version().content}
                    </pre>
                  </>
                )}
              </Show>
              <p class="mt-4 text-xs text-muted">
                Deleted {formatFullDate(head()?.created_at)}
              </p>
            </section>
            <p class="mt-4 text-sm text-muted">
              Restoring arrives with knowledge editing (#1805)
            </p>
            <VersionHistory
              loader={props.history}
              projectId={props.projectId}
            />
          </div>
        </article>
      </Match>
      <Match when={historyNotFound()}>
        <StateCard kind="error" title="Knowledge entry not found">
          No deleted-entry history exists for this ID.
        </StateCard>
      </Match>
      <Match when={props.history.error()}>
        <div class="p-5">
          {errorStateFor(
            props.history.error(),
            "Deleted-entry history",
            props.history.reload,
          )}
        </div>
      </Match>
      <Match when={!props.history.data()}>
        <StateCard kind="loading" title="Checking deleted-entry history">
          Looking for a tombstone before showing a not-found state.
        </StateCard>
      </Match>
      <Match when={props.history.data()}>
        <StateCard kind="error" title="Knowledge entry not found">
          The history has no deleted head for this ID.
        </StateCard>
      </Match>
    </Switch>
  );
};
