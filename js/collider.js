/**
 * PANODROME — Stage 2.0 · Walk World (collision + 3D overlay FX)
 * ============================================================================
 * LAW 2 (owner order 2026-11-03): spatial depth + floor grounding + furniture
 * interaction INSIDE the pure 360° sphere — WITHOUT bending a single photo
 * pixel.  All of these are independent REAL 3D objects in world space:
 *   · WALK WORLD — virtual walk position resolved against room_bounds +
 *     obstacle_colliders (exact furniture volumes) with sliding response;
 *     direct bumps surface as events (toast + ripple + soft thud + flash).
 *   · 3D PERSPECTIVE FLOOR GRID — fades in while stepping.
 *   · PLAYER RING — the micro-parallax marker under the camera.
 *   · FOOTSTEP TARGET RING — the double-tap destination marker, pulsing in
 *     true 3D perspective on the floor plane until you arrive.
 *   · 3D GLASS FURNITURE BOUNDING PROXIES — translucent glass volumes with
 *     crisp edge contours at every obstacle's true world bounds; proximity
 *     fades them in, bumps flash them, and they are tap targets (hotspots):
 *     double-tap a proxy to glide up to that furniture piece.
 */
import * as THREE from "three";

const BUMP_COOLDOWN_MS = 900;

export class WalkWorld {
  /** @param {object} room  rooms_db.json room record (walk.bounds + obstacles) */
  constructor(room) {
    this.room = room;
    const b = room.walk.bounds;
    this.bounds = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
    // EXACT boundary from the walkable-truth engine (docs/16): when present it
    // replaces the old axis-aligned box, so concave rooms and diagonals are real.
    const poly = room.walk.polygon;
    this.polygon = Array.isArray(poly) && poly.length >= 3 ? poly : null;
    this.ceilingH = room.walk.ceiling_h ?? null;
    this.playerR = room.walk.player_radius ?? 0.3;
    this.obstacles = (room.walk.obstacles || []).map((o) => ({
      type: o.type === "box" ? "box" : "cyl",
      x: o.x, z: o.z,
      hw: (o.hw ?? o.r), hd: (o.hd ?? o.r),
      rot: o.rot || 0,                       // OBB yaw (radians, optional)
      label: o.label || { en: "Obstacle", fa: "مانع" },
      raw: o,
    }));
    this._bumpAt = new Map();                // obstacle/wall key -> last event ms
    this._contact = new Set();              // obstacles currently touching
    this._wallTouch = new Set();            // wall sides currently touching
  }

