/**
 * PANODROME — Stage 2.0 · ZERO-WARP ARCHITECTURE (owner law 2026-11-03)
 * ============================================================================
 * LAW 1 — COMPLETE BAN ON PANORAMA VERTEX WARPING:
 *   The 360° equirectangular photograph is rendered on a 100% geometrically
 *   pure, undistorted THREE.SphereGeometry(500, 128, 96).  NO depth map, NO
 *   relief field, NO vertex displacement — ever.  From (nearly) the capture
 *   point every wall, ceiling, picture frame, bed, sofa and doorway is
 *   mathematically GUARANTEED straight and un-stretched, 360° all around.
 *
 *   UV SEAM LAW: the texture is seam-wrapped at load time — a narrow
 *   cross-dissolve band blends the left and right edges of the pano (in a
 *   canvas copy; the original file on disk is NEVER modified), so there is
 *   NEVER a hard white seam line across the floor or couch.
 *
 * LAW 3 — TRUE-3D ROOMS (room.type === "true_3d"): a real 3D architectural
 *   .glb scene (built by skills/build_true_3d_room.py — real box walls with
 *   PBR wood/plaster/travertine textures, real 3D furniture meshes, recessed
 *   ceiling lights, windows onto a skybox) is loaded with GLTFLoader and lit
 *   by the room's authored light rig.  Real meshes can never warp — full
 *   multi-metre 6DoF walking is enabled there (controls.js "free" mode).
 */
import * as THREE from "three";
import { GLTFLoader } from "../vendor/GLTFLoader-0.160.0.js";
import { loadSplat, createSplat, splatScaleFor } from "./splat.js";

/* ---------------------------------------------------------- owner laws */
export const PANO_SPHERE_RADIUS = 500;   // m  — owner law: SphereGeometry(500, 128, 96)
export const PANO_SEG_W = 128;           // azimuth segments
export const PANO_SEG_H = 96;            // elevation segments
export const SEAM_BLEND_PX = 24;         // px cross-dissolve band at u=0/1

/* ------------------------------------------------------------ pano sphere */

/**
 * Load the pano image and return a SEAM-WRAPPED CanvasTexture.
 * The left/right edge bands (SEAM_BLEND_PX each) are cross-dissolved in the
 * canvas copy so column 0 and column W-1 converge — the wrap interpolates
 * smoothly (no hard seam line at any mip level).  The source file on disk
 * is never touched (Rule A).
 */
function loadSeamWrappedTexture(url, renderer) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const W = img.naturalWidth, H = img.naturalHeight;
        const cv = document.createElement("canvas");
        cv.width = W; cv.height = H;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const pad = Math.min(SEAM_BLEND_PX, Math.floor(W / 8));
        // cross-dissolve the two edge bands: column k (left) with column
        // W-1-k (right); weight 0.5 at the extreme edge → 0 at pad, so the
        // outermost columns become identical and the wrap is continuous.
        for (let k = 0; k < pad; k++) {
          const w = 0.5 * (1 - k / pad);
          const L = ctx.getImageData(k, 0, 1, H);
          const R = ctx.getImageData(W - 1 - k, 0, 1, H);
          for (let i = 0; i < H * 4; i++) {
            const l = L.data[i], r = R.data[i];
            L.data[i] = l * (1 - w) + r * w;
            R.data[i] = r * (1 - w) + l * w;
          }
          ctx.putImageData(L, k, 0);
          ctx.putImageData(R, W - 1 - k, 0);
        }
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;   // standard sRGB passthrough
        tex.wrapS = THREE.RepeatWrapping;        // u wraps continuously
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        tex.needsUpdate = true;
        resolve(tex);
      } catch (err) { reject(err); }
    };
    img.onerror = () => reject(new Error("panorama failed: " + url));
    img.src = url;
  });
}

/**
 * Build the ZERO-WARP pano room: the original 4K photograph painted on a
 * pure SphereGeometry(500, 128, 96), centred on the capture point.
 * The equirect mapping of THREE.SphereGeometry is IDENTICAL to the historic
 * per-fragment shader convention (u = atan2(d.z, -d.x)/2π, v = 1-acos(d.y)/π)
 * — verified vertex-by-vertex — so the photo lands exactly where it always
 * did, minus every form of displacement.
 */
export async function buildPanoSphere(room, renderer) {
  const capture = new THREE.Vector3(room.camera.x, room.camera.y, room.camera.z);
  const texture = await loadSeamWrappedTexture(room.panorama, renderer);

  const geo = new THREE.SphereGeometry(PANO_SPHERE_RADIUS, PANO_SEG_W, PANO_SEG_H);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,          // we stand inside the sphere
    toneMapped: false,             // the photograph stays byte-faithful
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "panodrome_pano_sphere";
  mesh.position.copy(capture);
  mesh.frustumCulled = false;

  const stats = {
    kind: "sphere",
    sphere: {
      radius: PANO_SPHERE_RADIUS,
      segW: PANO_SEG_W,
      segH: PANO_SEG_H,
      seamBlendPx: SEAM_BLEND_PX,
    },
    textureSize: [texture.image.width, texture.image.height],
    capture: [capture.x, capture.y, capture.z],
  };

  return {
    mesh,
    texture,
    kind: "sphere",
    stats,
    setFade(f) { mat.opacity = f; mat.transparent = f < 1; },
    dispose() { geo.dispose(); texture.dispose(); mat.dispose(); },
  };
}

