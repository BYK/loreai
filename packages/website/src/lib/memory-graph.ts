export type MemoryPhase = "conversation" | "knowledge" | "recall";
export type Point3 = readonly [number, number, number];
export const GRAPH_SIZE = 420;
export const WORLD_SIZE = 360;
export const REST_PITCH = 0.22;
export const REST_YAW = -0.25;

// The live Lore graph's hub-and-spoke silhouette, with depth added to its nodes.
export const MEMORY_NODES = Object.freeze(
  [
    { position: [0, 116, -12], radius: 10, phase: "conversation" },
    { position: [-91, 74, -25], radius: 11, phase: "conversation" },
    { position: [124, 98, 8], radius: 11, phase: "conversation" },
    { position: [-122, 4, 0], radius: 9, phase: "recall" },
    { position: [116, -6, -12], radius: 9, phase: "knowledge" },
    { position: [-112, -102, 12], radius: 10, phase: "recall" },
    { position: [84, -81, 20], radius: 10, phase: "knowledge" },
    { position: [-66, -138, -8], radius: 9, phase: "recall" },
    { position: [74, -144, -20], radius: 9, phase: "knowledge" },
  ].map((node) =>
    Object.freeze({
      ...node,
      position: Object.freeze(node.position) as Point3,
      phase: node.phase as MemoryPhase,
    }),
  ),
);

export function projectPoint([x, y, z]: Point3): readonly [number, number] {
  const rx = x * Math.cos(REST_YAW) + z * Math.sin(REST_YAW);
  const rz = -x * Math.sin(REST_YAW) + z * Math.cos(REST_YAW);
  const ry = y * Math.cos(REST_PITCH) - rz * Math.sin(REST_PITCH);
  return [
    GRAPH_SIZE / 2 + (rx * GRAPH_SIZE) / WORLD_SIZE,
    GRAPH_SIZE / 2 - (ry * GRAPH_SIZE) / WORLD_SIZE,
  ];
}

export function connectionPoints(position: Point3): readonly Point3[] {
  const [x, y, z] = position;
  return [
    [0, 0, 0],
    [x * 0.28 - y * 0.08, y * 0.28 + x * 0.08, 24],
    [x * 0.72, y * 0.76, z + 20],
    position,
  ];
}

export function connectionPath(position: Point3): string {
  const [a, b, c, d] = connectionPoints(position).map(projectPoint);
  return `M ${a[0]} ${a[1]} C ${b[0]} ${b[1]}, ${c[0]} ${c[1]}, ${d[0]} ${d[1]}`;
}

export function orbitPath(radius: number): string {
  return (
    Array.from({ length: 97 }, (_, index) => {
      const angle = (index / 96) * Math.PI * 2;
      const point = projectPoint([
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        -22,
      ]);
      return `${index ? "L" : "M"} ${point[0]} ${point[1]}`;
    }).join(" ") + " Z"
  );
}
