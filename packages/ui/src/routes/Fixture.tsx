/**
 * `/ui/fixture` — the v2.2 design specimen as Solid components on real
 * tokens. Invented content, no backend calls, no agent actions. It exists so
 * the visual language (passage → discussion → source) can be reviewed and
 * screenshot in light/dark and desktop/mobile without real data.
 *
 *   ?view=focus   focused discussion in a side pane (mobile: full screen)
 *   ?view=blocks  UI-06a session blocks (block model + safe rendering) on an
 *                 invented session, one of every block kind
 *   ?view=busy    UI-06c busy-session fixture: 10k synthetic blocks streamed
 *                 through the real reader (`&blocks=` / `&seed=` override)
 */
import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";

import {
  AuthorLine,
  DocHeader,
  Draft,
  Message,
  NOTE_STATE_LABEL,
  NoteStateBadge,
  Passage,
  Quote,
  Reply,
  ScopeLabel,
  SourceLink,
  Tabs,
  ToolBlock,
  type NoteState,
  type Participant,
} from "~/components/lore/Document";
import {
  FUTURE_ACTIONS,
  FutureActionRow,
} from "~/components/lore/FutureAction";
import { ListRow, PaneHead } from "~/components/lore/Panes";
import {
  DistillationBlockView,
  MessageBlockView,
} from "~/components/reader/SessionBlock";
import { StateCard } from "~/components/lore/StateCard";
import { ConnectionStatus } from "~/components/shell/Nav";
import { Shell } from "~/components/shell/Shell";
import { Badge } from "~/components/ui/badge";
import { ConnectionContext, createConnectionStore } from "~/lib/connection";
import { cn } from "~/lib/utils";
import { buildBlocks } from "~/reader/blocks";
import {
  READER_SPECIMEN,
  READER_SPECIMEN_DISTILLATION,
} from "~/reader/specimen";

import { BusyFixture } from "./BusyFixture";

const BYK: Participant = { name: "BYK", initials: "BYK", kind: "person" };
const OC: Participant = { name: "OpenCode", initials: "OC", kind: "agent" };

const THREADS = [
  {
    title: "Storage architecture",
    preview: "Keep SQLite; portability is a requirement.",
    foot: ["2 discussions", "12:06"],
  },
  {
    title: "Session reader",
    preview: "Preserve selection during live updates.",
    foot: ["1 session", "Yesterday"],
  },
  {
    title: "Folk Lore onboarding",
    preview: "Separate team access from execution.",
    foot: ["3 notes", "Yesterday"],
  },
  {
    title: "Knowledge cleanup",
    preview: "Preview before merging entries.",
    foot: ["2 sessions", "Wednesday"],
  },
] as const;

const FixtureBanner: Component = () => (
  <div
    data-testid="fixture-banner"
    role="note"
    class="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 bg-inverse px-4 py-2.5 text-xs tracking-[0.02em] text-inverse-text sm:px-6"
  >
    <strong class="text-inverse-text-dim">
      LORE DESIGN SPECIMEN · v2.2 · NOT PRODUCTION
    </strong>
    <span>
      Invented content · proposed P3/P4 states · no backend, no real agent
      actions
    </span>
  </div>
);

const FixtureNavItem: Component<{
  active?: boolean;
  count?: string;
  children: JSX.Element;
}> = (props) => (
  <div
    class={cn(
      "my-0.5 flex items-center justify-between rounded-md px-3 py-2.25 text-sm",
      props.active && "bg-accent-soft font-semibold text-accent-soft-text",
    )}
    aria-current={props.active ? "page" : undefined}
  >
    <span>{props.children}</span>
    <Show when={props.count}>
      <span class="text-muted">{props.count}</span>
    </Show>
  </div>
);

const FixtureNav: Component = () => (
  <nav
    aria-label="Fixture workspace"
    class="flex h-full flex-col bg-nav px-3.5 py-6"
  >
    <div class="eyebrow px-3">Workspace</div>
    <FixtureNavItem count="6">Projects</FixtureNavItem>
    <FixtureNavItem count="124">Knowledge</FixtureNavItem>
    <FixtureNavItem count="38">Sessions</FixtureNavItem>
    <FixtureNavItem active count="8">
      Threads
    </FixtureNavItem>
    <h4 class="mx-2.5 mt-5.5 mb-2 text-[11px] uppercase tracking-[0.1em] text-muted">
      Project
    </h4>
    <FixtureNavItem active>Lore</FixtureNavItem>
    <FixtureNavItem>Personal</FixtureNavItem>
    <h4 class="mx-2.5 mt-5.5 mb-2 text-[11px] uppercase tracking-[0.1em] text-muted">
      Memory
    </h4>
    <FixtureNavItem>Find duplicates</FixtureNavItem>
    <FixtureNavItem>Folk Lore</FixtureNavItem>
    <ConnectionStatus class="mt-auto border-t border-line px-3 pt-4" />
    <A href="/" class="mt-4 px-3 text-xs text-accent">
      ← Leave the fixture
    </A>
  </nav>
);

