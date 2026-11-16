import { setUtilityIcon } from "./utility-icon";

type Diagram = { origin: HTMLElement };
let viewer: ReturnType<typeof createViewer> | undefined;

function createViewer() {
  const dialog = document.createElement("dialog");
  dialog.className = "media-dialog diagram-dialog";
  const toolbar = document.createElement("div");
  toolbar.className = "media-toolbar";
  const hint = document.createElement("p");
  hint.className = "media-hint";
  const status = document.createElement("output");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const canvas = document.createElement("div");
  canvas.className = "media-canvas diagram-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "region");
  canvas.setAttribute(
    "aria-label",
    "Media; scroll or use arrow keys to explore",
  );
  function button(label: string, text: string, action: () => void) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = text;
    control.setAttribute("aria-label", label);
    control.addEventListener("click", action);
    return control;
  }
  const fit = button("Fit to view", "Fit", () => resize(1));
  const minus = button("Zoom out", "−", () => resize(zoom - 0.25));
  const plus = button("Zoom in", "+", () => resize(zoom + 0.25));
  const close = button("Close image", "", () => dialog.close());
  close.className = "media-close diagram-close ui-icon-button";
  toolbar.append(fit, minus, status, plus, close);
  dialog.append(toolbar, hint, canvas);
  document.body.append(dialog);
  let trigger: HTMLElement | undefined;
  let diagram: Diagram | undefined;
  let media: SVGSVGElement | HTMLImageElement | undefined;
  let originalDiagramStyle: string | null = null;
  let zoom = 1;
  let fitWidth = 1;
  let fitHeight = 1;
  let drag: { x: number; y: number; left: number; top: number } | undefined;

  function resize(value: number) {
    zoom = Math.max(1, Math.min(4, value));
    status.textContent = zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`;
    minus.disabled = zoom === 1;
    plus.disabled = zoom === 4;
    if (!media) return;
    media.style.width = `${fitWidth * zoom}px`;
    media.style.height = `${fitHeight * zoom}px`;
    if (zoom === 1) canvas.scrollTo(0, 0);
  }
  function measure() {
    if (!media || !dialog.open) return;
    const width =
      media instanceof HTMLImageElement
        ? media.naturalWidth / 2
        : media.viewBox.baseVal.width;
    const height =
      media instanceof HTMLImageElement
        ? media.naturalHeight / 2
        : media.viewBox.baseVal.height;
    if (!width || !height) return;
    const scale = Math.min(
      1,
      (canvas.clientWidth - 2) / width,
      (canvas.clientHeight - 2) / height,
    );
    fitWidth = width * scale;
    fitHeight = height * scale;
    resize(zoom);
  }
  function content(node: SVGSVGElement | HTMLImageElement) {
    media = node;
    if (node instanceof SVGSVGElement)
      originalDiagramStyle = node.getAttribute("style");
    node.setAttribute("draggable", "false");
    canvas.replaceChildren(node);
    if (node instanceof HTMLImageElement) {
      node.style.width = "100%";
      node.style.height = "auto";
      node.addEventListener(
        "load",
        () => {
          if (media === node) measure();
        },
        { once: true },
      );
    }
    measure();
  }
  function open(
    opener: HTMLElement,
    node: SVGSVGElement | HTMLImageElement,
    record?: Diagram,
  ) {
    if (dialog.open) return;
    trigger = opener;
    diagram = record;
    zoom = 1;
    dialog.setAttribute(
      "aria-label",
      record ? "Expanded diagram" : "App screenshot",
    );
    setUtilityIcon(close, "close", record ? "Close diagram" : "Close image");
    hint.textContent = record
      ? "Fit or zoom. Scroll, drag, or use arrow keys to explore. + / − zoom; 0 fits; Escape closes."
      : "Read-only app capture. Fit or zoom; scroll, drag, or use arrow keys to explore. + / − zoom; 0 fits; Escape closes.";
    if (record)
      record.origin.style.minHeight = `${record.origin.getBoundingClientRect().height}px`;
    dialog.showModal();
    resize(1);
    content(node);
    close.focus({ preventScroll: true });
  }
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      resize(zoom + 0.25);
    } else if (event.key === "-") {
      event.preventDefault();
      resize(zoom - 0.25);
    } else if (event.key === "0") {
      event.preventDefault();
      resize(1);
    }
  });
  canvas.addEventListener("keydown", (event) => {
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-80, 0],
      ArrowRight: [80, 0],
      ArrowUp: [0, -80],
      ArrowDown: [0, 80],
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    canvas.scrollBy(...step);
  });
  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || zoom === 1)
      return;
    event.preventDefault();
    drag = {
      x: event.clientX,
      y: event.clientY,
      left: canvas.scrollLeft,
      top: canvas.scrollTop,
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("is-panning");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (drag)
      canvas.scrollTo(
        drag.left + drag.x - event.clientX,
        drag.top + drag.y - event.clientY,
      );
  });
  function stopDrag() {
    drag = undefined;
    canvas.classList.remove("is-panning");
  }
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  canvas.addEventListener("lostpointercapture", stopDrag);
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });
  dialog.addEventListener("close", () => {
    // Hidden or removed theme variants cannot receive focus safely.
    if (diagram?.origin.isConnected && media instanceof SVGSVGElement) {
      // A theme render can finish after close() but before its queued close event.
      // Keep that newer inline SVG instead of restoring a second stale one.
      if (!diagram.origin.querySelector(":scope > svg")) {
        if (originalDiagramStyle === null) media.removeAttribute("style");
        else media.setAttribute("style", originalDiagramStyle);
        diagram.origin.prepend(media);
      }
      diagram.origin.style.removeProperty("min-height");
    }
    const original = trigger;
    const fallback = original
      ?.closest("figure, section")
      ?.querySelectorAll<HTMLElement>(
        "a[data-media-viewer], button.diagram-expand",
      );
    const destination = [original, ...(fallback ?? [])].find(
      (element) => element?.isConnected && element.getClientRects().length,
    );
    destination?.focus({ preventScroll: true });
    trigger = undefined;
    diagram = undefined;
    media = undefined;
    canvas.replaceChildren();
    stopDrag();
  });
  window.addEventListener("resize", measure);
  return {
    open,
    refresh(origin: HTMLElement, svg: SVGSVGElement) {
      if (dialog.open && diagram?.origin === origin) content(svg);
    },
  };
}

export function expandDiagram(
  origin: HTMLElement,
  trigger: HTMLButtonElement,
  svg: SVGSVGElement,
) {
  (viewer ??= createViewer()).open(trigger, svg, { origin });
}
export function refreshExpandedDiagram(
  origin: HTMLElement,
  svg: SVGSVGElement,
) {
  viewer?.refresh(origin, svg);
}

// Only authored local PNG links are eligible; URL state never supplies media.
document.addEventListener("click", (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const link =
    event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[data-media-viewer]")
      : null;
  if (!link) return;
  const url = new URL(link.href, location.href);
  if (
    url.origin !== location.origin ||
    !/\/product-tour\/[a-z0-9-]+\.png$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    return;
  event.preventDefault();
  const image = document.createElement("img");
  image.src = url.href;
  image.alt =
    link.querySelector("img")?.alt ??
    "Read-only capture of the actual Lore app with sample data";
  (viewer ??= createViewer()).open(link, image);
});
