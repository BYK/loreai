import type { Component } from "solid-js";

import { ConflictsPage } from "~/components/lore/ConflictsPage";
import { TeamPage } from "~/components/lore/TeamPage";
import { Shell } from "~/components/shell/Shell";

const FolkManagementRoute: Component<{ view: "team" | "conflicts" }> = (
  props,
) => {
  return (
    <Shell
      detail={props.view === "team" ? <TeamPage /> : <ConflictsPage />}
      mobilePane="detail"
      back={{ href: "/", label: "Projects" }}
    />
  );
};

export const TeamRoute: Component = () => <FolkManagementRoute view="team" />;

export const ConflictsRoute: Component = () => (
  <FolkManagementRoute view="conflicts" />
);
