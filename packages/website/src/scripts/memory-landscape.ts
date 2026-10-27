import type { LandscapeRenderer } from "../lib/memory-landscape-renderer";
import type { MemoryPhase } from "../lib/memory-landscape";

const phases: readonly MemoryPhase[] = ["conversation", "knowledge", "recall"];
for (const root of document.querySelectorAll<HTMLElement>(
  ".memory-landscape",
)) {
  const art = root.querySelector<HTMLElement>(".landscape-art");
  const controls = root.querySelector<HTMLElement>(".landscape-controls");
  const rotation = root.querySelector<HTMLInputElement>(".landscape-rotate");
  const reset = root.querySelector<HTMLButtonElement>(".landscape-reset");
  const hint = root.querySelector<HTMLElement>(".landscape-hint");
  if (!art || !controls || !rotation || !reset || !hint) continue;
  const element = art,
    viewControls = controls,
    slider = rotation,
    help = hint;
  let renderer: LandscapeRenderer | null = null;
  let visible = false,
    loading = false,
    failed = false,
    generation = 0,
    keyboard = false;
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  const current = () =>
    (root.querySelector<HTMLInputElement>('input[name="memory-stage"]:checked')
      ?.value ?? "conversation") as MemoryPhase;
  const allowed = () => {
    const memory = (navigator as Navigator & { deviceMemory?: number })
      .deviceMemory;
    return !media.matches && (memory === undefined || memory > 2);
  };
  function ready(value: boolean) {
    const restoreFocus =
      !value && viewControls.contains(document.activeElement);
    element.dataset.renderer = value ? "webgl" : "static";
    viewControls.hidden = !value;
    if (!value) {
      slider.value = "0";
      element
        .querySelectorAll<HTMLElement>("[data-rest-style]")
        .forEach((label) => {
          label.style.cssText = label.dataset.restStyle ?? "";
        });
    }
    if (restoreFocus)
      root
        .querySelector<HTMLInputElement>('input[name="memory-stage"]:checked')
        ?.focus({ preventScroll: true });
  }
  function select(next: MemoryPhase) {
    const input = root.querySelector<HTMLInputElement>(
      `input[name="memory-stage"][value="${next}"]`,
    );
    if (!input) return;
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus({ preventScroll: true });
  }
  function hover(next: MemoryPhase | null) {
    if (next) element.dataset.targetPhase = next;
    else delete element.dataset.targetPhase;
    help.textContent = next
      ? `Select ${next}`
      : "Click a region to select its stage.";
  }
  hover(null);
  root.addEventListener("keydown", () => {
    keyboard = true;
  });
  root.addEventListener(
    "pointerdown",
    () => {
      keyboard = false;
    },
    { passive: true },
  );
  root
    .querySelectorAll<HTMLInputElement>('input[name="memory-stage"]')
    .forEach((input) =>
      input.addEventListener("change", () => {
        root.dataset.activePhase = current();
        renderer?.setPhase(current(), !keyboard);
        keyboard = false;
      }),
    );
  // The same region selection works with the SVG when GPU rendering is unavailable.
  const fallback = root.querySelector<SVGElement>(".landscape-fallback");
  fallback?.addEventListener("click", (event) => {
    const value = (event.target as Element).closest<SVGElement>(
      "[data-land-region]",
    )?.dataset.landRegion;
    if (phases.includes(value as MemoryPhase)) select(value as MemoryPhase);
  });
  fallback?.addEventListener("pointerover", (event) => {
    const value = (event.target as Element).closest<SVGElement>(
      "[data-land-region]",
    )?.dataset.landRegion;
    hover(
      phases.includes(value as MemoryPhase) ? (value as MemoryPhase) : null,
    );
  });
  fallback?.addEventListener("pointerleave", () => hover(null));
  slider.addEventListener("input", () =>
    renderer?.setRotation(slider.valueAsNumber),
  );
  reset.addEventListener("click", () => renderer?.resetView());
  async function sync() {
    if (!allowed()) {
      generation++;
      loading = false;
      renderer?.dispose();
      renderer = null;
      ready(false);
      return;
    }
    if (renderer) {
      renderer.setVisible(visible && !document.hidden);
      return;
    }
    if (!visible || document.hidden || loading || failed) return;
    loading = true;
    const ticket = ++generation;
    try {
      const module = await import("../lib/memory-landscape-renderer");
      if (ticket !== generation || !allowed() || !visible || document.hidden)
        return;
      renderer = module.mountLandscape(element, ready, {
        select,
        hover,
        rotation(value) {
          slider.value = String(value);
        },
        failure() {
          failed = true;
          renderer = null;
          ready(false);
        },
      });
      if (!renderer) {
        failed = true;
        return;
      }
      renderer.setPhase(current(), false);
      renderer.setVisible(true);
    } catch {
      failed = true;
      renderer?.dispose();
      renderer = null;
      ready(false);
    } finally {
      if (ticket === generation) loading = false;
    }
  }
  if (!("IntersectionObserver" in window) || !("ResizeObserver" in window))
    continue;
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    void sync();
  });
  observer.observe(element);
  media.addEventListener("change", () => {
    void sync();
  });
  document.addEventListener("visibilitychange", () => {
    void sync();
  });
  window.addEventListener("pagehide", (event) => {
    generation++;
    loading = false;
    renderer?.setVisible(false);
    if (!event.persisted) {
      renderer?.dispose();
      renderer = null;
      observer.disconnect();
    }
  });
  window.addEventListener("pageshow", () => {
    void sync();
  });
}
