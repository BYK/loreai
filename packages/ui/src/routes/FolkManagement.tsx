import type { Component } from "solid-js";

import { ConflictsPage } from "~/components/lore/ConflictsPage";
import { TeamPage } from "~/components/lore/TeamPage";
import { Nav } from "~/components/shell/Nav";
import { Shell } from "~/components/shell/Shell";
import { useWorkspace } from "./workspace";

const FolkManagementRoute: Component<{ view: "team" | "conflicts" }> = (
  props,
) => {
  const ws = useWorkspace();
  const nav = () => (
    <Nav
      projects={ws.projects.data()}
      loading={ws.projects.loading()}
      error={ws.projects.error()}
      activeProjectId={null}
      totalKnowledge={
        ws.projects
          .data()
          ?.reduce((count, project) => count + project.knowledge_count, 0) ??
        null
      }
      onRetry={ws.projects.reload}
      stale={ws.state.projects.status()}
    />
  );
  return (
    <Shell
      nav={nav}
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
