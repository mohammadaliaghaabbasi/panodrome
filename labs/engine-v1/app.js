/* Panodrome Engine V1.0 — isolated Spark compositor lab (PHASE 4/5/6)
 * Layers: A) immutable 4K equirect pano sphere (room.js recipe, BackSide, toneMapped:false)
 *         B) CPU-generated SPZ gaussian splat (our engine output)
 *         C) navigation: safe-radius clamped movement + crossfade + pointer look
 * Never modifies production assets; three 0.180 + Spark 2.4.0 vendored for this page only. */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const Q = new URLSearchParams(location.search);
const scene  = Q.get('scene') || 'cabin';
const PANO   = Q.get('pano') !== '0';
let BLEND  = Q.get('blend') || 'auto';        // auto | 0 | 1 | <any value> — mutable via __lab.lockBlend
const FADE_MS = parseFloat(Q.get('fade') || '350');
const SAFE_R = parseFloat(Q.get('safeR') || '1.3');
const OFF0   = parseFloat(Q.get('offset') || '0');
const DIR0   = (Q.get('dir') || '+x').replace(/ /g, '+');   // URL '+' decodes to space — restore it
const ERR = [];
window.__labErrors = ERR;
window.addEventListener('error', e => { ERR.push(String(e.message || e)); showErr(); });
window.addEventListener('unhandledrejection', e => { ERR.push('reject: ' + String(e.reason)); showErr(); });
function showErr() {
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = '⚠ ' + ERR.slice(-4).join('\n⚠ ');
}

