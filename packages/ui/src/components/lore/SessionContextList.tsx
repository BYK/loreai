import type { Component } from "solid-js";
import { For, Match, Show, Switch } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { Button } from "~/components/ui/button";
import { TextField, TextFieldInput } from "~/components/ui/text-field";
import { importsHref, sessionHref, sessionsHref } from "~/lib/href";
import { formatWhen } from "~/lib/format";
import { useWorkspace } from "~/routes/workspace";
import { errorStateFor } from "./ErrorState";
import { StateCard } from "./StateCard";
import { PaginationControls } from "./PaginationControls";

/** Reader-local session browsing preserves the selected transcript and anchor. */
export const SessionContextList: Component<{
  projectId: string;
  sessionId: string;
}> = (props) => {
  const ws = useWorkspace();
  const [params, setParams] = useSearchParams();
  const q = () =>
    typeof params.q === "string" ? params.q.trim().slice(0, 500) : "";
  const cursor = () =>
    typeof params.cursor === "string" ? params.cursor : null;
  const page = ws.state.sessions.page(() => ({
    projectId: props.projectId,
    q: q() || null,
    cursor: cursor(),
  }));
  const data = () => page.loader.data();
  const href = (id: string) => {
    const query = new URLSearchParams();
    if (q()) query.set("q", q());
    if (cursor()) query.set("cursor", cursor()!);
    return sessionHref(props.projectId, id) + (query.size ? `?${query}` : "");
  };
  return (
    <div data-testid="session-context-list">
      <div class="sticky top-0 z-10 border-b border-line bg-nav px-3 py-3">
        <div class="mb-3 flex items-center justify-between text-xs">
          <strong class="text-heading">Sessions</strong>
          <A
            href={sessionsHref(props.projectId, cursor(), q() || null)}
            class="inline-flex min-h-11 items-center text-muted hover:text-text md:min-h-0"
          >
            Open as list
          </A>
        </div>
        <form
          role="search"
          class="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const raw = new FormData(event.currentTarget).get("q");
            setParams({
              q:
                typeof raw === "string"
                  ? raw.trim().slice(0, 500) || undefined
                  : undefined,
              cursor: undefined,
            });
          }}
        >
          <TextField class="min-w-0 flex-1">
            <TextFieldInput
              name="q"
              type="search"
              aria-label="Filter session list"
              placeholder="Find a session…"
              value={q()}
              class="h-11 text-base md:h-8 md:text-xs"
            />
          </TextField>
          <Button type="submit" size="sm" class="h-11 px-2 text-xs md:h-8">
            Find
          </Button>
        </form>
      </div>
      <Switch>
        <Match when={page.loader.error() && !data()}>
          {errorStateFor(page.loader.error(), "Sessions", page.loader.reload)}
        </Match>
        <Match when={!data()}>
          <StateCard kind="loading" title="Loading sessions" compact />
        </Match>
        <Match when={data()?.items.length === 0}>
          <StateCard
            kind="empty"
            title={q() ? "No matching sessions" : "No captured sessions"}
            compact
          >
            <Show
              when={q()}
              fallback={
                <>
                  Run <code>lore</code> in this project to capture an agent
                  conversation.{" "}
                  <A
                    class="text-accent underline"
                    href={importsHref(props.projectId)}
                  >
                    View import history
                  </A>{" "}
                  for knowledge extracted with <code>lore import</code>.
                </>
              }
            >
              Try another session filter, or{" "}
              <Button
                type="button"
                variant="link"
                size="sm"
                class="h-11 md:h-9"
                onClick={() => setParams({ q: undefined, cursor: undefined })}
              >
                Clear filter
              </Button>
              .
            </Show>
          </StateCard>
        </Match>
        <Match when={data()}>
          <For each={data()?.items}>
            {(session) => (
              <A
                href={href(session.session_id)}
                data-testid="context-session"
                aria-current={
                  session.session_id === props.sessionId ? "page" : undefined
                }
                class="block border-b border-line px-3 py-3 outline-none hover:bg-soft focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-accent-soft"
              >
                <div class="line-clamp-2 text-[13px] font-medium text-heading">
                  {session.title || session.session_id}
                </div>
                <div class="mt-1 flex justify-between gap-2 text-[11px] text-muted">
                  <span>{session.message_count} messages</span>
                  <span>{formatWhen(session.last_message_at)}</span>
                </div>
              </A>
            )}
          </For>
        </Match>
      </Switch>
      <PaginationControls
        label="Session list pagination"
        class="p-3"
        compact
        onFirst={cursor() ? () => setParams({ cursor: undefined }) : undefined}
        nextDisabled={!data()?.next_cursor}
        onNext={() => setParams({ cursor: data()?.next_cursor ?? undefined })}
      />
    </div>
  );
};
