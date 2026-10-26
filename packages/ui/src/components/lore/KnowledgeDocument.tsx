import type { Component, JSX } from "solid-js";
import { createMemo, createUniqueId, For, Match, Show, Switch } from "solid-js";
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
import { sessionHref } from "~/lib/href";
import type {
  DistillationDetail,
  KnowledgeEntry,
  KnowledgeVersion,
  KnowledgeFiles as KnowledgeFilesData,
  ProjectSummary,
} from "~/contracts";
import type { EvidenceResult } from "~/state/sessions";
import type { Loader } from "~/lib/loader";
import type { KnowledgeVersionHistory } from "~/contracts";
import { errorStateFor } from "./ErrorState";

import {
  DOCUMENT_COLUMN_CLASS,
  DocHeader,
  ScopeLabel,
  type Participant,
} from "./Document";
import { KnowledgeFiles } from "./KnowledgeFiles";
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
      <dt class="max-w-[12ch] text-muted sm:max-w-none">{props.label}</dt>
      <dd
        class="m-0 min-w-0 whitespace-pre-wrap break-all font-mono text-xs"
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
  files?: Loader<KnowledgeFilesData>;
  evidence?: Loader<EvidenceResult>;
  loadDistillation?: (id: string) => Promise<DistillationDetail>;
  actions?: JSX.Element;
  renderRestore?: (version: KnowledgeVersion) => JSX.Element;
}> = (props) => {
  const detailsDescriptionId = createUniqueId();
  const isShared = () =>
    props.entry.project_id == null ||
    props.entry.cross_project === true ||
    props.entry.cross_project === 1;
  const sourceSession = () => props.entry.source_session;
  const sourceProjectUnavailable = () =>
    !props.project &&
    props.evidence &&
    !props.evidence.data() &&
    !props.evidence.error() &&
    !props.evidence.loading();
  const sourceProjectMessage =
    "Source project unavailable; source availability cannot be checked.";
  const sourceSummary = () => {
    if (!sourceSession()) return "No source session recorded.";
    const evidence = props.evidence;
    if (!evidence) return "Source session recorded; availability unknown.";
    if (evidence.error()) return "Source availability could not be checked.";
    if (sourceProjectUnavailable()) return sourceProjectMessage;
    if (evidence.loading() || !evidence.data()) return "Checking source…";
    switch (evidence.data()?.state) {
      case "available":
        return "Source session available · exact message not recorded.";
      case "summary_only":
        return "Original messages expired; retained summary only.";
      case "unavailable":
        return "Source session no longer available.";
      default:
        return "Source session recorded; availability unknown.";
    }
  };
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
        compact
        class={DOCUMENT_COLUMN_CLASS}
        crumb={[
          props.project?.name || props.project?.path || "Project",
          "Knowledge",
        ]}
        title={props.entry.title}
        participants={[authorOf(props.entry)]}
        scope={<ScopeLabel scope={isShared() ? "shared" : "project"} />}
        trailing={`Updated ${formatWhen(props.entry.updated_at ?? props.entry.created_at)}`}
      >
        <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="teal" data-testid="category">
              {props.entry.category}
            </Badge>
            <Badge
              variant="outline"
              data-testid="knowledge-confidence"
              title="Recorded value, not a probability of correctness"
            >
              Recorded confidence {formatConfidence(props.entry.confidence)}
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
          <Show when={props.actions}>
            <div class="flex shrink-0 items-center gap-2">{props.actions}</div>
          </Show>
        </div>
      </DocHeader>

      <div class={`${DOCUMENT_COLUMN_CLASS} py-7`}>
        <div class="text-[15px] leading-[1.75] [overflow-wrap:anywhere] [&_p]:my-0 [&_p+p]:mt-4">
          <For each={paragraphs(props.entry.content)}>{(p) => <p>{p}</p>}</For>
        </div>

        <p
          data-testid="knowledge-source-summary"
          class="mt-5 text-xs leading-relaxed text-muted [overflow-wrap:anywhere]"
        >
          {sourceSummary()}
        </p>

        <details class="mt-6 min-w-0 rounded-lg border border-line bg-bg">
          <summary
            aria-label="Source & history"
            aria-describedby={detailsDescriptionId}
            class="min-h-11 cursor-pointer rounded-lg px-4 py-3 text-xs font-medium text-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>Source &amp; history</span>
            <span
              id={detailsDescriptionId}
              class="mt-1 block text-[11px] font-normal leading-relaxed"
            >
              Source, files, confidence, versions and technical details
            </span>
          </summary>
          <section
            class="min-w-0 border-t border-line px-4 py-4 text-xs [overflow-wrap:anywhere]"
            data-testid="trust-section"
          >
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
                        when={!sourceProjectUnavailable()}
                        fallback={
                          <div class="mt-2 text-muted">
                            {sourceProjectMessage}
                          </div>
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
                                        each={
                                          value().detail?.distillations ?? []
                                        }
                                      >
                                        {(distillation) => (
                                          <div class="mt-1 text-muted">
                                            gen {distillation.generation},{" "}
                                            {formatWhen(
                                              distillation.created_at,
                                            )}
                                          </div>
                                        )}
                                      </For>
                                    }
                                  >
                                    {(load) => (
                                      <For
                                        each={
                                          value().detail?.distillations ?? []
                                        }
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
                <Show when={props.files}>
                  {(files) => <KnowledgeFiles loader={files()} />}
                </Show>
              </div>
              <div class="space-y-2">
                <div>
                  <span class="font-semibold">Sharing</span>{" "}
                  {isShared() ? "shared" : "project"}
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
                  {formatConfidence(props.entry.confidence)} — recorded value,
                  not a probability of correctness
                </div>
              </div>
            </div>
          </section>

          <div class="border-t border-line px-4 pb-4">
            <Show when={props.versions}>
              {(versions) => (
                <VersionHistory
                  loader={versions()}
                  projectId={
                    props.project?.id ?? props.entry.project_id ?? undefined
                  }
                  renderRestore={props.renderRestore}
                />
              )}
            </Show>

            <details class="mt-5 min-w-0 border-t border-line pt-4 text-xs">
              <summary class="min-h-11 cursor-pointer py-3 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:py-0">
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
                  value={
                    props.entry.cross_project === true ||
                    props.entry.cross_project === 1
                      ? "true"
                      : "false"
                  }
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
                          value={
                            head()?.source_refs.user_id
                              ? "Identity unavailable"
                              : undefined
                          }
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
          </div>
        </details>

        <p class="mt-6 border-t border-line pt-4 text-xs text-muted">
          Edits and deletions are revision-checked; restores create a new
          version.
        </p>
      </div>
    </article>
  );
};
