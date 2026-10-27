import type { LandscapeRenderer } from "../lib/memory-landscape-renderer";
import type { MemoryPhase } from "../lib/memory-landscape";

const phases: readonly MemoryPhase[] = ["conversation", "knowledge", "recall"];
for (const root of document.querySelectorAll<HTMLElement>(
  ".memory-landscape",
)) {
  const art = root.querySelector<HTMLElement>(".landscape-art");
  const hint = root.querySelector<HTMLElement>(".landscape-hint");
  if (!art || !hint) continue;
  const element = art,
    help = hint;
  let renderer: LandscapeRenderer | null = null;
  let visible = false,
    loading = false,
    failed = false,
    generation = 0,
    refining = false;
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
    help.textContent = refining
      ? current() === "conversation"
        ? "Returning to the conversation…"
        : current() === "knowledge"
          ? "Refining conversation into knowledge…"
          : "Carrying relevant knowledge to Orders…"
      : next
        ? {
            conversation: "Lower layers · Conversation",
            knowledge: "Middle layers · Distilled knowledge",
            recall: "Upper layers · Relevant context",
          }[next]
        : "Click a lower, middle or upper layer to explore.";
  }
  hover(null);
  root
    .querySelectorAll<HTMLInputElement>('input[name="memory-stage"]')
    .forEach((input) =>
      input.addEventListener("change", () => {
        root.dataset.activePhase = current();
        renderer?.setPhase(current());
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
        refining(active) {
          refining = active;
          hover((element.dataset.targetPhase as MemoryPhase) ?? null);
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
