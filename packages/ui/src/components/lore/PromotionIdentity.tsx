import type { Component } from "solid-js";

export const PromotionIdentity: Component<{
  id: string;
  label: string | null;
}> = (props) => <span>{props.label ?? "Former member"}</span>;
