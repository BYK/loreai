import * as THREE from "three";
export const PHASES = ["conversation", "knowledge", "recall"] as const;
export type MemoryPhase = (typeof PHASES)[number];
export const TITLES = ["Campfire", "Scribe’s desk", "Quest gate"] as const;
export const TOKENS = [
  "ground",
  "earth",
  "earth-side",
  "moss",
  "wood",
  "wood-light",
  "wood-dark",
  "stone",
  "stone-dark",
  "fabric",
  "cloth",
  "paper",
  "gold",
  "fire",
  "char",
  "face",
] as const;
export type CampToken = (typeof TOKENS)[number];
export const SVG_WIDTH = 600,
  SVG_HEIGHT = 400;
export function createCamp() {
  const scene = new THREE.Scene(),
    world = new THREE.Group();
  scene.add(world);
  const camera = new THREE.OrthographicCamera(-8, 8, 6, -6, 0.1, 100);
  camera.position.set(12, 15, 18);
  camera.lookAt(0, 0.6, 0);
  camera.updateMatrixWorld();
  const mats = Object.fromEntries(
    TOKENS.map((token) => [
      token,
      new THREE.MeshStandardMaterial({
        roughness: 0.9,
        metalness: token === "gold" ? 0.25 : 0,
      }),
    ]),
  ) as Record<CampToken, THREE.MeshStandardMaterial>;
  for (const token of TOKENS) mats[token].userData.campToken = token;
  const unitBox = new THREE.BoxGeometry(1, 1, 1),
    geometries = new Map<string, THREE.BufferGeometry>();
  function mesh<G extends THREE.BufferGeometry, M extends THREE.Material>(
    geometry: G,
    material: M,
    parent: THREE.Object3D = world,
  ) {
    const object = new THREE.Mesh(geometry, material);
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  }
  function box(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    parent: THREE.Object3D = world,
  ) {
    const object = mesh(unitBox, material, parent);
    object.scale.set(w, h, d);
    object.position.set(x, y, z);
    return object;
  }
  function cylinder(rt: number, rb: number, h: number, segments = 8) {
    const key = [rt, rb, h, segments].join(",");
    if (!geometries.has(key))
      geometries.set(key, new THREE.CylinderGeometry(rt, rb, h, segments));
    return geometries.get(key)!;
  }
  function ball(
    radius: number,
    material: THREE.Material,
    parent: THREE.Object3D = world,
    detail = 0,
  ) {
    const key = `ball${radius},${detail}`;
    if (!geometries.has(key))
      geometries.set(key, new THREE.IcosahedronGeometry(radius, detail));
    return mesh(geometries.get(key)!, material, parent);
  }
  function line(
    a: number[],
    b: number[],
    radius: number,
    material: THREE.Material,
    parent: THREE.Object3D = world,
  ) {
    const start = new THREE.Vector3(a[0], a[1], a[2]),
      end = new THREE.Vector3(b[0], b[1], b[2]),
      direction = end.clone().sub(start);
    const object = mesh(
      cylinder(radius, radius, direction.length(), 7),
      material,
      parent,
    );
    object.position.copy(start.add(end).multiplyScalar(0.5));
    object.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.normalize(),
    );
    return object;
  }
  function slab(
    points: number[][],
    depth: number,
    y: number,
    material: THREE.Material,
  ) {
    const shape = new THREE.Shape(
      points.map(([x, z]) => new THREE.Vector2(x, -z)),
    );
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelSize: 0.07,
      bevelThickness: 0.04,
      bevelSegments: 1,
      steps: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, y - depth, 0);
    return mesh(geometry, material);
  }
  const outline = [
    [-5.3, -1.9],
    [-4.0, -3.05],
    [-0.8, -3.35],
    [2.4, -2.85],
    [4.7, -1.8],
    [5.35, 0.5],
    [4.35, 2.35],
    [1.3, 3.05],
    [-2.7, 2.65],
    [-5.25, 0.9],
  ];
  slab(outline, 0.48, -0.11, mats["earth-side"]);
  slab(
    outline.map(([x, z]) => [x * 0.985, z * 0.985]),
    0.16,
    0.04,
    mats.earth,
  );
  slab(
    outline.map(([x, z]) => [x * 0.96, z * 0.96]),
    0.07,
    0.12,
    mats.ground,
  );
  // Irregular grass patches and rocks soften the edge of the clearing.
  const patchGeometry = new THREE.CircleGeometry(1, 9);
  patchGeometry.rotateX(-Math.PI / 2);
  for (const [x, z, s] of [
    [-4, -1.8, 0.85],
    [-4.4, 0.3, 0.65],
    [-2.2, -2.6, 0.8],
    [2.3, -2, 0.9],
    [4.2, -0.7, 0.75],
    [3.6, 2.0, 0.6],
    [-1.9, 2.05, 0.55],
  ]) {
    const patch = mesh(patchGeometry, mats.moss);
    patch.position.set(x, 0.17, z);
    patch.scale.set(s, 1, s * 0.6);
    patch.castShadow = false;
    patch.userData.groundDetail = true;
  }
  function pine(x: number, z: number, size: number) {
    const tree = new THREE.Group();
    tree.position.set(x, 0.14, z);
    tree.scale.setScalar(size);
    world.add(tree);
    mesh(cylinder(0.09, 0.14, 1.1), mats["wood-dark"], tree).position.y = 0.5;
    for (const [y, r] of [
      [1, 0.7],
      [1.43, 0.53],
      [1.8, 0.35],
    ]) {
      const crown = mesh(cylinder(0, r, 0.95, 6), mats.moss, tree);
      crown.position.y = y;
    }
    return tree;
  }
  for (const args of [
    [-4.3, -2.0, 1.05],
    [-4.7, -0.6, 0.7],
    [-2.1, -2.8, 0.9],
    [2.45, -2.3, 0.85],
    [4.25, -1.3, 0.9],
  ])
    pine(args[0], args[1], args[2]);
  for (let i = 0; i < 13; i++) {
    const angle = i * 2.39996,
      r = 4.8;
    const x = Math.cos(angle) * r,
      z = Math.sin(angle) * 2.45;
    if (z < -1.8 || x > 4.3 || x < -4.4) {
      const rock = ball(0.18 + (i % 3) * 0.04, mats["stone-dark"]);
      rock.position.set(x, 0.24, z);
      rock.scale.y = 0.65;
    }
  }
  // Canvas tent, bedroll and provisions.
  const tent = new THREE.Group();
  tent.position.set(-3.3, 0.15, -1.0);
  tent.rotation.y = 0.15;
  world.add(tent);
  function quad(
    points: number[][],
    material: THREE.Material,
    parent: THREE.Object3D,
  ) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(points.flat(), 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    const object = mesh(geometry, material, parent);
    object.material.side = THREE.DoubleSide;
    return object;
  }
  quad(
    [
      [-0.95, 0, 0.85],
      [0, 1.38, 0.85],
      [0, 1.38, -0.9],
      [-0.95, 0, -0.9],
    ],
    mats.fabric,
    tent,
  );
  quad(
    [
      [0, 1.38, 0.85],
      [0.95, 0, 0.85],
      [0.95, 0, -0.9],
      [0, 1.38, -0.9],
    ],
    mats.cloth,
    tent,
  );
  line([0, 0, 0.92], [0, 1.45, 0.92], 0.045, mats["wood-dark"], tent);
  line([0, 1.41, -0.95], [0, 1.41, 0.98], 0.04, mats["wood-dark"], tent);
  for (const x of [-1, 1])
    line([x * 0.8, 0.22, 0.75], [x * 1.24, 0.04, 1.1], 0.012, mats.gold, tent);
  const bed = mesh(cylinder(0.18, 0.18, 0.95, 12), mats.cloth, tent);
  bed.rotation.z = Math.PI / 2;
  bed.position.set(-0.25, 0.18, 0.1);
  box(0.5, 0.46, 0.48, -4.3, 0.4, 0.4, mats.wood);
  box(0.53, 0.05, 0.5, -4.3, 0.65, 0.4, mats["wood-light"]);
  const places = [new THREE.Group(), new THREE.Group(), new THREE.Group()];
  places.forEach((group, i) => {
    world.add(group);
    group.userData.stage = i;
  });
  places[0].position.set(-2.7, 0.16, 1.05);
  places[1].position.set(0.05, 0.16, -1.35);
  places[2].position.set(3.3, 0.16, 0.55);
  // Campfire: stone circle, crossed logs, faceted amber flames.
  for (let i = 0; i < 9; i++) {
    const rock = ball(0.18, mats["stone-dark"], places[0]);
    rock.position.set(
      Math.cos((i * Math.PI * 2) / 9) * 0.57,
      0.13,
      Math.sin((i * Math.PI * 2) / 9) * 0.57,
    );
    rock.scale.set(1, 0.7, 0.85);
  }
  for (const angle of [0.4, -0.65]) {
    const log = mesh(
      cylinder(0.12, 0.13, 0.95, 8),
      mats["wood-dark"],
      places[0],
    );
    log.rotation.z = Math.PI / 2;
    log.rotation.y = angle;
    log.position.y = 0.16;
  }
  const flame = new THREE.Group();
  places[0].add(flame);
  for (const [x, z, h, r] of [
    [0, 0, 0.72, 0.22],
    [-0.18, 0.07, 0.4, 0.16],
    [0.18, 0.05, 0.46, 0.15],
  ]) {
    const f = mesh(cylinder(0, r, h, 5), mats.fire, flame);
    f.position.set(x, 0.22 + h / 2, z);
    f.rotation.z = x * 0.7;
    f.castShadow = false;
  }
  const warmth = new THREE.PointLight(0xffffff, 1.4, 3, 2);
  warmth.position.set(0, 0.65, 0);
  places[0].add(warmth);
  for (const [x, z] of [
    [-1, 0.35],
    [0.7, 0.7],
  ]) {
    const stool = mesh(cylinder(0.25, 0.23, 0.36, 9), mats.wood, places[0]);
    stool.position.set(x, 0.18, z);
    box(0.48, 0.06, 0.43, x, 0.38, z, mats["wood-light"], places[0]);
  }
  // The scribe's workstation: open desk, books, parchment, quill and an archive shelf.
  const desk = places[1];
  box(1.85, 0.13, 1.02, 0, 0.86, 0, mats["wood-light"], desk);
  for (const x of [-0.72, 0.72])
    for (const z of [-0.36, 0.36])
      box(0.12, 0.78, 0.12, x, 0.42, z, mats.wood, desk);
  box(1.35, 0.12, 0.35, 0, 0.44, 0.78, mats.wood, desk);
  for (const x of [-0.5, 0.5])
    box(0.12, 0.38, 0.25, x, 0.2, 0.78, mats["wood-dark"], desk);
  box(1.75, 0.12, 0.42, 0, 1.0, -0.78, mats.wood, desk);
  box(1.75, 0.1, 0.42, 0, 1.72, -0.78, mats["wood-light"], desk);
  for (const x of [-0.85, 0.85])
    box(0.1, 1.72, 0.4, x, 0.86, -0.78, mats["wood-dark"], desk);
  for (let i = 0; i < 8; i++) {
    const book = box(
      0.13,
      0.35 + (i % 3) * 0.1,
      0.28,
      -0.65 + i * 0.18,
      1.24 + (i % 3) * 0.05,
      -0.72,
      i % 3 === 0 ? mats.fabric : i % 3 === 1 ? mats.cloth : mats["wood-dark"],
      desk,
    );
    book.rotation.z = ((i % 3) - 1) * 0.06;
  }
  for (let i = 0; i < 3; i++) {
    const book = box(
      0.48,
      0.075,
      0.34,
      -0.48,
      0.98 + i * 0.077,
      0.03,
      i === 1 ? mats.cloth : mats.paper,
      desk,
    );
    book.rotation.y = 0.13 - i * 0.08;
  }
  const paper = box(0.65, 0.02, 0.43, 0.28, 0.94, 0.08, mats.paper, desk);
  paper.rotation.y = -0.12;
  for (let i = 0; i < 3; i++) {
    const writing = box(
      0.32 - i * 0.04,
      0.008,
      0.016,
      0.27,
      0.954,
      0.0 + i * 0.08,
      mats["wood-dark"],
      desk,
    );
    writing.rotation.y = -0.12;
  }
  const ink = mesh(cylinder(0.075, 0.09, 0.12, 8), mats.char, desk);
  ink.position.set(0.65, 0.99, -0.19);
  line([0.65, 1.02, -0.19], [0.79, 1.4, -0.21], 0.014, mats.paper, desk);
  const feather = ball(0.1, mats.paper, desk);
  feather.position.set(0.79, 1.36, -0.21);
  feather.scale.set(0.35, 1.65, 0.45);
  feather.rotation.z = -0.3;
  // Stone quest gate with a hanging pennant and a quiet green opening.
  const gate = places[2];
  gate.rotation.y = -0.12;
  for (const x of [-0.76, 0.76])
    for (let i = 0; i < 4; i++) {
      const block = box(
        0.38,
        0.4,
        0.5,
        x,
        0.21 + i * 0.4,
        0,
        i % 2 ? mats.stone : mats["stone-dark"],
        gate,
      );
      block.rotation.y = (i % 2) * 0.025;
    }
  for (let i = 0; i <= 8; i++) {
    const angle = (i * Math.PI) / 8;
    const block = box(
      0.34,
      0.4,
      0.53,
      Math.cos(angle) * 0.76,
      1.56 + Math.sin(angle) * 0.76,
      0,
      i % 2 ? mats["stone-dark"] : mats.stone,
      gate,
    );
    block.rotation.z = angle - Math.PI / 2;
  }
  const doorway = new THREE.Shape();
  doorway.moveTo(-0.55, 0);
  doorway.lineTo(0.55, 0);
  doorway.lineTo(0.55, 1.55);
  doorway.absarc(0, 1.55, 0.55, 0, Math.PI, false);
  doorway.closePath();
  const opening = mesh(
    new THREE.ShapeGeometry(doorway),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    gate,
  );
  opening.position.z = 0.025;
  opening.castShadow = false;
  line([1.2, 0, 0.15], [1.2, 1.62, 0.15], 0.045, mats["wood-dark"], gate);
  box(0.7, 0.23, 0.1, 1.2, 1.4, 0.15, mats.wood, gate);
  box(0.56, 0.19, 0.1, 1.2, 1.08, 0.15, mats["wood-light"], gate);
  quad(
    [
      [-0.19, 2.15, 0.3],
      [0.19, 2.15, 0.3],
      [0.19, 1.63, 0.3],
      [0, 1.75, 0.3],
    ],
    mats.cloth,
    gate,
  );
  // A stone path connects the three destinations.
  const paths = [
    new THREE.CatmullRomCurve3([
      new THREE.Vector3(-2.0, 0.19, 1.3),
      new THREE.Vector3(-1.7, 0.19, 0.85),
      new THREE.Vector3(-0.85, 0.19, 0.23),
      new THREE.Vector3(0.05, 0.19, -0.1),
    ]),
    new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.05, 0.19, -0.1),
      new THREE.Vector3(1.0, 0.19, 0.15),
      new THREE.Vector3(1.9, 0.19, 1.15),
      new THREE.Vector3(3.25, 0.19, 1.4),
    ]),
  ];
  const stones: {
    stone: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    position: number;
  }[] = [];
  for (let leg = 0; leg < 2; leg++)
    for (let i = 0; i < 13; i++) {
      const material = new THREE.MeshStandardMaterial({ roughness: 1 });
      material.userData.campToken = "stone";
      const stone = mesh(cylinder(0.19, 0.22, 0.055, 6), material);
      stone.position.copy(paths[leg].getPointAt(i / 12));
      stone.rotation.y = i * 0.71;
      stone.scale.z = 0.7 + (i % 3) * 0.08;
      stone.userData.groundDetail = true;
      stones.push({ stone, position: leg + i / 12 });
    }
  const rings = places.map((group) => {
    const ring = mesh(
      new THREE.RingGeometry(0.84, 0.87, 48),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
      group,
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    ring.castShadow = false;
    return ring;
  });
  // A small hooded traveller carries one useful scroll to the next quest.
  const hero = new THREE.Group();
  world.add(hero);
  const body = mesh(cylinder(0.15, 0.26, 0.43, 7), mats.cloth, hero);
  body.position.y = 0.4;
  const head = ball(0.15, mats.face, hero, 1);
  head.position.set(0, 0.78, 0.085);
  const hood = ball(0.19, mats.cloth, hero, 1);
  hood.position.set(0, 0.8, -0.045);
  for (const x of [-0.05, 0.05]) {
    const eye = ball(0.018, mats.char, hero);
    eye.position.set(x, 0.8, 0.22);
  }
  box(0.2, 0.27, 0.14, 0, 0.52, -0.2, mats["wood-light"], hero);
  line([-0.1, 0.65, -0.23], [0.1, 0.65, -0.23], 0.015, mats["wood-dark"], hero);
  const feet = [
    box(0.1, 0.15, 0.17, -0.09, 0.13, 0.03, mats.char, hero),
    box(0.1, 0.15, 0.17, 0.09, 0.13, 0.03, mats.char, hero),
  ];
  const arm = box(0.07, 0.25, 0.08, 0.22, 0.45, 0.03, mats.cloth, hero);
  arm.rotation.z = 0.25;
  const carried = new THREE.Group();
  hero.add(carried);
  const scroll = mesh(cylinder(0.048, 0.048, 0.26, 10), mats.paper, carried);
  scroll.rotation.z = Math.PI / 2;
  scroll.position.set(0.27, 0.47, 0.14);
  const band = mesh(cylinder(0.051, 0.051, 0.045, 10), mats.gold, carried);
  band.rotation.z = Math.PI / 2;
  band.position.copy(scroll.position);
  const sky = new THREE.HemisphereLight(0xffffff, 0xffffff, 2);
  scene.add(sky);
  const light = new THREE.DirectionalLight(0xffffff, 3.2);
  light.position.set(-7, 13, 8);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  Object.assign(light.shadow.camera, {
    left: -8,
    right: 8,
    top: 7,
    bottom: -7,
    near: 1,
    far: 35,
  });
  light.shadow.bias = -0.0003;
  light.shadow.normalBias = 0.025;
  scene.add(light);
  const shadow = mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.ShadowMaterial({ opacity: 0.12 }),
    scene,
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.66;
  shadow.castShadow = false;
  shadow.userData.omitFallback = true;

  function heroPoint(position: number) {
    const leg = Math.min(1, Math.floor(position));
    return paths[leg].getPointAt(Math.max(0, Math.min(1, position - leg)));
  }
  hero.position.copy(heroPoint(0));
  carried.visible = false;
  world.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(world);
  const corners: THREE.Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z])
        corners.push(
          new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse),
        );
  function fit(width: number, height: number) {
    const ratio = width / height;
    const half =
      Math.max(
        ...corners.map((point) =>
          Math.max(Math.abs(point.y), Math.abs(point.x) / ratio),
        ),
      ) * 1.08;
    camera.top = half;
    camera.bottom = -half;
    camera.left = -half * ratio;
    camera.right = half * ratio;
    camera.updateProjectionMatrix();
  }
  fit(SVG_WIDTH, SVG_HEIGHT);
  return {
    scene,
    world,
    camera,
    mats,
    places,
    paths,
    stones,
    rings,
    hero,
    feet,
    carried,
    opening,
    warmth,
    sky,
    light,
    shadow,
    heroPoint,
    fit,
  };
}
export type Camp = ReturnType<typeof createCamp>;
export function disposeCamp(scene: THREE.Scene) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      geometries.add(object.geometry);
      (Array.isArray(object.material)
        ? object.material
        : [object.material]
      ).forEach((material) => materials.add(material));
    }
    if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  scene.clear();
}