  /**
   * Resolve one integration step with sliding collision.
   * Bump events fire on CONTACT TRANSITIONS (not touching -> touching), so a
   * deliberate slow auto-walk into an obstacle surfaces exactly like a fast
   * human stride — one event per contact episode, 0.9 s cooldown per body.
   * @returns {null | {label:{en,fa}, nx:number, nz:number, impact:number, ob:object}}
   */
  resolve(pos, vel) {
    let bump = null;
    const R = this.playerR;
    const now = performance.now();
    const fire = (key, b) => {
      const last = this._bumpAt.get(key) || 0;
      if (now - last < BUMP_COOLDOWN_MS) return null;
      this._bumpAt.set(key, now);
      return b;
    };

    // ---- walls ----
    const wallTouch = new Set();
    let wallNormal = null;
    if (this.polygon) {
      // circle vs every boundary SEGMENT: exact for concave polygons and
      // diagonals. Two passes so a corner push never leaves the capsule stuck
      // inside the neighbouring edge.
      const n = this.polygon.length;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
          const a = this.polygon[i], c = this.polygon[(i + 1) % n];
          const ex = c[0] - a[0], ez = c[1] - a[1];
          const len2 = ex * ex + ez * ez;
          if (len2 < 1e-9) continue;
          let t = ((pos.x - a[0]) * ex + (pos.z - a[1]) * ez) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = a[0] + ex * t, pz = a[1] + ez * t;
          let dx = pos.x - px, dz = pos.z - pz;
          let d = Math.hypot(dx, dz);
          if (d >= R) continue;
          let nx, nz;
          if (d < 1e-6) {
            // capsule centre exactly on the wall line: push along the inward
            // normal derived from the polygon winding (CCW -> left is inside)
            const l = Math.sqrt(len2);
            nx = -ez / l; nz = ex / l;
            d = 0;
          } else {
            nx = dx / d; nz = dz / d;
          }
          const push = R - d;
          pos.x += nx * push;
          pos.z += nz * push;
          const vn = vel.x * nx + vel.y * nz;
          if (vn < 0) { vel.x -= vn * nx; vel.y -= vn * nz; }
          if (push > 0.5 * R) { wallTouch.add("e" + i); wallNormal = [nx, nz]; }
        }
      }
    } else {
      // legacy axis-aligned clamp = classic tangent slide
      const wallN = { "x-": [1, 0], "x+": [-1, 0], "z-": [0, 1], "z+": [0, -1] };
      if (pos.x < this.bounds.minX) { wallTouch.add("x-"); pos.x = this.bounds.minX; if (vel.x < 0) vel.x = 0; }
      else if (pos.x > this.bounds.maxX) { wallTouch.add("x+"); pos.x = this.bounds.maxX; if (vel.x > 0) vel.x = 0; }
      if (pos.z < this.bounds.minZ) { wallTouch.add("z-"); pos.z = this.bounds.minZ; if (vel.y < 0) vel.y = 0; }
      else if (pos.z > this.bounds.maxZ) { wallTouch.add("z+"); pos.z = this.bounds.maxZ; if (vel.y > 0) vel.y = 0; }
      for (const k of wallTouch) {
        if (!this._wallTouch.has(k)) wallNormal = wallN[k];
      }
    }
    for (const k of wallTouch) {
      if (!this._wallTouch.has(k) && wallNormal) {
        const [nx, nz] = wallNormal;
        bump = bump || fire("wall" + k, {
          label: { en: "Wall", fa: "دیوار" }, nx, nz,
          impact: Math.max(Math.hypot(vel.x, vel.y), 0.25), ob: null,
        });
      }
    }
    this._wallTouch = wallTouch;

    // ---- obstacles: circle-vs-OBB / circle-vs-circle push-out ----
    for (const o of this.obstacles) {
      let nx, nz, push, touching;
      if (o.type === "cyl") {
        const ddx = pos.x - o.x, ddz = pos.z - o.z;
        const d = Math.hypot(ddx, ddz);
        const rr = o.hw + R;                    // o.hw = o.hd = radius
        touching = d < rr;
        if (!touching) { this._contact.delete(o); continue; }
        if (d < 1e-6) { nx = 1; nz = 0; }
        else { nx = ddx / d; nz = ddz / d; }
        push = rr - d;
      } else {
        // player position in the box LOCAL frame (yaw support)
        const cr = Math.cos(-o.rot), sr = Math.sin(-o.rot);
        const rx = pos.x - o.x, rz = pos.z - o.z;
        const lx = cr * rx - sr * rz;
        const lz = sr * rx + cr * rz;
        const cx = THREE.MathUtils.clamp(lx, -o.hw, o.hw);
        const cz = THREE.MathUtils.clamp(lz, -o.hd, o.hd);
        const dx = lx - cx, dz = lz - cz;
        const d = Math.hypot(dx, dz);
        touching = d < R;
        if (!touching) { this._contact.delete(o); continue; }
        let lnx, lnz;
        if (d < 1e-6) {
          const px = (o.hw + R) - Math.abs(lx);
          const pz = (o.hd + R) - Math.abs(lz);
          if (px < pz) { lnx = Math.sign(lx) || 1; lnz = 0; push = px; }
          else { lnx = 0; lnz = Math.sign(lz) || 1; push = pz; }
        } else {
          lnx = dx / d; lnz = dz / d; push = R - d;
        }
        // local normal -> world (rotate by +rot)
        const cw = Math.cos(o.rot), sw = Math.sin(o.rot);
        nx = cw * lnx - sw * lnz;
        nz = sw * lnx + cw * lnz;
      }
      const isNew = !this._contact.has(o);
      this._contact.add(o);
      pos.x += nx * push;
      pos.z += nz * push;
      // cancel the inward normal velocity → slide along the tangent
      const vn = vel.x * nx + vel.y * nz;
      if (vn < 0) {
        vel.x -= vn * nx;
        vel.y -= vn * nz;
      }
      if (isNew) {
        bump = bump || fire(o, {
          label: o.label, nx, nz,
          impact: Math.max(-vn, 0.25), ob: o,
        });
      }
    }
    return bump;
  }

  /** True if a world point is inside the walkable area (E2E helper). */
  insideWalkable(x, z, pad = 0) {
    if (this.polygon) {
      return pointInPolygon(this.polygon, x, z, pad);
    }
    return x >= this.bounds.minX - pad && x <= this.bounds.maxX + pad &&
           z >= this.bounds.minZ - pad && z <= this.bounds.maxZ + pad;
  }
}

