/**
 * Food models, built from primitives at runtime.
 *
 * Everything here is plain geometry — no external assets. That keeps the whole
 * game under the size of the dog model and lets the palette be tuned in one
 * place, which matters because food is read at a glance from across the room.
 *
 * The list is deliberately dog-plausible: dogs are omnivores leaning carnivore,
 * so meat and treats get a strong reaction and vegetables get a polite sniff.
 */
import * as THREE from 'three';

export type FoodKind =
  | 'kibble'
  | 'bone'
  | 'meat'
  | 'sausage'
  | 'carrot'
  | 'apple'
  | 'broccoli'
  | 'cheese';

export interface FoodDef {
  kind: FoodKind;
  name: string;
  /** How much the dog likes it, -1 .. 1. Drives the reaction animation. */
  appeal: number;
  /** How filling it is, 0 .. 1. */
  nutrition: number;
  /** Radius used for hit-testing and pickup. */
  radius: number;
}

export const FOODS: FoodDef[] = [
  { kind: 'meat',     name: '鲜肉',   appeal: 1.0,  nutrition: 0.75, radius: 0.16 },
  { kind: 'sausage',  name: '肉肠',   appeal: 0.9,  nutrition: 0.6,  radius: 0.15 },
  { kind: 'bone',     name: '磨牙骨', appeal: 0.85, nutrition: 0.35, radius: 0.18 },
  { kind: 'cheese',   name: '奶酪',   appeal: 0.8,  nutrition: 0.5,  radius: 0.13 },
  { kind: 'kibble',   name: '狗粮',   appeal: 0.6,  nutrition: 0.7,  radius: 0.12 },
  { kind: 'carrot',   name: '胡萝卜', appeal: 0.1,  nutrition: 0.45, radius: 0.12 },
  { kind: 'apple',    name: '苹果',   appeal: 0.05, nutrition: 0.4,  radius: 0.14 },
  { kind: 'broccoli', name: '西兰花', appeal: -0.2, nutrition: 0.35, radius: 0.13 },
];

const mat = (color: string, roughness = 0.8) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });

/** Shared materials so a plate of eight foods costs eight materials, not thirty. */
const M = {
  meat: mat('#b4453a', 0.7),
  meatFat: mat('#e8d5c0', 0.85),
  bone: mat('#f0ead8', 0.72),
  sausage: mat('#a8493c', 0.65),
  casing: mat('#7d3a30', 0.6),
  cheese: mat('#e8c65a', 0.7),
  kibble: mat('#8a5a34', 0.85),
  kibbleDark: mat('#6d4526', 0.85),
  carrot: mat('#e07a2c', 0.78),
  carrotTop: mat('#5f9a3c', 0.85),
  apple: mat('#c8452f', 0.6),
  appleFlesh: mat('#f2e8d0', 0.85),
  stem: mat('#5b4630', 0.9),
  broccoli: mat('#4a7f3a', 0.85),
  broccoliStem: mat('#8fae62', 0.85),
};

function group(...meshes: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  for (const m of meshes) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

/** Build one food item as a self-contained Group. */
export function buildFood(kind: FoodKind): THREE.Group {
  switch (kind) {
    case 'meat': {
      // a thick slab with a lighter fat marbling stripe
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.18), M.meat);
      slab.rotation.y = 0.3;
      const fat = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.03, 0.05), M.meatFat);
      fat.position.y = 0.02;
      fat.rotation.y = 0.3;
      return group(slab, fat);
    }
    case 'bone': {
      // classic cartoon bone: shaft plus four knuckle spheres.
      // NOTE: Object3D.position is read-only, so it must be set via
      // position.set(...) rather than assigned wholesale.
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 10), M.bone);
      shaft.rotation.z = Math.PI / 2;
      const knobs: THREE.Mesh[] = [];
      for (const x of [-0.12, 0.12]) {
        for (const y of [0.035, -0.035]) {
          const k = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), M.bone);
          k.position.set(x, y, 0);
          knobs.push(k);
        }
      }
      return group(shaft, ...knobs);
    }
    case 'sausage': {
      // two short links, slightly bent
      const link = (x: number, rot: number) => {
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.12, 4, 10), M.sausage);
        m.position.set(x, 0, 0);
        m.rotation.z = Math.PI / 2 + rot;
        return m;
      };
      const tie = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 12), M.casing);
      tie.rotation.y = Math.PI / 2;
      return group(link(-0.08, 0.08), link(0.08, -0.08), tie);
    }
    case 'cheese': {
      // a wedge: box tapered by scaling one end, plus holes
      const wedge = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.09, 3), M.cheese);
      wedge.rotation.y = Math.PI / 2;
      const hole = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), M.carrot);
      hole.position.set(0.02, 0.045, 0.03);
      hole.scale.setScalar(0.9);
      return group(wedge, hole);
    }
    case 'kibble': {
      // a small pile of irregular pellets
      const pellets: THREE.Mesh[] = [];
      const rng = (i: number) => {
        const s = Math.sin(i * 12.9898) * 43758.5453;
        return s - Math.floor(s);
      };
      for (let i = 0; i < 7; i++) {
        const r = 0.038 + rng(i) * 0.022;
        const p = new THREE.Mesh(
          new THREE.DodecahedronGeometry(r, 0),
          i % 2 ? M.kibble : M.kibbleDark,
        );
        p.position.set((rng(i + 10) - 0.5) * 0.16, r * 0.6, (rng(i + 20) - 0.5) * 0.16);
        p.rotation.set(rng(i + 30) * 3, rng(i + 40) * 3, rng(i + 50) * 3);
        pellets.push(p);
      }
      return group(...pellets);
    }
    case 'carrot': {
      // tapered cone lying down, with a small green crown
      const root = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.28, 8), M.carrot);
      root.rotation.z = Math.PI / 2;
      const crown = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.1, 6), M.carrotTop);
      crown.position.x = 0.16;
      crown.rotation.z = -Math.PI / 2;
      return group(root, crown);
    }
    case 'apple': {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 12), M.apple);
      body.scale.y = 0.92;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.06, 6), M.stem);
      stem.position.y = 0.14;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), M.carrotTop);
      leaf.position.set(0.04, 0.15, 0);
      leaf.scale.set(1.4, 0.35, 0.7);
      const bite = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), M.appleFlesh);
      bite.position.set(0.1, 0.03, 0.05);
      return group(body, stem, leaf, bite);
    }
    case 'broccoli': {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.12, 8), M.broccoliStem);
      stem.position.y = -0.03;
      const florets: THREE.Mesh[] = [];
      const spots: [number, number, number, number][] = [
        [0, 0.06, 0, 0.085],
        [0.07, 0.045, 0.03, 0.06],
        [-0.06, 0.05, 0.04, 0.055],
        [0.01, 0.04, -0.07, 0.06],
        [-0.03, 0.05, -0.05, 0.05],
      ];
      for (const [x, y, z, r] of spots) {
        const f = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), M.broccoli);
        f.position.set(x, y, z);
        florets.push(f);
      }
      return group(stem, ...florets);
    }
  }
}

/** Soft contact shadow so food does not look like it floats. */
export function buildFoodShadow(radius: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 1.35, 20),
    new THREE.MeshBasicMaterial({
      color: '#000',
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.004;
  return m;
}

export function foodDef(kind: FoodKind): FoodDef {
  return FOODS.find((f) => f.kind === kind)!;
}
