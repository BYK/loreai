import type { GraphRenderer } from "../lib/memory-graph-renderer";
import type { MemoryPhase } from "../lib/memory-graph";

for (const sculpture of document.querySelectorAll<HTMLElement>(
  ".memory-sculpture",
)) {
  const element = sculpture.querySelector<HTMLElement>(".memory-graph");
  const button = sculpture.querySelector<HTMLButtonElement>(".graph-motion");
  if (
    !element ||
    !button ||
    !("IntersectionObserver" in window) ||
    !("ResizeObserver" in window)
  )
    continue;
  const graph = element;
  const motionButton = button;
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  let renderer: GraphRenderer | null = null;
  let visible = false;
  let loading = false;
  let failed = false;
  let automatic = true;
  let generation = 0;
  const phase = () =>
    (sculpture.querySelector<HTMLInputElement>(
      'input[name="memory-stage"]:checked',
    )?.value as MemoryPhase) ?? "conversation";
  const allowed = () => {
    const memory = (navigator as Navigator & { deviceMemory?: number })
      .deviceMemory;
    return !media.matches && (memory === undefined || memory > 2);
  };
  function ready(value: boolean) {
    graph.dataset.renderer = value ? "webgl" : "static";
    const hadFocus = document.activeElement === motionButton;
    motionButton.hidden = !value;
    if (!value && hadFocus)
      sculpture
        .querySelector<HTMLInputElement>('input[name="memory-stage"]:checked')
        ?.focus({ preventScroll: true });
  }
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
      const module = await import("../lib/memory-graph-renderer");
      await document.fonts.ready;
      if (ticket !== generation || !allowed() || !visible || document.hidden)
        return;
      renderer = module.mountGraph(graph, ready);
      if (!renderer) {
        failed = true;
        return;
      }
      renderer.setPhase(phase());
      renderer.setMotion(automatic);
      renderer.setVisible(true);
    } catch {
      failed = true;
      ready(false);
    } finally {
      if (ticket === generation) loading = false;
    }
  }
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    void sync();
  });
  observer.observe(graph);
  media.addEventListener("change", () => {
    void sync();
  });
  document.addEventListener("visibilitychange", () => {
    void sync();
  });
  sculpture
    .querySelectorAll<HTMLInputElement>('input[name="memory-stage"]')
    .forEach((input) =>
      input.addEventListener("change", () => renderer?.setPhase(phase())),
    );
  motionButton.addEventListener("click", () => {
    automatic = !automatic;
    renderer?.setMotion(automatic);
    motionButton.textContent = automatic ? "Pause motion" : "Play motion";
    motionButton.setAttribute(
      "aria-label",
      automatic ? "Pause graph motion" : "Play graph motion",
    );
  });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) {
      generation++;
      renderer?.dispose();
      renderer = null;
      observer.disconnect();
    }
  });
}