/**
 * Even-odd containment for the engine's floor polygon (CCW, metres).
 * `pad` shrinks the area so E2E checks stay clear of the wall capsule radius.
 */
export function pointInPolygon(poly, x, z, pad = 0) {
  const n = poly.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z)) {
      const xc = xi + ((z - zi) / (zj - zi)) * (xj - xi);
      if (x < xc) inside = !inside;
    }
  }
  if (!inside) return false;
  if (pad === 0) return true;
  // require pad clearance from every edge
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const len = Math.hypot(ex, ez) || 1;
    const d = Math.abs(((x - a[0]) * ez - (z - a[1]) * ex) / len);
    if (d < pad) return false;
  }
  return true;
}

/* ============================================================ walk FX */

const GRID_COLOR = 0x9fc6ec;
const HALO_LINE_COLOR = 0xeaf5ff;
const HALO_FILL_COLOR = 0xaacfe8;
const PROXY_FILL_COLOR = 0xaad4f2;
const PROXY_EDGE_COLOR = 0xeaf7ff;
const TARGET_RING_COLOR = 0xd8ecff;

/**
 * 3D floor grid + player ring + footstep target ring + obstacle halos +
 * 3D glass furniture proxies.  All REAL 3D objects inside the pano sphere —
 * they move in true perspective while the photograph stays untouched.
 */
