import type { Component } from "solid-js";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { A } from "@solidjs/router";

import { Badge } from "~/components/ui/badge";
import {
  formatConfidence,
  formatFullDate,
  formatWhen,
  initials,
  pluralize,
  recordedWriter as recordedWriterOf,
} from "~/lib/format";
import { sessionHref } from "~/routes/Browse";
import type {
  DistillationDetail,
  KnowledgeEntry,
  ProjectSummary,
} from "~/contracts";
import type { EvidenceResult } from "~/state/sessions";
import type { Loader } from "~/lib/loader";
import type { KnowledgeVersionHistory } from "~/contracts";
import { errorStateFor } from "./ErrorState";

import { DocHeader, ScopeLabel, type Participant } from "./Document";
import { FUTURE_ACTIONS, FutureActionRow } from "./FutureAction";
import { RetainedSummary } from "./RetainedSummary";
import { VersionHistory } from "./VersionHistory";

function paragraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function authorOf(entry: KnowledgeEntry): Participant {
  const person = entry.created_by?.trim();
  const name = person || "Curator";
  return {
    name,
    initials: initials(name),
    kind: person ? "person" : "agent",
  };
}

const Meta: Component<{ label: string; value: string | null | undefined }> = (
  props,
) => (
  <Show when={props.value}>
    <div class="contents">
      <dt class="text-muted">{props.label}</dt>
      <dd
        class="m-0 truncate font-mono text-xs"
        title={props.value ?? undefined}
      >
        {props.value}
      </dd>
    </div>
  </Show>
);

/**
 * Read-only, content-first rendering of one knowledge entry and its provenance.
 */
