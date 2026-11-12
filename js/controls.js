/**
 * PANODROME — Stage 2.0 · Zero-Warp Walking Controls (owner law 2026-11-03)
 * ============================================================================
 * TWO WALK MODES — one per room kind:
 *
 * MICRO (360° pano rooms — LAW 1 + LAW 2):
 *   The camera lives in a strict ZERO-DISTORTION MICRO-PARALLAX SPHERE:
 *   max offset 0.08 m from the capture origin.  Inside that budget the
 *   photo shows genuine (tiny) parallax; beyond it the photograph would
 *   smear, so motion becomes a MATTERPORT-STYLE OPTICAL STEP-GLIDE:
 *     · a VIRTUAL walk position travels real metres through the collision
 *       world (collider.js) — sliding, furniture bumps, doorway walk-ins;
 *     · each step is a smooth optical glide pulse: FOV 72° → ~52° → 72°
 *       (owner spec), subtle walk head-bob, and acoustic footsteps every
 *       0.65 m of virtual travel;
 *     · the 3D floor grid / footstep target ring / glass furniture proxies
 *       (collider.js) move in true 3D perspective around the camera while
 *       the 4K photograph stays 100% un-bent, un-stretched, crystal clear.
 *
 * FREE (true-3D rooms — LAW 3):
 *   Full multi-metre 6DoF WASD/joystick walking across the real floor,
 *   camera.fov LOCKED at 72°, resolved against the exact furniture Box3
 *   colliders.  Real meshes never warp, so there is nothing to protect —
 *   walk 5 metres around the sofa if you like.
 *
 * Inputs (both modes): drag = look · wheel / two-finger drag = walk ·
 * W A S D / arrows · double-tap floor = walk TO the tapped point ·
 * virtual joystick (touch HUD) · reset button = glide home.
 */
import * as THREE from "three";

export const EYE_HEIGHT = 1.65;   // m — true-3D player eye (y = EYE + bob)
export const STEP_LEN = 0.65;     // m per footstep (audio + bob cycle)
export const MICRO_PARALLAX = 0.08; // m — owner law: max camera offset from capture origin
export const FOV_BASE = 72;       // owner law: base FOV (pano step-glide + true-3D locked)
export const FOV_GLIDE = 52;      // owner law: deepest step-glide zoom
const WALK_SPEED = 1.55;          // m/s virtual walk speed (calm museum pace)
const BOOST_MAX = 3.0;            // m/s peak scroll momentum
const BOOST_DECAY = 2.1;          // 1/s exponential momentum decay
const ACCEL = 8.5;                // 1/s input acceleration smoothing
const BOB_AMP = 0.02;             // m head-bob amplitude (subtle, owner spec)
const TURN_SPEED = 1.7;           // rad/s arrow-key turn
const STOP_EPS = 0.05;            // m — arrived at walkTo target
const STEP_PERIOD = 0.85;         // s — one step-glide cycle (FOV pulse + bob + footstep)

export class WalkingControls {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.enabled = false;

    // look
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 0.0031;

    // mode + origin
    this.mode = "micro";                       // "micro" | "free"
    this.origin = new THREE.Vector3();         // capture point (micro) / spawn (free)
    this.freeEye = EYE_HEIGHT;

    // virtual walk state (the ONLY position that travels metres — micro)
    this.pos = new THREE.Vector3();            // virtual position (x/z on the floor)
    this.vel = new THREE.Vector2();            // world-space velocity m/s (x, z)
    this.boost = new THREE.Vector2();          // scroll momentum (x, z)
    this.keys = new Set();
    this.joy = { x: 0, y: 0 };
    this.walkTarget = null;                    // Vector3 | null (double-tap destination)
    this.start = new THREE.Vector3();          // reset target (== origin xz)
    this.room = null;

    // step-glide engine (micro)
    this.stepPhase = 0;                        // 0..1 — one step cycle
    this.fov = FOV_BASE;                       // current eased FOV
    this.minFovSeen = FOV_BASE;
    this.maxFovSeen = FOV_BASE;
    this.maxOffsetSeen = 0;                    // m — camera offset from origin (E2E proof)

    // bob / steps
    this.bobPhase = 0;
    this.travelled = 0;                        // virtual metres walked this room
    this.onStep = null;                        // (material) fired every STEP_LEN m
    this.stepMaterial = "wood";

    // collision world
    this.world = null;
    this.onBump = null;

    this._pointers = new Map();
    this._down = null;
    this._lastTap = null;
    this._lookTween = null;
    this._resetTween = null;
    this._stepAccum = 0;

    this.onClick = null;
    this.onDouble = null;
    this._fwd = new THREE.Vector3();

