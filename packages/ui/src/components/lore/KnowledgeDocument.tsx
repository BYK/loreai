import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { A } from "@solidjs/router";

import { Badge } from "~/components/ui/badge";
import {
  formatConfidence,
  formatFullDate,
  formatWhen,
  initials,
} from "~/lib/format";
import type { KnowledgeEntry, ProjectSummary } from "~/contracts";
import { sessionHref } from "~/routes/Browse";

import { DocHeader, ScopeLabel, type Participant } from "./Document";
import { FUTURE_ACTIONS, FutureActionRow } from "./FutureAction";

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
 * Read-only, document-first rendering of one knowledge entry (the current
 * version — the API has no history route yet, see the API inventory on #1796).
 */
export const KnowledgeDocument: Component<{
  entry: KnowledgeEntry;
  project: ProjectSummary | undefined;
}> = (props) => {
  const isCrossProject = () =>
    props.entry.cross_project === true || props.entry.cross_project === 1;
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

        <section class="mt-7 rounded-lg border border-line bg-bg px-4 py-3.5 text-xs">
          <div class="eyebrow mb-2">Sources</div>
          <Show
            when={props.entry.source_session}
            fallback={
              <span class="text-muted">No source session recorded.</span>
            }
          >
            {(session) => (
              <div class="flex flex-wrap items-center gap-2">
                <Show
                  when={props.project?.id ?? props.entry.project_id}
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
                    <A
                      class="text-accent underline"
                      href={sessionHref(projectId(), session())}
                      aria-label="Distilled from session"
                    >
                      {session()}
                    </A>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </section>

        <dl class="mt-5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <Meta label="Logical id" value={props.entry.id} />
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
        </dl>

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
