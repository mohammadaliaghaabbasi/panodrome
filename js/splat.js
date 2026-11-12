/**
 * SPLAT RENDERER — Lane B2 (docs/17), EWA edition.
 *
 * Loads a 3DGS .ply baked by skills/bake_splat.py and renders it the way the
 * format intends: every gaussian becomes an ANISOTROPIC screen-space ellipse
 * (Zwicker et al. EWA splatting, the same maths 3DGS uses), depth sorted far
 * to near. Points were a stopgap — isotropic discs at one ERP footprint leave
 * visible striping wherever the surface is seen at a grazing angle.
 *
 * Pipeline per splat:
 *   PLY  ->  scale + quaternion  ->  3D covariance C = R S S^T R^T
 *        ->  view-space Jacobian J -> 2D covariance C' = (JV)C(JV)^T
 *        ->  eigen-decomposition  ->  two axis vectors -> instanced quad
 *
 * Sorting is a counting sort on 2048 depth bins (O(n), ~8 ms for 260k splats),
 * called on a timer rather than every frame.
 *
 * Public API (unchanged for callers):
 *   loadSplat(url)                        -> { count, pos, col, covA, covB, alpha }
 *   createSplat(splat, {pixelRatio})      -> THREE.Mesh (instanced quads)
 *   syncSplatUniforms(mesh, cam, renderer)-> keeps focal/viewport in sync
 *   sortSplat(mesh, cam)                  -> far-to-near reorder, returns ms
 */

import * as THREE from "three";
import { loadSpz } from "./spz.js";

const SH_C0 = 0.28209479177387814;

/* ------------------------------------------------------------------ parse */

export async function loadSplat(url) {
  // SPZ is the servable container (~8 B/splat measured vs 68 B as PLY); the
  // reader returns the same shape, so everything below stays untouched.
  if (/\.spz(\?|$)/i.test(url)) return await loadSpz(url);
  const buf = await (await fetch(url)).arrayBuffer();
  const head = new Uint8Array(buf);
  const marker = "\nend_header\n";
  let text = "";
  const limit = Math.min(head.length, 1 << 16);
  for (let i = 0; i < limit; i++) text += String.fromCharCode(head[i]);
  const cut = text.indexOf(marker);
  if (cut < 0) throw new Error("not a PLY: no end_header");
  const headerText = text.slice(0, cut);
  const bodyStart = cut + marker.length;

  const count = Number((headerText.match(/element vertex\s+(\d+)/) || [])[1] || 0);
  const props = [...headerText.matchAll(/property\s+float\s+(\S+)/g)].map((m) => m[1]);
  if (!count || !props.length) throw new Error("PLY has no vertex element");

  const stride = props.length;
  const f = new Float32Array(buf, bodyStart, count * stride);
  const off = {};
  props.forEach((p, i) => { off[p] = i; });
  for (const p of ["x", "y", "z", "f_dc_0", "opacity", "scale_0", "rot_0"]) {
    if (off[p] === undefined) throw new Error(`PLY missing property ${p}`);
  }

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const covA = new Float32Array(count * 3);   // Cxx, Cxy, Cxz
  const covB = new Float32Array(count * 3);   // Cyy, Cyz, Czz
  const alpha = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const b = i * stride;
    pos[i * 3] = f[b + off.x];
    pos[i * 3 + 1] = f[b + off.y];
    pos[i * 3 + 2] = f[b + off.z];
    for (let c = 0; c < 3; c++) {
      const dc = f[b + off[`f_dc_${c}`]];
      col[i * 3 + c] = Math.min(1, Math.max(0, 0.5 + SH_C0 * dc));
    }
    alpha[i] = 1 / (1 + Math.exp(-f[b + off.opacity]));

    // ---- covariance from scale + rotation (quaternion w,x,y,z) ----
    const sx = Math.exp(f[b + off.scale_0]);
    const sy = Math.exp(f[b + off.scale_1]);
    const sz = Math.exp(f[b + off.scale_2]);
    let w = f[b + off.rot_0], x = 0, y = 0, z = 0;
    if (off.rot_1 !== undefined) { x = f[b + off.rot_1]; y = f[b + off.rot_2]; z = f[b + off.rot_3]; }
    const n = Math.hypot(w, x, y, z) || 1;
    w /= n; x /= n; y /= n; z /= n;
    // R = rows of the rotation matrix
    const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
    const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
    const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
    // M = R * diag(s)  ->  C = M M^T
    const m00 = r00 * sx, m01 = r01 * sy, m02 = r02 * sz;
    const m10 = r10 * sx, m11 = r11 * sy, m12 = r12 * sz;
    const m20 = r20 * sx, m21 = r21 * sy, m22 = r22 * sz;
    covA[i * 3] = m00 * m00 + m01 * m01 + m02 * m02;
    covA[i * 3 + 1] = m00 * m10 + m01 * m11 + m02 * m12;
    covA[i * 3 + 2] = m00 * m20 + m01 * m21 + m02 * m22;
    covB[i * 3] = m10 * m10 + m11 * m11 + m12 * m12;
    covB[i * 3 + 1] = m10 * m20 + m11 * m21 + m12 * m22;
    covB[i * 3 + 2] = m20 * m20 + m21 * m21 + m22 * m22;
  }
  return { count, pos, col, covA, covB, alpha };
}

