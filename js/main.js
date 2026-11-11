/**
 * PANODROME — Stage 2.0 · main (ZERO-WARP ARCHITECTURE)
 * ============================================================================
 * Owner law 2026-11-03:
 *   · LAW 1 — the 10 360° pano rooms render on a pure SphereGeometry(500,
 *     128, 96) (room.js) — ZERO vertex displacement, forever.  The camera
 *     lives in a 0.08 m micro-parallax sphere around the capture point
 *     (controls.js "micro" mode); walking is a Matterport-style optical
 *     step-glide (FOV 72° ↔ 52°) over a VIRTUAL position that travels the
 *     real collision world.
 *   · LAW 2 — depth cues come from REAL 3D overlays inside the sphere: floor
 *     grid, footstep target ring, 3D glass furniture proxies (hotspots).
 *   · LAW 3 — Room #1 is a TRUE-3D .glb villa (modern_3d_villa) with full
 *     multi-metre 6DoF walking and exact Box3 furniture collision
 *     (controls.js "free" mode, fov LOCKED at 72°).
 *   · LAW 4 — honest verification: numeric straightness gates + screenshots
 *     (scripts/zerowarp_e2e.sh); no rubber judges.
 */
import * as THREE from "three";
import { i18n } from "./i18n.js";
import { buildRoomVolume, prefetchRoom } from "./room.js";
import { WalkingControls, FOV_BASE } from "./controls.js";
import { WalkWorld, WalkFX } from "./collider.js";
import { Waypoint, computeRoutes, projectToScreen, WALK_IN_DIST } from "./portals.js";
import { AudioEngine } from "./audio.js";
import { HUD } from "./hud.js";
import { Radar } from "./radar.js";

const state = {
  db: null,
  roomIdx: -1,
  room: null,
  meshObj: null,
  waypoint: null,
  world: null,
  fx: null,
  started: false,
  transitioning: false,
  mode: "architect",
  radarVisible: true,
  walkInArmedAt: 0,
};

let renderer, scene, camera, controls, hud, audio, radar;
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let hoveredWaypoint = false;
let hoveredProxy = null;
const isTouch = matchMedia("(pointer: coarse)").matches;

main();

