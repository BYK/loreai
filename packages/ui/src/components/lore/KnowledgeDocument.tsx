import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
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
  ProjectSummary,
} from "~/contracts";
import type { EvidenceResult } from "~/state/sessions";
import type { Loader } from "~/lib/loader";
import type { KnowledgeVersionHistory } from "~/contracts";
import { errorStateFor } from "./ErrorState";
import {
  DiscussionIndicator,
  DiscussionThread,
} from "~/components/discussions/DiscussionThread";
import { SelectionActions } from "~/components/discussions/SelectionActions";
import { Button } from "~/components/ui/button";
import { contentHash } from "~/lib/hash";
import {
  ANCHOR_MAPPING_VERSION,
  decodeAnchor,
  type SourceAnchor,
} from "~/reader/anchors";
import {
  discussionSpans,
  overlappingDiscussions,
} from "~/reader/discussion-marks";
import {
  applyHighlights,
  clearHighlight,
  type HighlightSpan,
  PART_SELECTOR,
  readSelection,
} from "~/reader/selection";
import type { DiscussionsState } from "~/state/discussions";

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

/**
 * Logical parts of an entry: one per paragraph, hashed like the server's
 * `knowledgePartHashes`, so anchors (`k.<id>`, part = paragraph) verify there.
 */
export function knowledgeParts(content: string) {
  return paragraphs(content).map((text) => ({ text, hash: contentHash(text) }));
}

