import assert from "node:assert/strict";
import { test } from "node:test";
import { OrthographicCamera, Vector3, Euler } from "three";
import {
  CAMERA_POSITION,
  REST_YAW,
  SITES,
  SVG_WIDTH,
  SVG_HEIGHT,
  terrainLevels,
  terrainTop,
  regionAt,
  clipRegion,
  landscapeView,
  projectPoint,
  trailPoints,
  landscapeFaces,
} from "../src/lib/memory-landscape.ts";

await test("each landmark belongs to its own terrain region and trails join the landmarks", () => {
  SITES.forEach(([x, z], index) => assert.equal(regionAt(x, z), index));
  for (let leg = 0; leg < 2; leg++) {
    const trail = trailPoints(leg);
    for (const [point, site] of [
      [trail[0], SITES[leg]],
      [trail.at(-1), SITES[leg + 1]],
    ]) {
      assert.deepEqual([point[0], point[2]], site);
      assert.equal(point[1], terrainTop(...site) + 1.25);
    }
    assert.ok(trail.every((point) => point.every(Number.isFinite)));
  }
});
await test("SVG and GPU camera projections agree across every contour and landmark", () => {
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
const area = (polygon) =>
  Math.abs(
    polygon.reduce((sum, a, i) => {
      const b = polygon[(i + 1) % polygon.length];
      return sum + a[0] * b[1] - a[1] * b[0];
    }, 0),
  ) / 2;
await test("region clipping partitions the terrain without gaps or double-counted area", () => {
  for (const level of terrainLevels())
    for (const loop of level.loops) {
      const clipped = SITES.map((_, index) => clipRegion(loop, index));
      assert.ok(
        Math.abs(clipped.reduce((sum, p) => sum + area(p), 0) - area(loop)) <
          1e-7,
      );
      clipped.forEach((polygon, index) =>
        polygon.forEach(([x, z]) => {
          const own = (x - SITES[index][0]) ** 2 + (z - SITES[index][1]) ** 2;
          for (const [sx, sz] of SITES)
            assert.ok(own <= (x - sx) ** 2 + (z - sz) ** 2 + 1e-7);
        }),
      );
    }
  const faces = landscapeFaces();
  assert.ok(
    faces.length < 200,
    "fallback groups wall faces to keep DOM size bounded",
  );
  assert.ok(faces.every((face) => !/(NaN|Infinity)/.test(face.path)));
});

await test("the restored island and checkpoint heads fit throughout rotation", () => {
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
    level.loops.flatMap((loop) =>
      loop.flatMap(([x, z]) => [
        [x, level.height + 0.2, z],
        [x, level.height - (level.height === 0 ? 5.2 : 2.88) - 0.2, z],
      ]),
    ),
  );
  for (const [x, z] of SITES) points.push([x, terrainTop(x, z) + 16, z]);
  for (const yaw of [-0.475, 0, 0.475])
    for (const pitch of [-0.125, 0, 0.125])
      for (const point of points) {
        const projected = new Vector3(...point)
          .applyEuler(new Euler(pitch, REST_YAW + yaw, 0))
          .project(camera);
        assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1);
      }
});
