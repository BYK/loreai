import type { Component } from "solid-js";
import { Match, Switch } from "solid-js";
import { cn } from "~/lib/utils";
import {
  CONNECTION_LABEL,
  useConnection,
  type ConnectionState,
} from "~/lib/connection";

const STATUS_TONE: Record<ConnectionState, string> = {
  checking: "bg-muted",
  reachable: "bg-accent",
  unreachable: "bg-danger",
  unauthorized: "bg-gold",
};

export const ConnectionStatus: Component<{
  class?: string;
  compact?: boolean;
}> = (props) => {
  const conn = useConnection();
  return (
    <div
      class={cn("text-[11px] text-muted", props.class)}
      data-testid="connection-status"
      data-connection={conn.state()}
      role="status"
      title={`${CONNECTION_LABEL[conn.state()]} · ${conn.detail() ?? "Private workspace · Nothing shared by this view"}`}
    >
      <div
        class={cn(
          "flex min-h-5 items-center gap-2",
          props.compact && "justify-center",
        )}
      >
        <span
          class={cn(
            "size-1.5 shrink-0 rounded-full",
            STATUS_TONE[conn.state()],
          )}
        />
        <span class={props.compact ? "sr-only" : "truncate"}>
          {CONNECTION_LABEL[conn.state()]}
        </span>
      </div>
      <span class={props.compact ? "sr-only" : "mt-1 block"}>
        <Switch fallback={<span>Local gateway</span>}>
          <Match when={conn.state() === "unreachable"}>
            {conn.detail() ?? "Start it with `lore start`."}
          </Match>
          <Match when={conn.state() === "unauthorized"}>
            Only loopback peers may manage this gateway unless
            LORE_ALLOW_REMOTE_MANAGEMENT is set.
          </Match>
        </Switch>
      </span>
      <span class="sr-only">
        Private workspace. Nothing shared by this view.
      </span>
    </div>
  );
};
