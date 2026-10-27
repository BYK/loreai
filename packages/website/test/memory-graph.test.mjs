import assert from "node:assert/strict";
import { test } from "node:test";
import { Euler, Vector3 } from "three";
import {
  GRAPH_SIZE,
  WORLD_SIZE,
  REST_PITCH,
  REST_YAW,
  MEMORY_NODES,
  MEMORY_WEAVE,
  connectionPoints,
  projectPoint,
} from "../src/lib/memory-graph.ts";

await test("static projections match the GPU's Euler rest pose", () => {
  for (const node of MEMORY_NODES) {
    const point = new Vector3(...node.position).applyEuler(
      new Euler(REST_PITCH, REST_YAW, 0),
    );
    const [x, y] = projectPoint(node.position);
    assert.ok(
      Math.abs(x - (GRAPH_SIZE / 2 + (point.x * GRAPH_SIZE) / WORLD_SIZE)) <
        1e-9,
    );
    assert.ok(
      Math.abs(y - (GRAPH_SIZE / 2 - (point.y * GRAPH_SIZE) / WORLD_SIZE)) <
        1e-9,
    );
    assert.ok(x > node.radius && x < GRAPH_SIZE - node.radius);
    assert.ok(y > node.radius && y < GRAPH_SIZE - node.radius);
  }
});

await test("connections terminate at their satellite and cannot mutate shared positions", () => {
  for (const node of MEMORY_NODES) {
    const points = connectionPoints(node.position);
    assert.ok(MEMORY_WEAVE.includes(points[0]));
    assert.deepEqual(points.at(-1), node.position);
    assert.throws(() => {
      node.position[0] = 999;
    }, TypeError);
  }
  assert.deepEqual(
    new Set(MEMORY_NODES.map((node) => node.phase)),
    new Set(["conversation", "knowledge", "recall"]),
  );
});

await test("woven tile orientations and fallback faces remain finite and correctly ordered", async () => {
  const { memoryPoint, tileRotation, MEMORY_TILE_FACES } =
    await import("../src/lib/memory-graph.ts");
  const { Quaternion } = await import("three");
  for (let index = 0; index < MEMORY_WEAVE.length; index++) {
    const rotation = new Quaternion(...tileRotation(index));
    assert.ok(Math.abs(rotation.length() - 1) < 1e-9);
    const tangent = new Vector3(
      ...memoryPoint(((index + 0.2) / MEMORY_WEAVE.length) * Math.PI * 2),
    )
      .sub(new Vector3(...MEMORY_WEAVE[index]))
      .normalize();
    assert.ok(
      new Vector3(1, 0, 0).applyQuaternion(rotation).distanceTo(tangent) < 1e-9,
    );
  }
  assert.ok(MEMORY_TILE_FACES.length >= MEMORY_WEAVE.length * 2);
  let lastDepth = -Infinity;
  for (const face of MEMORY_TILE_FACES) {
    assert.ok(face.depth >= lastDepth);
    lastDepth = face.depth;
    assert.equal(face.points.length, 4);
    for (const point of face.points) {
      const projected = projectPoint(point);
      assert.ok(
        projected.every(
          (value) => Number.isFinite(value) && value > 0 && value < GRAPH_SIZE,
        ),
      );
    }
  }
});
