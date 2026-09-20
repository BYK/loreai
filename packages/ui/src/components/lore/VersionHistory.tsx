import type { Component } from "solid-js";
import { For, Show, Switch, Match } from "solid-js";
import { A } from "@solidjs/router";

import type { KnowledgeVersionHistory } from "~/contracts";
import type { Loader } from "~/lib/loader";
import {
  formatConfidence,
  formatFullDate,
  formatWhen,
  recordedWriter,
} from "~/lib/format";
import { sessionHref } from "~/routes/Browse";

import { errorStateFor } from "./ErrorState";
import { StateCard } from "./StateCard";

export const VersionHistory: Component<{
  loader: Loader<KnowledgeVersionHistory>;
  projectId?: string;
}> = (props) => {
  const versions = () =>
    [...(props.loader.data()?.versions ?? [])].sort(
      (a, b) => b.version - a.version,
    );
  return (
    <section class="mt-8" data-testid="version-history">
      <h2 class="mb-3 text-base font-semibold">History</h2>
      <Switch>
        <Match when={props.loader.error() && !props.loader.data()}>
          <div class="py-2">
            {errorStateFor(
              props.loader.error(),
              "Version history",
              props.loader.reload,
            )}
          </div>
        </Match>
        <Match when={props.loader.loading() && !props.loader.data()}>
          <StateCard kind="loading" title="Loading version history" />
        </Match>
        <Match when={props.loader.data()}>
          <div class="space-y-2">
            <For each={versions()}>
              {(version) => (
                <details
                  class="rounded-lg border border-line bg-bg px-3.5 py-3"
                  data-testid={`knowledge-version-${version.version}`}
                >
                  <summary class="cursor-pointer list-none">
                    <div class="flex flex-wrap items-center gap-2 text-sm">
                      <span class="font-mono">v{version.version}</span>
                      <span class="rounded-full bg-chrome px-2 py-0.5 text-xs">
                        {version.is_deleted
                          ? "Deleted"
                          : version.is_current
                            ? "Current"
                            : `Superseded ${formatWhen(version.superseded_at)}`}
                      </span>
                      <span class="text-xs text-muted">
                        {formatFullDate(version.created_at)}
                      </span>
                      <Show when={recordedWriter(version)}>
                        <span class="text-xs text-muted">
                          · {recordedWriter(version)}
                        </span>
                      </Show>
                    </div>
                  </summary>
                  <div class="mt-3 space-y-2 border-t border-line pt-3 text-xs">
                    <div class="font-semibold">{version.title}</div>
                    <p class="m-0 whitespace-pre-wrap leading-relaxed">
                      {version.content}
                    </p>
                    <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
                      <dt class="text-muted">Category</dt>
                      <dd class="m-0">{version.category}</dd>
                      <dt class="text-muted">Scope</dt>
                      <dd class="m-0">
                        {version.scope} · confidence{" "}
                        {formatConfidence(version.confidence)}
                      </dd>
                    </dl>
                    <Show when={version.source_refs.session_id}>
                      {(sessionId) => (
                        <div>
                          <span class="text-muted">Source session: </span>
                          <Show
                            when={props.projectId}
                            fallback={<code>{sessionId()}</code>}
                          >
                            {(projectId) => (
                              <A
                                class="text-accent underline"
                                href={sessionHref(projectId(), sessionId())}
                              >
                                {sessionId()}
                              </A>
                            )}
                          </Show>
                        </div>
                      )}
                    </Show>
                  </div>
                </details>
              )}
            </For>
            <Show when={versions().length <= 1}>
              <p class="m-0 text-xs text-muted">No earlier versions.</p>
            </Show>
          </div>
        </Match>
      </Switch>
    </section>
  );
};
