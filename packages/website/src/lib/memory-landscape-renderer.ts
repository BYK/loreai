import * as THREE from "three";
import {
  CAMERA_POSITION,
  PHASES,
  REST_YAW,
  TERRAIN_STEP,
  landscapeView,
  bandAtHeight,
  terrainLevels,
  pointOnTerrain,
  refinementElevation,
  refinementDetailCount,
  type MemoryPhase,
} from "./memory-landscape";
export interface LandscapeRenderer {
  setPhase(phase: MemoryPhase, animate?: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
interface Events {
  select(phase: MemoryPhase): void;
  hover(phase: MemoryPhase | null): void;
  failure(): void;
  refining(active: boolean): void;
}
export function mountLandscape(
  element: HTMLElement,
  onReady: (ready: boolean) => void,
  events: Events,
): LandscapeRenderer | null {
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
  const scene = new THREE.Scene();
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
    const geometries = new Set<THREE.BufferGeometry>(),
      materials = new Set<THREE.Material>();
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        geometries.add(object.geometry);
        (Array.isArray(object.material)
          ? object.material
          : [object.material]
        ).forEach((material) => materials.add(material));
      }
      if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    scene.clear();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    onReady(false);
    delete element.dataset.refining;
    delete element.dataset.detailCount;
    events.refining(false);
    events.hover(null);
  }
  try {
    element.append(canvas);
    renderer.debug.onShaderError = () => {
      throw new Error("Landscape shader compilation failed");
    };
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.94;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const world = new THREE.Group();
    scene.add(world);
    const camera = new THREE.OrthographicCamera(-200, 200, 150, -150, 1, 1600);
    const view = landscapeView();
    camera.position.set(...CAMERA_POSITION);
    camera.lookAt(...view.focus);
    camera.updateMatrixWorld();
    scene.add(new THREE.HemisphereLight(0xfffdf4, 0x425a3c, 1.25));
    const key = new THREE.DirectionalLight(0xfff9e9, 2.5);
    key.position.set(-210, 350, 240);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, {
      left: -260,
      right: 260,
      top: 250,
      bottom: -250,
      near: 10,
      far: 900,
    });
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.35;
    key.shadow.radius = 3;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdce8d4, 0.6);
    fill.position.set(200, 130, -220);
    scene.add(fill);
    const materials: { material: THREE.MeshStandardMaterial; level: number }[] =
        [],
      tierMeshes: THREE.Mesh[] = [],
      contourMaterials: {
        material: THREE.LineBasicMaterial;
        band: number;
        level: number;
      }[] = [];
    for (const level of terrainLevels()) {
      const material = new THREE.MeshStandardMaterial({
        roughness: 0.89,
        metalness: 0.03,
      });
      materials.push({ material, level: level.height });
      const edgeMaterial = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 0.21,
      });
      contourMaterials.push({
        material: edgeMaterial,
        band: bandAtHeight(level.height),
        level: level.height,
      });
      for (const loop of level.loops) {
        const shape = new THREE.Shape(
          loop.map(([x, z]) => new THREE.Vector2(x, -z)),
        );
        const geometry = new THREE.ExtrudeGeometry(shape, {
          depth: level.height === 0 ? 5.2 : TERRAIN_STEP - 0.22,
          steps: 1,
          bevelEnabled: true,
          bevelSize: 0.22,
          bevelThickness: 0.16,
          bevelSegments: 1,
        });
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(
          0,
          level.height - (level.height === 0 ? 5.2 : TERRAIN_STEP - 0.22),
          0,
        );
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.band = bandAtHeight(level.height);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        world.add(mesh);
        tierMeshes.push(mesh);
        const points = loop.map(
          ([x, z]) => new THREE.Vector3(x, level.height + 0.22, z),
        );
        points.push(points[0].clone());
        const edge = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          edgeMaterial,
        );
        world.add(edge);
      }
    }
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(850, 850),
      new THREE.ShadowMaterial({ opacity: 0.13 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -6;
    shadow.receiveShadow = true;
    scene.add(shadow);
    const fragmentGeometry = new THREE.PlaneGeometry(5.4, 1.25);
    fragmentGeometry.rotateX(-Math.PI / 2);
    const fragments = Array.from({ length: 28 }, () => {
      const mesh = new THREE.Mesh(
        fragmentGeometry,
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          toneMapped: false,
          depthWrite: false,
        }),
      );
      mesh.visible = false;
      world.add(mesh);
      return mesh;
    });
    const colors = {
      low: new THREE.Color(),
      mid: new THREE.Color(),
      high: new THREE.Color(),
      gold: new THREE.Color(),
    };
    let phase = 0,
      cursor = 0,
      hovered = -1;
    let transition: {
      from: number;
      to: number;
      started: number | null;
      duration: number;
    } | null = null;
    let orbit = 0,
      tilt = 0,
      targetOrbit = 0,
      targetTilt = 0,
      pointerX = 0,
      pointerY = 0,
      targetX = 0,
      targetY = 0;
    let press: {
      id: number;
      x: number;
      y: number;
      orbit: number;
      tilt: number;
      moved: boolean;
      dragging: boolean;
      touch: boolean;
    } | null = null;
    let pendingTap = false;
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(max, value));
    const probe = document.createElement("canvas").getContext("2d");
    function color(token: string, fallback: string): THREE.Color {
      if (!probe) return new THREE.Color(fallback);
      try {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle =
          getComputedStyle(element).getPropertyValue(token).trim() || fallback;
        probe.fillRect(0, 0, 1, 1);
        const data = probe.getImageData(0, 0, 1, 1).data;
        return new THREE.Color(`rgb(${data[0]},${data[1]},${data[2]})`);
      } catch {
        return new THREE.Color(fallback);
      }
    }
    function hover(next: number) {
      if (next === hovered) return;
      hovered = next;
      paint();
      schedule();
      events.hover(hovered < 0 ? null : PHASES[hovered]);
    }
    function palette() {
      colors.low.copy(color("--land-ivory", "#e4e7d5"));
      colors.mid.copy(color("--land-sage", "#8eae83"));
      colors.high.copy(color("--land-jade", "#37684b"));
      colors.gold.copy(color("--land-brass", "#b28240"));
      fragments.forEach((mesh) => mesh.material.color.copy(colors.gold));
      paint();
      schedule();
    }
    function paint() {
      const { low, mid, high, gold } = colors;
      materials.forEach(({ material, level }) => {
        const t = level / 80,
          band = bandAtHeight(level),
          weight = Math.max(0, 1 - Math.abs(band - cursor));
        const selected = low.clone().lerp(high, 0.65 + t * 0.25);
        material.color
          .copy(low)
          .lerp(mid, 0.18 + t * 0.3)
          .lerp(selected, weight);
        if (band === hovered && band !== phase) material.color.lerp(gold, 0.16);
      });
      contourMaterials.forEach(({ material, band, level }) => {
        const weight = Math.max(0, 1 - Math.abs(band - cursor));
        const sweep = transition
          ? Math.exp(-(((level - refinementElevation(cursor)) / 5) ** 2))
          : 0;
        material.color
          .copy(high)
          .multiplyScalar(0.66)
          .lerp(gold, sweep * 0.75);
        material.opacity =
          0.15 +
          weight * 0.15 +
          sweep * 0.25 +
          (band === hovered && band !== phase ? 0.06 : 0);
      });
    }
    function finishTransition() {
      transition = null;
      cursor = phase;
      fragments.forEach((mesh) => {
        mesh.visible = false;
      });
      delete element.dataset.refining;
      delete element.dataset.detailCount;
      events.refining(false);
      paint();
    }
    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    function release() {
      if (press && canvas.hasPointerCapture(press.id))
        canvas.releasePointerCapture(press.id);
      press = null;
      delete element.dataset.dragging;
      canvas.style.removeProperty("cursor");
    }
    function settle() {
      release();
      pendingTap = false;
      targetX = targetY = 0;
      hover(-1);
      finishTransition();
    }
    function fit() {
      if (disposed || lost) return;
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      const half = landscapeView().halfHeight;
      camera.top = half;
      camera.bottom = -half;
      camera.left = (-half * width) / height;
      camera.right = (half * width) / height;
      camera.updateProjectionMatrix();
      schedule();
    }
    function render(now: number) {
      frame = 0;
      if (disposed || lost || !visible || document.hidden) return;
      try {
        const easing = 0.17;
        pointerX += (targetX - pointerX) * easing;
        pointerY += (targetY - pointerY) * easing;
        orbit += (targetOrbit - orbit) * easing;
        tilt += (targetTilt - tilt) * easing;
        world.rotation.y = REST_YAW + orbit + pointerX * 0.055;
        world.rotation.x = tilt + pointerY * 0.025;
        if (transition) {
          if (transition.started === null) transition.started = now;
          const t = Math.min(
              1,
              (now - transition.started) / transition.duration,
            ),
            ease = t * t * (3 - 2 * t);
          cursor = transition.from + (transition.to - transition.from) * ease;
          const count = refinementDetailCount(cursor),
            envelope = Math.sin(Math.PI * t) * 0.9;
          element.dataset.detailCount = String(Math.ceil(count));
          fragments.forEach((mesh, index) => {
            mesh.material.opacity =
              Math.min(1, Math.max(0, count - index)) * envelope;
            mesh.visible = mesh.material.opacity > 0.01;
            const angle = index * 2.3999632297 + cursor * 0.1;
            mesh.position.set(
              ...pointOnTerrain(refinementElevation(cursor), angle),
            );
            mesh.rotation.y = -angle;
            mesh.scale.x = 1.4 - cursor * 0.35;
          });
          paint();
          if (t === 1) finishTransition();
        }
        world.updateMatrixWorld(true);
        renderer.render(scene, camera);
        if (!announced) {
          announced = true;
          onReady(true);
        }
        if (
          transition ||
          Math.abs(targetX - pointerX) +
            Math.abs(targetY - pointerY) +
            Math.abs(targetOrbit - orbit) +
            Math.abs(targetTilt - tilt) >
            0.0015
        )
          schedule();
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
      phase = PHASES.indexOf(next);
      element.dataset.selectedBand = next;
      if (
        animate &&
        announced &&
        visible &&
        !lost &&
        Math.abs(cursor - phase) > 0.001
      ) {
        transition = {
          from: cursor,
          to: phase,
          started: null,
          duration: Math.abs(cursor - phase) > 1 ? 1200 : 850,
        };
        element.dataset.refining = "true";
        events.refining(true);
      } else finishTransition();
      paint();
      schedule();
    }
    const raycaster = new THREE.Raycaster(),
      rayPointer = new THREE.Vector2();
    function locate(clientX: number, clientY: number): number {
      if (disposed || lost || !visible) return -1;
      const r = element.getBoundingClientRect();
      if (
        clientX < r.left ||
        clientX > r.right ||
        clientY < r.top ||
        clientY > r.bottom
      )
        return -1;
      rayPointer.set(
        ((clientX - r.left) / r.width) * 2 - 1,
        1 - ((clientY - r.top) / r.height) * 2,
      );
      world.updateMatrixWorld(true);
      raycaster.setFromCamera(rayPointer, camera);
      const hit = raycaster.intersectObjects(tierMeshes, false)[0];
      if (!hit) return -1;
      return hit.object.userData.band as number;
    }
    function down(event: PointerEvent) {
      if (!event.isPrimary || event.button !== 0) {
        release();
        pendingTap = false;
        return;
      }
      pendingTap = false;
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        orbit: targetOrbit,
        tilt: targetTilt,
        moved: false,
        dragging: false,
        touch: event.pointerType !== "mouse",
      };
    }
    function move(event: PointerEvent) {
      if (press && event.pointerId === press.id) {
        const dx = event.clientX - press.x,
          dy = event.clientY - press.y;
        if (Math.hypot(dx, dy) > 7) press.moved = true;
        if (
          press.touch &&
          !press.dragging &&
          Math.abs(dy) > 8 &&
          Math.abs(dy) > Math.abs(dx)
        ) {
          release();
          pendingTap = false;
          return;
        }
        if (
          !press.dragging &&
          press.moved &&
          (!press.touch || Math.abs(dx) > Math.abs(dy) * 1.15)
        ) {
          press.dragging = true;
          canvas.setPointerCapture(event.pointerId);
          element.dataset.dragging = "true";
          canvas.style.cursor = "grabbing";
        }
        if (press.dragging) {
          targetOrbit = clamp(press.orbit + dx * 0.0045, -0.42, 0.42);
          if (!press.touch)
            targetTilt = clamp(press.tilt + dy * 0.0018, -0.1, 0.1);
          targetX = targetY = 0;
          hover(-1);
          schedule();
          return;
        }
      }
      if (event.pointerType === "mouse") {
        const r = element.getBoundingClientRect();
        targetX = ((event.clientX - r.left) / r.width - 0.5) * 2;
        targetY = ((event.clientY - r.top) / r.height - 0.5) * 2;
        hover(locate(event.clientX, event.clientY));
        schedule();
      }
    }
    function up(event: PointerEvent) {
      if (!press || press.id !== event.pointerId) return;
      pendingTap =
        !press.moved &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 7;
      release();
    }
    function cancel() {
      release();
      pendingTap = false;
      hover(-1);
      targetX = targetY = 0;
      schedule();
    }
    function leave() {
      if (press?.dragging) return;
      if (press) {
        release();
        pendingTap = false;
      }
      targetX = targetY = 0;
      hover(-1);
      schedule();
    }
    function click(event: MouseEvent) {
      const allowed = pendingTap;
      pendingTap = false;
      if (!allowed) return;
      const index = locate(event.clientX, event.clientY);
      if (index >= 0) events.select(PHASES[index]);
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
    cleanups.push(() => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("click", click);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
    });
    canvas.addEventListener("pointerdown", down, { passive: true });
    canvas.addEventListener("pointermove", move, { passive: true });
    canvas.addEventListener("pointerup", up, { passive: true });
    canvas.addEventListener("pointercancel", cancel, { passive: true });
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("click", click);
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
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
