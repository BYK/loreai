/**
 * `/entities` — the entity list (UI-08 PR1): type filter, keyset paging,
 * the rebuild card, and links into `/entities/:id` detail.
 */
import type { Component } from "solid-js";
import {
  createMemo,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";

import type { EntityRebuildResult } from "~/contracts";
import { formatWhen, pluralize } from "~/lib/format";
import { useWorkspace } from "~/routes/workspace";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { errorStateFor } from "./ErrorState";
import { ListRow } from "./Panes";
import { StateCard } from "./StateCard";

export const ENTITY_TYPES = [
  "self",
  "person",
  "org",
  "service",
  "tool",
  "repo",
  "infra",
] as const;

export const entityHref = (id: string) => `/entities/${encodeURIComponent(id)}`;
export const entitiesHref = (type?: string | null, cursor?: string | null) => {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return `/entities${qs ? `?${qs}` : ""}`;
};

/** The rebuild card: preview / rebuild-all / cancel + the result summary. */
const RebuildCard: Component = () => {
  const ws = useWorkspace();
  const entities = ws.state.entities;
  const [confirmRebuild, setConfirmRebuild] = createSignal(false);

  onMount(() => void entities.checkRebuildStatus());

  const result = () => entities.rebuild().result;
  const cancelled = () => result()?.cancelled === true;

  return (
    <section
      class="rounded-lg border border-line bg-surface p-4"
      data-testid="rebuild-card"
    >
      <h2 class="text-sm font-semibold">Rebuild entity graph</h2>
      <Switch>
        <Match
          when={
            entities.rebuild().phase === "running" ||
            entities.rebuild().phase === "cancelling"
          }
        >
          <p class="mt-1.5 text-[13px] text-muted">
            {entities.rebuild().phase === "cancelling"
              ? "Cancelling the rebuild…"
              : entities.rebuild().external
                ? "An entity rebuild is running (started elsewhere)."
                : entities.rebuild().dryRun
                  ? "Running a dry run — reading history, no writes."
                  : "Rebuilding entities from history…"}
          </p>
          <div class="mt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={entities.rebuild().phase === "cancelling"}
              onClick={() => void entities.cancelRebuild()}
            >
              Cancel
            </Button>
          </div>
        </Match>
        <Match when={entities.rebuild().phase === "done" && result()}>
          {(value) => (
            <>
              <Show
                when={!cancelled()}
                fallback={
                  <p class="mt-1.5 text-[13px] text-muted">
                    The rebuild was cancelled; the numbers below are partial.
                  </p>
                }
              >
                <p class="mt-1.5 text-[13px] text-muted">
                  {value().dryRun
                    ? "Dry run complete — nothing was written."
                    : "Rebuild complete."}
                </p>
              </Show>
              <RebuildResults result={value()} />
              <div class="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => entities.resetRebuild()}
                >
                  Dismiss
                </Button>
              </div>
            </>
          )}
        </Match>
        <Match when={entities.rebuild().phase === "error"}>
          {errorStateFor(
            entities.rebuild().error,
            "Entity rebuild",
            entities.resetRebuild,
          )}
        </Match>
        <Match when={true}>
          <p class="mt-1.5 text-[13px] text-muted">
            Rebuilds entities and relations from distilled conversation history.
            A rebuild sends history to the model and{" "}
            <strong>costs money</strong>. A dry run reads history, writes
            nothing, and still costs model calls.
          </p>
          <div class="mt-3 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={entities.rebuild().phase === "checking"}
              onClick={() => void entities.startRebuild(true)}
            >
              Preview (dry run)
            </Button>
            <Button
              size="sm"
              disabled={entities.rebuild().phase === "checking"}
              onClick={() => setConfirmRebuild(true)}
            >
              Rebuild all
            </Button>
          </div>
        </Match>
      </Switch>
      <ConfirmDialog
        open={confirmRebuild()}
        title="Rebuild all entities?"
        description={
          <>
            This sends distilled history from every project to the model and{" "}
            <strong>costs money</strong>. Existing entities are re-derived and
            may be merged.
          </>
        }
        confirmLabel="Rebuild all entities"
        onCancel={() => setConfirmRebuild(false)}
        onConfirm={() => {
          setConfirmRebuild(false);
          void entities.startRebuild(false);
        }}
      />
    </section>
  );
};

const RebuildResults: Component<{ result: EntityRebuildResult }> = (props) => (
  <table
    class="mt-3 w-full text-left text-[12px]"
    data-testid="rebuild-results"
  >
    <thead>
      <tr class="text-muted">
        <th class="py-1 pr-3 font-medium">Project</th>
        <th class="py-1 pr-3 font-medium">Detected</th>
        <th class="py-1 pr-3 font-medium">People</th>
        <th class="py-1 pr-3 font-medium">Orgs</th>
        <th class="py-1 pr-3 font-medium">Other</th>
        <th class="py-1 pr-3 font-medium">Relations</th>
        <th class="py-1 font-medium">Dedup merged</th>
      </tr>
    </thead>
    <tbody>
      <For each={props.result.results}>
        {(row) => (
          <tr class="border-t border-line">
            <td class="truncate py-1 pr-3">{row.projectPath}</td>
            <td class="py-1 pr-3">{row.detected}</td>
            <td class="py-1 pr-3">{row.personsCreated}</td>
            <td class="py-1 pr-3">{row.orgsCreated}</td>
            <td class="py-1 pr-3">{row.otherCreated}</td>
            <td class="py-1 pr-3">{row.relationsCreated}</td>
            <td class="py-1">{row.dedupMerged}</td>
          </tr>
        )}
      </For>
    </tbody>
  </table>
);

export const EntitiesPage: Component = () => {
  const ws = useWorkspace();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const typeFilter = () =>
    typeof searchParams.type === "string" ? searchParams.type : null;
  const cursor = () =>
    typeof searchParams.cursor === "string" ? searchParams.cursor : null;
  // Cursor history stack for Previous (keyset cursors are one-way).
  const [history, setHistory] = createSignal<string[]>([]);

  const source = createMemo(() => ({
    type: typeFilter(),
    cursor: cursor(),
  }));
  const list = ws.state.entities.page(source);

  const rows = () => list.loader.data()?.entities;
  const nextCursor = () => list.loader.data()?.next_cursor ?? null;

  const setType = (type: string | null) => {
    setHistory([]);
    navigate(entitiesHref(type && type !== "all" ? type : null));
  };
  const goNext = () => {
    const next = nextCursor();
    if (!next) return;
    setHistory((h) => [...h, cursor() ?? ""]);
    navigate(entitiesHref(typeFilter(), next));
  };
  const goPrev = () => {
    const stack = history();
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    setHistory(stack.slice(0, -1));
    navigate(entitiesHref(typeFilter(), prev === "" ? null : prev));
  };

  return (
    <div
      class="mx-auto max-w-[940px] px-5 py-8 sm:px-7.5"
      data-testid="entities-page"
    >
      <div class="eyebrow mb-2">Entities</div>
      <h1 class="mb-1 text-[25px] font-semibold">
        People, projects &amp; things
      </h1>
      <p class="mb-6 max-w-prose text-sm text-muted">
        Entities Lore extracted from your history — the people, organisations
        and services your agents learned about.
      </p>

      <div class="mb-4 flex items-center gap-2">
        <Select
          value={typeFilter() ?? "all"}
          onChange={(v) => setType(v)}
          options={["all", ...ENTITY_TYPES]}
          itemComponent={(item) => (
            <SelectItem item={item.item}>{item.item.rawValue}</SelectItem>
          )}
        >
          <SelectTrigger aria-label="Entity type" class="h-10 w-36">
            <SelectValue<string>>
              {(state) => state.selectedOption()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <Show when={list.loader.data()}>
          {(page) => (
            <span class="text-xs text-muted">
              {pluralize(page().total, "entity")}
            </span>
          )}
        </Show>
      </div>

      <Switch>
        <Match when={list.loader.error() && !rows()}>
          {errorStateFor(list.loader.error(), "Entities", list.loader.reload, {
            firstPage: () => navigate(entitiesHref()),
          })}
        </Match>
        <Match when={!rows()}>
          <StateCard kind="loading" title="Loading entities" />
        </Match>
        <Match when={rows()?.length === 0}>
          <StateCard kind="empty" title="No entities yet">
            Entities appear after conversations are distilled.{" "}
            <Show when={typeFilter()}>No entities of this type.</Show>
          </StateCard>
        </Match>
        <Match when={rows()}>
          {(items) => (
            <>
              <Show when={list.loader.stale()}>
                <div class="py-2 text-xs text-muted">
                  Showing cached entities while refreshing.
                </div>
              </Show>
              <div class="rounded-lg border border-line">
                <For each={items()}>
                  {(entity) => (
                    <ListRow
                      href={entityHref(entity.id)}
                      title={entity.canonical_name}
                      footLeft={
                        <>
                          <Badge variant="teal">{entity.entity_type}</Badge>{" "}
                          {entity.project_id === null
                            ? "cross-project"
                            : "project"}
                        </>
                      }
                      footRight={formatWhen(entity.updated_at)}
                      testId="entity-row"
                    />
                  )}
                </For>
              </div>
              <div class="mt-3 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={history().length === 0}
                  onClick={goPrev}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!nextCursor()}
                  onClick={goNext}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </Match>
      </Switch>

      <div class="mt-8">
        <RebuildCard />
      </div>
    </div>
  );
};
