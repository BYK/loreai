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
  terrainHeight,
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

await test("two distinct project islands retain separate shorelines and refinement bands", async () => {
  const { ISLANDS, islandAt } = await import("../src/lib/memory-landscape.ts");
  assert.equal(ISLANDS.length, 2);
  assert.ok(terrainHeight(0, 0) < 0);
  for (const [index, island] of ISLANDS.entries()) {
    assert.ok(terrainHeight(island.x, island.z) > 0);
    for (const [x, z] of [
      [-64, -8],
      [65, -30],
      [30, 60],
    ])
      assert.ok(
        terrainHeight(
          island.x + x * island.scale * island.mirror,
          island.z + z * island.scale,
        ) > 40,
      );
    assert.equal(islandAt(island.x, island.z), index);
  }
  const levels = terrainLevels();
  assert.equal(levels[0].loops.length, 2);
  for (const level of levels) assert.ok(level.loops.length <= 6);
  for (const band of [0, 1, 2])
    assert.ok(
      levels.some(
        (level) =>
          bandAtHeight(level.height) === band && level.loops.length === 2,
      ),
    );
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
      for (const island of [0, 1]) {
        const [x, y, z] = pointOnTerrain(height, index * 2.3999632297, island);
        assert.ok(Math.abs(terrainHeight(x, z) - height) < 1e-7);
        assert.ok(y >= Math.floor(height / TERRAIN_STEP) * TERRAIN_STEP + 0.16);
      }
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

await test("shared knowledge crosses the gap and arrives on the receiving island", async () => {
  const { transferPoint, crestPoint, transferPath } =
    await import("../src/lib/memory-landscape.ts");
  for (const angle of [0, 0.85, 2, 4]) {
    transferPoint(1.35, angle).forEach((value, index) =>
      assert.ok(Math.abs(value - crestPoint(0, angle)[index]) < 1e-8),
    );
    const end = transferPoint(2, angle),
      expected = crestPoint(1, angle);
    end.forEach((value, index) =>
      assert.ok(Math.abs(value - expected[index]) < 1e-8),
    );
    const midpoint = transferPoint(1.625, angle);
    assert.ok(midpoint[1] > 100);
    assert.ok(terrainHeight(midpoint[0], midpoint[2]) < 0);
  }
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
  for (const yaw of [-0.475, 0, 0.475])
    for (const pitch of [-0.125, 0, 0.125])
      for (const point of transferPath()) {
        const projected = new Vector3(...point)
          .applyEuler(new Euler(pitch, REST_YAW + yaw, 0))
          .project(camera);
        assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1);
      }
});

await test("visible transfer fragments clear both islands throughout launch and landing", async () => {
  const { transferPoint, refinementDetailCount, TERRAIN_STEP } =
    await import("../src/lib/memory-landscape.ts");
  for (let sample = 0; sample <= 650; sample++) {
    const position = (2 * sample) / 650,
      count = refinementDetailCount(position);
    for (let index = 0; index < count; index++) {
      const angle = index * 2.3999632297 + position * 0.1,
        point = transferPoint(position, angle),
        half = 2.7 * (1.4 - position * 0.35);
      for (const dx of [-half, 0, half])
        for (const dz of [-0.625, 0, 0.625]) {
          const x = point[0] + dx * Math.cos(angle) - dz * Math.sin(angle),
            z = point[2] + dx * Math.sin(angle) + dz * Math.cos(angle),
            height = terrainHeight(x, z);
          if (height >= 0)
            assert.ok(
              point[1] > Math.floor(height / TERRAIN_STEP) * TERRAIN_STEP + 0.2,
              `fragment ${index} clips terrain at ${position}`,
            );
        }
    }
  }
});