/* ------------------------------------------------------------- true 3D */

/** Gradient sky dome (villa windows look out onto this). */
function buildSky(room) {
  const sky = room.sky || {};
  const top = new THREE.Color(sky.zenith || "#7fb2e5");
  const bottom = new THREE.Color(sky.horizon || "#e8eef4");
  const sun = new THREE.Color(sky.sun || "#fff2dc");
  const sunDir = new THREE.Vector3(...(sky.sun_dir || [-0.55, 0.5, 0.25])).normalize();
  const geo = new THREE.SphereGeometry(450, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: top },
      uBottom: { value: bottom },
      uSun: { value: sun },
      uSunDir: { value: sunDir },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uSun;
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(uBottom, uTop, pow(h, 0.85));
        float d = max(dot(normalize(vDir), uSunDir), 0.0);
        col += uSun * pow(d, 42.0) * 0.9;          // sun disc glow
        col += uSun * pow(d, 5.0) * 0.10;          // wide haze
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "panodrome_sky";
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * LAW 3: load the TRUE-3D .glb architectural room + its authored light rig
 * (sun through the windows, sky/ground hemisphere, warm recessed spots) and
 * the sky dome outside the windows.  Everything here is a REAL 3D mesh —
 * multi-metre walking can never warp a single triangle.
 */
export function buildTrue3DRoom(room, renderer) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(room.glb, (gltf) => {
      const group = new THREE.Group();
      group.name = "panodrome_true3d_room";

      const root = gltf.scene || gltf.scenes[0];
      root.name = "villa_glb";
      group.add(root);

      // ---- authored light rig (rooms_db.json walk.lights) ----
      const lights = [];
      const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x8a7a66, 0.55);
      group.add(hemi); lights.push(hemi);
      for (const L of (room.walk && room.walk.lights) || []) {
        if (L.type === "sun") {
          const sun = new THREE.DirectionalLight(L.color || 0xfff0dd, L.intensity ?? 2.4);
          sun.position.set(...L.pos);
          group.add(sun); lights.push(sun);
        } else if (L.type === "spot") {
          const p = new THREE.PointLight(L.color || 0xffe6c4, L.intensity ?? 0.55, L.distance ?? 7, 2);
          p.position.set(...L.pos);
          group.add(p); lights.push(p);
        }
      }

      const sky = buildSky(room);
      group.add(sky);

      let meshes = 0, tris = 0;
      root.traverse((o) => {
        if (o.isMesh) {
          meshes++;
          tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
        }
      });

      resolve({
        mesh: group,
        texture: null,
        kind: "true3d",
        stats: {
          kind: "true3d",
          glb: room.glb,
          meshes,
          tris: Math.round(tris),
          lights: lights.length,
        },
        setFade() {},
        dispose() {
          root.traverse((o) => {
            if (o.isMesh) {
              o.geometry?.dispose?.();
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              for (const m of mats) { m?.map?.dispose?.(); m?.dispose?.(); }
            }
          });
          sky.geometry.dispose(); sky.material.dispose();
          for (const l of lights) l.dispose?.();
        },
      });
    }, undefined, () => reject(new Error("glb failed: " + room.glb)));
  });
}

/* ------------------------------------------------------------- public API */

/**
 * Build any room: pure pano sphere (LAW 1) or true-3D glb (LAW 3).
 * @returns {Promise<{mesh, texture, kind, stats, setFade, dispose}>}
 */
export function buildRoomVolume(room, renderer) {
  return room.type === "true_3d"
    ? buildTrue3DRoom(room, renderer)
    : buildPanoSphere(room, renderer);
}

/** Warm the browser cache for the likely-next room (pano or glb). */
export function prefetchRoom(room) {
  if (!room) return;
  if (room.type === "true_3d") {
    fetch(room.glb, { mode: "same-origin" }).catch(() => {});
    return;
  }
  const a = new Image();
  a.src = room.panorama;
}

/* ------------------------------------------------------ splat appearance */

/**
 * APPEARANCE LANE (docs/17 B2). When a room carries a baked 3DGS splat, the
 * flat photo shell is switched off and the splat is drawn in its place — the
 * photographed pixels, lifted into 3D at their measured depth. Collision is
 * untouched: it still comes from geometry (collider.js), never from here.
 */
export async function attachSplat(meshObj, room, renderer, camera) {
  const url = room.appearance && room.appearance.asset;
  if (!url) return null;
  const splat = await loadSplat(url);
  const points = createSplat(splat, {
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  });
  points.name = "panodrome_splat";
  meshObj.mesh.add(points);                 // mesh already sits at the capture point
  meshObj.mesh.material.visible = false;    // photo shell off, splat on

  const applyScale = () => {
    points.material.uniforms.uScale.value = splatScaleFor(camera, renderer);
  };
  applyScale();
  window.addEventListener("resize", applyScale);

  const prevDispose = meshObj.dispose.bind(meshObj);
  meshObj.dispose = () => {
    window.removeEventListener("resize", applyScale);
    points.geometry.dispose();
    points.material.dispose();
    prevDispose();
  };
  meshObj.splat = points;
  meshObj.splatCount = splat.count;
  return points;
}
