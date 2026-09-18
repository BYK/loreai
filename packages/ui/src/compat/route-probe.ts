import { createSignal } from "solid-js";

/**
 * Counters bumped by the router probe routes so tests (and the page itself)
 * can observe that Solid Router creates and disposes route components.
 */
const [mounted, setMounted] = createSignal<Record<string, number>>({});
const [disposed, setDisposed] = createSignal<Record<string, number>>({});

function bump(set: typeof setMounted, name: string): void {
  set((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
}

export const routeProbe = {
  mounted,
  disposed,
  recordMount: (name: string): void => bump(setMounted, name),
  recordDispose: (name: string): void => bump(setDisposed, name),
  reset(): void {
    setMounted({});
    setDisposed({});
  },
};