export class WalkFX {
  constructor(scene, room) {
    const { width, depth } = room.room_shape;
    const cell = Math.max(width, depth) > 15 ? 1.0 : 0.5;
    this.grid = buildGrid(width, depth, cell);
    this.grid.position.y = 0.02;
    scene.add(this.grid);

    // player ring — under the CAMERA (micro-parallax marker)
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.55, 48),
      new THREE.MeshBasicMaterial({
        color: 0xcfe4ff, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.021;
    scene.add(this.ring);

    // FOOTSTEP TARGET RING (LAW 2): double-tap destination marker — an
    // outer ring + soft inner disc, pulsing on the true floor plane.
    this.target = new THREE.Group();
    const tRing = new THREE.Mesh(
      new THREE.RingGeometry(0.30, 0.36, 48),
      new THREE.MeshBasicMaterial({
        color: TARGET_RING_COLOR, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    tRing.rotation.x = -Math.PI / 2;
    const tDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.30, 40),
      new THREE.MeshBasicMaterial({
        color: TARGET_RING_COLOR, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    tDisc.rotation.x = -Math.PI / 2;
    this.targetRing = tRing;
    this.targetDisc = tDisc;
    this.target.add(tRing, tDisc);
    this.target.position.y = 0.022;
    this.target.visible = false;
    this._targetFade = 0;
    this._targetPulse = 0;
    scene.add(this.target);

    this.halos = new ObstacleHalos(scene, room.walk.obstacles || []);
    this.proxies = new FurnitureProxies(scene, room.walk.obstacles || []);

    this._gridOpacity = 0;
    this._ringOpacity = 0;
    this._pulse = 0;
  }

  /** Show the footstep target marker at a floor point (double-tap). */
  showTarget(p) {
    this.target.position.set(p.x, 0.022, p.z);
    this.target.visible = true;
    this._targetFade = 1;
    this._targetPulse = 0;
  }

  /** @param vpos virtual walk position · camPos camera (real) · speed m/s */
  update(dt, vpos, camPos, speed) {
    const moving = speed > 0.15;
    this._pulse += dt * 1.6;

    const gTarget = moving ? 0.13 : 0;
    const rTarget = moving ? 0.30 + 0.08 * Math.sin(this._pulse * Math.PI) : 0;
    this._gridOpacity += (gTarget - this._gridOpacity) * Math.min(1, dt * 3.2);
    this._ringOpacity += (rTarget - this._ringOpacity) * Math.min(1, dt * 3.2);
    this.grid.material.opacity = this._gridOpacity;
    this.grid.material.transparent = true;
    this.ring.material.opacity = this._ringOpacity;

    // player ring follows the CAMERA — the true micro-parallax position
    this.ring.position.x = camPos.x;
    this.ring.position.z = camPos.z;
    const s = 1 + Math.min(speed / 2.2, 1) * 0.16 + 0.03 * Math.sin(this._pulse * Math.PI * 2);
    this.ring.scale.setScalar(s);

    // footstep target ring: pulse until it fades (arrival / new target)
    if (this.target.visible) {
      this._targetPulse += dt;
      const arrived = Math.hypot(vpos.x - this.target.position.x, vpos.z - this.target.position.z) < 0.25;
      if (arrived) this._targetFade = Math.max(0, this._targetFade - dt * 2.4);
      const pulse = 0.55 + 0.30 * Math.sin(this._targetPulse * Math.PI * 2.4);
      this.targetRing.material.opacity = 0.85 * this._targetFade * pulse;
      this.targetDisc.material.opacity = 0.14 * this._targetFade * pulse;
      const ps = 1 + 0.06 * Math.sin(this._targetPulse * Math.PI * 2.4);
      this.targetRing.scale.setScalar(ps);
      if (this._targetFade <= 0.01 && arrived) this.target.visible = false;
    }

    this.halos.update(dt, vpos);
    this.proxies.update(dt, vpos, moving);
  }

  dispose(scene) {
    scene.remove(this.grid);
    scene.remove(this.ring);
    scene.remove(this.target);
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.targetRing.geometry.dispose(); this.targetRing.material.dispose();
    this.targetDisc.geometry.dispose(); this.targetDisc.material.dispose();
    this.halos.dispose(scene);
    this.proxies.dispose(scene);
  }
}

/* ------------------------------------------------------------ glass halos */

/**
 * Glass floor contours around every obstacle (proximity-fade, bump-flash).
 */
export class ObstacleHalos {
  constructor(scene, obstacles) {
    this.items = [];
    for (const o of obstacles || []) {
      const it = buildHalo(o);
      if (!it) continue;
      scene.add(it.line);
      scene.add(it.fill);
      this.items.push(it);
    }
    this._scene = scene;
  }

  get count() { return this.items.length; }

  update(dt, playerPos) {
    for (const it of this.items) {
      const dx = playerPos.x - it.cx, dz = playerPos.z - it.cz;
      const dist = Math.hypot(dx, dz);
      const surface = Math.max(0, dist - it.effR);        // distance to the surface
      const prox = THREE.MathUtils.clamp(1 - surface / 1.5, 0, 1);
      it.prox += (prox - it.prox) * Math.min(1, dt * 5);
      it.flash = Math.max(0, it.flash - dt * 1.8);
      const breathe = 0.02 * Math.sin(performance.now() * 0.0012 + it.phase) * it.prox;
      it.line.material.opacity = 0.26 * it.prox * it.prox + 0.50 * it.flash;
      it.fill.material.opacity = 0.085 * it.prox * it.prox + 0.22 * it.flash;
      const s = 1 + 0.045 * it.flash;
      it.line.scale.set(s, 1, s);
      it.fill.scale.set(s, s, 1);
      it.line.visible = it.line.material.opacity > 0.006;
      it.fill.visible = it.fill.material.opacity > 0.004;
    }
  }

  /** Flash the halo of the obstacle that was just bumped. */
  flash(ob) {
    if (!ob) return;
    const it = this.items.find((i) => i.ob === ob || i.ob === ob.raw);
    if (it) it.flash = 1;
  }

  dispose(scene) {
    const sc = scene || this._scene;
    for (const it of this.items) {
      sc.remove(it.line);
      sc.remove(it.fill);
      it.line.geometry.dispose();
      it.line.material.dispose();
      it.fill.geometry.dispose();
      it.fill.material.dispose();
    }
    this.items = [];
  }
}

/* ------------------------------------------- 3D glass furniture proxies */

/**
 * LAW 2: clean 3D GLASS BOUNDING PROXIES — a translucent glass volume with
 * a crisp edge contour at every obstacle's TRUE world bounds (exact height
 * h from the collider).  Proximity fades them in (they read as elegant
 * glass furniture ghosts), bumps flash them, and the volumes are RAYCAST
 * HOTSPOTS: main.js double-tap = glide up to that furniture piece.
 */
export class FurnitureProxies {
  constructor(scene, obstacles) {
    this.items = [];
    this.meshes = [];                       // raycast targets (hotspots)
    for (const o of obstacles || []) {
      const it = buildProxy(o);
      if (!it) continue;
      scene.add(it.fill);
      scene.add(it.edges);
      it.fill.userData.obstacle = o;
      it.edges.userData.obstacle = o;
      this.items.push(it);
      this.meshes.push(it.fill, it.edges);
    }
    this._scene = scene;
  }

  get count() { return this.items.length; }

  update(dt, playerPos, moving) {
    // LAW 1+2 balance: the glass volumes appear ONLY while the user is walking
    // (speed > 0.15 m/s) — still views stay 100% pristine photograph.  They
    // stay raycastable at opacity 0 (hotspot taps work at rest).
    for (const it of this.items) {
      const dx = playerPos.x - it.cx, dz = playerPos.z - it.cz;
      const dist = Math.hypot(dx, dz);
      const surface = Math.max(0, dist - it.effR);
      const prox = moving ? THREE.MathUtils.clamp(1 - surface / 2.2, 0, 1) : 0;
      it.prox += (prox - it.prox) * Math.min(1, dt * 4.5);
      it.flash = Math.max(0, it.flash - dt * 1.8);
      const breathe = 1 + 0.012 * Math.sin(performance.now() * 0.0011 + it.phase);
      it.fill.material.opacity = 0.05 * it.prox * it.prox + 0.16 * it.flash;
      it.edges.material.opacity = 0.22 * it.prox * it.prox + 0.62 * it.flash;
      const s = (1 + 0.035 * it.flash) * breathe;
      it.fill.scale.setScalar(s);
      it.edges.scale.setScalar(s);
    }
  }

  flash(ob) {
    if (!ob) return;
    const it = this.items.find((i) => i.ob === ob || i.ob === ob.raw);
    if (it) it.flash = 1;
  }

  dispose(scene) {
    const sc = scene || this._scene;
    for (const it of this.items) {
      sc.remove(it.fill);
      sc.remove(it.edges);
      it.fill.geometry.dispose(); it.fill.material.dispose();
      it.edges.geometry.dispose(); it.edges.material.dispose();
    }
    this.items = [];
    this.meshes = [];
  }
}

function buildProxy(o) {
  const h = Math.max(0.25, o.h ?? 0.8);
  const rot = o.rot || 0;
  let geo, effR;
  if (o.type === "box") {
    const hw = o.hw ?? 0.4, hd = o.hd ?? 0.4;
    effR = Math.hypot(hw, hd);
    geo = new THREE.BoxGeometry(hw * 2, h, hd * 2);
  } else {
    const r = o.r ?? 0.5;
    effR = r;
    geo = new THREE.CylinderGeometry(r, r, h, 28, 1, true);
  }
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: PROXY_FILL_COLOR, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide,
  }));
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 25),
    new THREE.LineBasicMaterial({
      color: PROXY_EDGE_COLOR, transparent: true, opacity: 0, depthWrite: false,
    })
  );
  const y = h / 2;
  fill.position.set(o.x, y, o.z);
  edges.position.set(o.x, y, o.z);
  fill.rotation.y = -rot;
  edges.rotation.y = -rot;
  return { fill, edges, cx: o.x, cz: o.z, effR, h, ob: o, prox: 0, flash: 0, phase: Math.random() * Math.PI * 2 };
}

