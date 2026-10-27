import assert from "node:assert/strict";
import { test } from "node:test";
import { Euler, Vector3 } from "three";
import {
  GRAPH_SIZE,
  WORLD_SIZE,
  REST_PITCH,
  REST_YAW,
  MEMORY_NODES,
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
    assert.deepEqual(points[0], [0, 0, 0]);
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
