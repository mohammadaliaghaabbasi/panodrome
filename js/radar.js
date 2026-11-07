/**
 * PANODROME — Stage 2.1 · Mini 2D Floorplan Radar (owner order 2026-11-03
 * "پلان زنده گوشه تصویر") + the Dollhouse 2D Floor-Plan Dimension View.
 *
 * A compact canvas radar in the corner: room walls, doorway portal, furniture
 * blocks, and the LIVE camera position + view cone as you walk.  In
 * Dollhouse mode it grows into the dimension plan (W × D metres).
 */
import * as THREE from "three";
import { i18n, faDigits } from "./i18n.js";

const MINI_SIZE = 156;
const PLAN_SIZE = 264;

export class Radar {
  constructor(camera) {
    this.camera = camera;
    this.canvas = document.getElementById("radar");
    this.wrap = document.getElementById("radar-wrap");
    this.label = document.getElementById("radar-label");
    this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
    this.visible = true;
    this.planMode = false;
    this.room = null;
    this.world = null;
    this.playerPos = new THREE.Vector2();
    this.yaw = 0;
    this._acc = 0;
    this._dpr = Math.min(devicePixelRatio || 1, 2);
    this._resize();
    if (this.canvas) {
      addEventListener("resize", () => this._resize());
    }
  }

  _resize() {
    const s = this.planMode ? PLAN_SIZE : MINI_SIZE;
    if (!this.canvas) return;
    this.canvas.width = s * this._dpr;
    this.canvas.height = s * this._dpr;
    this.canvas.style.width = s + "px";
    this.canvas.style.height = s + "px";
  }

  setRoom(room, world) {
    this.room = room;
    this.world = world;
  }

  setPlanMode(on) {
    if (this.planMode === on) return;
    this.planMode = on;
    this.wrap?.classList.toggle("plan", on);
    this._resize();
  }

  toggleVisible() {
    this.visible = !this.visible;
    this.wrap?.classList.toggle("collapsed", !this.visible);
    return this.visible;
  }

  /** Called from the frame loop (throttled internally to ~20 fps). */
  update(dt, playerPos, yaw) {
    if (!this.ctx || !this.room || !this.visible) return;
    this._acc += dt;
    if (this._acc < 0.05) return;
    this._acc = 0;
    this.playerPos.set(playerPos.x, playerPos.y || playerPos.z);
    this.playerZ = playerPos.z !== undefined ? playerPos.z : this.playerPos.y;
    this.yaw = yaw;
    this._draw();
  }

  _draw() {
    const ctx = this.ctx;
    const S = this.canvas.width;
    const W = this.room.room_shape.width;
    const D = this.room.room_shape.depth;
    const pad = this.planMode ? 34 : 14;
    const s = Math.min((S - pad * 2) / W, (S - pad * 2) / D);
    const cx = S / 2, cy = S / 2;
    const X = (x) => cx + x * s;
    const Y = (z) => cy + z * s;      // north (-z) at the top

    ctx.clearRect(0, 0, S, S);

    // room shell
    ctx.strokeStyle = "rgba(235, 244, 255, 0.85)";
    ctx.lineWidth = 2.5 * this._dpr;
    ctx.strokeRect(X(-W / 2), Y(-D / 2), W * s, D * s);

    // doorway (portal ring position) — gap dot + arc
    const p = this.room.portals && this.room.portals[0];
    if (p) {
      const px = X(p.position[0]), py = Y(p.position[2]);
      ctx.fillStyle = "rgba(255, 214, 140, 0.95)";
      ctx.beginPath();
      ctx.arc(px, py, 3.2 * this._dpr, 0, Math.PI * 2);
      ctx.fill();
      if (this.planMode) {
        ctx.font = `${10 * this._dpr}px Vazirmatn, Inter, sans-serif`;
        ctx.fillStyle = "rgba(255, 214, 140, 0.9)";
        ctx.textAlign = "center";
        ctx.fillText(i18n.t.doorway, px, py - 7 * this._dpr);
      }
    }

    // furniture blocks (from the collision world = what you see)
    ctx.fillStyle = "rgba(190, 216, 240, 0.5)";
    for (const o of (this.world ? this.world.obstacles : [])) {
      if (o.type === "cyl") {
        ctx.beginPath();
        ctx.arc(X(o.x), Y(o.z), Math.max(o.hw * s, 2), 0, Math.PI * 2);
        ctx.fill();
      } else {
        // rotated OBB → axis-aligned approx (rot is tiny in our rooms)
        const ex = (o.hw || 0.5) * 2 * s, ez = (o.hd || 0.5) * 2 * s;
        ctx.fillRect(X(o.x) - ex / 2, Y(o.z) - ez / 2, ex, ez);
      }
    }

    // player: view cone + dot (real camera position)
    const px = X(this.playerPos.x), py = Y(this.playerZ);
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);   // camera forward
    const cone = 0.42;
    const R = this.planMode ? 26 * this._dpr : 18 * this._dpr;
    const a0 = Math.atan2(fz, fx);
    const g = ctx.createRadialGradient(px, py, 0, px, py, R);
    g.addColorStop(0, "rgba(255, 236, 180, 0.55)");
    g.addColorStop(1, "rgba(255, 236, 180, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, R, a0 - cone, a0 + cone);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffe9b8";
    ctx.beginPath();
    ctx.arc(px, py, 3.4 * this._dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 233, 184, 0.9)";
    ctx.lineWidth = 1.6 * this._dpr;
    ctx.stroke();

    if (this.planMode) {
      // dimension labels: W × D metres (metric floor plan)
      ctx.fillStyle = "rgba(234, 244, 255, 0.95)";
      ctx.font = `${11 * this._dpr}px Vazirmatn, Inter, sans-serif`;
      ctx.textAlign = "center";
      const wl = i18n.lang === "fa" ? `${faDigits(W.toFixed(1))} متر` : `${W.toFixed(1)} m`;
      const dl = i18n.lang === "fa" ? `${faDigits(D.toFixed(1))} متر` : `${D.toFixed(1)} m`;
      ctx.fillText(wl, cx, Y(D / 2) + 15 * this._dpr);
      ctx.save();
      ctx.translate(X(-W / 2) - 15 * this._dpr, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(dl, 0, 0);
      ctx.restore();
    }
  }
}