    this._bind();
  }

  /* ------------------------------------------------------------ room setup */

  setRoom(room) {
    this.room = room;
    const c = room.camera;
    this.mode = room.type === "true_3d" ? "free" : "micro";
    this.origin.set(c.x, this.mode === "free" ? EYE_HEIGHT : c.y, c.z);
    this.start.set(c.x, 0, c.z);
    this.pos.set(c.x, 0, c.z);
    this.vel.set(0, 0);
    this.boost.set(0, 0);
    this.walkTarget = null;
    this.travelled = 0;
    this.bobPhase = 0;
    this.stepPhase = 0;
    this._stepAccum = 0;
    this.fov = FOV_BASE;
    this.minFovSeen = FOV_BASE;
    this.maxFovSeen = FOV_BASE;
    this.maxOffsetSeen = 0;
    this.stepMaterial = room.floor_material || "wood";
    this.lookAtFraction(room.initial_view.facing);
    if (this._resetTween) { this._resetTween.kill(); this._resetTween = null; }
  }

  setWorld(world) { this.world = world; }

  /* ------------------------------------------------------------ walk API */

  /** Walk (virtually, micro / really, free) TO a world point on the floor.
   *  Returns the clamped target actually used. */
  walkTo(point) {
    if (!this.world) return null;
    const p = point.clone();
    p.y = 0;
    const b = this.world.bounds;
    if (b) {
      p.x = THREE.MathUtils.clamp(p.x, b.minX, b.maxX);
      p.z = THREE.MathUtils.clamp(p.z, b.minZ, b.maxZ);
    }
    this.walkTarget = p;
    return p;
  }

  /** "بازگشت به مرکز فضا" — glide the virtual position home. */
  resetView() {
    this.walkTarget = null;
    this.vel.set(0, 0);
    this.boost.set(0, 0);
    if (this._resetTween) this._resetTween.kill();
    const self = this;
    const from = this.pos.clone();
    const to = new THREE.Vector3(this.start.x, 0, this.start.z);
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    if (dist < 0.05) return;
    this._resetTween = gsap.to({ t: 0 }, {
      t: 1, duration: Math.min(1.4, 0.35 + dist * 0.22), ease: "power2.inOut",
      onUpdate() {
        const t = this.targets()[0].t;
        self.pos.x = from.x + (to.x - from.x) * t;
        self.pos.z = from.z + (to.z - from.z) * t;
      },
      onComplete() { self._resetTween = null; },
    });
  }

  /** The position doorway walk-ins and proximity FX measure against. */
  effectivePos() {
    return this.pos;                            // virtual metres in micro, real in free
  }

  /** Camera offset from the capture origin (micro-parallax proof, E2E). */
  cameraOffset() {
    const dx = this.camera.position.x - this.origin.x;
    const dy = this.camera.position.y - this.origin.y;
    const dz = this.camera.position.z - this.origin.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  get moved() { return Math.hypot(this.pos.x - this.start.x, this.pos.z - this.start.z) > 0.4; }
  get speed() { return this.vel.length(); }
  get fovCur() { return this.camera.fov; }
  get fovMust() { return FOV_BASE; }

  /** Orient yaw/pitch toward a horizontal image fraction f (0..1). */
  lookAtFraction(f) {
    const phi = 2 * Math.PI * f;
    const dir = new THREE.Vector3(-Math.cos(phi), 0, Math.sin(phi));
    const target = this.pos.clone().add(dir);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(target);
    this.camera.rotation.order = "YXZ";
    this.yaw = this.camera.rotation.y;
    this.pitch = this.camera.rotation.x;
  }

  /** Smoothly rotate the camera toward a world direction (GSAP, shortest arc). */
  lookToward(dir) {
    const d = dir.clone().normalize();
    const targetYaw = Math.atan2(-d.x, -d.z);
    const targetPitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), -1.2, 1.2);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    if (this._lookTween) this._lookTween.kill();
    const fromYaw = this.yaw, fromPitch = this.pitch;
    const self = this;
    this._lookTween = gsap.to({ t: 0 }, {
      t: 1, duration: 0.85, ease: "power2.inOut",
      onUpdate() {
        const t = this.targets()[0].t;
        self.yaw = fromYaw + dy * t;
        self.pitch = fromPitch + (targetPitch - fromPitch) * t;
      },
      onComplete() { self._lookTween = null; },
    });
  }

  /* ------------------------------------------------------------ frame loop */

  update(dt) {
    const cam = this.camera;

    // ---- desired virtual velocity from all inputs ----
    const wish = new THREE.Vector2(0, 0);   // world-space (x, z)

    if (this.enabled) {
      let ix = 0, iz = 0;   // strafe, forward
      if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) iz += 1;
      if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) iz -= 1;
      if (this.keys.has("KeyA")) ix -= 1;
      if (this.keys.has("KeyD")) ix += 1;
      if (this.keys.has("ArrowLeft")) this.yaw += TURN_SPEED * dt;
      if (this.keys.has("ArrowRight")) this.yaw -= TURN_SPEED * dt;

      ix += this.joy.x;
      iz += this.joy.y;

      const len = Math.hypot(ix, iz);
      if (len > 1e-4) {
        const s = WALK_SPEED * Math.min(1, len);
        const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
        // camera forward (horizontal) = (-sin(yaw), -cos(yaw)); right = (cos, -sin)
        wish.x += (ix * cosY - iz * sinY) * s;
        wish.y += (iz * -cosY + ix * -sinY) * s;
      }

      // double-tap destination (virtual walk target)
      if (this.walkTarget) {
        const dx = this.walkTarget.x - this.pos.x;
        const dz = this.walkTarget.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < STOP_EPS) {
          this.walkTarget = null;
        } else {
          const s = WALK_SPEED * Math.min(1, d / 0.6);
          wish.x += (dx / d) * s;
          wish.y += (dz / d) * s;
        }
      }
    }

    // smooth acceleration toward wish + scroll momentum
    const target = wish.clone().add(this.boost);
    this.vel.x += (target.x - this.vel.x) * Math.min(1, dt * ACCEL);
    this.vel.y += (target.y - this.vel.y) * Math.min(1, dt * ACCEL);
    const boostDecay = Math.exp(-BOOST_DECAY * dt);
    this.boost.multiplyScalar(boostDecay);
    if (this.boost.lengthSq() < 1e-4) this.boost.set(0, 0);

    // ---- integrate the VIRTUAL position + slide against the collision world ----
    const bx = this.pos.x, bz = this.pos.z;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.y * dt;
    let bump = null;
    if (this.world) {
      bump = this.world.resolve(this.pos, this.vel);
      if (this.walkTarget && bump && (bump.ob || bump.impact > 0.7)) this.walkTarget = null;
    }
    const movedDist = Math.hypot(this.pos.x - bx, this.pos.z - bz);
    const spd = this.vel.length();
    const moving = spd > 0.22;

    // ---- metres travelled → footsteps ----
    this.travelled += movedDist;
    this._stepAccum += movedDist;

    // ---- step-glide engine (micro): FOV 72↔52 pulse + bob + footstep ----
    let bob = 0;
    let fovTarget = FOV_BASE;
    if (this.mode === "micro") {
      if (moving) {
        const prev = this.stepPhase;
        this.stepPhase = (this.stepPhase + dt / STEP_PERIOD) % 1;
        // one warm acoustic footstep per completed step-glide cycle
        if (this.stepPhase < prev) this.onStep && this.onStep(this.stepMaterial);
      } else if (this.stepPhase > 0 && this.stepPhase < 1) {
        // finish the current step gracefully, then rest at base FOV
        this.stepPhase = Math.min(1, this.stepPhase + dt / STEP_PERIOD);
        if (this.stepPhase >= 1) this.stepPhase = 0;
      }
      const speedK = Math.min(1, spd / WALK_SPEED);
      const pulse = Math.sin(Math.PI * this.stepPhase) ** 2;   // 0→1→0 per step
      const dip = (FOV_BASE - FOV_GLIDE) * Math.max(pulse * 0.65 + speedK * 0.35, pulse);
      fovTarget = FOV_BASE - dip * (this.stepPhase > 0 ? 1 : 0);
      bob = BOB_AMP * Math.sin(2 * Math.PI * this.stepPhase) * Math.max(0.35, speedK);
    } else {
      // free mode: FOV locked; natural bob driven by real travel
      if (this._stepAccum >= STEP_LEN) {
        this._stepAccum -= STEP_LEN;
        this.onStep && this.onStep(this.stepMaterial);
      }
      this.bobPhase += movedDist * (Math.PI / STEP_LEN);
      bob = BOB_AMP * Math.sin(this.bobPhase) * Math.min(1, spd / 1.1);
    }

    // ease the FOV (never in free mode — it stays locked at FOV_BASE)
    if (this.mode === "micro") {
      this.fov += (fovTarget - this.fov) * Math.min(1, dt * 7);
      if (Math.abs(this.fov - cam.fov) > 0.01) {
        cam.fov = this.fov;
        cam.updateProjectionMatrix();
      }
      this.minFovSeen = Math.min(this.minFovSeen, this.fov);
      this.maxFovSeen = Math.max(this.maxFovSeen, this.fov);
    }

    // ---- apply to camera ----
    if (this.mode === "micro") {
      // ZERO-DISTORTION MICRO-PARALLAX SPHERE (owner law): the camera NEVER
      // leaves a 0.08 m sphere around the capture origin — total 3D offset,
      // head-bob included — no matter how far the virtual position glides.
      // The photograph can never smear.
      let dx = this.pos.x - this.origin.x;
      let dz = this.pos.z - this.origin.z;
      const dy = bob;
      const hMax = Math.sqrt(Math.max(0, MICRO_PARALLAX * MICRO_PARALLAX - dy * dy));
      const d = Math.hypot(dx, dz);
      if (d > hMax) {
        const k = hMax / Math.max(d, 1e-9);
        dx *= k; dz *= k;
      }
      cam.position.set(this.origin.x + dx, this.origin.y + dy, this.origin.z + dz);
    } else {
      cam.position.set(this.pos.x, EYE_HEIGHT + bob, this.pos.z);
    }
    const off = this.cameraOffset();
    if (off > this.maxOffsetSeen) this.maxOffsetSeen = off;
    cam.rotation.order = "YXZ";
    cam.rotation.set(this.pitch, this.yaw, 0);

    if (bump && this.onBump) this.onBump(bump);
    return bump;
  }

  /* ------------------------------------------------------------ events */

  _bind() {
    const dom = this.dom;

    this._onKeyDown = (e) => {
      if (e.code === "ArrowUp" || e.code === "ArrowDown" || e.code === "ArrowLeft" || e.code === "ArrowRight" || e.code === "Space") e.preventDefault();
      this.keys.add(e.code);
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();

    this._onPointerDown = (e) => {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 2) {
        this._down = null;                     // two-finger = walk, not look
        return;
      }
      if (!this.enabled) return;
      this._down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, id: e.pointerId };
      try { dom.setPointerCapture(e.pointerId); } catch (err) {}
    };

    this._onPointerMove = (e) => {
      const prev = this._pointers.get(e.pointerId);

      // two-finger vertical drag = walk forward / back (along the look direction)
      if (this._pointers.size === 2 && prev) {
        const dy = e.clientY - prev.y;
        if (this.enabled && Math.abs(dy) > 0.5) {
          const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
          this._addBoost(-sinY * -dy * 0.011, -cosY * -dy * 0.011);
        }
        prev.x = e.clientX; prev.y = e.clientY;
        return;
      }

      if (!this.enabled || !this._down || e.pointerId !== this._down.id) return;
      const dx = e.clientX - this._down.x, dy = e.clientY - this._down.y;
      this._down.moved += Math.abs(dx) + Math.abs(dy);
      this._down.x = e.clientX; this._down.y = e.clientY;
      this.yaw -= dx * this.sensitivity;
      this.pitch -= dy * this.sensitivity;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.35, 1.35);
    };

    this._onPointerUp = (e) => {
      this._pointers.delete(e.pointerId);
      if (!this._down || e.pointerId !== this._down.id) return;
      const quick = performance.now() - this._down.t < 350 && this._down.moved < 8;
      const { x, y } = this._down;
      this._down = null;
      if (!quick || !this.enabled) return;

      const now = performance.now();
      const lt = this._lastTap;
      this._lastTap = { t: now, x, y };
      if (lt && now - lt.t < 320 && Math.hypot(x - lt.x, y - lt.y) < 32) {
        this._lastTap = null;
        this.onDouble && this.onDouble(x, y);
      } else {
        this.onClick && this.onClick(x, y);
      }
    };

    this._onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const step = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
      // scroll up = walk forward, along the current look direction
      const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
      this._addBoost(-sinY * -step * 0.0075, -cosY * -step * 0.0075);
    };

    addEventListener("keydown", this._onKeyDown);
    addEventListener("keyup", this._onKeyUp);
    addEventListener("blur", this._onBlur);
    dom.addEventListener("pointerdown", this._onPointerDown);
    dom.addEventListener("pointermove", this._onPointerMove);
    dom.addEventListener("pointerup", this._onPointerUp);
    dom.addEventListener("pointercancel", this._onPointerUp);
    dom.addEventListener("wheel", this._onWheel, { passive: false });
  }

  /** Add scroll/two-finger momentum (m/s), clamped to BOOST_MAX. */
  _addBoost(x, z) {
    this.boost.x = THREE.MathUtils.clamp(this.boost.x + x, -BOOST_MAX, BOOST_MAX);
    this.boost.y = THREE.MathUtils.clamp(this.boost.y + z, -BOOST_MAX, BOOST_MAX);
    this.walkTarget = null;
  }

  dispose() {
    removeEventListener("keydown", this._onKeyDown);
    removeEventListener("keyup", this._onKeyUp);
    removeEventListener("blur", this._onBlur);
    const dom = this.dom;
    dom.removeEventListener("pointerdown", this._onPointerDown);
    dom.removeEventListener("pointermove", this._onPointerMove);
    dom.removeEventListener("pointerup", this._onPointerUp);
    dom.removeEventListener("pointercancel", this._onPointerUp);
    dom.removeEventListener("wheel", this._onWheel);
  }
}
