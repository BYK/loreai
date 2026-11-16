import { UI_ICONS, type UiIconName } from "../lib/ui-icons";

/** Static, named SVGs for controls created outside Astro templates. */
export function setUtilityIcon(
  button: HTMLButtonElement,
  icon: UiIconName,
  label: string,
) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", UI_ICONS[icon]);
  svg.append(path);
  button.replaceChildren(svg);
  button.setAttribute("aria-label", label);
  button.title = label;
}
