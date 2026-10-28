import type { CampRenderer } from "../lib/memory-camp-renderer";
import type { MemoryPhase } from "../lib/memory-camp";

const phases: readonly MemoryPhase[] = ["conversation", "knowledge", "recall"];
const titles = {
  conversation: "Campfire",
  knowledge: "Scribe’s desk",
  recall: "Quest gate",
};
for (const root of document.querySelectorAll<HTMLElement>(".memory-camp")) {
  const art = root.querySelector<HTMLElement>(".camp-art");
  const hint = root.querySelector<HTMLElement>(".camp-hint");
  if (!art || !hint) continue;
  const element = art,
    help = hint;
  let renderer: CampRenderer | null = null;
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
    element.dataset.renderer = value ? "webgl" : "static";
    if (!value) {
      element
        .querySelectorAll<HTMLElement>("[data-rest-style]")
        .forEach((label) => {
          label.style.cssText = label.dataset.restStyle ?? "";
        });
    }
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
      ? `Select ${titles[next]}`
      : "Choose the campfire, desk, or gate to explore.";
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
  const fallback = root.querySelector<SVGElement>(".camp-fallback");
  const fallbackPhase = (target: EventTarget | null) => {
    const value = (target as Element | null)?.closest<SVGElement>(
      "[data-camp-region]",
    )?.dataset.campRegion;
    return phases.includes(value as MemoryPhase)
      ? (value as MemoryPhase)
      : null;
  };
  let staticPress: {
      id: number;
      x: number;
      y: number;
      phase: MemoryPhase | null;
      moved: boolean;
    } | null = null,
    staticTap: MemoryPhase | null = null;
  fallback?.addEventListener("pointerdown", (event) => {
    staticTap = null;
    staticPress =
      event.isPrimary && event.button === 0
        ? {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            phase: fallbackPhase(event.target),
            moved: false,
          }
        : null;
  });
  fallback?.addEventListener("pointermove", (event) => {
    if (
      staticPress &&
      staticPress.id === event.pointerId &&
      Math.hypot(event.clientX - staticPress.x, event.clientY - staticPress.y) >
        7
    )
      staticPress.moved = true;
  });
  fallback?.addEventListener("pointerup", (event) => {
    if (!staticPress || staticPress.id !== event.pointerId) return;
    staticTap =
      !staticPress.moved &&
      Math.hypot(
        event.clientX - staticPress.x,
        event.clientY - staticPress.y,
      ) <= 7
        ? staticPress.phase
        : null;
    staticPress = null;
  });
  fallback?.addEventListener("pointercancel", () => {
    staticPress = null;
    staticTap = null;
  });
  fallback?.addEventListener("click", () => {
    const phase = staticTap;
    staticTap = null;
    if (phase) select(phase);
  });
  fallback?.addEventListener("pointerover", (event) => {
    const value = (event.target as Element).closest<SVGElement>(
      "[data-camp-region]",
    )?.dataset.campRegion;
    hover(
      phases.includes(value as MemoryPhase) ? (value as MemoryPhase) : null,
    );
  });
  fallback?.addEventListener("pointerleave", () => {
    if (staticPress) {
      staticPress = null;
      staticTap = null;
    }
    hover(null);
  });
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
      const module = await import("../lib/memory-camp-renderer");
      if (ticket !== generation || !allowed() || !visible || document.hidden)
        return;
      renderer = module.mountCamp(element, ready, {
        select,
        hover,
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
