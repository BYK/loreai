export type MemoryPhase = "conversation" | "knowledge" | "recall";
export type Point2 = readonly [number, number];
export type Point3 = readonly [number, number, number];
export interface TerrainLevel {
  readonly height: number;
  readonly loops: readonly (readonly Point2[])[];
}
export const PHASES = ["conversation", "knowledge", "recall"] as const;
export const SITES: readonly Point2[] = Object.freeze(
  [
    [30, 60],
    [-64, -8],
    [65, -30],
  ].map((point) => Object.freeze(point) as Point2),
);
export const REST_YAW = (-8 * Math.PI) / 180;
export const CAMERA_POSITION: Point3 = [310, 350, 460];
export const SVG_WIDTH = 600;
export const SVG_HEIGHT = 400;
export function phaseIndex(phase: MemoryPhase): number {
  return PHASES.indexOf(phase);
}
export function regionAt(x: number, z: number): number {
  let region = 0,
    nearest = Infinity;
  SITES.forEach(([sx, sz], index) => {
    const distance = (x - sx) ** 2 + (z - sz) ** 2;
    if (distance < nearest) {
      nearest = distance;
      region = index;
    }
  });
  return region;
}
export function terrainHeight(x: number, z: number): number {
  return (
    72 * Math.exp(-((x + 64) ** 2 / 3800 + (z + 8) ** 2 / 2400)) +
    62 * Math.exp(-((x - 65) ** 2 / 3300 + (z + 30) ** 2 / 2200)) +
    44 * Math.exp(-((x - 30) ** 2 / 1800 + (z - 60) ** 2 / 1600)) +
    12 * Math.exp(-((x * x) / 15000 + (z * z) / 10000)) -
    8 +
    0.8 *
      Math.sin(x * 0.065 + z * 0.04) *
      Math.exp(-((x * x) / 24000 + (z * z) / 17000))
  );
}
export const TERRAIN_STEP = 3.1;
let cachedLevels: readonly TerrainLevel[] | undefined;
export function terrainLevels(): readonly TerrainLevel[] {
  if (cachedLevels) return cachedLevels;
  const gridSize = 82,
    xMin = -184,
    zMin = -144,
    dx = 368 / gridSize,
    dz = 288 / gridSize;
  const field = Array.from({ length: gridSize + 1 }, (_, j) =>
    Array.from({ length: gridSize + 1 }, (_, i) =>
      terrainHeight(xMin + i * dx, zMin + j * dz),
    ),
  );
  function contours(threshold: number): Point2[][] {
    const nodes = new Map<string, Point2>(),
      links = new Map<string, string[]>();
    const connect = (a: string, b: string) => {
      if (!links.has(a)) links.set(a, []);
      if (!links.has(b)) links.set(b, []);
      links.get(a)!.push(b);
      links.get(b)!.push(a);
    };
    for (let j = 0; j < gridSize; j++)
      for (let i = 0; i < gridSize; i++) {
        const v = [
          field[j][i],
          field[j][i + 1],
          field[j + 1][i + 1],
          field[j + 1][i],
        ];
        const corners = [
            [i, j],
            [i + 1, j],
            [i + 1, j + 1],
            [i, j + 1],
          ],
          edges = [
            [0, 1],
            [1, 2],
            [2, 3],
            [3, 0],
          ];
        const keys = [
            `h${i},${j}`,
            `v${i + 1},${j}`,
            `h${i},${j + 1}`,
            `v${i},${j}`,
          ],
          cross: number[] = [];
        edges.forEach(([a, b], k) => {
          if (v[a] >= threshold === v[b] >= threshold) return;
          const t = (threshold - v[a]) / (v[b] - v[a]);
          nodes.set(keys[k], [
            xMin + (corners[a][0] + (corners[b][0] - corners[a][0]) * t) * dx,
            zMin + (corners[a][1] + (corners[b][1] - corners[a][1]) * t) * dz,
          ]);
          cross.push(k);
        });
        if (cross.length === 2) connect(keys[cross[0]], keys[cross[1]]);
        else if (cross.length === 4) {
          const center = (v[0] + v[1] + v[2] + v[3]) / 4;
          const pairs =
            center >= threshold === v[0] >= threshold
              ? [
                  [0, 1],
                  [2, 3],
                ]
              : [
                  [0, 3],
                  [1, 2],
                ];
          pairs.forEach(([a, b]) => connect(keys[a], keys[b]));
        }
      }
    const used = new Set<string>(),
      loops: Point2[][] = [];
    for (const start of links.keys()) {
      if (used.has(start)) continue;
      let previous: string | null = null,
        current = start;
      const points: Point2[] = [];
      for (let count = 0; count < 10000; count++) {
        if (used.has(current)) break;
        used.add(current);
        points.push(nodes.get(current)!);
        const next = links.get(current)?.find((n) => n !== previous);
        if (!next) break;
        previous = current;
        current = next;
        if (current === start) break;
      }
      if (current === start && points.length > 12) loops.push(points);
    }
    return loops;
  }
  cachedLevels = Object.freeze(
    Array.from({ length: 29 }, (_, index) => {
      const height = index * TERRAIN_STEP;
      return Object.freeze({
        height,
        loops: Object.freeze(
          contours(height).map((loop) =>
            Object.freeze(loop.map((point) => Object.freeze(point))),
          ),
        ),
      });
    }).filter((level) => level.loops.length),
  );
  return cachedLevels;
}

