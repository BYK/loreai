import type { Component } from "solid-js";

export const PromotionIdentity: Component<{
  id: string;
  label: string | null;
}> = (props) => (
  <span title={props.label === null ? props.id : undefined}>
    {props.label ?? `Teammate ${props.id.slice(0, 8)}`}
  </span>
);