/** Whole-entry hash: a single paragraph hashes like its part. */
export function knowledgeBlockHash(parts: readonly { hash: string }[]) {
  return parts.length === 1
    ? (parts[0]?.hash ?? "")
    : contentHash(parts.map((p) => p.hash).join("|"));
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
  /** Discussion state (APP-02); absent → the actions stay placeholders. */
  discussions?: DiscussionsState;
  /** Raw `?a=` value ("Back to source"). */
  anchorParam?: string | null;
  /** Opens the focused discussion route (used on narrow screens). */
  onOpenDiscussion?: (discussionId: string) => void;
}> = (props) => {
  const isShared = () =>
    props.entry.project_id == null ||
    props.entry.cross_project === true ||
    props.entry.cross_project === 1;
  const sourceSession = () => props.entry.source_session;
  const currentVersion = () =>
    props.versions?.data()?.versions.find((version) => version.is_current);
  const projectId = () =>
    props.project?.id ?? props.entry.project_id ?? undefined;
  const parts = createMemo(() => knowledgeParts(props.entry.content));
  // Discussions follow the logical entry across versions.
  const logicalId = () => props.entry.logical_id ?? props.entry.id;
  const blockId = () => `k.${logicalId()}`;
  const source = () => ({ kind: "knowledge" as const, id: logicalId() });
  const discussionProject = () =>
    props.discussions ? (projectId() ?? null) : null;
  const entryDiscussions = () => {
    const pid = discussionProject();
    return pid && props.discussions
      ? props.discussions.forSource(pid, source())
      : [];
  };
  createEffect(
    on(
      () => [props.discussions, discussionProject(), logicalId()] as const,
      ([state, pid, id]) => {
        if (state && pid) void state.loadSource(pid, { kind: "knowledge", id });
      },
    ),
  );
  const [selected, setSelected] = createSignal<{
    anchor: SourceAnchor;
    quote: string;
  } | null>(null);
  const [hint, setHint] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const target = createMemo(() => {
    const decoded = props.anchorParam ? decodeAnchor(props.anchorParam) : null;
    if (!decoded || decoded.mapping !== ANCHOR_MAPPING_VERSION) return null;
    const { anchor } = decoded;
    if (anchor.blockId !== blockId()) return null;
    const hash =
      anchor.partIndex === undefined
        ? knowledgeBlockHash(parts())
        : parts()[anchor.partIndex]?.hash;
    return hash === anchor.contentHash ? anchor : null;
  });
  let bodyEl: HTMLDivElement | undefined;
  let scrolledTo: string | null = null;

  function selectFromDom() {
    if (!bodyEl) return;
    const reading = readSelection(bodyEl, document.getSelection());
    if (reading.kind === "none") return;
    if (reading.kind === "ambiguous") {
      setHint(
        reading.reason === "parts"
          ? "Select within one paragraph, or discuss the whole entry."
          : "Select text inside the entry.",
      );
      return;
    }
    const part = parts()[reading.partIndex];
    if (!part) return;
    setHint(null);
    setSelected({
      anchor: {
        blockId: reading.blockId,
        partIndex: reading.partIndex,
        start: reading.start,
        end: reading.end,
        contentHash: part.hash,
      },
      quote: reading.quote,
    });
  }
  function selectEntry() {
    setHint(null);
    setSelected({
      anchor: {
        blockId: blockId(),
        start: 0,
        end: 0,
        contentHash: knowledgeBlockHash(parts()),
      },
      quote: parts()
        .map((p) => p.text)
        .join("\n\n"),
    });
  }
  function reveal(id: string, toggle = false) {
    if (
      props.onOpenDiscussion &&
      window.matchMedia?.("(max-width: 639px)").matches === true
    ) {
      props.onOpenDiscussion(id);
      return;
    }
    setExpanded((cur) => (toggle && cur === id ? null : id));
  }
  function collapse() {
    const id = expanded();
    setExpanded(null);
    if (!id) return;
    queueMicrotask(() =>
      document
        .querySelector<HTMLElement>(
          `[data-testid="discussion-indicator"][data-discussion-id="${CSS.escape(id)}"]`,
        )
        ?.focus(),
    );
  }

  // Marks are re-applied from logical anchors whenever anything they
  // depend on changes; DOM ranges are never stored.
  createEffect(() => {
    const list = entryDiscussions();
    const focus = selected()?.anchor ?? target();
    const id = blockId();
    parts();
    if (!bodyEl) return;
    for (const el of bodyEl.querySelectorAll<HTMLElement>(PART_SELECTOR)) {
      clearHighlight(el);
      const index = Number(el.dataset.part);
      const spans: HighlightSpan[] = [...discussionSpans(list, id, index)];
      if (focus?.partIndex === index && focus.end > focus.start) {
        spans.push({
          start: focus.start,
          end: focus.end,
          className: "passage-target",
        });
      }
      applyHighlights(el, spans);
    }
    const t = target();
    if (t && props.anchorParam && scrolledTo !== props.anchorParam) {
      scrolledTo = props.anchorParam;
      const el =
        bodyEl.querySelector<HTMLElement>("mark.passage-target") ?? bodyEl;
      queueMicrotask(() => el.scrollIntoView({ block: "center" }));
    }
  });

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
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (expanded()) {
          event.preventDefault();
          collapse();
        } else if (selected() || hint()) {
          event.preventDefault();
          setSelected(null);
          setHint(null);
        }
      }}
    >
      <DocHeader
        crumb={[
          props.project?.name || props.project?.path || "Project",
          "Knowledge",
          props.entry.title,
        ]}
        title={props.entry.title}
        participants={[authorOf(props.entry)]}
        scope={<ScopeLabel scope={isShared() ? "shared" : "project"} />}
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
        <div
          ref={(el) => (bodyEl = el)}
          class="text-[15px] leading-relaxed [&_p]:my-0 [&_p+p]:mt-3"
          data-testid="knowledge-body"
          onPointerUp={(e) => {
            const mark = (e.target as Element | null)?.closest?.<HTMLElement>(
              "[data-discussion]",
            );
            const sel = document.getSelection();
            if (mark?.dataset.discussion && (!sel || sel.isCollapsed)) {
              reveal(mark.dataset.discussion, true);
              return;
            }
            queueMicrotask(selectFromDom);
          }}
          onKeyUp={(e) => {
            if (e.shiftKey) selectFromDom();
          }}
        >
          <For each={parts()}>
            {(p, i) => (
              <p data-block={blockId()} data-part={i()}>
                {p.text}
              </p>
            )}
          </For>
        </div>

        <Show when={discussionProject()}>
          {(pid) => (
            <>
              <Show when={entryDiscussions().length > 0}>
                <div
                  class="mt-3 flex flex-col gap-1.5"
                  data-testid="discussion-anchor"
                >
                  <div class="flex flex-wrap gap-1.5">
                    <For each={entryDiscussions()}>
                      {(d) => (
                        <DiscussionIndicator
                          discussion={d}
                          expanded={expanded() === d.id}
                          onToggle={() => reveal(d.id, true)}
                        />
                      )}
                    </For>
                  </div>
                  <For
                    each={entryDiscussions().filter((d) => d.id === expanded())}
                  >
                    {(d) => (
                      <DiscussionThread
                        projectId={pid()}
                        discussion={d}
                        autofocus
                        onClose={collapse}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <section
                class="mt-4 rounded-lg border border-line px-4 py-3 text-sm"
                data-testid="selection-panel"
                aria-label="Selection"
              >
                <Show
                  when={selected()}
                  fallback={
                    <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span data-testid="selection-hint">
                        {hint() ?? "Select text to start a thread there."}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="discuss-entry"
                        onClick={selectEntry}
                      >
                        Discuss whole entry
                      </Button>
                      <FutureActionRow
                        actions={FUTURE_ACTIONS.filter(
                          (name) => name !== "Save note",
                        )}
                        class="w-full"
                      />
                    </div>
                  }
                >
                  {(sel) => (
                    <>
                      <blockquote
                        class="m-0 line-clamp-3 border-l-2 border-line pl-3 text-muted"
                        data-testid="selection-quote"
                      >
                        {sel().quote}
                      </blockquote>
                      <SelectionActions
                        projectId={pid()}
                        source={source()}
                        anchor={sel().anchor}
                        quote={sel().quote}
                        overlapping={overlappingDiscussions(
                          entryDiscussions(),
                          sel().anchor,
                        )}
                        onReplyIn={(d) => {
                          setSelected(null);
                          reveal(d.id);
                        }}
                        onCreated={(d) => {
                          setSelected(null);
                          reveal(d.id);
                        }}
                      />
                    </>
                  )}
                </Show>
              </section>
            </>
          )}
        </Show>

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
          <Show when={!discussionProject()}>
            <FutureActionRow actions={FUTURE_ACTIONS} primary="Ask agent" />
          </Show>
        </div>
      </div>
    </article>
  );
};
