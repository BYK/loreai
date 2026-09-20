import type { Component } from "solid-js";
import { A } from "@solidjs/router";
import { sessionHref, sessionsHref } from "~/routes/Browse";
import { StateCard } from "./StateCard";

export const SessionPlaceholder: Component<{
  projectId: string;
  sessionId: string;
}> = (props) => (
  <div class="p-5 sm:p-7.5" data-testid="session-placeholder">
    <StateCard kind="empty" title="Session reader arrives in UI-06">
      <span class="font-mono">{props.sessionId}</span>{" "}
      <A class="text-accent underline" href={sessionsHref(props.projectId)}>
        Back to sessions
      </A>
    </StateCard>
  </div>
);
