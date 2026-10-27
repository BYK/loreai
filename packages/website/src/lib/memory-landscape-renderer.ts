import * as THREE from "three";
import {
  CAMERA_POSITION,
  PHASES,
  REST_YAW,
  SITES,
  TERRAIN_STEP,
  landscapeView,
  regionAt,
  terrainLevels,
  terrainTop,
  trailPoints,
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
    const regionUniforms = {
      uLandSites: { value: SITES.map(([x, z]) => new THREE.Vector2(x, z)) },
      uLandActive: { value: 0 },
      uLandHover: { value: -1 },
      uLandMuted: { value: new THREE.Color() },
      uLandSelected: { value: new THREE.Color() },
      uLandBrass: { value: new THREE.Color() },
    };
    function regionMaterial(material: THREE.MeshStandardMaterial) {
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, regionUniforms);
        shader.vertexShader = "varying vec2 vLandXZ;\n" + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvLandXZ = position.xz;",
        );
        shader.fragmentShader =
          "varying vec2 vLandXZ; uniform vec2 uLandSites[3]; uniform float uLandActive; uniform float uLandHover; uniform vec3 uLandMuted; uniform vec3 uLandSelected; uniform vec3 uLandBrass;\n" +
          shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
   vec2 a0=vLandXZ-uLandSites[0],a1=vLandXZ-uLandSites[1],a2=vLandXZ-uLandSites[2];
   float d0=dot(a0,a0),d1=dot(a1,a1),d2=dot(a2,a2);
   float regionId=(d0<=d1 && d0<=d2)?0.0:(d1<=d2?1.0:2.0);
   float landSelection=1.0-step(0.5,abs(regionId-uLandActive));
   vec3 quiet=mix(diffuseColor.rgb,uLandMuted,0.70);
   vec3 chosen=mix(diffuseColor.rgb,uLandSelected,0.40);
   diffuseColor.rgb=mix(quiet,chosen,landSelection);
   float hover=(1.0-step(0.5,abs(regionId-uLandHover)))*(1.0-landSelection);
   diffuseColor.rgb=mix(diffuseColor.rgb,uLandBrass,hover*0.16);
   float nearest=min(d0,min(d1,d2));
   float second=max(min(d0,d1),min(max(d0,d1),d2));
   float seam=1.0-smoothstep(0.0,240.0,second-nearest);
   diffuseColor.rgb=mix(diffuseColor.rgb,uLandBrass,seam*0.32);
  `,
        );
      };
      material.customProgramCacheKey = () => "lore-terrain-regions-v1";
    }
    const materials: { material: THREE.MeshStandardMaterial; level: number }[] =
        [],
      tierMeshes: THREE.Mesh[] = [],
      contourMaterials: THREE.LineBasicMaterial[] = [];
    for (const level of terrainLevels()) {
      const material = new THREE.MeshStandardMaterial({
        roughness: 0.89,
        metalness: 0.03,
      });
      regionMaterial(material);
      materials.push({ material, level: level.height });
      const edgeMaterial = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 0.21,
      });
      contourMaterials.push(edgeMaterial);
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
      cursor = 0,
      hovered = -1;
    const top = terrainTop;
    const sites = SITES;
    const pins = sites.map(([x, z], i) => {
      const group = new THREE.Group();
      group.position.set(x, top(x, z) + 1.2, z);
      world.add(group);
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(4.5, 4.8, 0.9, 32),
        new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.4 }),
      );
      base.position.y = 0.45;
      group.add(base);
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.65, 0.65, 7, 12),
        base.material,
      );
      stem.position.y = 4.4;
      group.add(stem);
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(2.25, 16, 12),
        base.material,
      );
      head.position.y = 8.1;
      group.add(head);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(7.3, 8.2, 48),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: i === phase ? 0.9 : 0.16,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.2;
      group.add(ring);
      return {
        group,
        base,
        ring,
        label: element.querySelector<HTMLElement>(
          `[data-marker="${PHASES[i]}"]`,
        )!,
      };
    });
    const routes: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>[] =
        [],
      routeCurves: THREE.CatmullRomCurve3[] = [],
      baseRoutes: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>[] =
        [];
    for (let route = 0; route < 2; route++) {
      const points = trailPoints(route).map(
        (point) => new THREE.Vector3(...point),
      );
      const routeCurve = new THREE.CatmullRomCurve3(
        points,
        false,
        "centripetal",
        0.5,
      );
      const base = new THREE.Mesh(
        new THREE.TubeGeometry(routeCurve, 350, 0.34, 6, false),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0.34,
          toneMapped: false,
        }),
      );
      world.add(base);
      baseRoutes.push(base);
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.98,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(routeCurve, 350, 0.57, 6, false),
        material,
      );
      world.add(mesh);
      routes.push(mesh);
      routeCurves.push(routeCurve);
    }
    const courier = new THREE.Mesh(
      new THREE.SphereGeometry(1.65, 16, 12),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
    );
    courier.visible = false;
    world.add(courier);

    let orbit = 0,
      tilt = 0,
      targetOrbit = 0,
      targetTilt = 0;
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
      orbit: number;
      tilt: number;
      moved: boolean;
      dragging: boolean;
      touch: boolean;
      selection: number;
    } | null = null;
    let pendingTap: number | null = null;
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
    function applyTrail(position: number) {
      routes.forEach((route, index) => {
        const fraction = clamp(position - index, 0, 1);
        route.geometry.setDrawRange(
          0,
          Math.floor((route.geometry.index!.count * fraction) / 36) * 36,
        );
      });
    }
    function hover(next: number) {
      if (next === hovered) return;
      hovered = next;
      regionUniforms.uLandHover.value = hovered;
      pins.forEach(
        (pin, index) =>
          (pin.ring.material.opacity =
            index === phase ? 0.92 : index === hovered ? 0.62 : 0.16),
      );
      events.hover(hovered < 0 ? null : PHASES[hovered]);
    }
    function palette() {
      const low = color("--land-ivory", "#e4e7d5"),
        mid = color("--land-sage", "#8eae83"),
        high = color("--land-jade", "#37684b"),
        gold = color("--land-brass", "#b28240");
      regionUniforms.uLandMuted.value.copy(mid);
      regionUniforms.uLandSelected.value.copy(high);
      regionUniforms.uLandBrass.value.copy(gold);
      materials.forEach(({ material, level }) => {
        const t = level / 80;
        material.color.copy(
          t < 0.2
            ? low.clone().lerp(mid, t / 0.2)
            : mid.clone().lerp(high, (t - 0.2) / 0.8),
        );
      });
      contourMaterials.forEach((material) =>
        material.color.copy(high).multiplyScalar(0.66),
      );
      pins.forEach((pin) => {
        pin.base.material.color.copy(gold);
        pin.ring.material.color.copy(gold);
      });
      routes.forEach((route) => route.material.color.copy(gold));
      baseRoutes.forEach((route) => route.material.color.copy(mid));
      courier.material.color.copy(gold);
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
      pendingTap = null;
      hover(-1);
      travel = null;
      cursor = phase;
      courier.visible = false;
      applyTrail(cursor);
      delete element.dataset.tracing;
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
    function updateLabels() {
      const { width, height } = element.getBoundingClientRect();
      pins.forEach(({ group, label }, index) => {
        const point = group
          .localToWorld(new THREE.Vector3(0, 15, 0))
          .project(camera);
        const half = label.offsetWidth / 2;
        label.style.left = `${clamp(((point.x + 1) * width) / 2, half + 8, width - half - 8)}px`;
        label.style.top = `${clamp(((1 - point.y) * height) / 2 - (index === 1 ? 15 : 0), 30, height - 20)}px`;
      });
    }
    function render(now: number) {
      frame = 0;
      if (disposed || lost || !visible || document.hidden) return;
      try {
        const easing = 0.17;
        orbit += (targetOrbit - orbit) * easing;
        tilt += (targetTilt - tilt) * easing;
        world.rotation.y = REST_YAW + orbit;
        world.rotation.x = tilt;
        if (travel) {
          if (travel.started === null) travel.started = now;
          const t = Math.min(1, (now - travel.started) / travel.duration),
            ease = t * t * (3 - 2 * t);
          cursor = travel.from + (travel.to - travel.from) * ease;
          applyTrail(cursor);
          const leg = Math.min(
            routeCurves.length - 1,
            Math.floor(Math.min(cursor, travel.to - 0.00001)),
          );
          courier.position.copy(
            routeCurves[leg].getPointAt(clamp(cursor - leg, 0, 1)),
          );
          courier.position.y += 1.4;
          courier.visible = t < 1;
          if (t === 1) {
            travel = null;
            cursor = phase;
            applyTrail(cursor);
            delete element.dataset.tracing;
          }
        }
        world.updateMatrixWorld(true);
        renderer.render(scene, camera);
        updateLabels();
        if (!announced) {
          announced = true;
          onReady(true);
        }
        if (
          travel ||
          Math.abs(targetOrbit - orbit) + Math.abs(targetTilt - tilt) > 0.0015
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
      const previous = phase;
      phase = PHASES.indexOf(next);
      regionUniforms.uLandActive.value = phase;
      if (animate && announced && !lost && phase > 0 && phase >= previous) {
        let from = phase === previous ? phase - 1 : Math.min(cursor, phase);
        if (from >= phase - 0.001) from = phase - 1;
        cursor = from;
        travel = {
          from,
          to: phase,
          started: null,
          duration: phase - from > 1 ? 900 : 650,
        };
        element.dataset.tracing = String(phase);
      } else {
        travel = null;
        cursor = phase;
        courier.visible = false;
        delete element.dataset.tracing;
      }
      applyTrail(cursor);
      pins.forEach((pin, index) => {
        pin.ring.material.opacity =
          index === phase ? 0.92 : index === hovered ? 0.62 : 0.16;
        pin.label.dataset.selected = String(index === phase);
      });
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
      for (let index = 0; index < pins.length; index++) {
        const b = pins[index].label.getBoundingClientRect();
        if (
          clientX >= b.left &&
          clientX <= b.right &&
          clientY >= b.top &&
          clientY <= b.bottom
        )
          return index;
      }
      rayPointer.set(
        ((clientX - r.left) / r.width) * 2 - 1,
        1 - ((clientY - r.top) / r.height) * 2,
      );
      world.updateMatrixWorld(true);
      raycaster.setFromCamera(rayPointer, camera);
      const hit = raycaster.intersectObjects(tierMeshes, false)[0];
      if (!hit) return -1;
      const local = world.worldToLocal(hit.point.clone());
      return regionAt(local.x, local.z);
    }
    function down(event: PointerEvent) {
      if (!event.isPrimary || event.button !== 0) {
        release();
        pendingTap = null;
        return;
      }
      pendingTap = null;
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        orbit: targetOrbit,
        tilt: targetTilt,
        moved: false,
        dragging: false,
        touch: event.pointerType !== "mouse",
        // Click coordinates can be rounded; keep the precise pointer hit.
        selection: locate(event.clientX, event.clientY),
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
          pendingTap = null;
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
          hover(-1);
          schedule();
          return;
        }
      }
      if (event.pointerType === "mouse") {
        hover(locate(event.clientX, event.clientY));
        schedule();
      }
    }
    function up(event: PointerEvent) {
      if (!press || press.id !== event.pointerId) return;
      pendingTap =
        !press.moved &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 7
          ? press.selection
          : null;
      release();
    }
    function cancel() {
      release();
      pendingTap = null;
      hover(-1);
      schedule();
    }
    function leave() {
      if (press?.dragging) return;
      if (press) {
        release();
        pendingTap = null;
      }
      hover(-1);
      schedule();
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
