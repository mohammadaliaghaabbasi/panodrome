/* Panodrome VQ 1.1 — Visual Quality test harness (branch engine-upgrade-v1)
 * THREE INDEPENDENT MODES for layer attribution:
 *   pano  = immutable 4K equirect sphere ONLY  (reference sharpness)
 *   splat = SPZ gaussian splat ONLY            (true coverage / holes / dots)
 *   both  = pano backdrop + splat crossfade    (shipped composite behavior)
 * Plus: deterministic capture API, perf marks (fetch vs parse vs first frame),
 * and an in-page autotest battery for real iPhone Safari runs.
 * The original lab app.js / index.html are NOT modified. */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const Q = new URLSearchParams(location.search);
const scene  = Q.get('scene') || 'cabin';
const GEN    = Q.get('gen') || 'v12';         // v12 (VQ 1.2 content upgrade) | v11 | v1
let   MODE   = Q.get('mode') || 'both';          // pano | splat | both
const BG     = Q.get('bg') || 'black';           // splat-mode background
let   BLEND  = Q.get('blend') || 'auto';
const FADE_MS = parseFloat(Q.get('fade') || '350');
/* VQ 1.2 (2026-11-11, Marble §7 program on real content): ~521-530k splats,
 * anisotropic surface-adhering gaussians, fog-cull at the measured 45 m
 * (DAV2 clip plateau), tangent sigma capped at each splat's own source-pixel
 * size, SPZ ~5.3-6.0 MB (Marble 500k class). LoD available via Spark's in-app
 * build (?lod=1) — MEASURED 2026-11-11: the in-app LoD build does NOT complete
 * on the 2-core SwiftShader sandbox profile (splats stay 0 past 120 s), so the
 * default is OFF until verified on a real device; honest default = what we
 * verified. Renderer/format/locks untouched (three 0.180.0 + Spark 2.4.0). */
const LOD    = Q.get('lod') || '0';
/* NEW RULE 2026-11-07 (EQL / data confidence): envelope numbers come from MEASUREMENT.
 * Measured ladder on real content (Moradi set): PRIME 0.2–0.6 m · ACCEPTED 0.75 m ·
 * TRANSIT 1.0–1.3 m (small holes in mirror/wardrobe quadrants beyond 1.0 m).
 * Review/owner flow therefore clamps to the measured accepted envelope 0.75 m.
 * The full 1.3 m R&D ladder stays available via ?safeR=1.3, and the autotest
 * battery lifts SAFE_R by itself — the instrument is not degraded. */
let SAFE_R = parseFloat(Q.get('safeR') || '0.75');
const OFF0   = parseFloat(Q.get('offset') || '0');
const DIR0   = (Q.get('dir') || '+x').replace(/ /g, '+');
const LOOK0  = Q.get('look') || 'back';          // back | fwd | perp (rel. to travel dir)
const UI     = Q.get('ui') !== '0';
const AUTOTEST = Q.get('autotest') === '1';
const DEMO   = Q.get('demo') === '1';   // auto-run the 4-dir diamond walk once on load

const ERR = [];
window.__vqErrors = ERR;
window.addEventListener('error', e => { ERR.push(String(e.message || e)); showErr(); });
window.addEventListener('unhandledrejection', e => { ERR.push('reject: ' + String(e.reason)); showErr(); });
function showErr() {
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = '⚠ ' + ERR.slice(-4).join('\n⚠ ');
}

/* ---------- perf marks (T=0 at module eval) ---------- */
const T0 = performance.now();
const MARKS = { boot: 0 };
function mark(name, t) { MARKS[name] = Math.round(t !== undefined ? t : performance.now() - T0); }

