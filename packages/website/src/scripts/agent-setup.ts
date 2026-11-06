import { SETUP_AGENTS } from "../lib/agent-setup";
import { bindUrlChoice } from "./url-choice";
bindUrlChoice(
  ".agent-setup",
  "agent",
  SETUP_AGENTS.map((agent) => agent.id),
);
for (const setup of document.querySelectorAll<HTMLElement>(".agent-setup")) {
  setup
    .querySelectorAll<HTMLButtonElement>("[data-copy-setup]")
    .forEach((button) => {
      button.hidden = false;
      button.addEventListener("click", () => {
        void copy(button);
      });
    });
}
async function copy(button: HTMLButtonElement) {
  const panel = button.closest<HTMLElement>(".setup-panel"),
    status = panel?.querySelector<HTMLElement>(".setup-copy-status"),
    code = panel?.querySelector("code")?.textContent;
  if (!status || !code || button.disabled) return;
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(code);
    status.textContent = "Copied. Run this in your project’s terminal.";
  } catch {
    status.textContent =
      "Clipboard unavailable. Select and copy the command above.";
  } finally {
    button.disabled = false;
  }
}
