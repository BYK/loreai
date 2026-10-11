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
  const entityId = () => decodeParam(params.entityId);
  if (props.view === "list") return <EntitiesPage />;
  const id = entityId();
  if (!id) return <StateCard kind="error" title="Entity not found" />;
  return <EntityPage entityId={id} />;
};

/** `/entities` — the entity list. */
export const EntitiesList: Component = () => <EntitiesShell view="list" />;

/** `/entities/:entityId` — one entity. */
export const EntityDetailRoute: Component = () => (
  <EntitiesShell view="detail" />
);
