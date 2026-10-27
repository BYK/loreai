import * as THREE from "three";
import {
  CAMERA_POSITION,
  PHASES,
  REST_YAW,
  TERRAIN_STEP,
  landscapeView,
  bandAtHeight,
  terrainLevels,
  type MemoryPhase,
} from "./memory-landscape";
export interface LandscapeRenderer {
  setPhase(phase: MemoryPhase): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
interface Events {
  select(phase: MemoryPhase): void;
  hover(phase: MemoryPhase | null): void;
  failure(): void;
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
      contourMaterials: { material: THREE.LineBasicMaterial; band: number }[] =
        [];
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
    let phase = 0,
      hovered = -1;
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
      palette();
      events.hover(hovered < 0 ? null : PHASES[hovered]);
    }
    function palette() {
      const low = color("--land-ivory", "#e4e7d5"),
        mid = color("--land-sage", "#8eae83"),
        high = color("--land-jade", "#37684b"),
        gold = color("--land-brass", "#b28240");
      materials.forEach(({ material, level }) => {
        const t = level / 80,
          band = bandAtHeight(level);
        material.color
          .copy(low)
          .lerp(
            band === phase ? high : mid,
            band === phase ? 0.65 + t * 0.25 : 0.18 + t * 0.3,
          );
        if (band === hovered && band !== phase) material.color.lerp(gold, 0.16);
      });
      contourMaterials.forEach(({ material, band }) => {
        material.color.copy(high).multiplyScalar(0.66);
        material.opacity =
          band === phase ? 0.3 : band === hovered ? 0.24 : 0.15;
      });
      schedule();
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
    function render() {
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
        world.updateMatrixWorld(true);
        renderer.render(scene, camera);
        if (!announced) {
          announced = true;
          onReady(true);
        }
        if (
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
    function setPhase(next: MemoryPhase) {
      if (disposed) return;
      phase = PHASES.indexOf(next);
      element.dataset.selectedBand = next;
      palette();
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
    setPhase("conversation");
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
