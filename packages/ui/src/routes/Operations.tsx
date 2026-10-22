/** Warming and cost intelligence screens share the global workspace shell. */
import type { Component } from "solid-js";

import { CostsPage } from "~/components/lore/CostsPage";
import { ModelUsagePage } from "~/components/lore/ModelUsagePage";
import { WarmingPage } from "~/components/lore/WarmingPage";

export const WarmingRoute: Component = () => <WarmingPage />;

export const CostsRoute: Component = () => <CostsPage />;

export const ModelUsageRoute: Component = () => <ModelUsagePage />;
