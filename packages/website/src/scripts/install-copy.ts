// Shared by public pages and Starlight; no clipboard operation before an explicit click.
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-copy-install]",
)) {
  button.hidden = false;
  button.addEventListener("click", () => {
    void copyInstall(button);
  });
}
async function copyInstall(button: HTMLButtonElement) {
  const box = button.closest(".install-box"),
    status = box?.querySelector<HTMLElement>(".copy-status"),
    command = box?.querySelector("code")?.textContent;
  if (!command || !status || button.disabled) return;
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(command.trim());
    status.textContent =
      "Copied. Paste the command into your terminal to install Lore.";
  } catch {
    status.textContent =
      "Clipboard unavailable. Select and copy the command above, then paste it into your terminal.";
  } finally {
    button.disabled = false;
  }
}