const ThreadList: Component = () => (
  <div data-testid="fixture-threads">
    <PaneHead title="Threads · Lore" trailing="＋" />
    <div class="border-b border-line px-3.5 py-3 text-xs text-muted">
      Recent activity ⌄
    </div>
    <For each={THREADS}>
      {(t, i) => (
        <ListRow
          href="/fixture"
          title={t.title}
          preview={t.preview}
          footLeft={t.foot[0]}
          footRight={t.foot[1]}
          selected={i() === 0}
          testId="fixture-thread-row"
        />
      )}
    </For>
  </div>
);

const SourceQuote: Component<{ backlink?: boolean; class?: string }> = (
  props,
) => (
  <Quote
    label="ABOUT · OpenCode · proposal, step 2 · revision 1"
    class={props.class}
    backlink={
      <Show when={props.backlink}>
        <SourceLink href="#source-step">
          Back to highlighted passage ↑
        </SourceLink>
      </Show>
    }
  >
    “Replace the SQLite cache with a remote service.”
  </Quote>
);

const Replies: Component = () => (
  <>
    <Reply author={BYK} time="12:04" state="sent">
      <p>Keep SQLite; portability is a requirement.</p>
    </Reply>
    <Reply
      author={OC}
      time="12:05"
      link={
        <SourceLink href="#native-answer">
          View linked session response ↗
        </SourceLink>
      }
    >
      <p>Agreed. I’ll keep SQLite and make the migration incremental.</p>
    </Reply>
  </>
);

const ReplyDraft: Component = () => (
  <Draft
    about="Reply about step 2"
    state="draft"
    text="Also keep the zero-service setup."
  >
    <FutureActionRow
      actions={["Save note", "Ask agent"]}
      primary="Ask agent"
      trailing={
        <span class="ml-auto text-[11px] text-muted">Same session</span>
      }
    />
  </Draft>
);

const InlineDiscussion: Component = () => (
  <div
    data-testid="inline-discussion"
    class="relative my-3 mb-3.5 ml-3 border-l-2 border-thread pl-[19px] before:absolute before:-left-0.5 before:top-[18px] before:h-px before:w-4 before:bg-thread"
  >
    <div class="overflow-hidden rounded-lg border border-line bg-surface">
      <div class="flex items-center gap-2.5 bg-chrome px-3.25 py-2.25 text-xs">
        <b class="text-accent">Discussion</b>
        <span>2 replies</span>
        <Badge>Open</Badge>
        <A href="/fixture?view=focus" class="ml-auto" data-testid="open-focus">
          Open separately ↗
        </A>
      </div>
      <div class="px-4 py-3.5">
        <SourceQuote />
        <Replies />
        <ReplyDraft />
      </div>
      <div class="flex items-center gap-3 border-t border-line px-3.25 py-2 text-[11px] text-muted">
        <span>↳ Linked to the highlighted passage</span>
        <span class="ml-auto">discussion d-17</span>
      </div>
    </div>
  </div>
);

const Execution: Component<{ children: JSX.Element }> = (props) => (
  <div class="my-4 rounded-md border border-line bg-bg p-3.25 text-xs">
    <span class="eyebrow">Agent destination</span>
    <b class="my-1 block text-[13px]">Current session · OpenCode / s-42</b>
    {props.children}
  </div>
);

const FocusSide: Component = () => (
  <aside
    data-testid="focus-discussion"
    class="border-line bg-surface lg:border-l"
  >
    <PaneHead
      title="Discussion · d-17"
      trailing={
        <A href="/fixture" class="text-accent" data-testid="back-to-source">
          Back to source ↙
        </A>
      }
    />
    <div class="p-5">
      <div class="eyebrow lg:hidden">Storage architecture · d-17</div>
      <h2 class="my-2 mb-4 text-[21px] font-semibold tracking-[-0.4px]">
        Keep the local store
      </h2>
      <div class="mb-4 flex items-center gap-2 text-xs text-muted">
        <Badge>Open</Badge>
        <span>2 replies · private</span>
      </div>
      <SourceQuote backlink />
      <Replies />
      <Execution>
        <span>Separate view ≠ separate execution</span>
        <div class="mt-2 border-t border-line pt-2 text-muted">
          Explore separately… <Badge>P5</Badge>
          <br />
          Creates a new session only after confirmation.
        </div>
      </Execution>
      <ReplyDraft />
      <div class="mt-4 rounded-md border border-dashed border-line bg-bg p-3 text-xs text-muted">
        <b class="text-text">Source remains revision-bound.</b>
        <br />
        If the passage changes or expires, retain its reference and show that
        state; never move the reply silently.
      </div>
    </div>
  </aside>
);

