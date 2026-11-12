/**
 * HOLE-FILL COMPOSITE (docs/17, Lane C at runtime)
 *
 * The problem it solves: crossfading a splat over a sharp panorama as soon as
 * you move replaces 8 MP of photography with ~0.5 MP of sampled gaussians, so
 * the whole view goes soft. The photo never needed replacing — it is only
 * *incomplete* in the wedges the camera could never see.
 *
 * So: keep the photograph at full opacity, and draw the splat ONLY where the
 * translated viewpoint has no source sample. At the capture point the mask is
 * full (splat invisible → 100 % sharp). As you walk, thin slivers of splat
 * appear exactly where geometry was occluded. No global blur, and nothing is
 * invented that the photo could have shown.
 *
 * The mask is the same measurement as skills/walk_budget.py, done at 64×128 in
 * JavaScript: forward-project the low-res ERP depth to the new viewpoint and
 * mark every destination pixel that received a sample.
 */

import * as THREE from "three";

/** Load the low-res depth sphere exported by the bake (w,h uint16 + float32). */
export async function loadDepthSphere(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const view = new DataView(buf);
  const w = view.getUint16(0, true);
  const h = view.getUint16(2, true);
  const depth = new Float32Array(buf, 4, w * h);
  // pre-compute world points once (the mask is recomputed per movement)
  const pos = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const theta = ((y + 0.5) / h) * Math.PI;        // colatitude
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let x = 0; x < w; x++) {
      const phi = ((x + 0.5) / w) * 2 * Math.PI - Math.PI;
      const d = depth[y * w + x];
      const i = (y * w + x) * 3;
      pos[i] = st * Math.sin(phi) * d;
      pos[i + 1] = ct * d;
      pos[i + 2] = st * Math.cos(phi) * d;
    }
  }
  return { w, h, depth, pos };
}

/**
 * Recompute the coverage mask for a camera translated by (tx, ty, tz).
 * out[i] === 1 → the photograph has a valid sample in that direction.
 */
export function computeMask(ds, tx, ty, tz, out) {
  const { w, h, depth, pos } = ds;
  out.fill(0);
  const TWO_PI = Math.PI * 2;
  for (let i = 0, n = w * h; i < n; i++) {
    if (depth[i] <= 0) continue;
    const rx = pos[i * 3] - tx;
    const ry = pos[i * 3 + 1] - ty;
    const rz = pos[i * 3 + 2] - tz;
    const len = Math.hypot(rx, ry, rz);
    if (len < 1e-6) continue;
    const colat = Math.acos(Math.max(-1, Math.min(1, ry / len)));
    const lon = Math.atan2(rx, rz);
    const u = Math.floor(((lon + Math.PI) / TWO_PI) * w);
    const v = Math.min(h - 1, Math.max(0, Math.floor((colat / Math.PI) * h)));
    // 3x3 stamp: one point must cover its own pixel footprint
    for (let dv = -1; dv <= 1; dv++) {
      const vv = v + dv;
      if (vv < 0 || vv >= h) continue;
      for (let du = -1; du <= 1; du++) {
        out[vv * w + ((u + du + w) % w)] = 1;
      }
    }
  }
  return out;
}

/** Mask texture: 1 = photographed, 0 = unknown (splat must cover it). */
export function makeMaskTexture(ds) {
  const data = new Uint8Array(ds.w * ds.h);
  const tex = new THREE.DataTexture(data, ds.w, ds.h, THREE.RedFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Drive one mask update from the camera position.
 * `state.last` throttles the work to real movement (4 cm) so it is not per-frame.
 */
export function updateMask(ds, tex, state, camera) {
  const p = camera.position;
  if (state.last &&
      Math.abs(p.x - state.last.x) + Math.abs(p.z - state.last.z) < 0.04) {
    return 0;
  }
  const t0 = performance.now();
  computeMask(ds, p.x, p.y, p.z, ds.maskBuf);
  tex.image.data.set(ds.maskBuf);
  tex.needsUpdate = true;
  state.last = { x: p.x, y: p.y, z: p.z };
  // known fraction, for the HUD
  let covered = 0;
  for (let i = 0; i < ds.maskBuf.length; i++) covered += ds.maskBuf[i];
  return { ms: performance.now() - t0, covered: covered / ds.maskBuf.length };
}