export function terrainTop(x: number, z: number): number {
  return (
    Math.floor(Math.max(0, terrainHeight(x, z)) / TERRAIN_STEP) * TERRAIN_STEP
  );
}
export const ROUTE_WAYPOINTS: readonly (readonly Point2[])[] = [
  [
    [30, 60],
    [12, 46],
    [-12, 30],
    [-40, 12],
    [-64, -8],
  ],
  [
    [-64, -8],
    [-30, -20],
    [4, -32],
    [34, -40],
    [65, -30],
  ],
];
export function trailPoints(route: number): Point3[] {
  const path = ROUTE_WAYPOINTS[route];
  return Array.from({ length: 180 }, (_, index) => {
    const progress = (index / 179) * (path.length - 1),
      segment = Math.min(path.length - 2, Math.floor(progress)),
      t = progress - segment;
    const a = path[Math.max(0, segment - 1)],
      b = path[segment],
      c = path[segment + 1],
      d = path[Math.min(path.length - 1, segment + 2)];
    const at = (axis: 0 | 1) =>
      0.5 *
      (2 * b[axis] +
        (-a[axis] + c[axis]) * t +
        (2 * a[axis] - 5 * b[axis] + 4 * c[axis] - d[axis]) * t * t +
        (-a[axis] + 3 * b[axis] - 3 * c[axis] + d[axis]) * t * t * t);
    const x = at(0),
      z = at(1);
    return [x, terrainTop(x, z) + 1.25, z];
  });
}
const dot = (a: Point3, b: Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: Point3, b: Point3): Point3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const cross = (a: Point3, b: Point3): Point3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (point: Point3): Point3 => {
  const length = Math.hypot(...point);
  return [point[0] / length, point[1] / length, point[2] / length];
};
export function restRotate([x, y, z]: Point3): Point3 {
  return [
    x * Math.cos(REST_YAW) + z * Math.sin(REST_YAW),
    y,
    -x * Math.sin(REST_YAW) + z * Math.cos(REST_YAW),
  ];
}
export interface LandscapeView {
  focus: Point3;
  right: Point3;
  up: Point3;
  forward: Point3;
  halfHeight: number;
}
let cachedView: LandscapeView | undefined;
export function landscapeView(): LandscapeView {
  if (cachedView) return cachedView;
  const points = terrainLevels().flatMap((level) =>
    level.loops.flatMap((loop) =>
      loop.map(([x, z]): Point3 => [x, level.height, z]),
    ),
  );
  const xs = points.map((p) => p[0]),
    zs = points.map((p) => p[2]);
  const focus: Point3 = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (-5.2 + Math.max(...SITES.map(([x, z]) => terrainTop(x, z) + 10))) / 2,
    (Math.min(...zs) + Math.max(...zs)) / 2,
  ];
  const forward = normalize(subtract(CAMERA_POSITION, focus)),
    right = normalize(cross([0, 1, 0], forward)),
    up = cross(forward, right);
  const projected = points.map((p) => {
    const q = subtract(restRotate(p), focus);
    return [dot(q, right), dot(q, up)];
  });
  const px = projected.map((p) => p[0]),
    py = projected.map((p) => p[1]);
  const halfHeight = Math.max(
    (Math.max(...py) - Math.min(...py)) * 0.67,
    ((Math.max(...px) - Math.min(...px)) / (SVG_WIDTH / SVG_HEIGHT)) * 0.64,
  );
  cachedView = { focus, right, up, forward, halfHeight };
  return cachedView;
}
export function projectPoint(point: Point3): Point2 {
  const view = landscapeView(),
    q = subtract(restRotate(point), view.focus),
    scale = SVG_HEIGHT / (2 * view.halfHeight);
  return [
    SVG_WIDTH / 2 + dot(q, view.right) * scale,
    SVG_HEIGHT / 2 - dot(q, view.up) * scale,
  ];
}
export function svgPath(points: readonly Point3[], close = false): string {
  return (
    points
      .map((point, index) => {
        const [x, y] = projectPoint(point);
        return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ") + (close ? " Z" : "")
  );
}
export function clipRegion(
  polygon: readonly Point2[],
  region: number,
): Point2[] {
  let result = [...polygon];
  const [sx, sz] = SITES[region];
  for (let other = 0; other < SITES.length; other++) {
    if (other === region) continue;
    const [ox, oz] = SITES[other],
      a = 2 * (ox - sx),
      b = 2 * (oz - sz),
      limit = ox * ox + oz * oz - sx * sx - sz * sz;
    const input = result;
    result = [];
    for (let index = 0; index < input.length; index++) {
      const current = input[index],
        previous = input[(index + input.length - 1) % input.length],
        v = a * current[0] + b * current[1] - limit,
        p = a * previous[0] + b * previous[1] - limit;
      if (v <= 0 !== p <= 0) {
        const t = p / (p - v);
        result.push([
          previous[0] + (current[0] - previous[0]) * t,
          previous[1] + (current[1] - previous[1]) * t,
        ]);
      }
      if (v <= 0) result.push(current);
    }
  }
  return result;
}
export interface LandscapeFace {
  path: string;
  phase: MemoryPhase;
  layer: number;
  wall: boolean;
}
let cachedFaces: readonly LandscapeFace[] | undefined;
export function landscapeFaces(): readonly LandscapeFace[] {
  if (cachedFaces) return cachedFaces;
  const faces: LandscapeFace[] = [];
  for (const level of terrainLevels())
    for (const loop of level.loops) {
      const lower =
        level.height - (level.height === 0 ? 5.2 : TERRAIN_STEP - 0.22);
      for (let region = 0; region < 3; region++) {
        const polygon = clipRegion(loop, region);
        if (polygon.length < 3) continue;
        // Wall segments share the same region clipping as the top surface.
        const walls: string[] = [];
        for (let i = 0; i < polygon.length; i++) {
          const a = polygon[i],
            b = polygon[(i + 1) % polygon.length];
          const normal: Point3 = [b[1] - a[1], 0, a[0] - b[0]];
          if (dot(restRotate(normal), landscapeView().forward) <= 0) continue;
          walls.push(
            svgPath(
              [
                [a[0], level.height, a[1]],
                [a[0], lower, a[1]],
                [b[0], lower, b[1]],
                [b[0], level.height, b[1]],
              ],
              true,
            ),
          );
        }
        if (walls.length)
          faces.push({
            path: walls.join(" "),
            phase: PHASES[region],
            layer: level.height / 80,
            wall: true,
          });
        faces.push({
          path: svgPath(
            polygon.map(([x, z]): Point3 => [x, level.height, z]),
            true,
          ),
          phase: PHASES[region],
          layer: level.height / 80,
          wall: false,
        });
      }
    }
  cachedFaces = Object.freeze(faces);
  return cachedFaces;
}
