export type MemoryPhase = "conversation" | "knowledge" | "recall";
export type Point2 = readonly [number, number];
export type Point3 = readonly [number, number, number];
export interface TerrainLevel {
  readonly height: number;
  readonly loops: readonly (readonly Point2[])[];
}
export const PHASES = ["conversation", "knowledge", "recall"] as const;
export const REST_YAW = (-8 * Math.PI) / 180;
export const CAMERA_POSITION: Point3 = [310, 350, 460];
export const SVG_WIDTH = 600;
export const SVG_HEIGHT = 400;
// Each complete terrace belongs to one stage, including its bevel and wall.
export function bandAtHeight(height: number): number {
  return height >= 50 ? 2 : height >= 25 ? 1 : 0;
}
export const ISLANDS = Object.freeze(
  [
    { name: "Payments", x: -86, z: 40, scale: 0.43, mirror: 1 },
    { name: "Orders", x: 80, z: -40, scale: 0.43, mirror: -1 },
  ].map((island) => Object.freeze(island)),
);
function originalTerrainHeight(x: number, z: number): number {
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
function islandHeight(x: number, z: number, index: number): number {
  const island = ISLANDS[index];
  return originalTerrainHeight(
    ((x - island.x) / island.scale) * island.mirror,
    (z - island.z) / island.scale,
  );
}
export function terrainHeight(x: number, z: number): number {
  return Math.max(islandHeight(x, z, 0), islandHeight(x, z, 1));
}
export function islandAt(x: number, z: number): number {
  return (x - ISLANDS[0].x) ** 2 + (z - ISLANDS[0].z) ** 2 <=
    (x - ISLANDS[1].x) ** 2 + (z - ISLANDS[1].z) ** 2
    ? 0
    : 1;
}
interface Footprint {
  height: number;
  loop: readonly Point2[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
let cachedFootprints: readonly Footprint[] | undefined;
function fragmentClearance(x: number, z: number): number {
  if (!cachedFootprints)
    cachedFootprints = terrainLevels()
      .flatMap((level) =>
        level.loops.map((loop) => ({
          height: level.height,
          loop,
          minX: Math.min(...loop.map((p) => p[0])),
          maxX: Math.max(...loop.map((p) => p[0])),
          minZ: Math.min(...loop.map((p) => p[1])),
          maxZ: Math.max(...loop.map((p) => p[1])),
        })),
      )
      .sort((a, b) => b.height - a.height);
  // Covers the largest rotated fragment, plus the outward bevel.
  const extent = 4.8,
    minX = x - extent,
    maxX = x + extent,
    minZ = z - extent,
    maxZ = z + extent;
  for (const face of cachedFootprints) {
    if (
      face.maxX < minX ||
      face.minX > maxX ||
      face.maxZ < minZ ||
      face.minZ > maxZ
    )
      continue;
    let inside = false;
    for (let i = 0, j = face.loop.length - 1; i < face.loop.length; j = i++) {
      const a = face.loop[i],
        b = face.loop[j];
      if (a[0] >= minX && a[0] <= maxX && a[1] >= minZ && a[1] <= maxZ)
        return face.height + 1.66;
      if (
        a[1] > z !== b[1] > z &&
        x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside;
      let start = 0,
        end = 1,
        intersects = true;
      for (const [origin, delta, low, high] of [
        [a[0], b[0] - a[0], minX, maxX],
        [a[1], b[1] - a[1], minZ, maxZ],
      ]) {
        if (Math.abs(delta) < 1e-12) {
          if (origin < low || origin > high) intersects = false;
        } else {
          const first = (low - origin) / delta,
            last = (high - origin) / delta;
          start = Math.max(start, Math.min(first, last));
          end = Math.min(end, Math.max(first, last));
        }
      }
      if (intersects && start <= end) return face.height + 1.66;
    }
    if (inside) return face.height + 1.66;
  }
  return 1.66;
}
export function pointOnTerrain(
  height: number,
  angle: number,
  index = 0,
): Point3 {
  const island = ISLANDS[index],
    h = Math.max(0, Math.min(originalTerrainHeight(-64, -8) - 0.01, height));
  const direction = 1.75 + 0.5 * Math.sin(angle),
    dx = Math.cos(direction),
    dz = Math.sin(direction);
  let low = 0,
    high = 2;
  while (
    high < 500 &&
    originalTerrainHeight(-64 + dx * high, -8 + dz * high) > h
  ) {
    low = high;
    high += 2;
  }
  for (let iteration = 0; iteration < 34; iteration++) {
    const middle = (low + high) / 2;
    if (originalTerrainHeight(-64 + dx * middle, -8 + dz * middle) > h)
      low = middle;
    else high = middle;
  }
  const radius = (low + high) / 2;
  const x = island.x + (-64 + dx * radius) * island.scale * island.mirror,
    z = island.z + (-8 + dz * radius) * island.scale;
  return [x, fragmentClearance(x, z), z];
}
let cachedCrests: readonly Point3[] | undefined;
export function crestPoint(index: number, angle: number): Point3 {
  if (!cachedCrests) {
    cachedCrests = ISLANDS.map((_, island) => {
      let crest: Point3 = [0, 0, 0];
      for (const level of terrainLevels())
        for (const loop of level.loops) {
          if (
            islandAt(...loop[0]) !== island ||
            level.height + 1.66 <= crest[1]
          )
            continue;
          crest = [
            loop.reduce((sum, point) => sum + point[0], 0) / loop.length,
            level.height + 1.66,
            loop.reduce((sum, point) => sum + point[1], 0) / loop.length,
          ];
        }
      return Object.freeze(crest);
    });
  }
  const base = cachedCrests[index];
  return [
    base[0] + Math.cos(angle) * 1.2,
    base[1],
    base[2] + Math.sin(angle) * 1.2,
  ];
}
export function transferPoint(position: number, angle: number): Point3 {
  const p = Math.max(0, Math.min(2, position));
  if (p <= 1) return pointOnTerrain(refinementElevation(p), angle, 0);
  if (p <= 1.35) {
    const t = Math.min(1, (p - 1) / 0.35),
      blend = Math.max(0, (t - 0.8) / 0.2) ** 2;
    const surface = pointOnTerrain(
        37.2 + (originalTerrainHeight(-64, -8) - 0.01 - 37.2) * t,
        angle,
        0,
      ),
      crest = crestPoint(0, angle);
    const x = surface[0] + (crest[0] - surface[0]) * blend,
      z = surface[2] + (crest[2] - surface[2]) * blend;
    return [
      x,
      Math.max(
        surface[1] + (crest[1] - surface[1]) * blend,
        fragmentClearance(x, z),
      ),
      z,
    ];
  }
  if (p >= 1.9) return crestPoint(1, angle);
  const from = crestPoint(0, angle),
    to = crestPoint(1, angle),
    t = (p - 1.35) / 0.55,
    ease = t * t * (3 - 2 * t);
  return [
    from[0] + (to[0] - from[0]) * ease,
    from[1] + (to[1] - from[1]) * ease + 60 * Math.sin(Math.PI * ease),
    from[2] + (to[2] - from[2]) * ease,
  ];
}
export function transferPath(): Point3[] {
  return Array.from({ length: 90 }, (_, index) =>
    transferPoint(1.35 + (0.55 * index) / 89, 0.85),
  );
}
export function refinementElevation(position: number): number {
  const p = Math.max(0, Math.min(2, position)),
    index = Math.min(1, Math.floor(p));
  const heights = [12.4, 37.2, 68.2];
  return heights[index] + (heights[index + 1] - heights[index]) * (p - index);
}
export function refinementDetailCount(position: number): number {
  const p = Math.max(0, Math.min(2, position));
  return p <= 1 ? 28 - 16 * p : 12 - 8 * (p - 1);
}
export const TERRAIN_STEP = 3.1;
let cachedLevels: readonly TerrainLevel[] | undefined;
export function terrainLevels(): readonly TerrainLevel[] {
  if (cachedLevels) return cachedLevels;
  const gridSize = 144,
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
    (-5.2 + Math.max(...points.map((point) => point[1]))) / 2,
    (Math.min(...zs) + Math.max(...zs)) / 2,
  ];
  const forward = normalize(subtract(CAMERA_POSITION, focus)),
    right = normalize(cross([0, 1, 0], forward)),
    up = cross(forward, right);
  const fittingPoints = points.concat(
    Array.from({ length: 28 }, (_, index) =>
      Array.from({ length: 16 }, (_, step) =>
        transferPoint(1.35 + (0.55 * step) / 15, index * 2.3999632297),
      ),
    ).flat(),
  );
  const projected = fittingPoints.map((p) => {
    const q = subtract(restRotate(p), focus);
    return [dot(q, right), dot(q, up)];
  });
  const px = projected.map((p) => p[0]),
    py = projected.map((p) => p[1]);
  let halfHeight = Math.max(
    (Math.max(...py) - Math.min(...py)) * 0.67,
    ((Math.max(...px) - Math.min(...px)) / (SVG_WIDTH / SVG_HEIGHT)) * 0.64,
  );
  // Fit the entire drag/parallax envelope, with room for lower walls and bevels.
  for (let yawStep = -4; yawStep <= 4; yawStep++)
    for (let pitchStep = -2; pitchStep <= 2; pitchStep++) {
      const yaw = REST_YAW + (yawStep * 0.475) / 4,
        pitch = (pitchStep * 0.125) / 2;
      const sy = Math.sin(yaw),
        cy = Math.cos(yaw),
        sx = Math.sin(pitch),
        cx = Math.cos(pitch);
      for (const [x, height, z] of fittingPoints)
        for (const y of [
          height + 0.2,
          height - (height === 0 ? 5.2 : TERRAIN_STEP - 0.22) - 0.2,
        ]) {
          const rz = -x * sy + z * cy;
          const q = subtract(
            [x * cy + z * sy, y * cx - rz * sx, y * sx + rz * cx],
            focus,
          );
          halfHeight = Math.max(
            halfHeight,
            (Math.abs(dot(q, up)) + 1) * 1.04,
            ((Math.abs(dot(q, right)) + 1) / (SVG_WIDTH / SVG_HEIGHT)) * 1.04,
          );
        }
    }
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
      const polygon = loop;
      const phase = PHASES[bandAtHeight(level.height)];
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
          phase,
          layer: level.height / 80,
          wall: true,
        });
      faces.push({
        path: svgPath(
          polygon.map(([x, z]): Point3 => [x, level.height, z]),
          true,
        ),
        phase,
        layer: level.height / 80,
        wall: false,
      });
    }
  cachedFaces = Object.freeze(faces);
  return cachedFaces;
}