async function main() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch (e) {
    document.getElementById("webgl-error").classList.remove("hud-hidden");
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // true-3D lights only —
  renderer.toneMappingExposure = 1.05;                   // the pano is toneMapped:false
  document.getElementById("scene").appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(FOV_BASE, innerWidth / innerHeight, 0.05, 1200);
  camera.rotation.order = "YXZ";

  hud = new HUD();
  audio = new AudioEngine();
  radar = new Radar(camera);

  const saved = localStorage.getItem("panodrome_lang");
  i18n.setLang(saved === "fa" ? "fa" : "en");

  try {
    const res = await fetch("data/rooms_db.json");
    if (!res.ok) throw new Error("rooms_db " + res.status);
    state.db = await res.json();
  } catch (e) {
    hud.el.loadText.textContent = "Could not load data/rooms_db.json — serve public/ over HTTP.";
    hud.showLoading(true);
    return;
  }

  controls = new WalkingControls(camera, renderer.domElement);
  controls.onClick = (x, y) => handleClick(x, y);
  controls.onDouble = (x, y) => handleDouble(x, y);
  controls.onStep = (material) => audio.step(material);
  controls.onBump = (bump) => handleBump(bump);

  hud.bindJoystick((v) => { controls.joy.x = v.x; controls.joy.y = v.y; });
  hud.setMuted(audio.muted);
  audio.onMuteChange = (m) => hud.setMuted(m);
  hud.onSoundToggle(() => audio.setMuted(!audio.muted));

  hud.initIntro(state.db.rooms[0].preview, onEnter);
  hud.onLangToggle(() => {
    const next = i18n.lang === "en" ? "fa" : "en";
    localStorage.setItem("panodrome_lang", next);
    i18n.setLang(next);
    if (state.room) hud.setRoom(state.room, state.roomIdx, state.db.rooms.length);
  });
  hud.onViewButton(() => {
    if (controls.moved) {
      controls.resetView();          // "بازگشت به مرکز فضا"
    } else {
      toggleFullscreen();
    }
  });
  hud.onNavigate((dir) => {
    const n = state.db.rooms.length;
    navigateTo((state.roomIdx + dir + n) % n);
  });
  hud.onModeChange((mode) => {
    if (mode === state.mode) return;
    state.mode = mode;
    hud.setMode(mode);
    retargetWaypoint();
  });
  hud.onWaypointChip(() => state.waypoint && warpThrough(state.waypoint));
  hud.onRadarToggle(() => {
    state.radarVisible = radar.toggleVisible();
    hud.el.btnRadar.classList.toggle("on", state.radarVisible);
  });
  hud.el.btnRadar.classList.toggle("on", true);

  renderer.domElement.addEventListener("pointermove", onPointerMove);
  addEventListener("resize", onResize);

  renderer.setAnimationLoop(tick);

  // test/debug hook (safe no-op in production)
  window.__panodrome = {
    state,
    camera,
    get controls() { return controls; },
    get hud() { return hud; },
    get world() { return state.world; },
    get audio() { return audio; },
    rooms: () => state.db.rooms,
    fov: () => Math.round(camera.fov * 100) / 100,
    fovMust: () => controls.fovMust,
    fovStats: () => ({
      cur: Math.round(camera.fov * 100) / 100,
      base: controls.fovMust,
      minSeen: Math.round(controls.minFovSeen * 100) / 100,
      maxSeen: Math.round(controls.maxFovSeen * 100) / 100,
    }),
    mode: () => controls.mode,
    pos: () => [camera.position.x, camera.position.y, camera.position.z].map((v) => Math.round(v * 1000) / 1000),
    virtualPos: () => [controls.pos.x, controls.pos.z].map((v) => Math.round(v * 1000) / 1000),
    offsetFromOrigin: () => Math.round(controls.cameraOffset() * 10000) / 10000,
    maxOffsetSeen: () => Math.round(controls.maxOffsetSeen * 10000) / 10000,
    movedFromStart: () => Math.hypot(controls.pos.x - controls.start.x, controls.pos.z - controls.start.z),
    travelled: () => Math.round(controls.travelled * 100) / 100,
    roomStats: () => {
      if (!state.meshObj) return null;
      const s = { ...state.meshObj.stats };
      s.kind = state.meshObj.kind;
      s.textureUrl = state.room ? (state.room.panorama || state.room.glb) : null;
      s.obstacles = state.room?.walk?.obstacles?.length ?? 0;
      s.halos = state.fx?.halos?.count ?? 0;
      s.proxies = state.fx?.proxies?.count ?? 0;
      return s;
    },
    halos: () => (state.fx && state.fx.halos ? state.fx.halos.count : 0),
    proxies: () => (state.fx && state.fx.proxies ? state.fx.proxies.count : 0),
    textureSize: () => (state.meshObj ? state.meshObj.stats.textureSize : null),
    waypointScreen: () => {
      if (!state.waypoint) return null;
      const p = projectToScreen(state.waypoint.group.position, camera);
      return {
        ...p,
        dist: Math.round(camera.position.distanceTo(state.waypoint.group.position) * 100) / 100,
        walkDist: Math.round(state.waypoint.playerDist(controls.effectivePos()) * 100) / 100,
        target: state.waypoint.targetRoom.id,
        x: Math.round(p.x), y: Math.round(p.y),
      };
    },
    walkTo: (x, z) => {
      const t = new THREE.Vector3(x, 0, z);
      const used = controls.walkTo(t) || t;
      state.fx?.showTarget(used);
    },
    setMode: (m) => { state.mode = m; hud.setMode(m); retargetWaypoint(); },
    resetView: () => controls.resetView(),
    warpNext: () => state.waypoint && warpThrough(state.waypoint),
    // deterministic room jump for E2E (nav-next clicks are swallowed mid-warp)
    gotoRoom: async (id) => {
      const i = state.db.rooms.findIndex((r) => r.id === id);
      if (i < 0 || i === state.roomIdx) return state.room?.id ?? null;
      if (state.transitioning) { await new Promise((r) => setTimeout(r, 300)); }
      await navigateTo(i);
      for (let k = 0; k < 60 && state.transitioning; k++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return state.room?.id ?? null;
    },
    radar,
    radarPixels: () => {
      const cv = document.getElementById("radar");
      if (!cv) return 0;
      const ctx = cv.getContext("2d");
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) n++; }
      return n;
    },
    uiBounds: () => {
      const vw = innerWidth, vh = innerHeight;
      const ids = [
        "room-pill", "room-badge", "btn-sound", "btn-lang", "btn-view", "mode-bar",
        "btn-radar", "radar-wrap",
        "mode-architect", "mode-style", "mode-room_type", "mode-random",
        "nav-capsule", "bump-toast", "joystick", "wp-chip", "btn-enter",
      ];
      const out = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const cs = getComputedStyle(el);
        const hidden = el.classList.contains("hud-hidden") || cs.display === "none" || parseFloat(cs.opacity || "1") < 0.02;
        if (hidden) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out.push({
          id,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          inside: r.x >= 8 && r.y >= 8 && r.x + r.width <= vw - 8 && r.y + r.height <= vh - 8,
        });
      }
      return out;
    },
  };
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.();
}

