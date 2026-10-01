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
  /** Where the item sits right now (settles here after a missed drop). */
  home: THREE.Vector3;
  /**
   * The layout position, in the frame where the camera yaw is zero.
   * `setOrbit` always rotates FROM this, never from `home`, or repeated orbit
   * updates would compound and walk the items away.
   */
  anchor: THREE.Vector3;
}

/**
 * How far a held item sits above the floor. Kept tiny on purpose: any larger
 * and the item visibly floats away from the pointer instead of tracking it.
 */
const DRAG_LIFT = 0.09;

/** How quickly a held item catches up to the pointer (per 60fps frame). */
const FOLLOW_LERP = 0.35;

export class FeedingArea {
  readonly root = new THREE.Group();

  private items: FoodItem[] = [];
  private dragging: FoodItem | null = null;
  private ndc = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();

  constructor(private cb: FeedingCallbacks) {
    this.root.name = 'FeedingArea';
  }

  /**
   * Lay the food out in a shallow arc on the viewer's side of the dog.
   *
   * It must not sit right under the muzzle: when the camera orbits, the dog's
   * body would then hide the food. Putting the row near the camera keeps every
   * item visible from any angle, and the drag distance to the dog stays short
   * because the camera is only a few units away.
   */
  build(camera: THREE.Camera, creatureX = 0, mouthZ = 0.35) {
    const cols = 4;
    const spacingX = 0.52;
    const spacingZ = 0.42;
    this.items = FOODS.map((def, i) => {
      const group = buildFood(def.kind);
      const shadow = buildFoodShadow(def.radius);

      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = (col - (cols - 1) / 2) * spacingX + creatureX * 0.3;
      const z = mouthZ + 0.75 + row * spacingZ;

      group.position.set(x, 0, z);
      shadow.position.set(x, 0, z);

      this.root.add(shadow);
      this.root.add(group);

      return {
        kind: def.kind,
        group,
        shadow,
        home: new THREE.Vector3(x, 0, z),
        anchor: new THREE.Vector3(x, 0, z),
      };
    });
    void camera;
  }

  /**
   * Keep the food row on the viewer's side as the camera orbits, so it never
   * ends up hidden behind the dog.
   *
   * Always rotates from `anchor` (the yaw-zero layout), never from the current
   * position: rotating the current position each frame compounds, and the row
   * slowly spirals around to the far side of the dog.
   */
  setOrbit(yaw: number, centre: THREE.Vector3) {
    for (const item of this.items) {
      const ox = item.anchor.x - centre.x;
      const oz = item.anchor.z - centre.z;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const x = centre.x + ox * c + oz * s;
      const z = centre.z - ox * s + oz * c;
      item.home.set(x, 0, z);
      if (item === this.dragging || !item.group.visible) continue;
      // set(x, y, z): keep the item's own bob height, place it at the orbit spot.
      item.group.position.set(x, item.group.position.y, z);
      item.shadow.position.set(x, 0.006, z);
    }
  }

  /**
   * Screen point -> a world point the held item should occupy.
   *
   * NOT a floor intersection: intersecting a fixed y=0 plane means the item can
   * only ever slide around on that plane, so the pointer's height is thrown
   * away and the item feels stuck to the ground. Instead, pick the point along
   * the pointer ray at a fixed distance from the camera, which lets the item
   * move up and down with the cursor like something held in the hand.
   */
  private toPointer(
    clientX: number,
    clientY: number,
    camera: THREE.Camera,
  ): THREE.Vector3 | null {
    this.ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);

    // Pull the sample point in close to the camera. A distant sample makes the
    // vertical component of pointer movement almost vanish (the ray is nearly
    // parallel to the floor out there), which is why the item stayed glued down.
    // Near the camera the ray is steep, so moving the cursor up actually lifts.
    const dist = 3.0;

    const p = new THREE.Vector3();
    this.raycaster.ray.at(dist, p);
    // Never let it sink through the floor.
    p.y = Math.max(p.y, 0.06);
    return p;
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
    this.gestureOwned = true;
    // A small constant lift only — enough to read as "picked up" without the
    // item visibly floating away from the pointer.
    item.group.position.y = DRAG_LIFT;
    // Start the follow target at the item's current spot so it does not lurch
    // toward the origin on the first move.
    this.dragTarget.copy(item.group.position);
    this.cb.onPickup(item.kind);
    return true;
  }

  /** Move the dragged item; returns true if it consumed the pointer move. */
  moveDrag(clientX: number, clientY: number, camera: THREE.Camera): boolean {
    if (!this.dragging) return false;
    const p = this.toPointer(clientX, clientY, camera);
    if (p) {
      // Only clamp the far side, so the item cannot be flung out of the room.
      const cx = THREE.MathUtils.clamp(p.x, -3.5, 3.5);
      const cz = THREE.MathUtils.clamp(p.z, -2.5, 4.5);
      this.dragTarget.set(cx, p.y, cz);
    }
    this.lastPointer = { x: clientX, y: clientY };
    this.nearMouth = this.cb.isOverCreature(clientX, clientY);
    return true;
  }

  /** Where the held item is heading; smoothed toward in update(). */
  private dragTarget = new THREE.Vector3();

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
    this.gestureOwned = false;
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

    // missed: let it settle flat on the floor where it was dropped
    const px = item.group.position.x;
    const pz = item.group.position.z;
    item.group.position.set(px, 0, pz);
    item.group.scale.setScalar(1);
    item.shadow.position.set(px, 0.006, pz);
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

  /**
   * True from pointerdown until pointerup of a food drag.
   *
   * The gesture that started on food must own the whole press: while this is
   * true the creature must not treat pointer movement as petting, otherwise
   * dragging food across the dog makes it think it is being poked and it walks
   * away.
   */
  private gestureOwned = false;

  get ownsGesture() {
    return this.gestureOwned;
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

      // An eaten item hides its mesh AND its shadow. Skipping the whole loop
      // body left orphaned shadow discs behind, which looked like invisible food.
      if (!it.group.visible) {
        it.shadow.visible = false;
        continue;
      }
      it.shadow.visible = true;

      if (it === this.dragging) {
        // Smoothly chase the pointer instead of snapping to it, so the item
        // looks held rather than teleported. Y follows too, so the item can be
        // lifted off the floor rather than sliding around on one plane.
        it.group.position.lerp(this.dragTarget, FOLLOW_LERP);
        it.shadow.position.set(it.group.position.x, 0.006, it.group.position.z);
        // Shadow shrinks as the item rises, which is what sells the height.
        const lift = Math.max(0, it.group.position.y);
        const shrink = THREE.MathUtils.clamp(1 - lift * 0.5, 0.45, 1);
        it.shadow.scale.setScalar(shrink);
        (it.shadow.material as THREE.MeshBasicMaterial).opacity = 0.28 * shrink;
        it.group.rotation.y += 0.03;
        const s = this.nearMouth ? 1.18 : 1;
        it.group.scale.lerp(new THREE.Vector3(s, s, s), 0.25);
        continue;
      }

      it.group.scale.lerp(new THREE.Vector3(1, 1, 1), 0.25);
      it.shadow.scale.setScalar(1);
      (it.shadow.material as THREE.MeshBasicMaterial).opacity = 0.28;
      it.group.position.y = Math.sin(t * 1.6 + i * 0.8) * 0.012;
      it.group.rotation.y = Math.sin(t * 0.5 + i) * 0.25;
    }
  }
}
