/**
 * Scene setup: a quiet room, one warm light, and a creature standing on the floor.
 * Kept deliberately sparse so the creature is the only thing worth looking at.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Creature } from './creature';

export interface Stage {
  creature: Creature;
  dispose: () => void;
  raycastHit: (nx: number, ny: number) => boolean;
}

export async function createStage(canvas: HTMLCanvasElement): Promise<Stage> {
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
  const key = new THREE.DirectionalLight('#fff2df', 2.2);
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

  const fill = new THREE.HemisphereLight('#8fb4d9', '#1a1d21', 1.1);
  scene.add(fill);

  const rim = new THREE.DirectionalLight('#9fd0ff', 0.7);
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
  const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/fox.glb`);

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

  // The source model is authored lying along Z (X=0.32, Y=0.90, Z=1.18) — it is
  // long front-to-back, not tall. Normalising by height alone squashes it, so
  // scale by the longest edge and then turn it to face the camera.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const scale = 1.9 / longest;
  model.scale.setScalar(scale);

  // face the camera: the animal runs along +Z, so yaw it a quarter turn and
  // tip it slightly so we see the side/three-quarter view rather than its nose.
  model.rotation.y = Math.PI * 0.5;
  model.rotation.x = -0.06;

  const box2 = new THREE.Box3().setFromObject(model);
  model.position.y -= box2.min.y; // stand on the floor
  model.position.z -= (box2.min.z + box2.max.z) / 2; // centre front-to-back

  creature.bind(model);

  // ---- interaction
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const hitsCreature = (nx: number, ny: number) => {
    ndc.set(nx, ny);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObject(model, true).length > 0;
  };

  // ---- loop
  let raf = 0;
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    creature.update(dt);

    // camera drifts slightly toward the creature, so it feels observed
    const cx = creature.root.position.x;
    camera.position.x += (cx * 0.28 - camera.position.x) * Math.min(1, dt * 1.2);
    camera.lookAt(cx * 0.5, 0.62, 0);

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

  return {
    creature,
    raycastHit: hitsCreature,
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      creature.dispose();
      renderer.dispose();
    },
  };
}
