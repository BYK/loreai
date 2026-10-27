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
