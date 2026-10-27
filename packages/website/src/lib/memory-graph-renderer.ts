import * as THREE from "three";
import {
  MEMORY_NODES,
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
  const textures: THREE.CanvasTexture[] = [];
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
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
        if (object instanceof THREE.Mesh) geometries.add(object.geometry);
        (Array.isArray(object.material)
          ? object.material
          : [object.material]
        ).forEach((material) => materials.add(material));
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
    scene.clear();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    onReady(false);
  }
  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
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
    scene.add(new THREE.AmbientLight(0xffffff, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-120, 180, 300);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffd99a, 0.65);
    fill.position.set(160, -80, 100);
    scene.add(fill);
    const hub = new THREE.Mesh(
      new THREE.SphereGeometry(45, 48, 32),
      new THREE.MeshStandardMaterial({
        color: 0x2a4d32,
        roughness: 0.38,
        metalness: 0.1,
      }),
    );
    graph.add(hub);
    const nodeGeometry = new THREE.SphereGeometry(1, 24, 16);
    const nodes = MEMORY_NODES.map((node) => {
      const mesh = new THREE.Mesh(
        nodeGeometry,
        new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.12 }),
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
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 40, 0.55, 6, false),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6 }),
      );
      graph.add(mesh);
      return mesh;
    });
    const orbitMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.2,
    });
    for (const radius of [158, 104, 58]) {
      const orbit = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.4, 5, 128),
        orbitMaterial,
      );
      orbit.position.z = -22;
      graph.add(orbit);
    }
    function label(
      text: string,
      position: readonly [number, number, number],
      width: number,
      color: string,
      serif = false,
    ) {
      const surface = document.createElement("canvas");
      surface.width = 768;
      surface.height = 160;
      const ctx = surface.getContext("2d");
      if (!ctx) return;
      const texture = new THREE.CanvasTexture(surface);
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push(texture);
      const material = new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(width, (width * 160) / 768, 1);
      sprite.position.set(...position);
      sprite.renderOrder = 2;
      graph.add(sprite);
      const paint = (ink: string) => {
        ctx.clearRect(0, 0, 768, 160);
        ctx.font = serif
          ? 'italic 130px "Playfair Display", Georgia, serif'
          : '500 80px "DM Sans Variable", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = ink;
        ctx.fillText(text, 384, 80);
        texture.needsUpdate = true;
      };
      paint(color);
      return paint;
    }
    label("Lore.AI", [0, 0, 47], 120, "#f7f2e8", true);
    const labelPainters = [
      label("Conversation", [-92, 103, 22], 110, "#52604a"),
      label("Knowledge", [100, -36, 35], 100, "#52604a"),
      label("Recall", [-125, -76, 35], 70, "#52604a"),
    ];
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
      neutral = color("--palette-base-400", "#8c9a7d");
      orbitMaterial.color.copy(color("--muted", "#52604a"));
      const ink = `#${color("--muted", "#52604a").getHexString()}`;
      labelPainters.forEach((paint) => paint?.(ink));
      MEMORY_NODES.forEach((node, index) => {
        const selected = node.phase === phase;
        nodes[index].material.color.copy(selected ? accent : neutral);
        connections[index].material.color.copy(selected ? accent : neutral);
        connections[index].material.opacity = selected ? 0.85 : 0.3;
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
        REST_PITCH - currentY * 0.18 + Math.sin(elapsed * 0.35) * 0.025;
      graph.rotation.y =
        REST_YAW + currentX * 0.3 + Math.sin(elapsed * 0.23) * 0.045;
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
        mesh.scale.setScalar(node.radius + lift * 0.15);
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