async function onEnter() {
  if (state.started) return;
  state.started = true;
  audio.unlock();                       // user gesture → warm acoustic engine
  hud.setMuted(audio.muted);
  hud.hideIntro();
  hud.showLoading(true);
  hud.setLoadProgress(0.1);
  await loadRoom(0);
  hud.setLoadProgress(1);
  hud.showLoading(false);
  hud.showHud();

  // a soft step in — the player arrives in the space
  controls.enabled = true;
}

/* ------------------------------------------------------------- room lifecycle */

function routeFor(idx) {
  return computeRoutes(state.db.rooms, idx, state.mode);
}

function retargetWaypoint() {
  if (!state.waypoint || state.roomIdx < 0) return;
  const { target } = routeFor(state.roomIdx);
  state.waypoint.retarget(state.db.rooms[target]);
  if (hoveredWaypoint) {
    const p = projectToScreen(state.waypoint.group.position, camera);
    hud.showWaypointChip(state.waypoint.targetRoom, p.x, p.y);
  }
  prefetchRoom(state.db.rooms[target]);
}

async function loadRoom(idx) {
  const room = state.db.rooms[idx];
  hud.hideWaypointChip();

  // build FIRST — the swap below is atomic, so state.room / world / waypoint
  // can never disagree (no walking in the previous room's collision world)
  hud.setLoadProgress(0.15);
  const meshObj = await buildRoomVolume(room, renderer);
  hud.setLoadProgress(0.85);

  if (state.meshObj) {
    scene.remove(state.meshObj.mesh);
    state.meshObj.dispose();
    state.meshObj = null;
  }
  if (state.waypoint) {
    scene.remove(state.waypoint.group);
    state.waypoint.dispose();
    state.waypoint = null;
  }
  if (state.fx) {
    state.fx.dispose(scene);
    state.fx = null;
  }

  state.meshObj = meshObj;
  scene.add(meshObj.mesh);
  state.roomIdx = idx;
  state.room = room;

  // physics world + 3D overlay FX (grid, rings, halos, glass proxies)
  state.world = new WalkWorld(room);
  state.fx = new WalkFX(scene, room);
  controls.setWorld(state.world);
  controls.setRoom(room);

  // one verified doorway waypoint → routed next room
  const { target } = routeFor(idx);
  const wp = new Waypoint(room.portals[0], state.db.rooms[target]);
  scene.add(wp.group);
  state.waypoint = wp;

  // base FOV law: 72° (pano step-glide base · true-3D locked)
  camera.fov = FOV_BASE;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  audio.setRoom(room.audio || { ambient: "room_tone", reverb: 0.25 });
  radar.setRoom(room, state.world);
  radar.setPlanMode(false);
  hud.setRoom(room, idx, state.db.rooms.length);
  state.walkInArmedAt = performance.now() + 700;   // walk-in trigger arming

  hud.setLoadProgress(1);
  setTimeout(() => prefetchRoom(state.db.rooms[target]), 1500);
}

