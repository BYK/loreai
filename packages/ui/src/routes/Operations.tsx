/** Warming and cost intelligence screens share the global workspace shell. */
import type { Component } from "solid-js";

import { CostsPage } from "~/components/lore/CostsPage";
import { WarmingPage } from "~/components/lore/WarmingPage";
import { Nav } from "~/components/shell/Nav";
import { Shell } from "~/components/shell/Shell";
import { useWorkspace } from "./workspace";

const OperationsShell: Component<{ view: "warming" | "costs" }> = (props) => {
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
      detail={props.view === "warming" ? <WarmingPage /> : <CostsPage />}
      mobilePane="detail"
    />
  );
};

export const WarmingRoute: Component = () => <OperationsShell view="warming" />;

export const CostsRoute: Component = () => <OperationsShell view="costs" />;
