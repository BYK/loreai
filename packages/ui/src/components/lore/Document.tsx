/**
 * Document-first building blocks from the v2.2 design fixture: header with
 * participants, message and tool blocks, the addressable passage with its
 * discussion marker, quotes, replies, drafts and note-state badges.
 *
 * These are presentation only. Nothing here calls the API or performs an
 * action; every "future" affordance renders through <FutureAction>.
 */
import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";

import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

import { Avatar, type AvatarKind } from "./Avatar";

export interface Participant {
  name: string;
  initials: string;
  kind: AvatarKind;
}

export const DocHeader: Component<{
  crumb: readonly string[];
  title: string;
  participants?: readonly Participant[];
  scope?: JSX.Element;
  trailing?: JSX.Element;
  children?: JSX.Element;
}> = (props) => (
  <header class="border-b border-line px-5 pb-3.5 pt-5 sm:px-7.5">
    <div class="mb-2 truncate text-xs text-muted">
      {props.crumb.join(" / ")}
    </div>
    <h1 class="mb-3 text-[25px] leading-[1.2] font-semibold tracking-[-0.65px]">
      {props.title}
    </h1>
    <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
      <For each={props.participants ?? []}>
        {(p) => (
          <>
            <Avatar label={p.initials} kind={p.kind} size="sm" />
            <span>{p.name}</span>
          </>
        )}
      </For>
      {props.scope}
      <Show when={props.trailing}>
        <span class="ml-auto">{props.trailing}</span>
      </Show>
    </div>
    {props.children}
  </header>
);

export const Tabs: Component<{
  tabs: readonly string[];
  active: string;
}> = (props) => (
  <div
    role="tablist"
    class="flex h-[42px] items-center gap-6 border-b border-line px-5 text-[13px] sm:px-7.5"
  >
    <For each={props.tabs}>
      {(tab) => (
        <span
          role="tab"
          aria-selected={tab === props.active}
          class={cn(
            "text-muted",
            tab === props.active &&
              "self-stretch border-b-2 border-accent pt-2.5 font-semibold text-accent",
          )}
        >
          {tab}
        </span>
      )}
    </For>
  </div>
);

export const AuthorLine: Component<{
  participant: Participant;
  time?: string;
  badge?: JSX.Element;
  size?: "sm" | "md";
}> = (props) => (
  <div class="mb-2 flex items-center gap-2 text-[13px]">
    <Avatar
      label={props.participant.initials}
      kind={props.participant.kind}
      size={props.size}
    />
    <b>{props.participant.name}</b>
    {props.badge}
    <Show when={props.time}>
      <span class="ml-auto text-xs text-muted">{props.time}</span>
    </Show>
  </div>
);

export const Message: Component<{
  author: Participant;
  time?: string;
  badge?: JSX.Element;
  children: JSX.Element;
}> = (props) => (
  <section class="mb-5">
    <AuthorLine
      participant={props.author}
      time={props.time}
      badge={props.badge}
    />
    <div class="pl-0 sm:pl-[37px] [&_p]:my-2">{props.children}</div>
  </section>
);

/** Collapsed tool call/result block, as agents render them in transcripts. */
export const ToolBlock: Component<{
  name: string;
  summary: string;
  status?: "ok" | "error" | "running";
  children?: JSX.Element;
}> = (props) => (
  <details class="my-2.5 rounded-md border border-line bg-bg text-[13px] open:bg-surface">
    <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
      <span class="rounded-sm bg-chrome px-1.5 py-0.5 font-mono text-[11px] text-accent">
        {props.name}
      </span>
      <span class="truncate text-muted">{props.summary}</span>
      <Show when={props.status}>
        <Badge
          class="ml-auto"
          variant={
            props.status === "error"
              ? "danger"
              : props.status === "running"
                ? "gold"
                : "outline"
          }
        >
          {props.status}
        </Badge>
      </Show>
    </summary>
    <Show when={props.children}>
      <pre class="m-0 overflow-x-auto border-t border-line px-3 py-2 font-mono text-xs leading-relaxed">
        {props.children}
      </pre>
    </Show>
  </details>
);

