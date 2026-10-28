// Static, shared choices: selecting a client never executes a command or stores credentials.
export const SETUP_AGENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    guide: "with-claude-code",
    command: "lore run claude",
    detail:
      "Run this from your project. Lore launches your installed Claude Code client with routing for this session.",
  },
  {
    id: "codex",
    name: "Codex CLI",
    guide: "with-codex",
    command: "lore run codex",
    detail:
      "Run this from your project. Lore launches Codex with per-session routing and your existing Codex authentication.",
  },
  {
    id: "codex-desktop",
    name: "Codex Desktop",
    guide: "with-codex",
    command: "lore setup codex\nlore start --bg --local",
    detail:
      "Configure routing once, start the local gateway, then fully quit and reopen Codex Desktop. Setup backs up the settings it changes.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    guide: "with-opencode",
    command: "lore run opencode",
    detail:
      "Run this from your project. The launcher supplies the Lore plugin configuration to your installed OpenCode client.",
  },
  {
    id: "pi",
    name: "Pi",
    guide: "with-pi",
    command: "pi install\nlore run pi",
    detail:
      "First add npm:@loreai/pi@latest to the packages array in Pi’s settings.json. The @loreai/pi extension handles routing and memory hooks; pi install installs the configured extension.",
  },
  {
    id: "hermes",
    name: "Hermes",
    guide: "with-hermes",
    command: "lore run hermes",
    detail:
      "Run this from your project. Lore launches your installed Hermes Agent with routing for this session.",
  },
] as const;
export function setupAgent(value: string | null) {
  return SETUP_AGENTS.find((agent) => agent.id === value) ?? SETUP_AGENTS[0];
}