const StatesSpecimen: Component = () => (
  <section
    data-testid="states-specimen"
    class="mt-8 border-t border-dashed border-line pt-6"
  >
    <div class="eyebrow mb-3">States</div>
    <div class="mb-4 flex flex-wrap gap-2" data-testid="note-states">
      <For each={Object.keys(NOTE_STATE_LABEL) as NoteState[]}>
        {(state) => <NoteStateBadge state={state} />}
      </For>
    </div>
    <div
      class="mb-4 flex flex-wrap items-center gap-2"
      data-testid="participants"
    >
      <AuthorLine participant={BYK} size="sm" />
      <AuthorLine
        participant={OC}
        size="sm"
        badge={<Badge>Session s-42</Badge>}
      />
      <ScopeLabel scope="private" />
      <ScopeLabel scope="project" />
      <ScopeLabel scope="team" />
      <ScopeLabel scope="cross-project" />
    </div>
    <div class="grid gap-3 md:grid-cols-3" data-testid="pane-states">
      <StateCard kind="empty" title="No knowledge yet" compact>
        This project has sessions but no distilled entries.
      </StateCard>
      <StateCard kind="error" title="Knowledge unavailable" compact>
        Gateway unreachable. Start it with `lore start`.
      </StateCard>
      <StateCard kind="locked" title="Projects hidden" compact>
        The management API is only served to loopback peers.
      </StateCard>
    </div>
    <div class="mt-4">
      <div class="eyebrow mb-1">Future actions</div>
      <FutureActionRow actions={FUTURE_ACTIONS} primary="Ask agent" />
    </div>
  </section>
);

const Doc: Component<{ focus: boolean }> = (props) => (
  <article data-testid="fixture-document">
    <DocHeader
      crumb={["Lore", "Threads", "Storage architecture"]}
      title="Storage architecture"
      participants={[BYK, OC]}
      scope={<ScopeLabel scope="private" />}
      trailing="Native transcript · linked"
    />
    <Tabs tabs={["Context", "Activity", "Sources"]} active="Context" />
    <div class="mx-auto max-w-[940px] px-5 py-6 sm:px-7.5">
      <Message author={BYK} time="12:01">
        <p>
          Review this storage plan. Keep deployment simple and make existing
          sessions easy to inspect.
        </p>
      </Message>
      <Message author={OC} time="12:03" badge={<Badge>Session s-42</Badge>}>
        <ToolBlock name="read" summary="packages/core/src/db.ts" status="ok">
          {
            "export function openDatabase(path: string) {\n  // WAL mode, FTS5 …\n}"
          }
        </ToolBlock>
        <ToolBlock name="grep" summary="remote cache" status="error">
          {"grep: pattern found in 0 files"}
        </ToolBlock>
        <b>Proposed approach</b>
        <ol class="my-2 pl-6 [&_li]:py-1">
          <li>Refactor the parser around stable block IDs.</li>
          <li>
            <Passage id="source-step" selected marker="2 replies">
              Replace the SQLite cache with a remote service.
            </Passage>
            <Show when={!props.focus}>
              <InlineDiscussion />
            </Show>
            <Show when={props.focus}>
              <div class="my-4 rounded-md border border-line bg-soft px-4 py-3 text-[13px]">
                <b>2 replies · discussion open on the right</b>
                <br />
                Source highlight and discussion identity stay linked.
              </div>
            </Show>
          </li>
          <li>
            <Passage marker="1 note">
              Migrate existing data before the next release.
            </Passage>
          </li>
          <li>Add tests for cache recovery and source links.</li>
        </ol>
        <div class="my-3 text-[13px] text-muted">
          <b>About step 3:</b> “Could migration be lazy?”{" "}
          <NoteStateBadge state="saved" />
        </div>
        <div class="my-3 text-[13px] text-muted">
          <b>About step 4:</b> “Cover the WAL recovery path.”{" "}
          <NoteStateBadge state="unknown" />
        </div>
        <Show when={props.focus}>
          <div
            id="native-answer"
            class="mt-6 border-t border-dashed border-line pt-5"
          >
            <span class="text-[11px] uppercase tracking-[0.1em] text-muted">
              Later in the native session · 12:05
            </span>
            <div class="mt-3 border-l-[3px] border-accent bg-soft px-3 py-2.5 text-[13px]">
              <b>Response to discussion d-17</b>
              <p class="my-1.5">
                Agreed. I’ll keep SQLite and make the migration incremental.
              </p>
              <SourceLink href="#source-step">
                Back to source, step 2 ↑
              </SourceLink>
            </div>
            <p class="mt-2 text-[13px] text-muted">
              This is the same response shown in the discussion, not another
              message or a rewritten history.
            </p>
          </div>
        </Show>
      </Message>
      <StatesSpecimen />
    </div>
    <div class="border-t border-line bg-soft px-3 py-2.75 text-center text-xs text-accent">
      New activity stays out of your way while you read ↑
    </div>
  </article>
);

