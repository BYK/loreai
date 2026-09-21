/**
 * `/entities` + `/entities/:entityId` — the global entities screens (UI-08
 * PR1). Entities are not project-scoped, so these routes render the shell
 * directly (nav + a single detail pane) rather than reusing Browse, whose
 * list pane is the project-scoped knowledge list.
 */
import type { Component } from "solid-js";
import { useParams } from "@solidjs/router";

import { EntitiesPage } from "~/components/lore/EntitiesPage";
import { EntityPage } from "~/components/lore/EntityPage";
import { StateCard } from "~/components/lore/StateCard";
import { Nav } from "~/components/shell/Nav";
import { Shell, type MobilePane } from "~/components/shell/Shell";
import { useWorkspace } from "./workspace";

function decodeParam(segment: string | undefined) {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const EntitiesShell: Component<{ view: "list" | "detail" }> = (props) => {
  const params = useParams<{ entityId?: string }>();
  const ws = useWorkspace();
  const entityId = () => decodeParam(params.entityId);

  const nav = () => (
    <Nav
      projects={ws.projects.data()}
      loading={ws.projects.loading()}
      error={ws.projects.error()}
      activeProjectId={null}
      totalKnowledge={
        ws.projects.data()?.reduce((n, p) => n + p.knowledge_count, 0) ?? null
      }
      onRetry={ws.projects.reload}
      stale={ws.state.projects.status()}
    />
  );

  const detail = () => {
    if (props.view === "list") return <EntitiesPage />;
    const id = entityId();
    if (!id) return <StateCard kind="error" title="Entity not found" />;
    return <EntityPage entityId={id} />;
  };

  const mobilePane = (): MobilePane => "detail";
  const back = () =>
    props.view === "detail"
      ? { href: "/entities", label: "Entities" }
      : undefined;

  return (
    <Shell
      nav={nav}
      detail={detail()}
      mobilePane={mobilePane()}
      back={back()}
    />
  );
};

/** `/entities` — the entity list. */
export const EntitiesList: Component = () => <EntitiesShell view="list" />;

/** `/entities/:entityId` — one entity. */
export const EntityDetailRoute: Component = () => (
  <EntitiesShell view="detail" />
);
