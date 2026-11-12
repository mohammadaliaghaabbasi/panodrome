/**
 * SPZ READER — the container half of the photographic-density bake.
 *
 * skills/spz_lod.py writes Niantic SPZ v2 (gzip, 24-bit fixed-point positions,
 * 8-bit log scales, 8-bit alpha, 8-bit DC colour, first-three rotations) with
 * four LOD tiers. This loader turns those bytes into exactly the shape
 * splat.js already renders — { count, pos, col, covA, covB, alpha } — so the
 * EWA renderer needs no knowledge of the container.
 *
 * Why SPZ at all: a photographic bake is one gaussian per panorama pixel. As
 * PLY that is 68 B/splat (570 MB for a 4K pano); as SPZ it is ~8 B/splat
 * (4.2 MB for a 524k demo, measured), which is what makes the sharp bake
 * servable at all.
 *
 * Layout (all little endian):
 *   0..4   magic 0x5053474e   4..8 version 2   8..12 numPoints
 *   12 dim-1 shDegree  13 fractionalBits  14 flags  15 reserved
 *   positions int24 x3 (value * 2^fractionalBits) | alphas u8 | colors u8x3
 *   | scales u8x3 (exp(b/16 - 10)) | rotations i8x3 (q.xyz: b/127.5 - 1)
 */

const SH_C0 = 0.28209479177387814;
const MAGIC = 0x5053474e;

/** gzip bytes -> ArrayBuffer, via the platform decompressor. */
async function gunzip(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buf;   // already raw
  if (typeof DecompressionStream === "undefined") {
    throw new Error("SPZ needs DecompressionStream (gzip) — unsupported browser");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

function quatToCov(w, x, y, z, sx, sy, sz, covA, covB, i) {
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
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

export async function loadSpz(url) {
  const raw = await (await fetch(url)).arrayBuffer();
  const buf = await gunzip(raw);
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) throw new Error(`not an SPZ file: magic 0x${magic.toString(16)}`);
  const version = dv.getUint32(4, true);
  const count = dv.getUint32(8, true);
  const shDegree = dv.getUint8(12);
  const frac = dv.getUint8(13);
  if (version !== 2) throw new Error(`SPZ version ${version} not supported (need 2)`);
  if (shDegree !== 0) throw new Error(`SPZ shDegree ${shDegree} not supported (need 0)`);

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const covA = new Float32Array(count * 3);
  const covB = new Float32Array(count * 3);
  const alpha = new Float32Array(count);

  const u8 = new Uint8Array(buf);
  const i8 = new Int8Array(buf);
  const scaleFixed = 1 / (1 << frac);
  let o = 16;

  // positions: three signed 24-bit little-endian ints per splat
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      let v = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16);
      if (v >= 0x800000) v -= 0x1000000;
      pos[i * 3 + a] = v * scaleFixed;
      o += 3;
    }
  }
  for (let i = 0; i < count; i++) alpha[i] = u8[o + i] / 255;
  o += count;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const byte = u8[o + i * 3 + c] / 255;
      const dc = (byte - 0.5) / 0.15;
      col[i * 3 + c] = Math.min(1, Math.max(0, 0.5 + SH_C0 * dc));
    }
  }
  o += count * 3;
  const sBase = o;
  o += count * 3;
  const rBase = o;

  for (let i = 0; i < count; i++) {
    const sx = Math.exp(u8[sBase + i * 3] / 16 - 10);
    const sy = Math.exp(u8[sBase + i * 3 + 1] / 16 - 10);
    const sz = Math.exp(u8[sBase + i * 3 + 2] / 16 - 10);
    const qx = (i8[rBase + i * 3] + 128) / 127.5 - 1;
    const qy = (i8[rBase + i * 3 + 1] + 128) / 127.5 - 1;
    const qz = (i8[rBase + i * 3 + 2] + 128) / 127.5 - 1;
    const qw = Math.sqrt(Math.max(0, 1 - (qx * qx + qy * qy + qz * qz)));
    quatToCov(qw, qx, qy, qz, sx, sy, sz, covA, covB, i);
  }

  return { count, pos, col, covA, covB, alpha, container: "spz/2", bytes: raw.byteLength };
}