/* ---------------------------------------------------------------- shaders */

const VERT = /* glsl */ `
  precision highp float;
  attribute vec3 aPos;
  attribute vec3 aColor;
  attribute vec3 aCovA;   // Cxx, Cxy, Cxz
  attribute vec3 aCovB;   // Cyy, Cyz, Czz
  attribute float aAlpha;

  uniform vec2 uViewport;   // device pixels
  uniform vec3 uFocal;      // fx, fy, 0

  varying vec3 vColor;
  varying float vAlpha;
  varying vec2 vPos;
  varying vec3 vDir;

  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vPos = position.xy * 2.0;         // corner quad is [-1,1] -> [-2,2] sigma
    vDir = normalize(aPos - cameraPosition);

    vec4 vc = viewMatrix * vec4(aPos, 1.0);
    if (vc.z > -0.02) {               // behind the camera
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    float z = vc.z;

    // Jacobian of the perspective projection at this point
    vec3 J1 = vec3(uFocal.x / z, 0.0, -uFocal.x * vc.x / (z * z));
    vec3 J2 = vec3(0.0, uFocal.y / z, -uFocal.y * vc.y / (z * z));
    mat3 Jm = mat3(J1, J2, vec3(0.0));
    mat3 Vrk = mat3(aCovA.x, aCovA.y, aCovA.z,
                    aCovA.y, aCovB.x, aCovB.y,
                    aCovA.z, aCovB.y, aCovB.z);
    mat3 T = transpose(mat3(viewMatrix)) * Jm;
    mat3 C2 = transpose(T) * Vrk * T;

    // 2x2 eigen-decomposition (closed form) + low-pass filter
    float a = C2[0][0] + 0.3;
    float b = C2[1][0];
    float d = C2[1][1] + 0.3;
    float mid = 0.5 * (a + d);
    float diff = sqrt(max(0.1, mid * mid - (a * d - b * b)));
    float l1 = mid + diff;
    float l2 = mid - diff;
    float th = 0.5 * atan(2.0 * b, a - d);
    vec2 v1 = vec2(cos(th), sin(th)) * sqrt(l1);
    vec2 v2 = vec2(-sin(th), cos(th)) * sqrt(l2);

    // the quad must span 2 sigma (the fragment discards past r = 2), so the
    // offset is doubled here — without it every splat renders at half size and
    // the surface reads as dark slivers
    vec4 clip = projectionMatrix * vc;
    vec2 offset = 2.0 * (position.x * v1 + position.y * v2);
    clip.xy += offset * 2.0 / uViewport * clip.w;
    gl_Position = clip;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec2 vPos;
  varying vec3 vDir;

  uniform float uOpacity;    // global layer opacity (crossfade tests)
  uniform float uUseMask;    // 1 = hole-fill: hide where the photo is valid
  uniform sampler2D uMask;   // low-res ERP coverage of the translated view

  const float PI = 3.141592653589793;

  void main() {
    float A = -dot(vPos, vPos);      // exp(-r^2), r in sigma units
    if (A < -4.0) discard;

    // HOLE-FILL: the photograph keeps every direction it can still explain;
    // the splat is painted only into the wedges it never saw. This is why the
    // view stays sharp while moving instead of crossfading into a 500k-splat
    // layer.
    if (uUseMask > 0.5) {
      vec2 uv = vec2(atan(vDir.x, vDir.z) / (2.0 * PI) + 0.5,
                     acos(clamp(vDir.y, -1.0, 1.0)) / PI);
      if (texture2D(uMask, uv).r > 0.5) discard;
    }

    float a = exp(A) * vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

/* ------------------------------------------------------------------ build */

export function createSplat(splat, { pixelRatio = 1 } = {}) {
  const n = splat.count;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute("aPos", new THREE.InstancedBufferAttribute(splat.pos, 3));
  geo.setAttribute("aColor", new THREE.InstancedBufferAttribute(splat.col, 3));
  geo.setAttribute("aCovA", new THREE.InstancedBufferAttribute(splat.covA, 3));
  geo.setAttribute("aCovB", new THREE.InstancedBufferAttribute(splat.covB, 3));
  geo.setAttribute("aAlpha", new THREE.InstancedBufferAttribute(splat.alpha, 1));
  geo.instanceCount = n;

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    uniforms: {
      uViewport: { value: new THREE.Vector2(1, 1) },
      uFocal: { value: new THREE.Vector3(1, 1, 0) },
      uOpacity: { value: 1 },
      uUseMask: { value: 0 },
      uMask: { value: new THREE.DataTexture(new Uint8Array([0]), 1, 1) },
    },
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.name = "splat";
  Object.assign(mesh.userData, {
    splat,
    pixelRatio,
    order: new Uint32Array(n),
    bins: new Uint16Array(n),
    counts: new Uint32Array(2049),
    scratch: [new Float32Array(3 * n), new Float32Array(3 * n),
              new Float32Array(3 * n), new Float32Array(3 * n), new Float32Array(n)],
  });
  return mesh;
}

/** Keep focal length and viewport in device pixels (call on resize). */
export function syncSplatUniforms(mesh, camera, renderer) {
  if (!mesh || !mesh.material.uniforms || !mesh.material.uniforms.uFocal) return;
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const W = Math.max(1, Math.round(size.x * pr));
  const H = Math.max(1, Math.round(size.y * pr));
  const fovY = (camera.fov * Math.PI) / 180;
  const fy = H / (2 * Math.tan(fovY / 2));
  const fx = fy / Math.max(camera.aspect, 1e-6) * camera.aspect;  // square pixels
  mesh.material.uniforms.uViewport.value.set(W, H);
  mesh.material.uniforms.uFocal.value.set(fx, fy, 0);
}

/**
 * Counting sort far -> near, then reorder the instance attributes in place.
 * Returns the milliseconds spent (the caller decides how often to call it).
 */
export function sortSplat(mesh, camera) {
  const t0 = performance.now();
  const ud = mesh.userData;
  const splat = ud.splat;
  const n = splat.count;
  const pos = splat.pos;

  camera.updateMatrixWorld();
  const e = camera.matrixWorldInverse.elements;   // column-major
  // view-space depth d = -(m20*x + m21*y + m22*z + m23)  (larger = farther)
  let minD = Infinity, maxD = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const d = -(e[2] * x + e[6] * y + e[10] * z + e[14]);
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  const span = Math.max(1e-3, maxD - minD);
  const BINS = 2047;
  const counts = ud.counts;
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const d = -(e[2] * x + e[6] * y + e[10] * z + e[14]);
    const b = Math.min(BINS, Math.max(0, ((d - minD) / span) * BINS | 0));
    ud.bins[i] = b;
    counts[b + 1]++;
  }
  for (let i = 1; i <= BINS + 1; i++) counts[i] += counts[i - 1];

  const order = ud.order;
  for (let i = 0; i < n; i++) order[counts[ud.bins[i]]++] = i;

  // rewrite instance attributes in sorted order
  const [np, nc, nA, nB, na] = ud.scratch;
  const col = splat.col, covA = splat.covA, covB = splat.covB, alpha = splat.alpha;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    np[k * 3] = pos[i * 3]; np[k * 3 + 1] = pos[i * 3 + 1]; np[k * 3 + 2] = pos[i * 3 + 2];
    nc[k * 3] = col[i * 3]; nc[k * 3 + 1] = col[i * 3 + 1]; nc[k * 3 + 2] = col[i * 3 + 2];
    nA[k * 3] = covA[i * 3]; nA[k * 3 + 1] = covA[i * 3 + 1]; nA[k * 3 + 2] = covA[i * 3 + 2];
    nB[k * 3] = covB[i * 3]; nB[k * 3 + 1] = covB[i * 3 + 1]; nB[k * 3 + 2] = covB[i * 3 + 2];
    na[k] = alpha[i];
  }
  pos.set(np); col.set(nc); covA.set(nA); covB.set(nB); alpha.set(na);

  const g = mesh.geometry.attributes;
  g.aPos.needsUpdate = true;
  g.aColor.needsUpdate = true;
  g.aCovA.needsUpdate = true;
  g.aCovB.needsUpdate = true;
  g.aAlpha.needsUpdate = true;
  return performance.now() - t0;
}

/** Back-compat helper: the pixel-per-metre factor at the current viewport. */
export function splatScaleFor(camera, renderer) {
  const size = renderer.getSize(new THREE.Vector2());
  const h = Math.round(size.y * renderer.getPixelRatio());
  return h / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
