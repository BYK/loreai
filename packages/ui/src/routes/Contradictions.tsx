import type { Component } from "solid-js";

import { ContradictionsPage } from "~/components/lore/ContradictionsPage";
import { Nav } from "~/components/shell/Nav";
import { Shell } from "~/components/shell/Shell";
import { useWorkspace } from "./workspace";

export const ContradictionsRoute: Component = () => {
  const ws = useWorkspace();
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

  return (
    <Shell
      nav={nav}
      detail={<ContradictionsPage />}
      mobilePane="detail"
      back={{ href: "/", label: "Projects" }}
    />
  );
};