export const KnowledgeDocument: Component<{
  entry: KnowledgeEntry;
  project: ProjectSummary | undefined;
  versions?: Loader<KnowledgeVersionHistory>;
  evidence?: Loader<EvidenceResult>;
  loadDistillation?: (id: string) => Promise<DistillationDetail>;
}> = (props) => {
  const isCrossProject = () =>
    props.entry.cross_project === true || props.entry.cross_project === 1;
  const sourceSession = () => props.entry.source_session;
  const currentVersion = () =>
    props.versions?.data()?.versions.find((version) => version.is_current);
  const projectId = () =>
    props.project?.id ?? props.entry.project_id ?? undefined;
  const recordedWriter = createMemo(() => {
    const version = currentVersion();
    return recordedWriterOf({
      updated_by: props.entry.updated_by,
      source_refs: version?.source_refs,
    });
  });
  return (
    <article
      data-testid="knowledge-document"
      data-knowledge-id={props.entry.id}
    >
      <DocHeader
        crumb={[
          props.project?.name || props.project?.path || "Project",
          "Knowledge",
          props.entry.title,
        ]}
        title={props.entry.title}
        participants={[authorOf(props.entry)]}
        scope={
          <ScopeLabel scope={isCrossProject() ? "cross-project" : "project"} />
        }
        trailing={`Updated ${formatWhen(props.entry.updated_at ?? props.entry.created_at)}`}
      >
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="teal" data-testid="category">
            {props.entry.category}
          </Badge>
          <Badge variant="outline">
            Confidence {formatConfidence(props.entry.confidence)}
          </Badge>
          <Show
            when={
              props.entry.sensitivity && props.entry.sensitivity !== "normal"
            }
          >
            <Badge variant="gold">{props.entry.sensitivity}</Badge>
          </Show>
          <Show
            when={
              props.entry.approval_status &&
              props.entry.approval_status !== "approved"
            }
          >
            <Badge variant="outline">{props.entry.approval_status}</Badge>
          </Show>
        </div>
      </DocHeader>

      <div class="mx-auto max-w-[940px] px-5 py-6 sm:px-7.5">
        <div class="text-[15px] leading-relaxed [&_p]:my-0 [&_p+p]:mt-3">
          <For each={paragraphs(props.entry.content)}>{(p) => <p>{p}</p>}</For>
        </div>

        <section
          class="mt-7 rounded-lg border border-line bg-bg px-4 py-3.5 text-xs"
          data-testid="trust-section"
        >
          <div class="eyebrow mb-2">Why trust this</div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <div class="font-semibold">Source</div>
              <Show
                when={sourceSession()}
                fallback={
                  <span class="text-muted">No source session recorded.</span>
                }
              >
                {(session) => (
                  <div class="flex flex-wrap items-center gap-2">
                    <Show
                      when={projectId()}
                      fallback={
                        <>
                          <code class="rounded-sm bg-chrome px-1.5 py-0.5 font-mono text-[11px]">
                            {session()}
                          </code>
                          <span class="text-muted">
                            · exact message not recorded
                          </span>
                        </>
                      }
                    >
                      {(projectId) => (
                        <>
                          <A
                            class="text-accent underline"
                            href={sessionHref(projectId(), session())}
                            aria-label="Distilled from session"
                          >
                            {session()}
                          </A>
                          <span class="text-muted">
                            · exact message not recorded
                          </span>
                        </>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={sourceSession()}>
                <Show when={props.evidence}>
                  {(evidence) => (
                    <Show
                      when={props.project}
                      fallback={
                        <div class="mt-2 text-muted">Checking source…</div>
                      }
                    >
                      <div class="mt-2 text-muted">
                        <Show
                          when={evidence().data()}
                          fallback={
                            <Show
                              when={evidence().error()}
                              fallback="Checking source…"
                            >
                              {errorStateFor(
                                evidence().error(),
                                "Source session",
                                evidence().reload,
                              )}
                            </Show>
                          }
                        >
                          {(value) => (
                            <Switch>
                              <Match when={value().state === "available"}>
                                Source session available
                              </Match>
                              <Match when={value().state === "summary_only"}>
                                <div class="mt-1">
                                  Original messages expired · retained summary
                                  only —{" "}
                                  {pluralize(
                                    value().detail?.distillations.length ?? 0,
                                    "distillation",
                                  )}
                                </div>
                                <Show
                                  when={props.loadDistillation}
                                  fallback={
                                    <For
                                      each={value().detail?.distillations ?? []}
                                    >
                                      {(distillation) => (
                                        <div class="mt-1 text-muted">
                                          gen {distillation.generation},{" "}
                                          {formatWhen(distillation.created_at)}
                                        </div>
                                      )}
                                    </For>
                                  }
                                >
                                  {(load) => (
                                    <For
                                      each={value().detail?.distillations ?? []}
                                    >
                                      {(distillation) => (
                                        <RetainedSummary
                                          distillation={distillation}
                                          load={load()}
                                        />
                                      )}
                                    </For>
                                  )}
                                </Show>
                                <div class="mt-1 text-muted">
                                  Open in the{" "}
                                  <Show
                                    when={projectId()}
                                    fallback="session reader."
                                  >
                                    {(id) => (
                                      <>
                                        {" "}
                                        <A
                                          class="text-accent underline"
                                          href={sessionHref(
                                            id(),
                                            sourceSession() ?? "",
                                          )}
                                        >
                                          session reader.
                                        </A>
                                      </>
                                    )}
                                  </Show>
                                </div>
                              </Match>
                              <Match when={value().state === "unavailable"}>
                                Source session no longer available
                              </Match>
                            </Switch>
                          )}
                        </Show>
                      </div>
                    </Show>
                  )}
                </Show>
              </Show>
            </div>
            <div class="space-y-2">
              <div>
                <span class="font-semibold">Sharing</span>{" "}
                {isCrossProject() ? "global" : "project"}
              </div>
              <div>
                <span class="font-semibold">Last change</span>{" "}
                {formatWhen(props.entry.updated_at ?? props.entry.created_at)}
                <Show when={recordedWriter()}>
                  {" · "}
                  {recordedWriter()}
                </Show>
              </div>
              <div>
                <span class="font-semibold">Recorded confidence</span>{" "}
                {formatConfidence(props.entry.confidence)} — recorded value, not
                a probability of correctness
              </div>
            </div>
          </div>
        </section>

        <Show when={props.versions}>
          {(versions) => (
            <VersionHistory
              loader={versions()}
              projectId={
                props.project?.id ?? props.entry.project_id ?? undefined
              }
            />
          )}
        </Show>

        <details class="mt-7 rounded-lg border border-line px-4 py-3 text-xs">
          <summary class="cursor-pointer font-semibold">
            Technical details
          </summary>
          <dl class="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <Meta label="ID" value={props.entry.id} />
            <Meta label="Logical ID" value={props.entry.logical_id} />
            <Meta label="Project ID" value={props.entry.project_id} />
            <Meta label="Title" value={props.entry.title} />
            <Meta label="Category" value={props.entry.category} />
            <Meta
              label="Cross project"
              value={isCrossProject() ? "true" : "false"}
            />
            <Meta label="Created by" value={props.entry.created_by} />
            <Meta label="Updated by" value={props.entry.updated_by} />
            <Meta
              label="Created"
              value={formatFullDate(props.entry.created_at)}
            />
            <Meta
              label="Updated"
              value={formatFullDate(props.entry.updated_at)}
            />
            <Meta label="Promotion" value={props.entry.promotion_status} />
            <Show when={props.entry.last_reinforced_at}>
              <Meta
                label="Last reinforced"
                value={formatFullDate(props.entry.last_reinforced_at)}
              />
            </Show>
            <Show when={props.versions?.data()}>
              {(history) => {
                const head = () =>
                  history().versions.find((version) => version.is_current);
                return (
                  <>
                    <Meta label="Version ID" value={head()?.version_id} />
                    <Meta
                      label="Current version ID"
                      value={history().current_version_id}
                    />
                    <Meta
                      label="Source user"
                      value={head()?.source_refs.user_id}
                    />
                    <Meta
                      label="Source entry"
                      value={head()?.source_refs.entry_id}
                    />
                    <Meta
                      label="Source created by"
                      value={head()?.source_refs.created_by}
                    />
                    <Meta
                      label="Source updated by"
                      value={head()?.source_refs.updated_by}
                    />
                    <Meta
                      label="Worker provider"
                      value={head()?.source_refs.worker_provider_id}
                    />
                    <Meta
                      label="Worker model"
                      value={head()?.source_refs.worker_model_id}
                    />
                  </>
                );
              }}
            </Show>
          </dl>
        </details>

        <div class="mt-7 border-t border-dashed border-line pt-5">
          <div class="eyebrow mb-1">Actions</div>
          <p class="m-0 text-xs text-muted">
            Notes, agent requests and sharing arrive in later slices. Nothing on
            this page writes to memory.
          </p>
          <FutureActionRow actions={FUTURE_ACTIONS} primary="Ask agent" />
        </div>
      </div>
    </article>
  );
};