/* ---------- renderer / scene / camera ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene3d = new THREE.Scene();
scene3d.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 1200);
camera.rotation.order = 'YXZ';
let yaw = -Math.PI / 2, pitch = -0.03;   // look toward -x (matches CPU renders / u=0 seam convention)

/* ---------- layer A: immutable 4K pano sphere (room.js recipe) ---------- */
let panoMat = null;
if (PANO) {
  const tex = await new THREE.TextureLoader().loadAsync(`../../assets/panoramas/${scene}.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.SphereGeometry(500, 128, 96);
  // OPAQUE backdrop — deterministic layering: the opaque pass always renders before
  // the splat transparent pass, so the splat composites OVER the pano (no sort ties).
  panoMat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, toneMapped: false, transparent: false, opacity: 1 });
  const mesh = new THREE.Mesh(geo, panoMat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;   // draw before everything
  scene3d.add(mesh);
}

/* ---------- layer B: SPZ splat via Spark ---------- */
const spark = new SparkRenderer({ renderer });
scene3d.add(spark);
const loadStart = performance.now();
let loadMs = null, splatCount = 0;
const splat = new SplatMesh({
  url: `assets/${scene}_splat.spz`,
  onLoad: () => {
    loadMs = performance.now() - loadStart;
    try { splatCount = splat.splats?.getNumSplats?.() ?? (typeof splat.numSplats === 'number' ? splat.numSplats : -1); }
    catch { splatCount = -1; }
  },
});
splat.opacity = BLEND === '1' ? 1 : 0;
scene3d.add(splat);

/* ---------- layer C: navigation ---------- */
const pos = new THREE.Vector3();
const DIRV = { '+x': [1,0,0], '-x': [-1,0,0], '+z': [0,0,1], '-z': [0,0,-1] };
if (OFF0 > 0 && DIRV[DIR0]) pos.fromArray(DIRV[DIR0]).multiplyScalar(OFF0);

let drag = null;
renderer.domElement.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointermove', e => {
  if (!drag) return;
  yaw   -= (e.clientX - drag.x) * 0.0052;
  pitch -= (e.clientY - drag.y) * 0.0052;
  pitch = Math.max(-1.45, Math.min(1.45, pitch));
  drag = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', () => drag = null);
addEventListener('pointercancel', () => drag = null);

const keys = {};
addEventListener('keydown', e => keys[e.key] = true);
addEventListener('keyup', e => keys[e.key] = false);
const dpad = document.getElementById('dpad');
const padKeys = {};
for (const b of dpad.querySelectorAll('button')) {
  const mv = b.dataset.mv;
  b.addEventListener('pointerdown', () => padKeys[mv] = true);
  b.addEventListener('pointerup', () => padKeys[mv] = false);
  b.addEventListener('pointerleave', () => padKeys[mv] = false);
}
const MOVE_MPS = 0.9;                       // walking speed m/s (lab)
function step(dt) {
  let f = 0, r = 0;
  if (keys['ArrowUp'] || keys['w'] || keys['W'] || padKeys.fwd)  f += 1;
  if (keys['ArrowDown'] || keys['s'] || keys['S'] || padKeys.back) f -= 1;
  if (keys['ArrowRight'] || keys['d'] || keys['D'] || padKeys.right) r += 1;
  if (keys['ArrowLeft'] || keys['a'] || keys['A'] || padKeys.left)  r -= 1;
  if (!f && !r) return;
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));      // camera horizontal forward
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const v = fwd.multiplyScalar(f).add(right.multiplyScalar(r));
  if (v.lengthSq() > 0) v.normalize().multiplyScalar(MOVE_MPS * dt);
  pos.add(v);
  const d = Math.hypot(pos.x, pos.z);
  if (d > SAFE_R) pos.multiplyScalar(SAFE_R / d);                       // hard clamp: never leave tested region
}

/* ---------- crossfade: pano <-> splat, complementary alphas, no double exposure ---------- */
let sCur = BLEND === '1' ? 1 : 0;            // current splat blend
let sTarget = sCur;
const state = { mode: BLEND, offset0: pos.length() };
function updateBlend(dt, dist) {
  const b = parseFloat(BLEND);
  if (!isNaN(b)) sTarget = Math.max(0, Math.min(1, b));   // locked numeric blend (deterministic capture)
  else if (BLEND === 'auto') {
    // zone logic: pano is the main view at rest & beyond the safe radius;
    // the splat owns the view while actively walking inside the tested region.
    if (dist > SAFE_R + 1e-3) sTarget = 0;
    else if (dist < 0.05) sTarget = 0;          // at capture point -> pristine 4K pano
    else sTarget = 1;
  }
  const k = 1 - Math.exp(-dt * (1000 / FADE_MS) * 3);   // ~3 time-constants over FADE_MS
  sCur += (sTarget - sCur) * k;
  if (Math.abs(sTarget - sCur) < 0.002) sCur = sTarget;
  // compositor model: pano is the IMMUTABLE OPAQUE backdrop (never fades); the splat
  // layer alpha-crossfades on top. Splat coverage holes fall through to the 4K pano
  // (disocclusion filling) instead of black. Double exposure exists only during the
  // 350ms transition window (tunable param) — accepted by owner as starting point.
  splat.opacity = sCur;
  splat.visible = sCur > 0.003;
}

/* ---------- loop + stats ---------- */
const frameMs = [];
let last = performance.now();
const hud = document.getElementById('hud');
renderer.setAnimationLoop(now => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  step(dt);
  const dist = Math.hypot(pos.x, pos.z);
  updateBlend(dt, dist);
  camera.position.set(pos.x, 0, pos.z);
  camera.rotation.set(pitch, yaw, 0);
  renderer.render(scene3d, camera);
  frameMs.push(dt * 1000);
  if (frameMs.length > 90) frameMs.shift();
});
function fps() {
  if (frameMs.length < 5) return { fps: 0, p95: 0 };
  const s = frameMs.slice(-60).sort((a, b) => a - b);
  return { fps: 1000 / (s.reduce((a, b) => a + b, 0) / s.length), p95: s[Math.floor(s.length * 0.95)] };
}
setInterval(() => {
  const f = fps();
  const dist = Math.hypot(pos.x, pos.z);
  const heap = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : 'n/a';
  hud.textContent =
`PANODROME ENGINE V1.0 LAB — ${scene}
splats: ${splatCount || '…'} | spz load: ${loadMs ? Math.round(loadMs) + ' ms' : '…'}
fps: ${f.fps.toFixed(1)} | frame p95: ${f.p95.toFixed(1)} ms | heap: ${heap}
pos: (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)}) | dist: ${dist.toFixed(2)} / safe ${SAFE_R} m
blend splat: ${sCur.toFixed(3)} | pano: ${(panoMat ? panoMat.opacity : 0).toFixed(3)} | fade τ: ${FADE_MS} ms
view: yaw ${(yaw * 57.3).toFixed(0)}° pitch ${(pitch * 57.3).toFixed(0)}° | errors: ${ERR.length}`;
}, 400);

window.__lab = {
  ready: true,
  splat,
  stats() {
    const f = fps();
    return {
      scene, splats: splatCount, spzLoadMs: loadMs == null ? null : Math.round(loadMs),
      fps: +f.fps.toFixed(1), frameP95Ms: +f.p95.toFixed(1),
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      offset: +Math.hypot(pos.x, pos.z).toFixed(3), pos: [pos.x, pos.y, pos.z],
      view: [+yaw.toFixed(3), +pitch.toFixed(3)],
      blend: +sCur.toFixed(3), panoOpacity: panoMat ? +panoMat.opacity.toFixed(3) : 0,
      safeR: SAFE_R, fadeMs: FADE_MS, errors: ERR.length, gl2: !!renderer.capabilities.isWebGL2,
    };
  },
  setOffset(dir, m) { pos.set(0, 0, 0); if (DIRV[dir]) pos.fromArray(DIRV[dir]).multiplyScalar(m); },
  look(y, p) { yaw = y; pitch = p; },
  forceBlend(v) { sCur = sTarget = v; },
  lockBlend(v) { BLEND = (v === null ? 'auto' : String(v)); if (v !== null) sCur = sTarget = v; return BLEND; },
  crossfadeTest() {          // deterministic 0->1->0 sweep for PHASE 5 ghosting measurement
    return new Promise(res => {
      let t0 = null, phase = 0;
      const stepT = (now) => {
        if (t0 === null) t0 = now;
        const t = (now - t0) / (FADE_MS * 3);
        if (phase === 0) { sCur = Math.min(1, t); sTarget = 1; if (sCur >= 1) { phase = 1; t0 = null; } }
        else { sCur = Math.max(0, 1 - t); sTarget = 0; if (sCur <= 0) { sTarget = 0; res(this.stats()); return; } }
        requestAnimationFrame(stepT);
      };
      requestAnimationFrame(stepT);
    });
  },
  errors: ERR,
};
