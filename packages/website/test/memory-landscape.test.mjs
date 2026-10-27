import assert from "node:assert/strict";
import { test } from "node:test";
import { OrthographicCamera, Vector3, Euler } from "three";
import {
  CAMERA_POSITION,
  REST_YAW,
  PHASES,
  bandAtHeight,
  SVG_WIDTH,
  SVG_HEIGHT,
  terrainLevels,
  landscapeView,
  projectPoint,
  landscapeFaces,
} from "../src/lib/memory-landscape.ts";

await test("lower, middle and upper elevations classify consistently across every hill", () => {
  for (const [height, expected] of [
    [-5.2, 0],
    [0, 0],
    [24.8, 0],
    [25, 1],
    [49.6, 1],
    [50, 2],
    [80, 2],
  ])
    assert.equal(bandAtHeight(height), expected);
  const phases = new Set(
    terrainLevels().map((level) => PHASES[bandAtHeight(level.height)]),
  );
  assert.deepEqual(phases, new Set(PHASES));
});
await test("SVG and GPU camera projections agree across every contour", () => {
  const view = landscapeView(),
    half = view.halfHeight,
    ratio = SVG_WIDTH / SVG_HEIGHT;
  const camera = new OrthographicCamera(
    -half * ratio,
    half * ratio,
    half,
    -half,
    1,
    1600,
  );
  camera.position.set(...CAMERA_POSITION);
  camera.lookAt(...view.focus);
  camera.updateMatrixWorld();
  const points = terrainLevels().flatMap((level) =>
    level.loops.flatMap((loop) => loop.map(([x, z]) => [x, level.height, z])),
  );
  for (const point of points) {
    const gpu = new Vector3(...point)
        .applyEuler(new Euler(0, REST_YAW, 0))
        .project(camera),
      svg = projectPoint(point);
    assert.ok(Math.abs(svg[0] - ((gpu.x + 1) * SVG_WIDTH) / 2) < 1e-8);
    assert.ok(Math.abs(svg[1] - ((1 - gpu.y) * SVG_HEIGHT) / 2) < 1e-8);
    assert.ok(
      svg[0] > 0 && svg[0] < SVG_WIDTH && svg[1] > 0 && svg[1] < SVG_HEIGHT,
    );
  }
  assert.throws(() => {
    terrainLevels()[0].loops[0][0][0] = 999;
  }, TypeError);
});
await test("static faces use the owning contour elevation, without landmark regions or artificial partition walls", () => {
  const faces = landscapeFaces();
  assert.equal(
    faces.filter((face) => !face.wall).length,
    terrainLevels().reduce((sum, level) => sum + level.loops.length, 0),
  );
  for (const face of faces) {
    assert.equal(face.phase, PHASES[bandAtHeight(face.layer * 80)]);
    assert.ok(!/(NaN|Infinity)/.test(face.path));
  }
  assert.ok(faces.length < 150);
});

await test("the terrain is a single narrowing landform with one summit", () => {
  const levels = terrainLevels();
  const area = (loop) =>
    Math.abs(
      loop.reduce((sum, a, i) => {
        const b = loop[(i + 1) % loop.length];
        return sum + a[0] * b[1] - a[1] * b[0];
      }, 0),
    ) / 2;
  let previous = Infinity;
  for (const level of levels) {
    assert.equal(level.loops.length, 1);
    const current = area(level.loops[0]);
    assert.ok(current < previous);
    previous = current;
  }
  assert.ok(area(levels.at(-1).loops[0]) / area(levels[0].loops[0]) < 0.03);
});
await test("refinement fragments follow the terraces and thin toward relevant context", async () => {
  const {
    pointOnTerrain,
    terrainHeight,
    refinementElevation,
    refinementDetailCount,
    TERRAIN_STEP,
  } = await import("../src/lib/memory-landscape.ts");
  let previous = Infinity;
  for (let position = 0; position <= 2; position += 0.05) {
    const count = refinementDetailCount(position);
    assert.ok(count <= previous);
    previous = count;
    const height = refinementElevation(position);
    for (let index = 0; index < 28; index++) {
      const [x, y, z] = pointOnTerrain(height, index * 2.3999632297);
      assert.ok(Math.abs(terrainHeight(x, z) - height) < 1e-7);
      assert.ok(
        Math.abs(y - (Math.floor(height / TERRAIN_STEP) * TERRAIN_STEP + 1.5)) <
          1e-7,
      );
    }
  }
  assert.equal(refinementDetailCount(0), 28);
  assert.equal(refinementDetailCount(1), 12);
  assert.equal(refinementDetailCount(2), 4);
});

await test("the complete terrain fits at drag and pointer-parallax extremes, including walls and bevels", () => {
  const view = landscapeView(),
    half = view.halfHeight,
    ratio = SVG_WIDTH / SVG_HEIGHT;
  const camera = new OrthographicCamera(
    -half * ratio,
    half * ratio,
    half,
    -half,
    1,
    1600,
  );
  camera.position.set(...CAMERA_POSITION);
  camera.lookAt(...view.focus);
  camera.updateMatrixWorld();
  for (const yaw of [-0.475, -0.2375, 0, 0.2375, 0.475])
    for (const pitch of [-0.125, 0, 0.125]) {
      const pose = new Euler(pitch, REST_YAW + yaw, 0);
      for (const level of terrainLevels())
        for (const loop of level.loops)
          for (const [x, z] of loop) {
            const lower = level.height - (level.height === 0 ? 5.2 : 2.88);
            for (const y of [level.height + 0.2, lower - 0.2])
              for (const offset of [-0.25, 0.25]) {
                const point = new Vector3(x + offset, y, z + offset)
                  .applyEuler(pose)
                  .project(camera);
                assert.ok(
                  Math.abs(point.x) < 1 && Math.abs(point.y) < 1,
                  `clipped terrain at yaw=${yaw}, pitch=${pitch}: ${point.x},${point.y}`,
                );
              }
          }
    }
});
