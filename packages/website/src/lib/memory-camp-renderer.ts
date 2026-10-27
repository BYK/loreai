import * as THREE from "three";
import {
  createCamp,
  disposeCamp,
  PHASES,
  TOKENS,
  type CampToken,
  type Camp,
  type MemoryPhase,
} from "./memory-camp";
export interface CampRenderer {
  setPhase(phase: MemoryPhase, animate?: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
interface Events {
  select(phase: MemoryPhase): void;
  hover(phase: MemoryPhase | null): void;
  failure(): void;
}
export function mountCamp(
  element: HTMLElement,
  onReady: (ready: boolean) => void,
  events: Events,
): CampRenderer | null {
  const canvas = document.createElement("canvas");
  let renderer: THREE.WebGLRenderer;
  try {
    const context = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
    });
    if (!context) return null;
    renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      alpha: true,
      antialias: true,
    });
  } catch {
    return null;
  }
  let camp: Camp;
  try {
    camp = createCamp();
  } catch {
    renderer.dispose();
    renderer.forceContextLoss();
    return null;
  }
  const {
    scene,
    world,
    camera,
    mats,
    places,
    paths,
    stones,
    rings,
    hero,
    feet,
    carried,
    opening,
    warmth,
    sky,
    light,
    shadow,
    heroPoint,
  } = camp;
  const cleanups: (() => void)[] = [];
  let disposed = false,
    lost = false,
    announced = false,
    visible = false,
    frame = 0;
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    frame = 0;
    cleanups.forEach((cleanup) => cleanup());
    disposeCamp(scene);
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    delete element.dataset.tracing;
    onReady(false);
    events.hover(null);
  }
  try {
    element.append(canvas);
    renderer.debug.onShaderError = () => {
      throw new Error("Camp shader compilation failed");
    };
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    let phase = 0,
      cursor = 0,
      hovered = -1;
    let travel: {
      from: number;
      to: number;
      started: number | null;
      duration: number;
    } | null = null;
    let press: {
        id: number;
        x: number;
        y: number;
        selection: number;
        moved: boolean;
      } | null = null,
      pendingTap: number | null = null;
    const paletteColors = {} as Record<CampToken, THREE.Color>;
    function color(token: string) {
      const probe = document.createElement("span");
      probe.style.color = `var(--camp-${token})`;
      probe.hidden = true;
      element.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return new THREE.Color(value);
    }
    function paint() {
      if (!paletteColors.stone) return;
      rings.forEach((ring, i) => {
        ring.material.color.copy(paletteColors.gold);
        ring.material.opacity =
          i === phase ? 0.85 : i === hovered ? 0.45 : 0.08;
      });
      stones.forEach(({ stone, position }) =>
        stone.material.color
          .copy(paletteColors.stone)
          .lerp(paletteColors.gold, position <= cursor ? 0.32 : 0),
      );
      opening.material.opacity = phase === 2 ? 0.27 : 0.1;
      hero.position.copy(heroPoint(cursor));
      carried.visible = cursor > 0.7;
    }
    function palette() {
      for (const token of TOKENS) {
        paletteColors[token] = color(token);
        mats[token].color.copy(paletteColors[token]);
      }
      mats.fire.emissive.copy(paletteColors.fire).multiplyScalar(0.25);
      sky.color.copy(color("sky"));
      sky.groundColor.copy(paletteColors.moss);
      light.color.copy(color("light"));
      warmth.color.copy(paletteColors.fire);
      opening.material.color.copy(paletteColors.cloth);
      shadow.material.color.copy(color("shadow"));
      paint();
      schedule();
    }
    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    function hover(next: number) {
      if (next === hovered) return;
      hovered = next;
      paint();
      events.hover(next < 0 ? null : PHASES[next]);
      schedule();
    }
    function settle() {
      press = null;
      pendingTap = null;
      hover(-1);
      travel = null;
      cursor = phase;
      feet.forEach((foot) => (foot.rotation.x = 0));
      paint();
      delete element.dataset.tracing;
    }
    function fit() {
      if (disposed || lost) return;
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camp.fit(width, height);
      schedule();
    }
    function render(now: number) {
      frame = 0;
      if (disposed || lost || !visible || document.hidden) return;
      try {
        if (travel) {
          if (travel.started === null) travel.started = now;
          const t = Math.min(1, (now - travel.started) / travel.duration),
            ease = t * t * (3 - 2 * t);
          cursor = travel.from + (travel.to - travel.from) * ease;
          paint();
          const leg = Math.min(1, Math.floor(Math.min(cursor, 1.999))),
            direction = paths[leg].getTangentAt(
              Math.max(0, Math.min(1, cursor - leg)),
            );
          hero.rotation.y =
            Math.atan2(direction.x, direction.z) +
            (travel.to < travel.from ? Math.PI : 0);
          hero.position.y += Math.sin(t * Math.PI * 18) * 0.035;
          feet[0].rotation.x = Math.sin(t * Math.PI * 18) * 0.35;
          feet[1].rotation.x = -feet[0].rotation.x;
          if (t === 1) {
            travel = null;
            cursor = phase;
            paint();
            feet.forEach((foot) => (foot.rotation.x = 0));
            delete element.dataset.tracing;
          }
        }
        renderer.render(scene, camera);
        if (!announced) {
          announced = true;
          onReady(true);
        }
        if (travel) schedule();
      } catch {
        dispose();
        events.failure();
      }
    }
    function schedule() {
      if (!frame && !disposed && !lost && visible && !document.hidden)
        frame = requestAnimationFrame(render);
    }
    function setPhase(next: MemoryPhase, animate = true) {
      if (disposed) return;
      const previous = phase;
      phase = PHASES.indexOf(next);
      if (
        animate &&
        announced &&
        !lost &&
        visible &&
        !document.hidden &&
        phase !== previous
      ) {
        travel = {
          from: cursor,
          to: phase,
          started: null,
          duration: Math.abs(cursor - phase) > 1 ? 1450 : 900,
        };
        element.dataset.tracing = String(phase);
      } else {
        travel = null;
        cursor = phase;
        feet.forEach((foot) => (foot.rotation.x = 0));
        delete element.dataset.tracing;
      }
      paint();
      schedule();
    }
    const raycaster = new THREE.Raycaster(),
      pointer = new THREE.Vector2();
    function locate(x: number, y: number) {
      if (disposed || lost || !visible) return -1;
      const bounds = canvas.getBoundingClientRect();
      pointer.set(
        ((x - bounds.left) / bounds.width) * 2 - 1,
        1 - ((y - bounds.top) / bounds.height) * 2,
      );
      world.updateMatrixWorld(true);
      raycaster.setFromCamera(pointer, camera);
      let object: THREE.Object3D | null =
        raycaster.intersectObjects(places, true)[0]?.object ?? null;
      while (object) {
        if (object.userData.stage !== undefined)
          return object.userData.stage as number;
        object = object.parent;
      }
      return -1;
    }
    function down(event: PointerEvent) {
      pendingTap = null;
      if (!event.isPrimary || event.button !== 0) {
        press = null;
        return;
      }
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        selection: locate(event.clientX, event.clientY),
        moved: false,
      };
    }
    function move(event: PointerEvent) {
      if (
        press &&
        press.id === event.pointerId &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) > 7
      )
        press.moved = true;
      if (event.pointerType === "mouse")
        hover(locate(event.clientX, event.clientY));
    }
    function up(event: PointerEvent) {
      if (!press || press.id !== event.pointerId) return;
      pendingTap =
        !press.moved &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 7
          ? press.selection
          : null;
      press = null;
    }
    function cancel() {
      press = null;
      pendingTap = null;
      hover(-1);
    }
    function leave() {
      // Touch emits pointerleave after pointerup, before click. Keep the saved tap.
      if (press) {
        press = null;
        pendingTap = null;
      }
      hover(-1);
    }
    function click() {
      const index = pendingTap;
      pendingTap = null;
      if (index !== null && index >= 0) events.select(PHASES[index]);
    }
    function contextLost(event: Event) {
      event.preventDefault();
      lost = true;
      announced = false;
      stop();
      settle();
      onReady(false);
    }
    function contextRestored() {
      lost = false;
      fit();
      palette();
      schedule();
    }
    const ro = new ResizeObserver(fit);
    cleanups.push(() => ro.disconnect());
    ro.observe(element);
    const mo = new MutationObserver(palette);
    cleanups.push(() => mo.disconnect());
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    for (const [type, handler] of Object.entries({
      pointerdown: down,
      pointermove: move,
      pointerup: up,
      pointercancel: cancel,
      pointerleave: leave,
      click,
      webglcontextlost: contextLost,
      webglcontextrestored: contextRestored,
    })) {
      canvas.addEventListener(type, handler as EventListener, {
        passive: type !== "webglcontextlost",
      });
      cleanups.push(() =>
        canvas.removeEventListener(type, handler as EventListener),
      );
    }
    fit();
    palette();
    setPhase("conversation", false);
    return {
      setPhase,
      setVisible(next) {
        visible = next;
        if (visible) schedule();
        else {
          stop();
          settle();
        }
      },
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}
