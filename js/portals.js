/**
 * PANODROME — Stage 1.5 · Doorway Waypoint + Portal Routing Modes
 *
 * ONE VLM-verified doorway per room, rendered as the refined 32px pulsing
 * glass ring (Stage-1 visual language, unchanged). New in Stage 1.5:
 *
 *   · PORTAL ROUTING MODES (user-driven exploration, restored from 3203ae2
 *     with cleaner semantics):
 *       architect — the next space by the SAME architect / creator
 *       style     — same style family (modern / classic / cozy / historic /
 *                   open_air), falling back to the closest style_tags match
 *       room_type — same type group (residential / hospitality / heritage /
 *                   outdoor)
 *       random    — serendipitous discovery
 *   · WALK-INTO-DOORWAY: walking physically within 1.1 m of the ring
 *     triggers the portal transition — like walking through a real door.
 */
import * as THREE from "three";

const RING_SCREEN_PX = 32;   // constant on-screen ring size
const PULSE_HZ = 1.35;
export const WALK_IN_DIST = 1.1;   // m — walk into the doorway to travel

function ringTexture() {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const ctx = cv.getContext("2d");
  const c = S / 2;

  // soft glass halo
  let g = ctx.createRadialGradient(c, c, S * 0.30, c, c, S * 0.5);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.72, "rgba(255,255,255,0.10)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // refined thin glass ring
  ctx.strokeStyle = "rgba(255,255,255,0.97)";
  ctx.lineWidth = 10;
  ctx.beginPath(); ctx.arc(c, c, S * 0.33, 0, Math.PI * 2); ctx.stroke();

  // inner accent thread
  ctx.strokeStyle = "rgba(190,225,255,0.55)";
  ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.arc(c, c, S * 0.415, 0, Math.PI * 2); ctx.stroke();

  // centre dot
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath(); ctx.arc(c, c, S * 0.045, 0, Math.PI * 2); ctx.fill();

  const tex = new THREE.CanvasTexture(cv);
  return tex;
}

export class Waypoint {
  /**
   * @param {object} def        portal definition (rooms_db.json, *_door)
   * @param {object} targetRoom the room this doorway leads to
   */
  constructor(def, targetRoom) {
    this.def = def;
    this.targetRoom = targetRoom;
    this.hovered = false;

    this.group = new THREE.Group();
    this.group.position.fromArray(def.position);

    this.mat = new THREE.SpriteMaterial({
      map: ringTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,     // always readable, like a UI affordance
    });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.renderOrder = 10;
    this.group.add(this.sprite);

    // generous invisible tap target (~1.5× the visual ring)
    this.collider = new THREE.Mesh(
      new THREE.SphereGeometry(1, 10, 10),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.group.add(this.collider);

    this.phase = Math.random() * Math.PI * 2;
    this._opacity = 0;
  }

  /** Retarget the same doorway at a new destination (routing-mode change). */
  retarget(targetRoom) {
    this.targetRoom = targetRoom;
  }

  /** Constant-32px world scale for the current camera. */
  update(t, dt, camera, hovered) {
    this.hovered = !!hovered;

    const dist = Math.max(0.5, camera.position.distanceTo(this.group.position));
    const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / innerHeight;
    const pulse = 1 + 0.07 * Math.sin(t * Math.PI * 2 * PULSE_HZ + this.phase);
    const targetScale = RING_SCREEN_PX * worldPerPx * pulse * (this.hovered ? 1.18 : 1);
    const s = this.sprite.scale.x + (targetScale - this.sprite.scale.x) * Math.min(1, dt * 14);
    this.sprite.scale.set(s, s, 1);
    this.collider.scale.setScalar(s * 0.75);

    const targetOpacity = this.hovered ? 1 : 0.88;
    this._opacity += (targetOpacity - this._opacity) * Math.min(1, dt * 8);
    this.mat.opacity = this._opacity * (0.9 + 0.1 * Math.sin(t * Math.PI * 2 * PULSE_HZ + this.phase));
  }

  /** Horizontal distance from the player (effective/virtual position) to the doorway. */
  playerDist(pos) {
    const p = this.group.position;
    return Math.hypot(pos.x - p.x, pos.z - p.z);
  }

  doorPos() { return this.group.position.clone(); }

  dispose() {
    this.sprite.geometry?.dispose?.();
    this.mat.map.dispose();
    this.mat.dispose();
    this.collider.geometry.dispose();
    this.collider.material.dispose();
  }
}

/* ============================================================ routing */

export const ROUTING_MODES = ["architect", "style", "room_type", "random"];

/**
 * Where does this doorway lead?
 * @returns {{target:number, reason:string}} index into rooms
 */
export function computeRoutes(rooms, currentIndex, mode) {
  const n = rooms.length;
  const cur = rooms[currentIndex];
  const next = (i) => (i + 1) % n;

  if (mode === "architect") {
    const me = (cur.attribution?.creator || "").trim();
    for (let k = 1; k < n; k++) {
      const i = (currentIndex + k) % n;
      const other = (rooms[i].attribution?.creator || "").trim();
      if (i !== currentIndex && other && other === me) return { target: i, reason: "architect" };
    }
    return { target: next(currentIndex), reason: "architect_fallback" };
  }

  if (mode === "style") {
    const family = cur.style_family;
    for (let k = 1; k < n; k++) {
      const i = (currentIndex + k) % n;
      if (rooms[i].style_family === family) return { target: i, reason: "style" };
    }
    // closest style_tags overlap
    let best = -1, bestScore = -1;
    for (let i = 0; i < n; i++) {
      if (i === currentIndex) continue;
      const score = (rooms[i].style_tags || []).filter((t) => (cur.style_tags || []).includes(t)).length;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return { target: best >= 0 ? best : next(currentIndex), reason: "style_near" };
  }

  if (mode === "room_type") {
    const group = cur.type_group;
    for (let k = 1; k < n; k++) {
      const i = (currentIndex + k) % n;
      if (rooms[i].type_group === group) return { target: i, reason: "room_type" };
    }
    return { target: next(currentIndex), reason: "room_type_fallback" };
  }

  // random serendipity
  const pool = [...Array(n).keys()].filter((i) => i !== currentIndex);
  return { target: pool[Math.floor(Math.random() * pool.length)], reason: "random" };
}

/** Project a world position to CSS pixel coords. Returns {x, y, behind}. */
export function projectToScreen(pos, camera) {
  const v = pos.clone().project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * innerWidth,
    y: (-v.y * 0.5 + 0.5) * innerHeight,
    behind: v.z > 1,
  };
}