/* ------------------------------------------------------------- warp */

function warpThrough(waypoint) {
  if (state.transitioning) return;
  const dir = waypoint.doorPos().sub(camera.position);
  navigateTo(state.db.rooms.indexOf(waypoint.targetRoom), dir);
}

function navigateTo(idx, dirWorld) {
  if (state.transitioning || idx === state.roomIdx) return;
  state.transitioning = true;
  controls.enabled = false;
  controls.walkTarget = null;
  controls.vel.set(0, 0);
  hud.hideWaypointChip();
  audio.warp();

  const dir = (dirWorld || new THREE.Vector3()).clone();
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) camera.getWorldDirection(dir).setY(0);
  dir.normalize();

  // step INTO the doorway: tween the virtual position (the camera follows it
  // every frame, clamped to the micro-parallax sphere in pano rooms)
  const start = controls.pos.clone();
  const end = start.clone().addScaledVector(dir, 0.55);

  const tl = gsap.timeline({
    onComplete: async () => {
      await loadRoom(idx);
      gsap.to("#fade", { opacity: 0, duration: 0.8, ease: "power2.out" });
      controls.enabled = true;
      state.transitioning = false;
    },
  });
  tl.to(controls.pos, { x: end.x, z: end.z, duration: 0.55, ease: "power2.in" }, 0);
  tl.to("#fade", { opacity: 1, duration: 0.4, ease: "power1.in" }, 0.15);
}

/* ------------------------------------------------------------- collisions */

function handleBump(bump) {
  if (!bump) return;
  const label = bump.label[i18n.lang] || bump.label.en;
  hud.showBump(`${i18n.t.bump_prefix} ${label}`);
  audio.bump();
  if (state.fx && state.fx.halos && bump.ob) {
    state.fx.halos.flash(bump.ob);       // glass halo flash
    state.fx.proxies?.flash(bump.ob);    // 3D glass proxy flash
  }
  // ripple at the obstacle's screen position
  const hitX = camera.position.x + bump.nx * 1.2;
  const hitZ = camera.position.z + bump.nz * 1.2;
  const p = projectToScreen(new THREE.Vector3(hitX, 1.0, hitZ), camera);
  if (!p.behind) hud.ripple(p.x, p.y);
}

/* ------------------------------------------------------------- pointer logic */

function onPointerMove(e) {
  if (!state.started || state.transitioning || isTouch) return;
  const hit = raycastWaypoint(e.clientX, e.clientY);
  const proxy = hit ? null : raycastProxy(e.clientX, e.clientY);
  const cursor = hit || proxy ? "pointer" : "";
  renderer.domElement.style.cursor = cursor;
  if (hit !== hoveredWaypoint) {
    hoveredWaypoint = hit;
    if (hit) {
      const p = projectToScreen(state.waypoint.group.position, camera);
      hud.showWaypointChip(state.waypoint.targetRoom, p.x, p.y);
    } else if (!proxy) {
      hud.hideWaypointChip();
    }
  }
  hoveredProxy = proxy;
  if (hoveredWaypoint && state.waypoint) {
    const p = projectToScreen(state.waypoint.group.position, camera);
    hud.placeWaypointChip(p.x, p.y);
  }
}

