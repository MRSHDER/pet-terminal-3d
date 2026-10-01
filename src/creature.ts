/**
 * Creature engine — the whole point of this project.
 *
 * There are no buttons and no menus. You press and hold the creature, and it
 * responds: it looks up at you, its tail starts moving, it leans in. Let go and
 * it settles. Poke it too fast and it gets annoyed and walks away.
 *
 * Every motion here is generated at runtime by driving the 10 bones of the
 * fox rig. There are no baked animation clips — the "aliveness" comes from
 * layered oscillators feeding the skeleton each frame.
 */
import * as THREE from 'three';

export type Mood = 'idle' | 'curious' | 'happy' | 'annoyed';

export interface CreatureState {
  mood: Mood;
  /** 0..1 — how attached it feels. Grows with gentle attention, decays if ignored. */
  bond: number;
  /** 0..1 — how irritated it is right now. */
  irritation: number;
  /** True while the pointer is held down on the creature. */
  touching: boolean;
}

/** Small deterministic 1D value-noise, so motion is smooth but not a pure sine. */
function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const a = h(i);
  const b = h(i + 1);
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

export class Creature {
  readonly root = new THREE.Group();

  private bones: Record<string, THREE.Bone | THREE.Object3D> = {};
  private state: CreatureState = {
    mood: 'idle',
    bond: 0,
    irritation: 0,
    touching: false,
  };

  private clock = 0;
  private touchCount = 0;
  private lastTouchAt = -99;
  /** Where the creature wants to stand, in world units on the X axis. */
  private targetX = 0;
  private currentX = 0;
  private leanZ = 0;
  private headLift = 0;
  private tailEnergy = 0;
  private annoyance = 0;
  private blinkTimer = 2;
  private blinking = 0;
  private disposed = false;

  onStateChange?: (s: CreatureState) => void;

  constructor() {
    this.root.name = 'CreatureRoot';
  }

  /** Call once the GLB has loaded. */
  bind(gltfScene: THREE.Object3D) {
    const trim = (n: string) => n.replace(/^Fox_/, '').replace(/^mixamorig[:_]?/, '');
    gltfScene.traverse((o) => {
      if ((o as THREE.Bone).isBone || o.name) {
        this.bones[o.name] = o as THREE.Bone;
        this.bones[trim(o.name)] = o as THREE.Bone;
      }
    });

    // Snapshot the rest pose. Without this the animation code would *overwrite*
    // each bone's authored rotation instead of layering on top of it, which
    // tears the rig apart.
    for (const name of [
      'Spine', 'Neck', 'Head', 'Tail1', 'Tail2',
      'Leg_FL', 'Leg_FR', 'Leg_BL', 'Leg_BR',
    ]) {
      const b = this.bone(name);
      if (b) {
        this.rest.set(name, {
          x: b.rotation.x,
          y: b.rotation.y,
          z: b.rotation.z,
        });
      }
    }

    this.root.add(gltfScene);
  }

  private rest = new Map<string, { x: number; y: number; z: number }>();

  /** Set a bone rotation as (rest + offset). */
  private pose(name: string, ox: number, oy: number, oz: number) {
    const b = this.bone(name);
    const r = this.rest.get(name);
    if (!b) return;
    if (r) {
      b.rotation.x = r.x + ox;
      b.rotation.y = r.y + oy;
      b.rotation.z = r.z + oz;
    } else {
      b.rotation.x = ox;
      b.rotation.y = oy;
      b.rotation.z = oz;
    }
  }

  has(name: string) {
    return !!this.bones[name];
  }

  private bone(...names: string[]) {
    for (const n of names) {
      const b = this.bones[n];
      if (b) return b;
    }
    return undefined;
  }

  getState(): CreatureState {
    return { ...this.state };
  }

  private emit() {
    this.onStateChange?.(this.getState());
  }

  // ---------------------------------------------------------------- input

  /** Pointer pressed down on the creature. */
  onTouchStart() {
    this.state.touching = true;

    // Rapid repeated pokes irritate it. A slow, sustained press does not.
    const since = this.clock - this.lastTouchAt;
    this.lastTouchAt = this.clock;
    if (since < 0.45) {
      this.touchCount += 1;
      this.annoyance = Math.min(1, this.annoyance + 0.22);
    } else {
      this.touchCount = 1;
      this.annoyance = Math.max(0, this.annoyance - 0.15);
    }

    if (this.annoyance > 0.7) {
      this.state.mood = 'annoyed';
      this.state.irritation = this.annoyance;
      // walk away from the pointer
      this.targetX = this.currentX > 0 ? -1.6 : 1.6;
    } else if (this.annoyance > 0.35) {
      this.state.mood = 'curious';
      this.targetX = this.currentX * 0.4;
    } else {
      this.state.mood = 'happy';
      this.state.bond = Math.min(1, this.state.bond + 0.12);
      // come toward the viewer/hand
      this.targetX = this.currentX * 0.3;
    }
    this.emit();
  }

