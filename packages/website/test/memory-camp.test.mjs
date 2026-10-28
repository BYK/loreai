import assert from "node:assert/strict";
import { test } from "node:test";
import { Vector3, Mesh } from "three";
import {
  createCamp,
  disposeCamp,
  PHASES,
  SVG_WIDTH,
  SVG_HEIGHT,
} from "../src/lib/memory-camp.ts";
import { campFallback } from "../src/lib/memory-camp-fallback.ts";
await test("camp and traveller fit the camera at every supported aspect ratio", () => {
  const camp = createCamp();
  try {
    for (const [width, height] of [
      [600, 400],
      [296, 197.33],
      [736, 490.67],
    ]) {
      camp.fit(width, height);
      camp.world.updateMatrixWorld(true);
      camp.world.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const positions = object.geometry.getAttribute("position");
        for (let i = 0; i < positions.count; i++) {
          const p = new Vector3()
            .fromBufferAttribute(positions, i)
            .applyMatrix4(object.matrixWorld)
            .project(camp.camera);
          assert.ok(
            Math.abs(p.x) < 1 && Math.abs(p.y) < 1,
            "camp geometry remains in view",
          );
        }
      });
      for (let position = 0; position <= 2; position += 0.05) {
        const point = camp.heroPoint(position);
        assert.ok(point.toArray().every(Number.isFinite));
        const p = point
          .clone()
          .add(new Vector3(0, 1.1, 0))
          .project(camp.camera);
        assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1);
      }
    }
    assert.ok(
      camp.paths[0].getPointAt(1).distanceTo(camp.paths[1].getPointAt(0)) <
        1e-10,
    );
    camp.places.forEach((place, i) => assert.equal(place.userData.stage, i));
  } finally {
    disposeCamp(camp.scene);
  }
});
await test("fallback is deterministic, bounded, and includes every selectable camp landmark", () => {
  const faces = campFallback();
  assert.deepEqual(campFallback(), faces);
  assert.ok(faces.length < 2500, `fallback size: ${faces.length}`);
  for (const phase of PHASES) {
    assert.ok(faces.some((f) => f.phase === phase && !f.hero && !f.ring));
    assert.ok(faces.some((f) => f.hero === phase));
    assert.ok(faces.some((f) => f.ring === phase));
  }
  for (const face of faces) {
    assert.ok(!/NaN|Infinity/.test(face.path));
    const coords = [...face.path.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)];
    assert.ok(coords.length >= 3);
    for (const [, x, y] of coords) {
      assert.ok(+x > 0 && +x < SVG_WIDTH);
      assert.ok(+y > 0 && +y < SVG_HEIGHT);
    }
    assert.match(face.token, /^[a-z-]+$/);
  }
});

await test("the Conversation fallback hides the carried scroll until knowledge is curated", () => {
  const faces = campFallback();
  assert.equal(
    faces.filter(
      (face) => face.hero === "conversation" && face.token === "paper",
    ).length,
    0,
  );
  assert.ok(
    faces.some((face) => face.hero === "knowledge" && face.token === "paper"),
  );
});

await test("fallback paints the entire ground before the camp props", () => {
  const faces = campFallback(),
    firstProp = faces.findIndex((face) => face.phase && !face.ring);
  assert.ok(firstProp > 0);
  assert.ok(
    faces.every(
      (face, index) =>
        !["ground", "earth", "earth-side"].includes(face.token) ||
        index < firstProp,
    ),
  );
});
