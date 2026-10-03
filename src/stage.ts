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

  // snout: shorter and blunter.
  //
  // This runs before the muzzle shaping below, which needs the pre-squash
  // proportions, so it keeps its original job of shortening and widening.
  squashGeometry(/Snout|Nose/i, (p) => {
    p.z *= 0.85;
    p.x *= 1.15;
  });

  // ---------------------------------------------------------------------------
  // Muzzle: stop the snout reading as a flat panel.
  //
  // After the squash above, Fox_Snout is a tapered box whose BACK face is
  // 0.133 x 0.110 and whose FRONT face is 0.092 x 0.080 — nearly as wide as it
  // is tall, and almost as wide as the head is (0.28). Viewed in profile that is
  // a perfectly good protruding muzzle. Viewed HEAD-ON — which is the only view
  // this app ever presents, because the creature turns to face the viewer —
  // a short box with a broad flat front reads as a cream square stuck on a dark
  // slab, with Fox_Nose as a dot in the middle. That is the "bandage".
  //
  // The fix is only about the front face: pull its corners in so the muzzle
  // tapers properly toward the tip, and drop it slightly so the snout reads as
  // angled downward out of the brow rather than squared off. The back face is
  // untouched, so the profile silhouette that already looks right does not move.
  //
  // The nose rides the snout's taper rather than its own: tapering each mesh by
  // its own z-span would shrink the small nose about its own centre and leave it
  // sitting off to one side of the narrowing muzzle.
  const MUZZLE_TIP = 0.62; // front face scale vs. back, both x and y
  const MUZZLE_DROOP = 0.022; // tip drops this far (model units) below the root

  const snout = model.getObjectByName('Fox_Snout') as THREE.Mesh | undefined;
  if (snout) {
    const geo = snout.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    if (pos) {
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const span = bb.max.z - bb.min.z || 1;
      const midY = (bb.min.y + bb.max.y) / 2;
      // t = 0 at the root (toward the skull), t = 1 at the tip (most forward, -Z)
      for (let i = 0; i < pos.count; i++) {
        const p = new THREE.Vector3().fromBufferAttribute(pos, i);
        const t = (bb.max.z - p.z) / span;
        const taper = 1 + (MUZZLE_TIP - 1) * t;
        p.x *= taper;
        p.y = midY + (p.y - midY) * taper - MUZZLE_DROOP * t;
        pos.setXYZ(i, p.x, p.y, p.z);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();

      // Now carry the nose with the snout, using the snout's own taper profile so
      // the two stay concentric.
      const nose = model.getObjectByName('Fox_Nose') as THREE.Mesh | undefined;
      const npos = nose?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (nose && npos) {
        for (let i = 0; i < npos.count; i++) {
          const p = new THREE.Vector3().fromBufferAttribute(npos, i);
          const t = Math.min(1, Math.max(0, (bb.max.z - p.z) / span));
          const taper = 1 + (MUZZLE_TIP - 1) * t;
          p.x *= taper;
          p.y = midY + (p.y - midY) * taper - MUZZLE_DROOP * t;
          npos.setXYZ(i, p.x, p.y, p.z);
        }
        npos.needsUpdate = true;
        nose.geometry.computeVertexNormals();
        nose.geometry.computeBoundingSphere();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Eyes: bring them forward onto the face and make them readable.
  //
  // Measured from the source GLB (model space, before any app transform):
  //     Fox_Head   x=[-0.140, 0.140]  z=[-0.410, -0.170]   a frustum, 0.24 deep
  //     Fox_Snout  root 0.133 x 0.110 at z=-0.3485, tip at z=-0.493
  //     Fox_Eye_L  x=[ 0.127, 0.135]  y=[0.661,0.709]  z=[-0.350,-0.290]
  //
  // The eye is a 0.008-thick fin lying ACROSS the skull's side wall, and it sits
  // 0.09 BEHIND the head's front face (z=-0.41) at |x|=0.131, where the head is
  // only 0.1275 wide. Projected through the camera, both eyes land 0.25-0.46
  // units behind the head's own front surface — buried in the skull. Measured on
  // a flat-colour isolation render, the left eye covers 5 px head-on and the
  // right eye is not visible at all.
  //
  // It is a fox eye, authored for a long pointed fox face; this is a blunt dog
  // with a short muzzle, so it has to move FORWARD onto the cheek and INBOARD
  // off the silhouette, and be rebuilt as a compact quad rather than a fin.
  // Binding to the Head bone is untouched — only vertices move.
  const EYE_X = 0.080; // |x| of the eye centre (was 0.131)
  const EYE_Y = 0.655; // eye height stays on the brow
  const EYE_Z = -0.405; // just proud of the head's front face (was -0.320)
  const EYE_HALF = 0.022; // half-extent: square, so it reads as an eye
  const EYE_YAW = Math.PI / 6; // 30 deg off the wall, turning it toward the viewer

  for (const name of ['Fox_Eye_L', 'Fox_Eye_R'] as const) {
    const m = model.getObjectByName(name) as THREE.Mesh | undefined;
    if (!m) continue;
    const geo = m.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) continue;
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const side = (bb.min.x + bb.max.x) / 2 >= 0 ? 1 : -1;
    // Quad basis. The eye's face normal starts pointing straight out of the
    // cheek (+/-X) and is rotated EYE_YAW toward the front (-Z), which is the
    // direction the camera looks from. In-plane axes are that normal rotated 90
    // degrees within the XZ plane, and straight up.
    const nx = side * Math.cos(EYE_YAW);
    const nz = -Math.sin(EYE_YAW);
    const rx = -nz;
    const rz = nx;
    const ex = (bb.max.x - bb.min.x) || 1;
    const ey = (bb.max.y - bb.min.y) || 1;
    const ez = (bb.max.z - bb.min.z) || 1;
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      // Normalise the source fin's own axes into -1..1, then rebuild the vertex
      // as a corner of the square quad. The fin's long axis (z) becomes the
      // quad's in-plane "right", its height (y) stays vertical, and its 0.008
      // thickness (x) becomes a small relief along the normal so the eye is a
      // thin slab rather than a zero-volume plane.
      const u = ((p.z - bb.min.z) / ez) * 2 - 1;
      const v = ((p.y - bb.min.y) / ey) * 2 - 1;
      const w = ((p.x - bb.min.x) / ex) * 2 - 1;
      pos.setXYZ(
        i,
        side * EYE_X + rx * u * EYE_HALF + nx * w * 0.004,
        EYE_Y + v * EYE_HALF,
        EYE_Z + rz * u * EYE_HALF + nz * w * 0.004,
      );
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

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

  // The animal is authored nose at -Z and tail at +Z (Fox_Nose centres at
  // z = -0.958, Fox_Tail_2 at z = +0.958), so an unrotated model presents its
  // BACK to a camera parked on +Z — which is exactly where the orbit ring puts
  // it at camYaw = 0. Leave the authored orientation alone: the creature drives
  // its own yaw via `pivot`, and a baked half-turn here would only hide the
  // convention that the facing maths below has to account for.
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
    const cz = creature.root.position.z;

    // Keep a hard floor on the orbit radius. The dog's meshes are ~1.9 units
    // long, so a radius below that puts the near plane inside its body and the
    // screen fills with fur.
    const radius = 3.7;
    const targetX = cx + Math.sin(camYaw) * radius;
    const targetZ = cz + Math.cos(camYaw) * radius;

    camera.position.x += (targetX - camera.position.x) * Math.min(1, dt * 1.6);
    camera.position.z += (targetZ - camera.position.z) * Math.min(1, dt * 1.6);
    camera.position.y = 1.35;

    // Safety net: if the camera somehow ends up inside the creature's bounding
    // sphere, push it back out along the view direction.
    const focus = new THREE.Vector3(cx * 0.5, 0.62, cz);
    const away = camera.position.clone().sub(focus);
    const dist = away.length();
    const MIN_CAM_DIST = 2.2;
    if (dist < MIN_CAM_DIST) {
      away.setLength(MIN_CAM_DIST);
      camera.position.copy(focus).add(away);
    }

    camera.lookAt(focus);

    // Tell the creature where the viewer is, in its own local space, so it can
    // turn to meet the camera rather than always presenting a profile.
    //
    // The model is authored nose at -Z, so its local forward is (0, 0, -1); at a
    // pivot yaw t that forward becomes (-sin t, 0, -cos t). The camera sits at
    // angle camYaw on the ring, i.e. in the direction (sin camYaw, 0, cos camYaw)
    // as seen from the creature. Meeting it head-on therefore needs
    //   (-sin t, -cos t) == (sin camYaw, cos camYaw)   =>   t = camYaw + PI.
    // `faceToward` is also called every frame with a fresh absolute target, so
    // the error term it eases away is what keeps this tracking as the camera
    // swings — a constant offset here would only ever be right at one angle.
    const worldYaw = camYaw + Math.PI; // camera sits at +yaw around the origin
    const facingYaw = worldYaw - creature.root.rotation.y;
    creature.faceToward(facingYaw, creature.getState().touching);

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