function raycastWaypoint(px, py) {
  if (!state.waypoint) return false;
  pointerNdc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  return raycaster.intersectObject(state.waypoint.collider, false).length > 0;
}

/** Raycast the 3D glass furniture proxies (LAW 2 interactive hotspots). */
function raycastProxy(px, py) {
  const meshes = state.fx?.proxies?.meshes;
  if (!meshes || !meshes.length) return null;
  pointerNdc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? hits[0].object.userData.obstacle : null;
}

function handleClick(x, y) {
  if (!state.started || state.transitioning) return;
  if (raycastWaypoint(x, y)) {
    // desktop: hover already previewed the chip — click travels.
    // touch: first tap previews, the second tap (ring or chip) travels.
    if (!isTouch || hud.chipOpen) warpThrough(state.waypoint);
    else {
      const p = projectToScreen(state.waypoint.group.position, camera);
      hud.showWaypointChip(state.waypoint.targetRoom, p.x, p.y);
    }
    return;
  }
  const proxy = raycastProxy(x, y);
  if (proxy) {
    // hotspot: single tap surfaces the furniture label (glass flash + ripple)
    const label = proxy.label[i18n.lang] || proxy.label.en;
    hud.showBump(label);
    state.fx?.proxies?.flash(proxy);
    const p = projectToScreen(new THREE.Vector3(proxy.x, (proxy.h ?? 0.8) * 0.6, proxy.z), camera);
    if (!p.behind) hud.ripple(p.x, p.y);
    return;
  }
  hud.hideWaypointChip();
}

function handleDouble(x, y) {
  if (!state.started || state.transitioning) return;
  if (raycastWaypoint(x, y)) { warpThrough(state.waypoint); return; }

  // LAW 2: double-tap a 3D glass furniture proxy → glide up to that piece
  const proxy = raycastProxy(x, y);
  if (proxy) {
    const vpos = controls.effectivePos();
    const dx = proxy.x - vpos.x, dz = proxy.z - vpos.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    const stand = (proxy.type === "box"
      ? Math.max(Math.abs((proxy.hw ?? 0.5) / Math.max(Math.abs(dx / d), 0.35)),
                 Math.abs((proxy.hd ?? 0.5) / Math.max(Math.abs(dz / d), 0.35)))
      : (proxy.r ?? 0.5)) + 0.55;
    const t = new THREE.Vector3(proxy.x - (dx / d) * stand, 0, proxy.z - (dz / d) * stand);
    controls.lookToward(t.clone().sub(vpos));
    controls.walkTo(t);
    state.fx.showTarget(t);
    return;
  }

  // walk TO the tapped floor point — the footstep target ring marks it
  pointerNdc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(floorPlane, hit)) {
    // clamp the destination into the walkable area
    const b = state.world?.bounds;
    if (b) {
      hit.x = THREE.MathUtils.clamp(hit.x, b.minX, b.maxX);
      hit.z = THREE.MathUtils.clamp(hit.z, b.minZ, b.maxZ);
    }
    const dir = hit.clone().sub(camera.position).normalize();
    controls.lookToward(dir);
    controls.walkTo(hit);
    state.fx.showTarget(hit);
  }
}

/* ------------------------------------------------------------- loop */

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  controls.update(dt);

  if (state.fx) {
    state.fx.update(dt, controls.effectivePos(), camera.position, controls.speed);
  }

  if (state.waypoint && !state.transitioning) {
    state.waypoint.update(t, dt, camera, hoveredWaypoint);

    // walk (virtually, in pano rooms) INTO the doorway → travel
    if (state.started && performance.now() > state.walkInArmedAt) {
      const d = state.waypoint.playerDist(controls.effectivePos());
      if (d < WALK_IN_DIST) {
        warpThrough(state.waypoint);
      }
    }
  }

  hud.setMoved(controls.moved);
  if (state.started) radar.update(dt, controls.effectivePos(), controls.yaw);
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
