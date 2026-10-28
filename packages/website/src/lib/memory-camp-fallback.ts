import * as THREE from "three";
import {
  createCamp,
  disposeCamp,
  PHASES,
  SVG_WIDTH,
  SVG_HEIGHT,
  type MemoryPhase,
} from "./memory-camp";
export interface CampFace {
  path: string;
  token: string;
  shade: number;
  phase?: MemoryPhase;
  hero?: MemoryPhase;
  ring?: MemoryPhase;
}
// Project the same meshes used by WebGL at build time. No Three.js is needed to
// display or select the camp on low-memory devices, without JS, or reduced motion.
export function campFallback() {
  const camp = createCamp(),
    faces: (CampFace & { depth: number; layer: number })[] = [];
  const sunlight = new THREE.Vector3(-7, 13, 8).normalize();
  function collect(root: THREE.Object3D, hero?: MemoryPhase) {
    root.updateWorldMatrix(true, true);
    root.traverseVisible((object) => {
      if (
        !(object instanceof THREE.Mesh) ||
        object.userData.omitFallback ||
        !object.visible
      )
        return;
      if (!hero && camp.hero.getObjectById(object.id)) return;
      let parent: THREE.Object3D | null = object,
        phase: MemoryPhase | undefined;
      while (parent) {
        if (parent.userData.stage !== undefined) {
          phase = PHASES[parent.userData.stage as number];
          break;
        }
        parent = parent.parent;
      }
      const ringIndex = camp.rings.indexOf(
        object as (typeof camp.rings)[number],
      );
      const material = Array.isArray(object.material)
        ? object.material[0]
        : object.material;
      const token = material.userData.campToken as string | undefined;
      if (!token && ringIndex < 0) return;
      const position = object.geometry.getAttribute("position"),
        index = object.geometry.index,
        count = index?.count ?? position.count;
      for (let i = 0; i < count; i += 3) {
        const vertices = [0, 1, 2].map((offset) =>
          new THREE.Vector3()
            .fromBufferAttribute(
              position,
              index ? index.getX(i + offset) : i + offset,
            )
            .applyMatrix4(object.matrixWorld),
        );
        const normal = vertices[1]
          .clone()
          .sub(vertices[0])
          .cross(vertices[2].clone().sub(vertices[0]))
          .normalize();
        if (
          material.side !== THREE.DoubleSide &&
          normal.dot(camp.camera.position.clone().sub(vertices[0])) <= 0
        )
          continue;
        const projected = vertices.map((point) =>
          point.clone().project(camp.camera),
        );
        const path =
          projected
            .map(
              (p, j) =>
                `${j ? "L" : "M"}${(((p.x + 1) * SVG_WIDTH) / 2).toFixed(2)},${(((1 - p.y) * SVG_HEIGHT) / 2).toFixed(2)}`,
            )
            .join("") + "Z";
        faces.push({
          path,
          token: token ?? "gold",
          shade: Math.round(
            (0.73 + 0.27 * Math.max(0, normal.dot(sunlight))) * 100,
          ),
          phase,
          hero,
          layer:
            token === "earth-side"
              ? 0
              : token === "earth"
                ? 1
                : token === "ground"
                  ? 2
                  : object.userData.groundDetail || ringIndex >= 0
                    ? 3
                    : 4,
          ring: ringIndex < 0 ? undefined : PHASES[ringIndex],
          depth: projected.reduce((sum, p) => sum + p.z, 0) / 3,
        });
      }
    });
  }
  collect(camp.world);
  for (let i = 0; i < 3; i++) {
    camp.hero.position.copy(camp.heroPoint(i));
    camp.hero.rotation.y = Math.atan2(
      camp.paths[Math.min(i, 1)].getTangentAt(i === 0 ? 0 : 1).x,
      camp.paths[Math.min(i, 1)].getTangentAt(i === 0 ? 0 : 1).z,
    );
    camp.carried.visible = i > 0;
    collect(camp.hero, PHASES[i]);
  }
  faces.sort((a, b) => a.layer - b.layer || b.depth - a.depth);
  // Adjacent triangles with the same styling can share one path.
  const grouped: CampFace[] = [];
  for (const face of faces) {
    const last = grouped.at(-1);
    if (
      last &&
      last.token === face.token &&
      last.shade === face.shade &&
      last.phase === face.phase &&
      last.hero === face.hero &&
      last.ring === face.ring
    )
      last.path += face.path;
    else grouped.push({ ...face });
  }
  disposeCamp(camp.scene);
  return grouped;
}
