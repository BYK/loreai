import type { Component } from "solid-js";

import { PromotionsPage } from "~/components/lore/PromotionsPage";
import { Shell } from "~/components/shell/Shell";

export const PromotionsRoute: Component = () => {
  return (
    <Shell
      detail={<PromotionsPage />}
      mobilePane="detail"
      back={{ href: "/", label: "Projects" }}
    />
  );
};