/** The highlighted, addressable passage a discussion or note is about. */
export const Passage: Component<{
  id?: string;
  children: JSX.Element;
  marker?: string;
  selected?: boolean;
}> = (props) => (
  <>
    <span
      id={props.id}
      data-passage
      class={props.selected ? "passage-target" : undefined}
    >
      {props.children}
    </span>
    <Show when={props.marker}>
      <span class="ml-1.75 whitespace-nowrap rounded-sm border border-line bg-chrome px-1.5 py-0.5 text-[11px] text-accent">
        {props.marker}
      </span>
    </Show>
  </>
);

export const SourceLink: Component<{
  href: string;
  children: JSX.Element;
  class?: string;
}> = (props) => (
  <a
    href={props.href}
    class={cn("text-[13px] text-accent hover:underline", props.class)}
  >
    {props.children}
  </a>
);

export const Quote: Component<{
  label: string;
  children: JSX.Element;
  backlink?: JSX.Element;
  class?: string;
}> = (props) => (
  <blockquote
    class={cn(
      "mb-3 border-l-[3px] border-quote-edge bg-bg px-3.25 py-2.5 text-[13px]",
      props.class,
    )}
  >
    <span class="mb-1 block text-[11px] text-muted">{props.label}</span>
    {props.children}
    <Show when={props.backlink}>
      <div class="mt-1.75">{props.backlink}</div>
    </Show>
  </blockquote>
);

export type NoteState = "draft" | "saved" | "sent" | "unknown";

export const NOTE_STATE_LABEL: Record<NoteState, string> = {
  draft: "Draft on this device",
  saved: "Saved · not sent",
  sent: "Sent to current session",
  unknown: "State unknown",
};

export const NoteStateBadge: Component<{ state: NoteState }> = (props) => (
  <Badge
    data-note-state={props.state}
    variant={
      props.state === "sent"
        ? "teal"
        : props.state === "unknown"
          ? "danger"
          : "outline"
    }
  >
    {NOTE_STATE_LABEL[props.state]}
  </Badge>
);

export const Reply: Component<{
  author: Participant;
  time?: string;
  state?: NoteState;
  link?: JSX.Element;
  children: JSX.Element;
}> = (props) => (
  <div class="mb-3 text-sm">
    <AuthorLine participant={props.author} time={props.time} />
    <div class="pl-0 sm:pl-[37px] [&_p]:my-1.5">
      {props.children}
      <div class="flex flex-wrap items-center gap-2">
        <Show when={props.state}>{(s) => <NoteStateBadge state={s()} />}</Show>
        {props.link}
      </div>
    </div>
  </div>
);

/** Read-only rendering of a draft reply (no editing in this slice). */
export const Draft: Component<{
  about: string;
  state?: NoteState;
  text: string;
  children?: JSX.Element;
}> = (props) => (
  <div class="mt-3 rounded-md border border-thread bg-surface px-3.25 py-3">
    <div class="mb-2 flex items-center justify-between text-[11px] text-muted">
      <b class="text-text">{props.about}</b>
      <NoteStateBadge state={props.state ?? "draft"} />
    </div>
    <div class="min-h-[52px] text-sm" aria-readonly="true">
      {props.text}
      <span
        aria-hidden="true"
        class="ml-px inline-block h-[17px] w-px translate-y-0.75 bg-accent"
      />
    </div>
    {props.children}
  </div>
);

export const ScopeLabel: Component<{
  scope: "private" | "project" | "team" | "cross-project";
}> = (props) => (
  <Badge variant="outline" data-scope={props.scope}>
    {props.scope === "private"
      ? "Private"
      : props.scope === "project"
        ? "Project scope"
        : props.scope === "team"
          ? "Team"
          : "Cross-project"}
  </Badge>
);