/* ---------- renderer / scene / camera (identical recipe to app.js) ---------- */
/* preserveDrawingBuffer: deterministic in-page captures (toDataURL) — test harness
 * only; the original lab app.js is untouched. */
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 3));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene3d = new THREE.Scene();
if (MODE === 'splat' && BG === 'magenta') scene3d.background = new THREE.Color(0xff00ff);
else scene3d.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 1200);
camera.rotation.order = 'YXZ';
let yaw = -Math.PI / 2, pitch = -0.03;

const DIRV = { '+x': [1,0,0], '-x': [-1,0,0], '+z': [0,0,1], '-z': [0,0,-1] };
function yawToward(f) { return Math.atan2(-f[0], -f[2]); }
function lookDirOf(dirName, lookName) {
  const D = DIRV[dirName] || DIRV['+x'];
  if (lookName === 'fwd')  return D;
  if (lookName === 'perp') return [D[2], 0, -D[0]];       // left of travel
  return [-D[0], 0, -D[2]];                               // back (default)
}
if (OFF0 > 0 && DIRV[DIR0]) { const f = lookDirOf(DIR0, LOOK0); yaw = yawToward(f); }

/* ---------- layer A: pano sphere (NOT created in splat mode) ---------- */
let panoMat = null, panoMesh = null;
let panoTexReady = false;
if (MODE !== 'splat') {
  const texLoad0 = performance.now();
  const tex = await new THREE.TextureLoader().loadAsync(`../../assets/panoramas/${scene}.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  mark('pano_tex_ms', performance.now() - texLoad0);
  panoTexReady = true;
  const geo = new THREE.SphereGeometry(500, 128, 96);
  panoMat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, toneMapped: false, transparent: false, opacity: 1 });
  panoMesh = new THREE.Mesh(geo, panoMat);
  panoMesh.frustumCulled = false;
  panoMesh.renderOrder = -100;
  scene3d.add(panoMesh);
}

/* ---------- layer B: SPZ splat ---------- */
const spark = new SparkRenderer({ renderer });
scene3d.add(spark);
/* SPZ resolution with existence check + generation fallback (v12 -> v11 -> v1).
 * Rationale (owner review 2026-11-07): a missing generation must NEVER silently
 * degrade to pano-only — that reads as "previous engine". HEAD the candidates,
 * prefer the requested one, fall back down the chain, surface the truth in the
 * HUD + stats (genActual). */
const GEN_CHAIN = {
  v12: [`assets/${scene}_splat_v12.spz`, `assets/${scene}_splat_v11.spz`, `assets/${scene}_splat.spz`],
  v11: [`assets/${scene}_splat_v11.spz`, `assets/${scene}_splat.spz`, `assets/${scene}_splat_v12.spz`],
  v1:  [`assets/${scene}_splat.spz`, `assets/${scene}_splat_v11.spz`, `assets/${scene}_splat_v12.spz`],
};
const SPZ_CANDIDATES = GEN_CHAIN[GEN] || GEN_CHAIN.v12;
let SPZ_URL = SPZ_CANDIDATES[0];
let GEN_ACTUAL = GEN;
try {
  const headT = performance.now();
  let found = false;
  for (const u of SPZ_CANDIDATES) {
    const r = await fetch(u, { method: 'HEAD' });
    if (r.ok) {
      if (u !== SPZ_CANDIDATES[0]) {
        SPZ_URL = u;
        GEN_ACTUAL = u.includes('_v12.') ? 'v12' : u.includes('_v11.') ? 'v11' : 'v1';
      }
      found = true; break;
    }
  }
  mark('spz_head_ms', performance.now() - headT);
  if (!found) { ERR.push(`SPZ not found for scene "${scene}" (v12/v11/v1 all checked)`); showErr(); }
} catch { /* HEAD unsupported on this server — keep the default candidate */ }
const constructT = performance.now();
let spzReadyMs = null, splatCount = 0;
const splat = new SplatMesh({
  url: SPZ_URL,
  lod: LOD === '1',                     // VQ 1.2: Spark in-app LoD (smooth motion)
  onLoad: () => { spzReadyMs = performance.now() - constructT; mark('spz_ready_ms', spzReadyMs);
    try { splatCount = splat.splats?.getNumSplats?.() ?? (typeof splat.numSplats === 'number' ? splat.numSplats : -1); }
    catch { splatCount = -1; } },
});
splat.opacity = 1;
scene3d.add(splat);

/* ---------- mode switching (three INDEPENDENT modes) ---------- */
function setBg(name) {
  scene3d.background.set(name === 'magenta' ? 0xff00ff : 0x000000);
}
function applyMode(m) {
  if (m !== 'pano' && m !== 'splat' && m !== 'both') return;   // guard: walkbtn & foreign clicks must never blank the screen
  MODE = m;
  if (panoMesh) panoMesh.visible = (m === 'pano' || m === 'both');
  splat.visible = (m === 'splat' || m === 'both');
  if (m === 'splat') { splat.opacity = 1; }
  if (m === 'pano')  { splat.opacity = 0; }
  for (const b of document.querySelectorAll('#modes button[data-mode]'))
    b.classList.toggle('on', b.dataset.mode === m);
}
applyMode(MODE);
if (!UI) { for (const id of ['hud','dpad','badge','modes']) document.getElementById(id).style.display = 'none'; }
for (const b of document.querySelectorAll('#modes button[data-mode]'))
  b.addEventListener('click', () => { if (MODE !== 'both' || b.dataset.mode !== 'both') { applyMode(b.dataset.mode); if (b.dataset.mode === 'both') { BLEND = '1'; forceBlend(1); } } });

/* ---------- navigation (identical to app.js) ---------- */
const pos = new THREE.Vector3();
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
const MOVE_MPS = 0.9;
function step(dt) {
  let f = 0, r = 0;
  if (keys['ArrowUp'] || keys['w'] || keys['W'] || padKeys.fwd)  f += 1;
  if (keys['ArrowDown'] || keys['s'] || keys['S'] || padKeys.back) f -= 1;
  if (keys['ArrowRight'] || keys['d'] || keys['D'] || padKeys.right) r += 1;
  if (keys['ArrowLeft'] || keys['a'] || keys['A'] || padKeys.left)  r -= 1;
  if (!f && !r) return;
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const v = fwd.multiplyScalar(f).add(right.multiplyScalar(r));
  if (v.lengthSq() > 0) v.normalize().multiplyScalar(MOVE_MPS * dt);
  pos.add(v);
  const d = Math.hypot(pos.x, pos.z);
  if (d > SAFE_R) pos.multiplyScalar(SAFE_R / d);
}

/* ---------- blend (both-mode only; identical math to app.js) ---------- */
let sCur = parseFloat(BLEND), sTarget = sCur;
if (isNaN(sCur)) { sCur = 0; sTarget = 0; }
function forceBlend(v) { sCur = sTarget = v; splat.opacity = v; splat.visible = v > 0.003 && MODE !== 'pano'; }
/* 2026-11-12 FIX (owner report: "moving makes the whole view blurry").
 * The old rule faded the splat to FULL opacity after 5 cm of walking, so the
 * 4K photograph (8.4 MP) was replaced by ~520k gaussians — a 1/16 sample rate,
 * i.e. softness by construction, even though the photograph was still valid.
 *
 * New rule, same policy as the walkable-truth engine (docs/17 Lane C): while
 * the camera is inside the MEASURED walk budget the photograph is authoritative
 * and the splat is NOT shown at all (0 % invented, 100 % sharp). Past the
 * budget the photograph can no longer explain the view, so the splat fades in
 * over HOLD_RAMP metres instead of popping.
 *
 *   ?hold=0.75  override the budget   ?holdramp=0.45  fade length
 *   ?fill=1     old behaviour (splat everywhere) for A/B comparison
 */
function updateBlend(dt, dist) {
  if (MODE !== 'both') return;
  const b = parseFloat(BLEND);
  if (!isNaN(b)) sTarget = Math.max(0, Math.min(1, b));
  else if (BLEND === 'auto') {
    const FILL = new URLSearchParams(location.search).get('fill') === '1';
    const HOLD = parseFloat(new URLSearchParams(location.search).get('hold') || String(SAFE_R));
    const RAMP = Math.max(0.05, parseFloat(new URLSearchParams(location.search).get('holdramp') || '0.45'));
    if (FILL) sTarget = dist < 0.05 ? 0 : 1;
    else sTarget = dist <= HOLD ? 0 : Math.min(1, (dist - HOLD) / RAMP);
  }
  const k = 1 - Math.exp(-dt * (1000 / FADE_MS) * 3);
  sCur += (sTarget - sCur) * k;
  if (Math.abs(sTarget - sCur) < 0.002) sCur = sTarget;
  splat.opacity = sCur;
  splat.visible = sCur > 0.003;
}

/* ---------- loop + frame stats ---------- */
const frameMs = [];
let firstFrameMs = null;
let last = performance.now();
let walking = false;                       // autotest walks via waypoints
let walkPath = null;
let frozen = false;
const hud = document.getElementById('hud');
function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  step(dt);
  if (walkPath) walkStep(dt);
  const dist = Math.hypot(pos.x, pos.z);
  updateBlend(dt, dist);
  camera.position.set(pos.x, 0, pos.z);
  camera.rotation.set(pitch, yaw, 0);
  renderer.render(scene3d, camera);
  if (firstFrameMs === null) { firstFrameMs = performance.now() - T0; mark('first_frame_ms', firstFrameMs); }
  frameMs.push(dt * 1000);
  if (frameMs.length > 2400) frameMs.shift();
}
renderer.setAnimationLoop(tick);
function freeze(on) {                        // deterministic captures: pause rAF loop
  if (on && !frozen) { frozen = true; renderer.setAnimationLoop(null); renderer.render(scene3d, camera); }
  else if (!on && frozen) { frozen = false; last = performance.now(); renderer.setAnimationLoop(tick); }
}
function fpsStats(from = 0) {
  const s = frameMs.slice(from).sort((a, b) => a - b);
  if (s.length < 5) return { fps: 0, p50ms: 0, p95ms: 0, p99ms: 0, n: s.length };
  const q = p => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { fps: +(1000 / (s.reduce((a, b) => a + b, 0) / s.length)).toFixed(1),
           p50ms: +q(0.5).toFixed(1), p95ms: +q(0.95).toFixed(1), p99ms: +q(0.99).toFixed(1), n: s.length };
}
setInterval(() => {
  if (!UI) return;
  const f = fpsStats();
  const dist = Math.hypot(pos.x, pos.z);
  const heap = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : 'n/a';
  hud.textContent =
`PANODROME VQ 1.2 — ${scene} · gen ${GEN}${GEN_ACTUAL !== GEN ? '→' + GEN_ACTUAL + ' (fallback)' : ''} · mode ${MODE}
splats: ${splatCount || '…'} | spz ready: ${spzReadyMs == null ? '…' : Math.round(spzReadyMs) + ' ms'} | first frame: ${firstFrameMs == null ? '…' : Math.round(firstFrameMs) + ' ms'}
fps: ${f.fps.toFixed(1)} | frame p95: ${f.p95ms.toFixed(1)} ms | heap: ${heap}
pos: (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)}) | dist: ${dist.toFixed(2)} / safe ${SAFE_R} m
blend splat: ${sCur.toFixed(3)} | fade τ: ${FADE_MS} ms | lod: ${LOD === '1' ? 'on' : 'off'} | errors: ${ERR.length}`;
}, 400);

/* ---------- deterministic walk (autotest + motion videos) ---------- */
function walkStep(dt) {
  if (!walkPath) return;
  const { points, mps, i, seg } = walkPath;
  if (i >= points.length - 1) { const done = walkPath.done; walkPath = null; walking = false; done(); return; }
  const a = points[i], b = points[i + 1];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) { walkPath.i++; walkPath.seg = 0; return; }
  walkPath.seg += mps * dt;
  const t = Math.min(1, walkPath.seg / len);
  pos.set(a[0] + dx * t, 0, a[1] + dz * t);
  if (t >= 1) { walkPath.i++; walkPath.seg = 0; }
}
function runWalkPath(points, mps = MOVE_MPS) {
  return new Promise(res => { walking = true; walkPath = { points, mps, i: 0, seg: 0, done: res }; });
}

/* ---------- resource timing (network attribution: fetch vs parse) ---------- */
function resourceStats() {
  const out = [];
  for (const e of performance.getEntriesByType('resource')) {
    if (/\.spz($|\?)/.test(e.name) || /panoramas\/.*\.jpg($|\?)/.test(e.name) || /spark\.module|three.*module/.test(e.name)) {
      out.push({ file: e.name.split('/').pop().slice(0, 40),
        fetch_ms: Math.round(e.duration),
        transfer_kb: e.transferSize ? Math.round(e.transferSize / 1024) : null,
        ttfb_ms: Math.round(e.responseStart - e.startTime) });
    }
  }
  return out;
}

/* ---------- public capture API ---------- */
window.__vq = {
  ready: true, mode: MODE, gen: GEN, scene,
  splat,
  stats() {
    const f = fpsStats();
    const dist = Math.hypot(pos.x, pos.z);
    return {
      scene, gen: GEN, genActual: GEN_ACTUAL, mode: MODE, splats: splatCount, lod: LOD === '1',
      spzReadyMs: spzReadyMs == null ? null : Math.round(spzReadyMs),
      firstFrameMs: firstFrameMs == null ? null : Math.round(firstFrameMs),
      marks: { ...MARKS }, resources: resourceStats(),
      fps: f.fps, frameP95Ms: f.p95ms, frameP99Ms: f.p99ms,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      pos: [+pos.x.toFixed(3), +pos.z.toFixed(3)], dist: +dist.toFixed(3),
      view: [+yaw.toFixed(3), +pitch.toFixed(3)],
      blend: +sCur.toFixed(3), safeR: SAFE_R, fadeMs: FADE_MS, errors: ERR.length,
    };
  },
  applyMode,
  setOffset(dir, m) { pos.set(0, 0, 0); if (DIRV[dir]) pos.fromArray(DIRV[dir]).multiplyScalar(m); },
  lookToward(dir) { const f = DIRV[dir]; if (f) { yaw = yawToward(f); pitch = 0; } },
  setLook(y, p) { yaw = y; pitch = p; },
  lockBlend(v) { BLEND = String(v); forceBlend(v); return BLEND; },
  setBg,
  state(o = {}) {                // one-call deterministic reconfiguration
    if (o.bg) setBg(o.bg);
    if (o.dir && DIRV[o.dir]) {
      pos.set(0, 0, 0);
      if (o.offset != null) pos.fromArray(DIRV[o.dir]).multiplyScalar(o.offset);
    }
    if (o.mode) applyMode(o.mode);
    if (o.look && o.dir) {
      const f = lookDirOf(o.dir, o.look);
      yaw = yawToward(f); pitch = o.pitch ?? 0;
    } else if (o.lookToward && DIRV[o.lookToward]) {
      yaw = yawToward(DIRV[o.lookToward]); pitch = o.pitch ?? 0;
    }
    if (o.blend != null) { BLEND = String(o.blend); forceBlend(o.blend); }
    renderer.render(scene3d, camera);
    return window.__vq.stats();
  },
  freeze(on = true) { freeze(on); },
  settleState(state, min_ms = 12000, timeout_ms = 25000) {
    /* Deterministic capture support for headless GL: Spark's async depth sort
     * renders only the background for ~10 s after a camera MOVE in software
     * GL (ms on real GPUs). Per-frame render noise makes pixel-hash stability
     * impossible, so settle = (a) wait min_ms (>= the measured sort time for
     * moves, ~1 s for mode-only changes) and (b) probe that real content
     * (>50% of pixels differ from the background colour) is on screen. */
    const c = document.querySelector('canvas');
    const probe = () => {
      const t = document.createElement('canvas'); t.width = 40; t.height = 80;
      const x = t.getContext('2d');
      x.fillStyle = '#010203'; x.fillRect(0, 0, 40, 80);
      x.drawImage(c, 0, 0, c.width, c.height, 0, 0, 40, 80);
      const d = x.getImageData(0, 0, 40, 80).data;
      const bg = (state.bg === 'magenta') ? [255, 0, 255] : [0, 0, 0];
      let content = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i+1] - bg[1]) + Math.abs(d[i+2] - bg[2]) > 90) content++;
        n++;
      }
      return content / n;
    };
    this.state(state);
    return new Promise(res => {
      const t0 = performance.now();
      const tick = () => {
        const content = probe();
        const waited = performance.now() - t0;
        if (waited >= min_ms && content > 0.5) return res({ settled: true, ms: Math.round(waited), content: +content.toFixed(2) });
        if (waited > timeout_ms) return res({ settled: false, ms: Math.round(waited), content: +content.toFixed(2) });
        setTimeout(tick, 400);
      };
      setTimeout(tick, Math.min(min_ms, 800));
    });
  },
  snap(fmt = 'png') {         // full-DPR deterministic frame grab (data URL)
    renderer.render(scene3d, camera);
    return renderer.domElement.toDataURL('image/' + fmt, 0.95);
  },
  snapTimed(fmt = 'jpeg') {   // profiling: render vs encode split
    const t0 = performance.now();
    renderer.render(scene3d, camera);
    const t1 = performance.now();
    const url = renderer.domElement.toDataURL('image/' + fmt, 0.95);
    const t2 = performance.now();
    return { render_ms: +(t1 - t0).toFixed(0), encode_ms: +(t2 - t1).toFixed(0),
             bytes: url.length, url };
  },
  runWalkPath,
  hideUI() { for (const id of ['hud','dpad','badge','modes']) document.getElementById(id).style.display = 'none'; },
};

/* ---------- one-click walk demo (owner review 2026-11-07): diamond 0-0.75-0 m, 4 dirs ---------- */
{
  const b = document.getElementById('walkbtn');
  if (b) b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true; b.textContent = '🚶 …';
    const R = Math.min(SAFE_R, 0.75);
    await runWalkPath([[0,0],[R,0],[0,0],[0,R],[0,0],[-R,0],[0,0],[0,-R],[0,0]], MOVE_MPS);
    b.disabled = false; b.textContent = '🚶 Walk ' + (+R.toFixed(2)) + 'm';   // honest label: the radius actually walked
  });
}

/* ---------- auto-demo (owner review 2026-11-07): enter → the engine shows itself ---------- */
/* demo=1 — once the SPZ is ready, run the 4-direction diamond walk ONCE so the
 * new-engine behaviour is visible in the first seconds: rest = sharp 4K pano,
 * moving = 3D splat layer with the 350 ms soft fade. Then full control returns
 * to the user (WASD / d-pad / drag). Never fights the autotest battery. */
if (DEMO && !AUTOTEST) (async () => {
  const note = document.createElement('div');
  note.dir = 'rtl';
  note.style.cssText =
    'position:fixed;bottom:170px;left:50%;transform:translateX(-50%);z-index:8;' +
    'max-width:min(92vw,560px);padding:10px 16px;border-radius:12px;' +
    'background:rgba(0,24,14,.9);border:1px solid rgba(87,230,164,.5);color:#d7f5e6;' +
    'font:13px/1.75 Vazirmatn,Tahoma,sans-serif;text-align:center;cursor:pointer;' +
    'box-shadow:0 4px 22px rgba(0,0,0,.45);transition:opacity .6s ease;opacity:0';
  note.textContent = '⏳ در حال بارگذاری موتور VQ 1.2…';
  document.body.appendChild(note);
  requestAnimationFrame(() => { note.style.opacity = '1'; });
  const hide = () => { note.style.opacity = '0'; setTimeout(() => note.remove(), 700); };
  note.addEventListener('click', hide);
  for (let i = 0; i < 300 && spzReadyMs == null; i++) await new Promise(r => setTimeout(r, 100));
  if (spzReadyMs == null) {
    note.textContent = '⚠ اسپلت بارگذاری نشد — فقط پانو نمایش داده می‌شود (موتور جدید نیامده)';
    setTimeout(hide, 4000); return;
  }
  note.textContent = '🚶 دموی خودکار موتور V1.2 — ایست: پانوی 4K · هنگام حرکت: لایهٔ اسپلت سه‌بعدی (۵۲۹٬۳۹۶ اسپلت سطح‌چسب) با محو نرم ۳۵۰ms';
  await new Promise(r => setTimeout(r, 900));
  const b = document.getElementById('walkbtn');
  if (b && !b.disabled) b.click();            // same 4-dir diamond as the button
  setTimeout(hide, 11000);
})();

/* ---------- autotest battery (real iPhone Safari) ---------- */
if (AUTOTEST) (async () => {
  const rep = document.getElementById('report'), txt = document.getElementById('rep-json');
  const log = s => { document.getElementById('rep-txt').textContent = s; };
  rep.style.display = 'flex';
  log('VQ 1.1 autotest — waiting for splat load…');
  for (let i = 0; i < 200 && spzReadyMs == null; i++) await new Promise(r => setTimeout(r, 100));
  log('VQ 1.1 autotest — 10 s idle measurement…');
  frameMs.length = 0;
  await new Promise(r => setTimeout(r, 10000));
  const idle = fpsStats();
  log('VQ 1.1 autotest — walking battery (4 directions, out & back)…');
  frameMs.length = 0;
  applyMode('both'); BLEND = 'auto';
  SAFE_R = Math.max(SAFE_R, 1.3);   // R&D instrument: always walk the FULL measured ladder (0.75 default is the review envelope, not the battery's)
  const R = Math.min(SAFE_R, 1.3);
  await runWalkPath([[0,0],[R,0],[0,0],[0,R],[0,0],[-R,0],[0,0],[0,-R],[0,0]], MOVE_MPS);
  const walk = fpsStats();
  const s = window.__vq.stats();
  const nav = performance.getEntriesByType('navigation')[0];
  const report = {
    test: 'panodrome_vq11_autotest', scene, gen: GEN, when: new Date().toISOString(),
    device: { ua: navigator.userAgent, dpr: devicePixelRatio, screen: `${screen.width}x${screen.height}`,
              viewport: `${innerWidth}x${innerHeight}`, cores: navigator.hardwareConcurrency || null,
              memGB: navigator.deviceMemory || null },
    timings_ms: { ...s.marks, spz_ready: s.spzReadyMs, first_frame: s.firstFrameMs,
                  domContentLoaded: Math.round(nav ? nav.domContentLoadedEventEnd : -1),
                  page_load: Math.round(nav ? nav.loadEventEnd : -1) },
    network: s.resources,
    perf: { idle, walk, walk_path_m: R },
    blend_final: s.blend, errors: ERR,
    heap: performance.memory ? { usedMB: s.heapMB, limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576) } : 'unavailable (Safari)',
  };
  txt.value = JSON.stringify(report, null, 1);
  log('VQ 1.1 autotest DONE — copy the JSON below and send it back.');
  document.getElementById('rep-copy').onclick = () => navigator.clipboard?.writeText(txt.value);
  document.getElementById('rep-close').onclick = () => rep.style.display = 'none';
})();
