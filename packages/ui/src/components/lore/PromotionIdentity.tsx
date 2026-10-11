import type { Component } from "solid-js";

export const PromotionIdentity: Component<{
  label: string | null;
}> = (props) => <span>{props.label ?? "Former member"}</span>;
