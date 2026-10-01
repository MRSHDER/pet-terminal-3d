/**
 * Feeding: a row of food on the ground, dragged onto the dog.
 *
 * Drag-and-drop rather than click-to-feed, because dragging is the part that
 * makes it feel like handing something over. The food follows the pointer in
 * world space along the floor plane, and only counts when released near the
 * dog's mouth.
 */
import * as THREE from 'three';
import { FOODS, buildFood, buildFoodShadow, foodDef, type FoodKind } from './food';

export interface FeedingCallbacks {
  onFed: (kind: FoodKind, appeal: number, nutrition: number) => void;
  onPickup: (kind: FoodKind) => void;
  /**
   * Is the pointer currently over the dog? Used instead of comparing world
   * coordinates, because dragging up-screen sends the floor intersection far
   * behind the dog — the drop point is a poor proxy for "aimed at the dog".
   */
  isOverCreature: (clientX: number, clientY: number) => boolean;
}

interface FoodItem {
  kind: FoodKind;
  group: THREE.Group;
  shadow: THREE.Mesh;
  home: THREE.Vector3;
}

export class FeedingArea {
  readonly root = new THREE.Group();

  private items: FoodItem[] = [];
  private dragging: FoodItem | null = null;
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ndc = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();

  constructor(private cb: FeedingCallbacks) {
    this.root.name = 'FeedingArea';
  }

  /**
   * Lay the food out in a shallow arc in front of the dog.
   *
   * `mouthZ` is where the dog's muzzle projects onto the floor. Food sits just
   * short of it (toward the camera) so the drag distance to the mouth is tiny —
   * a long drag across the screen is what made feeding feel unresponsive.
   */
  build(camera: THREE.Camera, creatureX = 0, mouthZ = 0.35) {
    const cols = 4;
    const spacingX = 0.46;
    const spacingZ = 0.34;
    this.items = FOODS.map((def, i) => {
      const group = buildFood(def.kind);
      const shadow = buildFoodShadow(def.radius);

      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = (col - (cols - 1) / 2) * spacingX + creatureX * 0.3;
      const z = mouthZ + 0.12 + row * spacingZ;

      group.position.set(x, 0, z);
      shadow.position.set(x, 0, z);

      this.root.add(shadow);
      this.root.add(group);

      return { kind: def.kind, group, shadow, home: new THREE.Vector3(x, 0, z) };
    });
    void camera;
  }

  /** Screen point -> world point on the floor plane. */
  private toFloor(clientX: number, clientY: number, camera: THREE.Camera): THREE.Vector3 | null {
    this.ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.plane, hit) ? hit : null;
  }

  /** Returns the food under the pointer, if any. */
  private pick(clientX: number, clientY: number, camera: THREE.Camera): FoodItem | null {
    this.ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);
    const meshes = this.items.map((i) => i.group);
    const hits = this.raycaster.intersectObjects(meshes, true);
    if (!hits.length) return null;
    // walk up to the group we registered
    let o: THREE.Object3D | null = hits[0].object;
    while (o && !this.items.some((i) => i.group === o)) o = o.parent;
    return this.items.find((i) => i.group === o) ?? null;
  }

  /** True if the pointer grabbed a food item; call from pointerdown. */
  beginDrag(clientX: number, clientY: number, camera: THREE.Camera): boolean {
    const item = this.pick(clientX, clientY, camera);
    if (!item) return false;
    this.dragging = item;
    item.group.position.y = 0.45; // lift it off the floor
    this.cb.onPickup(item.kind);
    return true;
  }

  /** Move the dragged item; returns true if it consumed the pointer move. */
  moveDrag(clientX: number, clientY: number, camera: THREE.Camera): boolean {
    if (!this.dragging) return false;
    const p = this.toFloor(clientX, clientY, camera);
    if (p) {
      // Clamp so the item never flies off behind the dog when the pointer is
      // aimed at its head (that ray hits the floor metres away).
      const cx = THREE.MathUtils.clamp(p.x, -3, 3);
      const cz = THREE.MathUtils.clamp(p.z, -1.2, 3);
      this.dragging.group.position.set(cx, 0.4, cz);
      this.dragging.shadow.position.set(cx, 0.006, cz);
    }
    this.lastPointer = { x: clientX, y: clientY };
    this.nearMouth = this.cb.isOverCreature(clientX, clientY);
    const s = this.nearMouth ? 1.2 : 1;
    this.dragging.group.scale.lerp(new THREE.Vector3(s, s, s), 0.25);
    return true;
  }

  private lastPointer: { x: number; y: number } | null = null;

  /**
   * Drop the dragged item.
   *
   * Whether it gets eaten is decided by where the POINTER is, not by the floor
   * point the item sits on. Aiming at the dog's head sends the floor ray far
   * behind it, so the item's world position is a misleading proxy.
   */
  endDrag(): { kind: FoodKind } | null {
    const item = this.dragging;
    const wasOver = this.nearMouth;
    const ptr = this.lastPointer;
    this.dragging = null;
    this.nearMouth = false;
    this.lastPointer = null;
    if (!item) return null;

    // Re-check at release, in case the last pointermove was missed.
    const over = ptr ? this.cb.isOverCreature(ptr.x, ptr.y) : wasOver;

    this.lastDrop = {
      item: {
        x: +item.group.position.x.toFixed(3),
        z: +item.group.position.z.toFixed(3),
      },
      pointer: ptr,
      overCreature: over,
    };

    if (over) {
      const def = foodDef(item.kind);
      this.cb.onFed(item.kind, def.appeal, def.nutrition);
      item.group.visible = false;
      item.shadow.visible = false;
      item.group.scale.setScalar(1);
      const home = item.home.clone();
      window.setTimeout(() => {
        item.group.visible = true;
        item.shadow.visible = true;
        item.group.position.copy(home);
        item.shadow.position.set(home.x, 0.006, home.z);
      }, 2600);
      return { kind: item.kind };
    }

    // missed: let it settle where it was dropped
    item.group.scale.setScalar(1);
    const home = item.home;
    item.group.position.set(item.group.position.x, 0, item.group.position.z);
    item.shadow.position.set(item.group.position.x, 0.006, item.group.position.z);
    void home;
    return null;
  }

  /** Last drop decision, for debugging the gesture from the console. */
  lastDrop: unknown = null;

  /** True while the dragged food is close enough to the mouth to be eaten. */
  private nearMouth = false;

  get inDropZone() {
    return this.nearMouth;
  }

  get isDragging() {
    return this.dragging !== null;
  }

  /** Debug: current world position and visibility of every food item. */
  debugItems() {
    return this.items.map((i) => ({
      kind: i.kind,
      dragging: i === this.dragging,
      visible: i.group.visible,
      pos: {
        x: +i.group.position.x.toFixed(3),
        y: +i.group.position.y.toFixed(3),
        z: +i.group.position.z.toFixed(3),
      },
    }));
  }

  /** Gentle bob so the food reads as "available" rather than scenery. */
  update(t: number) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it === this.dragging || !it.group.visible) continue;
      it.group.position.y = Math.sin(t * 1.6 + i * 0.8) * 0.012;
      it.group.rotation.y = Math.sin(t * 0.5 + i) * 0.25;
    }
    if (this.dragging) {
      this.dragging.group.rotation.y += 0.02;
    }
  }
}