  onTouchEnd() {
    this.state.touching = false;
    this.emit();
  }

  // ---------------------------------------------------------------- update

  update(dt: number) {
    if (this.disposed) return;
    this.clock += dt;

    // ---- irritation cools down over time
    if (!this.state.touching) {
      this.annoyance = Math.max(0, this.annoyance - dt * 0.16);
      this.state.irritation = this.annoyance;
      if (this.annoyance < 0.3 && this.state.mood === 'annoyed') {
        this.state.mood = this.state.bond > 0.4 ? 'curious' : 'idle';
        this.targetX = 0;
        this.emit();
      }
    }

    // ---- bond decays when ignored, so it has to be maintained
    if (!this.state.touching && this.clock - this.lastTouchAt > 12) {
      this.state.bond = Math.max(0, this.state.bond - dt * 0.012);
    }

    // ---- desired motion targets, eased so nothing snaps
    const touching = this.state.touching;
    const mood = this.state.mood;
    const wantLean = touching && mood === 'happy' ? 0.16 : 0;
    const wantLift = touching ? 0.42 : mood === 'curious' ? 0.18 : 0;
    const wantTail = touching && mood === 'happy' ? 1 : mood === 'annoyed' ? 0.75 : 0.25;

    this.leanZ += (wantLean - this.leanZ) * Math.min(1, dt * 4);
    this.headLift += (wantLift - this.headLift) * Math.min(1, dt * 3.2);
    this.tailEnergy += (wantTail - this.tailEnergy) * Math.min(1, dt * 3);

    // ---- walk toward the target X
    this.currentX += (this.targetX - this.currentX) * Math.min(1, dt * 1.6);
    this.root.position.x = this.currentX;

    const moving = Math.abs(this.targetX - this.currentX) > 0.02;

    // ---- breathing: always present, this is what makes it read as alive
    const breath = Math.sin(this.clock * 1.5) * 0.02;

    const spine = this.bone('Spine');
    const neck = this.bone('Neck');
    const head = this.bone('Head');
    const tail1 = this.bone('Tail1');
    const tail2 = this.bone('Tail2');

    if (spine) {
      // rotation is (rest + offset) so the authored pose survives
      this.pose('Spine', breath + this.leanZ * 0.5, (noise1(this.clock * 0.6) - 0.5) * 0.06, this.leanZ);
    }
    if (neck) {
      this.pose('Neck', -this.headLift * 0.7 + (noise1(this.clock * 0.9 + 10) - 0.5) * 0.04, 0, 0);
    }
    if (head) {
      // look around when idle, lock onto the viewer when touched/curious
      const look = touching ? 0 : (noise1(this.clock * 0.35 + 30) - 0.5) * 0.5;
      this.pose('Head', -this.headLift * 0.4, look, (noise1(this.clock * 0.5 + 50) - 0.5) * 0.08);
    }

    // ---- tail: the clearest emotional readout
    if (tail1 && tail2) {
      const speed = 2.5 + this.tailEnergy * 9;
      const amp = 0.12 + this.tailEnergy * 0.5;
      const wag = Math.sin(this.clock * speed) * amp;
      this.pose('Tail1', -0.25 - this.tailEnergy * 0.35 + breath, wag, 0);
      this.pose('Tail2', -0.2, wag * 1.6, 0);
    }

    // ---- legs
    const legs = ['Leg_FL', 'Leg_FR', 'Leg_BL', 'Leg_BR'];
    legs.forEach((name, i) => {
      if (!this.bone(name)) return;
      if (moving) {
        const phase = this.clock * 7 + (i % 2) * Math.PI + (i >= 2 ? Math.PI / 2 : 0);
        this.pose(name, Math.sin(phase) * 0.4, 0, 0);
      } else {
        this.pose(name, 0, 0, 0);
      }
    });

    // ---- blinking: small, frequent, easy to miss — and that is the point
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinking = 1;
      this.blinkTimer = 1.6 + Math.random() * 3.4;
    }
    if (this.blinking > 0) {
      this.blinking = Math.max(0, this.blinking - dt * 6);
    }

    // slight body bob while walking
    this.root.position.y = moving ? Math.abs(Math.sin(this.clock * 7)) * 0.03 : breath * 0.5;
  }

  dispose() {
    this.disposed = true;
  }
}
