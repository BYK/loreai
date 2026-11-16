// Enhance native radio groups with shareable, allowlisted state. No URL value is
// interpolated into markup, selectors, commands, or destinations.
export function bindUrlChoice(
  selector: string,
  parameter: string,
  choices: readonly string[],
) {
  const fallback = choices[0];
  if (!fallback) return;
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      `${selector} input[type="radio"]`,
    ),
  );
  if (!inputs.length) return;
  function restore() {
    const value =
      new URLSearchParams(location.search).get(parameter) ?? fallback;
    const selected = choices.includes(value) ? value : fallback;
    for (const input of inputs) input.checked = input.value === selected;
  }
  function select(value: string) {
    if (!choices.includes(value)) return;
    const url = new URL(location.href);
    if (url.searchParams.get(parameter) === value) return;
    url.searchParams.set(parameter, value);
    history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  // Native controls can be used before this enhancement loads. A valid explicit
  // URL takes precedence; otherwise retain an already-changed native selection.
  const initial = new URLSearchParams(location.search).get(parameter);
  if (!initial || !choices.includes(initial)) {
    const pending = inputs.find(
      (input) => input.checked && !input.defaultChecked,
    );
    if (pending) select(pending.value);
  }
  restore();
  for (const input of inputs)
    input.addEventListener("change", () => {
      if (!input.checked) return;
      select(input.value);
      restore();
    });
  window.addEventListener("popstate", restore);
}
