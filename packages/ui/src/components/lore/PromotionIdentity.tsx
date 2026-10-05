import type { Component } from "solid-js";

export const PromotionIdentity: Component<{
  id: string;
  label: string | null;
  showId?: boolean;
}> = (props) => (
  <span title={props.showId ? props.id : undefined}>
    {props.label ?? "Former member"}
  </span>
);
