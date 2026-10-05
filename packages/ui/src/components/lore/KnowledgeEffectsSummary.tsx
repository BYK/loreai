import type { Component } from "solid-js";

import type { KnowledgeEffects } from "~/contracts";

export function loreEffectOutcome(effects: KnowledgeEffects): string {
  const lore = effects.lore_file;
  if (effects.project_id === null)
    return ".lore.md files are not affected (entries without a project are not exported)";
  if (!lore.enabled) return ".lore.md export is off";
  if (!lore.affected) return "The project .lore.md file is unavailable";
  return lore.regenerated
    ? "Project .lore.md regenerated"
    : "Project .lore.md was not regenerated";
}

export const KnowledgeEffectsSummary: Component<{
  effects: KnowledgeEffects;
  phase: "confirm" | "complete";
}> = (props) => {
  const loreText = () => {
    const lore = props.effects.lore_file;
    if (props.effects.project_id === null)
      return ".lore.md files are not affected (entries without a project are not exported)";
    if (props.phase === "confirm")
      return !lore.enabled
        ? ".lore.md export is off"
        : !lore.affected
          ? "The project .lore.md file is unavailable"
          : "This project's .lore.md is regenerated (when .lore.md export is enabled)";
    return loreEffectOutcome(props.effects);
  };

  const agentsText = () => {
    switch (props.effects.agents_file.mode) {
      case "pointer":
        return "The AGENTS.md pointer is unchanged";
      case "inline":
        return props.phase === "confirm"
          ? "The inline AGENTS.md section is rewritten only by the next idle exporter"
          : "The inline AGENTS.md section updates on the next idle export";
      case "off":
        return "AGENTS.md export is off";
    }
  };

  return (
    <ul class="my-3 list-disc space-y-1 pl-5 text-sm">
      <li>{loreText()}</li>
      <li>{agentsText()}</li>
      <li>
        {props.effects.sync.enabled
          ? "Sync is enabled"
          : "Sync is off; this change remains local until sync is configured"}
      </li>
    </ul>
  );
};
