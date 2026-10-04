import type { Component } from "solid-js";

import { PromotionsPage } from "~/components/lore/PromotionsPage";
import { Nav } from "~/components/shell/Nav";
import { Shell } from "~/components/shell/Shell";
import { useWorkspace } from "./workspace";

export const PromotionsRoute: Component = () => {
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
      detail={<PromotionsPage />}
      mobilePane="detail"
      back={{ href: "/", label: "Projects" }}
    />
  );
};
