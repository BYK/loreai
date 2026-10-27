export type MemoryPhase = "conversation" | "knowledge" | "recall";
export type Point3 = readonly [number, number, number];
export const GRAPH_SIZE = 420;
export const WORLD_SIZE = 360;
export const REST_PITCH = 0.18;
export const REST_YAW = -0.38;

// Nine anchors sit in a connected, three-dimensional memory constellation.
export const MEMORY_NODES = Object.freeze(
  [
    { position: [-16, 128, 32], radius: 5, phase: "conversation" },
    { position: [-105, 65, 52], radius: 4, phase: "conversation" },
    { position: [104, 86, -18], radius: 5, phase: "conversation" },
    { position: [-127, -12, -15], radius: 4, phase: "recall" },
    { position: [118, -20, 48], radius: 5, phase: "knowledge" },
    { position: [-84, -103, 46], radius: 5, phase: "recall" },
    { position: [74, -90, -64], radius: 4, phase: "knowledge" },
    { position: [-27, -128, -20], radius: 4, phase: "recall" },
    { position: [79, -111, 24], radius: 4, phase: "knowledge" },
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
  const start = MEMORY_WEAVE.reduce((nearest, point) => {
    const distance = (candidate: Point3) =>
      Math.hypot(candidate[0] - x, candidate[1] - y, candidate[2] - z);
    return distance(point) < distance(nearest) ? point : nearest;
  });
  return [
    start,
    [start[0] * 0.7 + x * 0.3, start[1] * 0.7 + y * 0.3 + 12, start[2] + 20],
    [start[0] * 0.25 + x * 0.75, start[1] * 0.25 + y * 0.75 + 8, z + 20],
    position,
  ];
}

export function connectionPath(position: Point3): string {
  const [a, b, c, d] = connectionPoints(position).map(projectPoint);
  return `M ${a[0]} ${a[1]} C ${b[0]} ${b[1]}, ${c[0]} ${c[1]}, ${d[0]} ${d[1]}`;
}

// A continuous, woven memory path; its three lobes keep a round silhouette.
export function memoryPoint(angle: number): Point3 {
  const radius = 2 + Math.cos(3 * angle);
  return [
    Math.cos(2 * angle) * radius * 40,
    Math.sin(2 * angle) * radius * 43,
    Math.sin(3 * angle) * 48,
  ];
}

export const MEMORY_WEAVE = Object.freeze(
  Array.from({ length: 216 }, (_, index) =>
    Object.freeze(memoryPoint((index / 216) * Math.PI * 2)),
  ),
);

export const MEMORY_THREADS = Object.freeze(
  MEMORY_WEAVE.flatMap((point, index) =>
    MEMORY_WEAVE.slice(index + 1).flatMap((other, offset) => {
      const distance = Math.hypot(
        point[0] - other[0],
        point[1] - other[1],
        point[2] - other[2],
      );
      return distance > 18 && distance < 27
        ? [Object.freeze([index, index + offset + 1])]
        : [];
    }),
  ),
);

export function projectedPath(points: readonly Point3[]): string {
  return points
    .map((point, index) => {
      const [x, y] = projectPoint(point);
      return `${index ? "L" : "M"} ${x.toFixed(3)} ${y.toFixed(3)}`;
    })
    .join(" ");
}

export function viewDepth([x, y, z]: Point3): number {
  return (
    y * Math.sin(REST_PITCH) +
    (-x * Math.sin(REST_YAW) + z * Math.cos(REST_YAW)) * Math.cos(REST_PITCH)
  );
}

export function tileRotation(
  index: number,
): readonly [number, number, number, number] {
  const point = MEMORY_WEAVE[index];
  const next = memoryPoint(((index + 0.2) / MEMORY_WEAVE.length) * Math.PI * 2);
  const delta = next.map((value, axis) => value - point[axis]);
  const length = Math.hypot(...delta);
  const [x, y, z] = delta.map((value) => value / length);
  const magnitude = Math.hypot(-z, y, 1 + x);
  return [0, -z / magnitude, y / magnitude, (1 + x) / magnitude];
}

function rotateTile(
  [x, y, z]: Point3,
  [qx, qy, qz, qw]: readonly number[],
): Point3 {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

// Painter-sorted faces preserve the same tile dimensions, pose and occlusion without JS.
export const MEMORY_TILE_FACES = Object.freeze(
  MEMORY_WEAVE.flatMap((point, index) => {
    const rotation = tileRotation(index);
    const vertex = (x: number, y: number, z: number): Point3 => {
      const offset = rotateTile([x * 2.7, y * 4.4, z * 3.8], rotation);
      return [offset[0] + point[0], offset[1] + point[1], offset[2] + point[2]];
    };
    const faces = [
      {
        normal: [0, 0, 1],
        corners: [
          [-1, -1, 1],
          [1, -1, 1],
          [1, 1, 1],
          [-1, 1, 1],
        ],
        shade: 0,
      },
      {
        normal: [0, 0, -1],
        corners: [
          [1, -1, -1],
          [-1, -1, -1],
          [-1, 1, -1],
          [1, 1, -1],
        ],
        shade: 1,
      },
      {
        normal: [0, 1, 0],
        corners: [
          [-1, 1, 1],
          [1, 1, 1],
          [1, 1, -1],
          [-1, 1, -1],
        ],
        shade: 0,
      },
      {
        normal: [0, -1, 0],
        corners: [
          [-1, -1, -1],
          [1, -1, -1],
          [1, -1, 1],
          [-1, -1, 1],
        ],
        shade: 2,
      },
      {
        normal: [1, 0, 0],
        corners: [
          [1, -1, 1],
          [1, -1, -1],
          [1, 1, -1],
          [1, 1, 1],
        ],
        shade: 1,
      },
      {
        normal: [-1, 0, 0],
        corners: [
          [-1, -1, -1],
          [-1, -1, 1],
          [-1, 1, 1],
          [-1, 1, -1],
        ],
        shade: 2,
      },
    ] as const;
    return faces
      .filter((face) => viewDepth(rotateTile(face.normal, rotation)) > 0)
      .map((face) => ({
        points: face.corners.map((corner) =>
          vertex(corner[0], corner[1], corner[2]),
        ),
        depth: viewDepth(point),
        phase: (["conversation", "knowledge", "recall"] as const)[
          Math.floor(index / 72)
        ],
        shade: face.shade,
      }));
  }).sort((a, b) => a.depth - b.depth),
);
