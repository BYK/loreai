import type { Component } from "solid-js";

import { ConflictsPage } from "~/components/lore/ConflictsPage";
import { TeamPage } from "~/components/lore/TeamPage";

const FolkManagementRoute: Component<{ view: "team" | "conflicts" }> = (
  props,
) => {
  return props.view === "team" ? <TeamPage /> : <ConflictsPage />;
};

export const TeamRoute: Component = () => <FolkManagementRoute view="team" />;

export const ConflictsRoute: Component = () => (
  <FolkManagementRoute view="conflicts" />
);