const Callouts: Component = () => (
  <footer class="grid gap-5 border-t border-line bg-chrome px-5 py-5 sm:px-7.5 md:grid-cols-3">
    <For
      each={[
        [
          "Reply where the subject is",
          "The exact passage remains visible and addressable. Original agent text is never edited.",
        ],
        [
          "One discussion, several views",
          "Inline, focused and chronological views share identity and preserve a source backlink.",
        ],
        [
          "Saving is not sending",
          "Notes, agent requests and separate exploration are explicit, different actions.",
        ],
      ]}
    >
      {([title, body], i) => (
        <div class="flex gap-2.5 text-xs text-muted">
          <span class="inline-flex size-6 flex-none items-center justify-center rounded-full bg-accent text-[11px] text-accent-contrast">
            {i() + 1}
          </span>
          <div>
            <strong class="mb-0.75 block text-[13px] text-text">{title}</strong>
            {body}
          </div>
        </div>
      )}
    </For>
  </footer>
);

/**
 * UI-06a specimen: the invented session detail run through the real block
 * model and renderer. No virtualisation or selection yet (UI-06b).
 */
const ReaderBlocks: Component = () => {
  const blocks = buildBlocks(READER_SPECIMEN);
  return (
    <section
      class="mx-auto max-w-[760px] px-4.5 py-6 sm:px-8"
      data-testid="reader-blocks"
    >
      <DocHeader
        crumb={["Specimen", "Session"]}
        title="Session blocks"
        trailing="Captured history · invented"
      />
      <For each={blocks.messages}>
        {(block) => <MessageBlockView block={block} />}
      </For>
      <For each={blocks.distillations}>
        {(block) => (
          <DistillationBlockView
            block={block}
            detail={{
              ...block.summary,
              project_id: "specimen",
              observations: READER_SPECIMEN_DISTILLATION,
              source_ids: "[]",
            }}
          />
        )}
      </For>
    </section>
  );
};

export const Fixture: Component = () => {
  const [search] = useSearchParams<{ view?: string }>();
  const focus = () => search.view === "focus";
  const blocksView = () => search.view === "blocks";
  const busyView = () => search.view === "busy";
  const connection = createConnectionStore();
  connection.markReachable();

  return (
    <ConnectionContext.Provider value={connection}>
      <Shell
        banner={<FixtureBanner />}
        nav={() => <FixtureNav />}
        list={
          focus() || blocksView() || busyView() ? undefined : <ThreadList />
        }
        mobilePane="detail"
        mobileTitle={
          focus()
            ? "Discussion"
            : blocksView()
              ? "Session blocks"
              : busyView()
                ? "Busy session"
                : "Storage architecture"
        }
        back={
          focus()
            ? { href: "/fixture", label: "Source" }
            : { href: "/fixture", label: "Threads" }
        }
        detail={
          <Show
            when={!blocksView() && !busyView()}
            fallback={busyView() ? <BusyFixture /> : <ReaderBlocks />}
          >
            <div data-fixture-view={focus() ? "focus" : "context"}>
              <div
                class={cn(
                  focus() && "lg:grid lg:grid-cols-[minmax(0,1fr)_450px]",
                )}
              >
                <div class={cn(focus() && "hidden lg:block")}>
                  <Doc focus={focus()} />
                </div>
                <Show when={focus()}>
                  <FocusSide />
                </Show>
              </div>
              <Show when={focus()}>
                <div class="border-t border-line bg-chrome px-4.5 py-3.75 text-xs text-muted lg:hidden">
                  <b class="text-text">
                    The source travels with the discussion.
                  </b>
                  <br />
                  Save a note without a model call. Ask agent only when ready.
                  This is an invented P3/P4 design specimen.
                </div>
              </Show>
              <Callouts />
            </div>
          </Show>
        }
      />
    </ConnectionContext.Provider>
  );
};
