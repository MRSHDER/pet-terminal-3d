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

export type Mood = 'idle' | 'curious' | 'happy' | 'annoyed' | 'eating' | 'disgusted';

export interface CreatureState {
  mood: Mood;
  /** 0..1 — how attached it feels. Grows with gentle attention, decays if ignored. */
  bond: number;
  /** 0..1 — how irritated it is right now. */
  irritation: number;
  /** True while the pointer is held down on the creature. */
  touching: boolean;
  /** 0..1 — how full it is. Rises when fed, falls slowly over time. */
  sated: number;
}

/**
 * How often continuous state drift (bond/sated/irritation) is published to the
 * HUD. The meters render whole percentages, so 4 updates a second is
 * indistinguishable from per-frame updates to the player, while avoiding a
 * state-object allocation and a React re-render on every animation frame.
 */
const EMIT_INTERVAL = 0.25;

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

  /**
   * The loaded model lives here rather than directly under `root`, so the rig's
   * authored orientation and the creature's own facing stay independent.
   * `root` carries position and the lean; this carries yaw only.
   */
  readonly pivot = new THREE.Group();

  /** Yaw the creature turns toward. Drives "it looks at you". */
  private facingTarget = 0;
  private facing = 0;
  /** True when it is deliberately facing the viewer, so it holds the pose. */
  private attending = false;

  private bones: Record<string, THREE.Bone | THREE.Object3D> = {};
  private state: CreatureState = {
    mood: 'idle',
    bond: 0,
    irritation: 0,
    touching: false,
    sated: 0.25,
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
  /** Accumulates dt so continuous drift is published to the HUD on a throttle. */
  private emitAccum = 0;
  private blinkTimer = 2;
  private blinking = 0;
  private disposed = false;

  /** Counts down while a chew/recoil reaction plays. */
  private eatTimer = 0;
  /** 1 = loved the food, 0 = hated it. Shapes the reaction animation. */
  private eatLiking = 0;
  /** Head-down chew bob. */
  private chew = 0;
  /** Recoil offset when it tastes something it dislikes. */
  private recoil = 0;

  onStateChange?: (s: CreatureState) => void;

  constructor() {
    this.root.name = 'CreatureRoot';
    this.pivot.name = 'CreaturePivot';
    this.root.add(this.pivot);
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

    this.pivot.add(gltfScene);
  }

  /**
   * Point the creature toward a yaw, in the creature's own space.
   * Called each frame with an angle derived from where the viewer is.
   */
  faceToward(yaw: number, attentive: boolean) {
    this.facingTarget = yaw;
    this.attending = attentive;
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

  // ---------------------------------------------------------------- feeding

  /**
   * Feed it something. `appeal` is -1..1: meat gets a happy chew, broccoli gets
   * a recoil and a look of betrayal. Feeding also raises bond, but a disliked
   * food raises it far less than a liked one.
   */
  feed(appeal: number, nutrition: number) {
    this.eatTimer = 1.5;
    this.eatLiking = Math.max(-1, Math.min(1, appeal));
    this.chew = 0;

    if (appeal > 0.3) {
      this.state.mood = 'eating';
      this.state.bond = Math.min(1, this.state.bond + 0.1 * appeal);
      this.leanZ = 0.2;
    } else if (appeal < -0.05) {
      this.state.mood = 'disgusted';
      this.recoil = 1;
      // it barely trusts you after that
      this.state.bond = Math.max(0, this.state.bond - 0.04);
    } else {
      // neutral: it eats, unenthusiastically
      this.state.mood = 'eating';
      this.state.bond = Math.min(1, this.state.bond + 0.02);
    }

    this.state.sated = Math.min(1, this.state.sated + nutrition * 0.45);
    this.emit();
  }

  // ---------------------------------------------------------------- input

  /** Pointer pressed down on the creature. */
  onTouchStart() {
    this.state.touching = true;
    // A press is a discrete, player-driven event with its own emit() below, so
    // restart the drift throttle. Without this, a poke landing inside an
    // already-satisfied throttle window was not published until the NEXT window
    // elapsed, leaving the 烦躁 meter a whole poke behind (measured 22pp lag).
    this.emitAccum = 0;

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

    // The meter tracks `annoyance` whatever branch we take, so it is never left
    // showing a value older than the poke that just happened.
    this.state.irritation = this.annoyance;

    if (this.annoyance > 0.7) {
      this.state.mood = 'annoyed';
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

    // ---- irritation always tracks `annoyance`, held or not.
    // `annoyance` is the quantity that actually decides whether the creature
    // walks off, so the 烦躁 meter must read it continuously. Gating this behind
    // `!touching` froze the meter at its pre-press value for the entire duration
    // of a held press — i.e. it was live exactly when nothing was happening and
    // frozen exactly when the player was doing the thing that changes it.
    if (this.state.touching) {
      // While held, poke accumulation is already applied in onTouchStart; just
      // mirror it so the meter responds immediately.
      this.state.irritation = this.annoyance;
    } else {
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

    // ---- hunger: sated drifts down, so feeding has a reason to exist
    this.state.sated = Math.max(0, this.state.sated - dt * 0.006);

    // The block above mutates state every frame, so the HUD has to be told about
    // it — otherwise the 饱食/羁绊 meters sit on whatever value the last discrete
    // event emitted (measured: frozen at 25% while sated fell 24% -> 20%).
    // emit() copies the state object, so calling it per frame would allocate
    // 60x/s and re-render React just as often. Throttle instead: publish at most
    // every EMIT_INTERVAL, which is far below the resolution the meters show.
    this.emitAccum += dt;
    if (this.emitAccum >= EMIT_INTERVAL) {
      this.emitAccum = 0;
      this.emit();
    }

    // ---- eating reaction: a chew bob, or a recoil if it hated the food
    if (this.eatTimer > 0) {
      this.eatTimer -= dt;
      if (this.eatLiking >= -0.05) {
        this.chew = Math.max(0, Math.sin(this.clock * 18) * 0.5 + 0.5) * 0.5;
      }
      if (this.eatTimer <= 0) {
        this.eatTimer = 0;
        this.chew = 0;
        // Only restore the settled mood if nothing was earned during the chew.
        // onTouchStart keeps running while it eats, so an unconditional write
        // here silently discarded a mood the player had just provoked — which
        // is how 烦躁 could read 1.0 while the caption said it was merely
        // curious, disabling the rapid-poking -> walk-away loop for 1.5s.
        if (this.state.mood !== 'annoyed' && this.annoyance < 0.3) {
          this.state.mood = this.state.bond > 0.45 ? 'curious' : 'idle';
        }
        this.emit();
      }
    } else {
      this.chew += (0 - this.chew) * Math.min(1, dt * 6);
    }
    this.recoil += (0 - this.recoil) * Math.min(1, dt * 2.2);

    // ---- desired motion targets, eased so nothing snaps
    const touching = this.state.touching;
    const mood = this.state.mood;
    const isEating = this.eatTimer > 0 && this.eatLiking >= -0.05;
    const wantLean = touching && mood === 'happy' ? 0.16 : 0;
    const wantLift = isEating
      ? -0.5 + this.chew * 0.25 // head goes DOWN to the food, bobbing
      : touching
        ? 0.42
        : mood === 'curious'
          ? 0.18
          : 0;
    const wantTail = isEating
      ? Math.max(0, this.eatLiking) // wags hard for meat, barely for veg
      : touching && mood === 'happy'
        ? 1
        : mood === 'annoyed'
          ? 0.75
          : 0.25;

    this.leanZ += (wantLean - this.leanZ) * Math.min(1, dt * 4);
    this.headLift += (wantLift - this.headLift) * Math.min(1, dt * 3.2);
    this.tailEnergy += (wantTail - this.tailEnergy) * Math.min(1, dt * 3);

    // ---- walk toward the target X
    this.currentX += (this.targetX - this.currentX) * Math.min(1, dt * 1.6);
    this.root.position.x = this.currentX;
    // recoil: a quick step back when it tastes something it dislikes
    this.root.position.z = this.recoil * 0.22;

    // ---- turn to face the viewer
    // Shortest-path interpolation, or a 350deg -> 10deg turn would spin the long
    // way round and look like it was running off.
    let diff = this.facingTarget - this.facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    // Attentive (being touched or fed) turns quickly and holds; idle drifts
    // lazily and lets the head wander instead.
    const turnSpeed = this.attending ? 3.4 : 0.9;
    this.facing += diff * Math.min(1, dt * turnSpeed);
    this.pivot.rotation.y = this.facing;

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

    // ---- tail: the clearest emotional readout.
    // A fox carries its brush high; a dog's tail hangs lower at rest and lifts
    // as it gets excited, so the resting offset pulls down and only the wag
    // (and the happy lift) raises it.
    if (tail1 && tail2) {
      const speed = 2.5 + this.tailEnergy * 9;
      const amp = 0.12 + this.tailEnergy * 0.5;
      const wag = Math.sin(this.clock * speed) * amp;
      const lift = 0.62 - this.tailEnergy * 0.62; // 0.62 at rest -> 0 when happy
      this.pose('Tail1', lift + breath * 0.5, wag, 0);
      this.pose('Tail2', 0.18 - this.tailEnergy * 0.1, wag * 1.6, 0);
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