/* ------------------------------------------------------------ halo build */

function buildHalo(o) {
  const isCyl = o.type !== "box";
  const rot = o.rot || 0;
  let effR, line, fill;
  const yLine = 0.018, yFill = 0.014;

  if (isCyl) {
    const r = (o.r ?? o.hw ?? 0) + 0.025;
    effR = o.r ?? o.hw ?? 0;
    const pts = [];
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      pts.push(new THREE.Vector3(o.x + r * Math.cos(a), yLine, o.z + r * Math.sin(a)));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
      color: HALO_LINE_COLOR, transparent: true, opacity: 0.07, depthWrite: false,
    }));
    fill = new THREE.Mesh(
      new THREE.CircleGeometry(effR + 0.02, 48),
      new THREE.MeshBasicMaterial({
        color: HALO_FILL_COLOR, transparent: true, opacity: 0.022,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(o.x, yFill, o.z);
  } else {
    const hw = o.hw ?? 0, hd = o.hd ?? 0;
    effR = Math.hypot(hw, hd);
    const cr = Math.min(hw, hd) * 0.35;                 // rounded corners
    const ow = hw + 0.03, od = hd + 0.03;               // outline margin
    const pts = [];
    const seg = 10;
    const corners = [
      [Math.min(ow - cr, ow), Math.min(od - cr, od), 0],
      [-(ow - cr), od - cr, Math.PI / 2],
      [-ow + 0, -(od - cr), Math.PI],
      [ow - cr, -(od - cr), Math.PI * 1.5],
    ];
    for (const [cx0, cz0, a0] of corners) {
      for (let i = 0; i <= seg; i++) {
        const a = a0 + (i / seg) * (Math.PI / 2);
        const lx = cx0 + cr * Math.cos(a);
        const lz = cz0 + cr * Math.sin(a);
        const cw = Math.cos(rot), sw = Math.sin(rot);
        pts.push(new THREE.Vector3(o.x + cw * lx - sw * lz, yLine, o.z + sw * lx + cw * lz));
      }
    }
    pts.push(pts[0].clone());
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
      color: HALO_LINE_COLOR, transparent: true, opacity: 0.07, depthWrite: false,
    }));
    const shape = roundedRectShape(hw + 0.01, hd + 0.01, Math.min(hw, hd) * 0.35);
    fill = new THREE.Mesh(
      new THREE.ShapeGeometry(shape, 8),
      new THREE.MeshBasicMaterial({
        color: HALO_FILL_COLOR, transparent: true, opacity: 0.022,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    fill.rotation.x = -Math.PI / 2;
    fill.rotation.z = -rot;
    fill.position.set(o.x, yFill, o.z);
  }

  return { line, fill, cx: o.x, cz: o.z, effR, ob: o, prox: 0, flash: 0, phase: Math.random() * Math.PI * 2 };
}

function roundedRectShape(hw, hd, r) {
  const s = new THREE.Shape();
  r = Math.min(r, hw, hd);
  s.moveTo(-hw + r, -hd);
  s.lineTo(hw - r, -hd);
  s.quadraticCurveTo(hw, -hd, hw, -hd + r);
  s.lineTo(hw, hd - r);
  s.quadraticCurveTo(hw, hd, hw - r, hd);
  s.lineTo(-hw + r, hd);
  s.quadraticCurveTo(-hw, hd, -hw, hd - r);
  s.lineTo(-hw, -hd + r);
  s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  return s;
}

function buildGrid(w, d, cell) {
  const pts = [];
  const hw = w / 2, hd = d / 2;
  for (let x = -hw; x <= hw + 1e-6; x += cell) {
    pts.push(x, 0, -hd, x, 0, hd);
  }
  for (let z = -hd; z <= hd + 1e-6; z += cell) {
    pts.push(-hw, 0, z, hw, 0, z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: GRID_COLOR, transparent: true, opacity: 0, depthWrite: false,
  });
  return new THREE.LineSegments(geo, mat);
}
