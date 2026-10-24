/** Warming and cost intelligence screens share the global workspace shell. */
import type { Component } from "solid-js";

import { CostsPage } from "~/components/lore/CostsPage";
import { ModelUsagePage } from "~/components/lore/ModelUsagePage";
import { WarmingPage } from "~/components/lore/WarmingPage";
import { Shell } from "~/components/shell/Shell";

const OperationsShell: Component<{
  view: "warming" | "costs" | "model-usage";
}> = (props) => {
  return (
    <Shell
      detail={
        props.view === "warming" ? (
          <WarmingPage />
        ) : props.view === "costs" ? (
          <CostsPage />
        ) : (
          <ModelUsagePage />
        )
      }
      mobilePane="detail"
    />
  );
};

export const WarmingRoute: Component = () => <OperationsShell view="warming" />;

export const CostsRoute: Component = () => <OperationsShell view="costs" />;

export const ModelUsageRoute: Component = () => (
  <OperationsShell view="model-usage" />
);
