/**
 * Scene setup: a quiet room, one warm light, and a creature standing on the floor.
 * Kept deliberately sparse so the creature is the only thing worth looking at.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Creature } from './creature';
import { FeedingArea } from './feeding';
import type { FoodKind } from './food';

export interface Stage {
  creature: Creature;
  feeding: FeedingArea;
  dispose: () => void;
  raycastHit: (nx: number, ny: number) => boolean;
  /** World position of the dog's head — where food must be dropped to be eaten. */
  mouthPosition: () => THREE.Vector3;
  camera: THREE.Camera;
  /** Swing the camera around the creature, in radians. */
  setOrbit: (yaw: number) => void;
}

/** Notified when food is picked up or eaten, so the UI can react. */
export interface StageHooks {
  onFed?: (kind: FoodKind) => void;
  onPickup?: (kind: FoodKind) => void;
}

export async function createStage(
  canvas: HTMLCanvasElement,
  hooks: StageHooks = {},
): Promise<Stage> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0e1013');
  scene.fog = new THREE.Fog('#0e1013', 6, 16);

  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.35, 3.6);
  camera.lookAt(0, 0.6, 0);

  // ---- lighting: one warm key light, cool fill, so it feels like a room
  const key = new THREE.DirectionalLight('#fff4e2', 2.9);
  key.position.set(2.5, 4, 2.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 15;
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -4;
  key.shadow.bias = -0.0012;
  scene.add(key);

  const fill = new THREE.HemisphereLight('#a8c8e8', '#23262b', 1.7);
  scene.add(fill);

  const rim = new THREE.DirectionalLight('#a9d8ff', 1.1);
  rim.position.set(-3, 2, -3);
  scene.add(rim);

  // ---- floor
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(9, 64),
    new THREE.MeshStandardMaterial({ color: '#1b1f24', roughness: 0.95, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // faint grid so motion is readable without being busy
  const grid = new THREE.GridHelper(18, 36, 0x2a3138, 0x22272d);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  grid.position.y = 0.002;
  scene.add(grid);

  // ---- load the creature
  const creature = new Creature();
  scene.add(creature.root);

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/dog.glb`);

  const model = gltf.scene;
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      // the source model is tiny; scale it up to room size
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat && mat.isMeshStandardMaterial) {
        mat.roughness = 0.75;
        mat.metalness = 0.05;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Recolour the fox rig into a dog.
  //
  // The GLB ships exactly four materials (AccentRed / Paper / Ink / Gold), which
  // map cleanly onto a Bernese-mountain-dog palette: dark saddle over the back,
  // cream chest and muzzle, tan markings, black legs and paws. Recolouring here
  // rather than editing the GLB keeps the source asset untouched and makes the
  // palette a one-line change.
  const DOG_PALETTE: Record<string, { color: string; roughness: number }> = {
    // orange fur -> warm charcoal saddle (back, head, ears, upper tail).
    // Kept a clear step lighter than the legs so the dog does not read as a
    // single black blob under the key light.
    AccentRed: { color: '#4a4640', roughness: 0.86 },
    // cream underbelly / muzzle / tail tip -> warm off-white chest
    Paper: { color: '#efe9dd', roughness: 0.88 },
    // legs, eyes, nose -> near-black, slightly softer than pure ink
    Ink: { color: '#1b1b1e', roughness: 0.8 },
    // collar hardware -> rust/tan tag, the Bernese marking
    Gold: { color: '#c2863f', roughness: 0.6 },
  };

  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    const preset = mat?.name ? DOG_PALETTE[mat.name] : undefined;
    if (preset && mat) {
      mat.color = new THREE.Color(preset.color);
      mat.roughness = preset.roughness;
    }
  });

  // Fox ears are long and pointed; dogs have shorter, blunter ears. These meshes
  // are skinned, so changing mesh.scale does nothing visible — the vertex
  // positions come from the bone matrices. Deform the geometry itself instead,
  // compressing each vertex toward the ear's own base so the silhouette reads
  // canine while every animation keeps working.
  const squashGeometry = (
    match: RegExp,
    fn: (p: THREE.Vector3, box: THREE.Box3) => void,
  ) => {
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !match.test(m.name)) return;
      const geo = m.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      if (!pos) return;
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      for (let i = 0; i < pos.count; i++) {
        const p = new THREE.Vector3().fromBufferAttribute(pos, i);
        fn(p, bb);
        pos.setXYZ(i, p.x, p.y, p.z);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    });
  };

  // ears: squash vertically toward the base, widen slightly
  squashGeometry(/Ear/i, (p, bb) => {
    p.y = bb.min.y + (p.y - bb.min.y) * 0.6;
    p.x *= 1.25;
    p.z *= 1.2;
  });

  // snout: shorter and blunter
  squashGeometry(/Snout|Nose/i, (p) => {
    p.z *= 0.85;
    p.x *= 1.15;
  });

  // tail: thinner and straighter than a fox brush
  squashGeometry(/Tail_1|Tail_2/i, (p, bb) => {
    const mid = (bb.min.x + bb.max.x) / 2;
    p.x = mid + (p.x - mid) * 1.15; // flatten the side-to-side spread
    p.y *= 0.94;
  });

  // The source model is authored lying along Z (X=0.32, Y=0.90, Z=1.18) — it is
  // long front-to-back, not tall. Normalising by height alone squashes it, so
  // scale by the longest edge.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const scale = 1.9 / longest;
  model.scale.setScalar(scale);

  // The animal runs along +Z, i.e. it is authored nose-out toward the camera when
  // unrotated. Leave it there: the creature drives its own yaw via `pivot`, and a
  // baked quarter-turn here would make "face the viewer" impossible to express.
  model.rotation.x = -0.04;

  const box2 = new THREE.Box3().setFromObject(model);
  model.position.y -= box2.min.y; // stand on the floor
  model.position.z -= (box2.min.z + box2.max.z) / 2; // centre front-to-back

  creature.bind(model);

  // ---- food laid out on the floor in front of the dog
  const feeding = new FeedingArea({
    onFed: (kind, appeal, nutrition) => {
      creature.feed(appeal, nutrition);
      hooks.onFed?.(kind);
    },
    onPickup: (kind) => hooks.onPickup?.(kind),
    isOverCreature: (clientX, clientY) =>
      hitsCreature(
        (clientX / window.innerWidth) * 2 - 1,
        -(clientY / window.innerHeight) * 2 + 1,
      ),
  });
  // place food relative to where the muzzle actually sits on the floor
  const muzzleZ = model.getObjectByName('Head')
    ? (() => {
        const v = new THREE.Vector3();
        model.getObjectByName('Head')!.getWorldPosition(v);
        return v.z + 0.18;
      })()
    : 0.35;
  feeding.build(camera, 0, muzzleZ);
  scene.add(feeding.root);

  // ---- interaction
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const hitsCreature = (nx: number, ny: number) => {
    ndc.set(nx, ny);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObject(model, true).length > 0;
  };

  /** Roughly the dog's muzzle, in world space. Food dropped near here is eaten. */
  const mouthPosition = () => {
    const head = model.getObjectByName('Head');
    const v = new THREE.Vector3();
    if (head) head.getWorldPosition(v);
    else model.getWorldPosition(v);
    // the rig's head pivot sits at the neck; push forward toward the snout
    v.z += 0.34;
    return v;
  };

  /** Orbit angle of the camera around the creature, and its eased target. */
  let camYaw = 0;
  let camYawTarget = 0;
  /** Last yaw the food row was arranged for, so it only re-lays when it moves. */
  let lastFoodYaw = -99;

  // ---- loop
  let raf = 0;
  let last = performance.now();
  let elapsed = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    creature.update(dt);
    feeding.update(elapsed);

    // ---- orbiting camera
    // Drag with the right button (or two fingers) to swing around the creature.
    // The creature then turns to keep facing the viewer, so you can walk all the
    // way round to its front, side and back.
    camYaw += (camYawTarget - camYaw) * Math.min(1, dt * 6);
    const cx = creature.root.position.x;
    const radius = 3.7;
    const camX = cx + Math.sin(camYaw) * radius;
    const camZ = Math.cos(camYaw) * radius;
    camera.position.x += (camX - camera.position.x) * Math.min(1, dt * 1.6);
    camera.position.z += (camZ - camera.position.z) * Math.min(1, dt * 1.6);
    camera.position.y = 1.35;
    camera.lookAt(cx * 0.5, 0.62, 0);

    // Tell the creature where the viewer is, in its own local space, so it can
    // turn to meet the camera rather than always presenting a profile.
    const worldYaw = camYaw; // camera sits at +yaw around the origin
    const facingYaw = worldYaw - creature.root.rotation.y;
    creature.faceToward(-facingYaw, creature.getState().touching);

    // Keep the food row in front of the viewer as the camera swings round, so it
    // is never occluded by the dog's body.
    if (Math.abs(camYaw - lastFoodYaw) > 0.01) {
      feeding.setOrbit(camYaw, creature.root.position);
      lastFoodYaw = camYaw;
    }

    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  // ---- orbit controls
  // Right-drag orbits the camera. The left button is reserved for petting and for
  // dragging food, so it cannot double as the camera control.
  let orbitDragging = false;
  let orbitLastX = 0;

  const onContextMenu = (e: MouseEvent) => {
    // stop the browser menu so a right-drag can rotate
    if (orbitDragging || (e.target as HTMLElement)?.tagName === 'CANVAS') e.preventDefault();
  };
  const onPointerDownOrbit = (e: PointerEvent) => {
    if (e.button !== 2 && e.button !== 1) return;
    orbitDragging = true;
    orbitLastX = e.clientX;
    e.preventDefault();
  };
  const onPointerMoveOrbit = (e: PointerEvent) => {
    if (!orbitDragging) return;
    const dx = e.clientX - orbitLastX;
    orbitLastX = e.clientX;
    camYawTarget += dx * 0.006;
  };
  const onPointerUpOrbit = (e: PointerEvent) => {
    if (e.button !== 2 && e.button !== 1) return;
    orbitDragging = false;
  };

  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointerdown', onPointerDownOrbit);
  window.addEventListener('pointermove', onPointerMoveOrbit);
  window.addEventListener('pointerup', onPointerUpOrbit);
  window.addEventListener('pointercancel', onPointerUpOrbit);

  // ---- debug hook: expose the pieces the drag maths depends on, so the
  // gesture can be inspected from the console without guessing.
  (window as unknown as { __stage?: unknown }).__stage = {
    camera,
    feeding,
    mouthPosition,
    creature,
    /** Reproduce the app's screen->floor projection for a client point. */
    project(clientX: number, clientY: number) {
      const ndc = new THREE.Vector2(
        (clientX / window.innerWidth) * 2 - 1,
        -(clientY / window.innerHeight) * 2 + 1,
      );
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, camera);
      const hit = new THREE.Vector3();
      const ok = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit);
      return ok ? { x: hit.x, y: hit.y, z: hit.z } : null;
    },
    /** Where each food currently sits. */
    items() {
      return feeding.debugItems();
    },
    /** Orbit the camera, for tests and for the on-screen hint. */
    setOrbit(yaw: number) {
      camYawTarget = yaw;
      camYaw = yaw;
    },
    getOrbit() {
      return camYaw;
    },
  };

  return {
    creature,
    feeding,
    camera,
    mouthPosition,
    raycastHit: hitsCreature,
    setOrbit: (yaw: number) => {
      camYawTarget = yaw;
      camYaw = yaw;
    },
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointerdown', onPointerDownOrbit);
      window.removeEventListener('pointermove', onPointerMoveOrbit);
      window.removeEventListener('pointerup', onPointerUpOrbit);
      window.removeEventListener('pointercancel', onPointerUpOrbit);
      creature.dispose();
      renderer.dispose();
    },
  };
}
