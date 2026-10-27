import * as THREE from "three";
import {
  MEMORY_NODES,
  MEMORY_WEAVE,
  tileRotation,
  MEMORY_THREADS,
  REST_PITCH,
  REST_YAW,
  WORLD_SIZE,
  connectionPoints,
  type MemoryPhase,
} from "./memory-graph";

export interface GraphRenderer {
  setPhase(phase: MemoryPhase): void;
  setMotion(enabled: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

// Only this lazily imported module loads Three. The server-rendered SVG is always present.
export function mountGraph(
  element: HTMLElement,
  onReady: (ready: boolean) => void,
): GraphRenderer | null {
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
  let disposed = false;
  let frame = 0;
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    cleanups.forEach((cleanup) => cleanup());
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        geometries.add(object.geometry);
        if (object instanceof THREE.InstancedMesh) object.dispose();
        (Array.isArray(object.material)
          ? object.material
          : [object.material]
        ).forEach((material) => materials.add(material));
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    scene.clear();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    onReady(false);
  }
  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    element.appendChild(canvas);
    const camera = new THREE.OrthographicCamera(
      -WORLD_SIZE / 2,
      WORLD_SIZE / 2,
      WORLD_SIZE / 2,
      -WORLD_SIZE / 2,
      1,
      1200,
    );
    camera.position.z = 600;
    const graph = new THREE.Group();
    graph.rotation.set(REST_PITCH, REST_YAW, 0);
    scene.add(graph);
    scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const key = new THREE.DirectionalLight(0xfff6df, 2.8);
    key.position.set(-120, 180, 300);
    scene.add(key);
    const nodeGeometry = new THREE.IcosahedronGeometry(1, 0);
    const nodes = MEMORY_NODES.map((node) => {
      const mesh = new THREE.Mesh(
        nodeGeometry,
        new THREE.MeshStandardMaterial({ roughness: 0.76, metalness: 0.16 }),
      );
      mesh.position.set(...node.position);
      mesh.scale.setScalar(node.radius);
      graph.add(mesh);
      return mesh;
    });
    const connections = MEMORY_NODES.map((node) => {
      const points = connectionPoints(node.position).map(
        (point) => new THREE.Vector3(...point),
      );
      const curve = new THREE.CubicBezierCurve3(
        points[0],
        points[1],
        points[2],
        points[3],
      );
      const mesh = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(56)),
        new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }),
      );
      graph.add(mesh);
      return mesh;
    });
    const tileGeometry = new THREE.BoxGeometry(5.4, 8.8, 7.6);
    const tileMaterials = [0, 1, 2].map(
      () =>
        new THREE.MeshStandardMaterial({ roughness: 0.58, metalness: 0.12 }),
    );
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    tileMaterials.forEach((material, phaseIndex) => {
      const tiles = new THREE.InstancedMesh(tileGeometry, material, 72);
      for (let index = 0; index < 72; index++) {
        const tileIndex = phaseIndex * 72 + index;
        position.set(...MEMORY_WEAVE[tileIndex]);
        rotation.set(...tileRotation(tileIndex));
        matrix.compose(position, rotation, scale);
        tiles.setMatrixAt(index, matrix);
      }
      tiles.instanceMatrix.needsUpdate = true;
      graph.add(tiles);
    });
    const threadMaterial = new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0.32,
    });
    const threadPositions = MEMORY_THREADS.flatMap(([a, b]) => [
      ...MEMORY_WEAVE[a],
      ...MEMORY_WEAVE[b],
    ]);
    const threadGeometry = new THREE.BufferGeometry();
    threadGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(threadPositions, 3),
    );
    graph.add(new THREE.LineSegments(threadGeometry, threadMaterial));
    let phase: MemoryPhase = "conversation";
    let automatic = true;
    let visible = false;
    let lost = false;
    let announced = false;
    let lastTime = 0;
    let elapsed = 0;
    let targetX = 0,
      targetY = 0;
    let currentX = 0,
      currentY = 0;
    let touchId: number | null = null;
    let accent = new THREE.Color(0xb45309);
    let neutral = new THREE.Color(0x8c9a7d);
    const probe = document.createElement("canvas").getContext("2d");
    function color(token: string, fallback: string): THREE.Color {
      if (!probe) return new THREE.Color(fallback);
      try {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle =
          getComputedStyle(element).getPropertyValue(token).trim() || fallback;
        probe.fillRect(0, 0, 1, 1);
        const bytes = probe.getImageData(0, 0, 1, 1).data;
        return new THREE.Color(`rgb(${bytes[0]},${bytes[1]},${bytes[2]})`);
      } catch {
        return new THREE.Color(fallback);
      }
    }
    function palette() {
      accent = color("--accent", "#b45309");
      neutral = color("--palette-base-500", "#719078");
      const dark = document.documentElement.dataset.theme === "dark";
      const phases = ["conversation", "knowledge", "recall"];
      tileMaterials.forEach((material, index) => {
        material.color.set(
          phases[index] === phase
            ? dark
              ? "#52846b"
              : "#345b47"
            : dark
              ? "#c4c7b1"
              : "#b7bdab",
        );
      });
      threadMaterial.color.copy(color("--muted", "#52604a"));
      threadMaterial.opacity = dark ? 0.18 : 0.12;
      MEMORY_NODES.forEach((node, index) => {
        const selected = node.phase === phase;
        nodes[index].material.color.copy(selected ? accent : neutral);
        connections[index].material.color.copy(selected ? accent : neutral);
        connections[index].material.opacity = selected ? 0.65 : 0.12;
      });
      resume();
    }
    function stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
    }
    function animate(now: number) {
      frame = 0;
      if (disposed || lost || !visible || document.hidden) return;
      const delta = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 1 / 60;
      lastTime = now;
      if (automatic) elapsed += delta;
      const easing = 1 - Math.exp(-delta * 9);
      currentX += (targetX - currentX) * easing;
      currentY += (targetY - currentY) * easing;
      graph.rotation.x =
        REST_PITCH - currentY * 0.18 + Math.sin(elapsed * 0.24) * 0.085;
      graph.rotation.y =
        REST_YAW + currentX * 0.42 + Math.sin(elapsed * 0.16) * 0.22;
      nodes.forEach((mesh, index) => {
        const node = MEMORY_NODES[index];
        const distance = Math.hypot(
          node.position[0] - currentX * 150,
          node.position[1] + currentY * 150,
        );
        const lift =
          Math.exp((-distance * distance) / 2400) *
          (Math.abs(currentX) + Math.abs(currentY)) *
          9;
        mesh.scale.setScalar(node.radius + lift * 0.09);
        mesh.rotation.y = elapsed * 0.15;
      });
      renderer.render(scene, camera);
      if (!announced) {
        announced = true;
        onReady(true);
      }
      if (
        automatic ||
        Math.abs(targetX - currentX) > 0.0005 ||
        Math.abs(targetY - currentY) > 0.0005
      )
        resume();
    }
    function resume() {
      if (!frame && visible && !lost && !disposed && !document.hidden)
        frame = requestAnimationFrame(animate);
    }
    function resize() {
      if (disposed || lost) return;
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.left = ((-WORLD_SIZE / 2) * width) / height;
      camera.right = ((WORLD_SIZE / 2) * width) / height;
      camera.updateProjectionMatrix();
      resume();
    }
    function reset() {
      targetX = 0;
      targetY = 0;
      touchId = null;
      resume();
    }
    function move(event: PointerEvent) {
      if (
        !visible ||
        (event.pointerType !== "mouse" && event.pointerId !== touchId)
      )
        return;
      const bounds = element.getBoundingClientRect();
      targetX = Math.max(
        -1,
        Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1),
      );
      targetY = Math.max(
        -1,
        Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1),
      );
      resume();
    }
    function down(event: PointerEvent) {
      if (event.isPrimary && event.pointerType !== "mouse") {
        touchId = event.pointerId;
        move(event);
      }
    }
    function up(event: PointerEvent) {
      if (event.pointerId === touchId) reset();
    }
    function contextLost(event: Event) {
      event.preventDefault();
      lost = true;
      announced = false;
      stop();
      onReady(false);
    }
    function contextRestored() {
      lost = false;
      resize();
      palette();
      resume();
    }
    const resizeObserver = new ResizeObserver(resize);
    cleanups.push(() => resizeObserver.disconnect());
    resizeObserver.observe(element);
    const themeObserver = new MutationObserver(palette);
    cleanups.push(() => themeObserver.disconnect());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    cleanups.push(() => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("pointerleave", reset);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
    });
    element.addEventListener("pointermove", move, { passive: true });
    element.addEventListener("pointerdown", down, { passive: true });
    element.addEventListener("pointerup", up, { passive: true });
    element.addEventListener("pointercancel", up, { passive: true });
    element.addEventListener("pointerleave", reset);
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    resize();
    palette();
    return {
      setPhase(next) {
        phase = next;
        palette();
      },
      setMotion(enabled) {
        automatic = enabled;
        resume();
      },
      setVisible(next) {
        visible = next;
        if (visible) resume();
        else {
          stop();
          targetX = 0;
          targetY = 0;
        }
      },
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}
