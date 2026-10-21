import type { Component } from "solid-js";

import { ContradictionsPage } from "~/components/lore/ContradictionsPage";
import { Shell } from "~/components/shell/Shell";

export const ContradictionsRoute: Component = () => {
  return (
    <Shell
      detail={<ContradictionsPage />}
      mobilePane="detail"
      back={{ href: "/", label: "Projects" }}
    />
  );
};
