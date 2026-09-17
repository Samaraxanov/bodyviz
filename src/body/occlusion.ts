/**
 * Baked ambient occlusion.
 *
 * The figure is assembled from separate solids that interpenetrate, so the
 * places a real body goes dark — the armpit, the crotch, under the chin, the
 * gap where a hand rests against a hip — are exactly the places where two parts
 * come close. That makes occlusion cheap to approximate: give every part a
 * coarse proxy (a stack of elliptical cross-sections), then darken each vertex
 * by how close it sits to the parts it does *not* belong to.
 *
 * It is not a ray-traced bake, but it lands the shadows where the eye expects
 * them, and it costs one pass over the vertices instead of one per ray.
 */

import { Section } from './mesh';

export interface Proxy {
  /** Ascending sweep positions (height, in metres). */
  ys: number[];
  /** Cross-section centre and half-extents at each position. */
  cx: number[];
  cz: number[];
  rx: number[];
  rz: number[];
  /** Bounding box, already grown by the occlusion reach, for early rejection. */
  bounds: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  /** Height -> ring index, so locating a ring is a lookup and not a scan. */
  lookup: Int32Array;
  lookupY0: number;
  lookupScale: number;
}

/**
 * Distance falloff: how far from a part its shadow still reaches. Kept tight,
 * because an arm hangs a couple of centimetres from the ribs for its whole
 * length and should not darken it.
 */
const REACH = 0.026;
/** How dark a fully enclosed crease gets. */
const FLOOR = 0.66;
const STRENGTH = 0.55;
/** Bounce light from the floor fades out by this height. */
const GROUND_FADE = 0.4;

const LOOKUP_BUCKETS = 128;

/** Builds a proxy from the rings a part was actually built from. */
export function proxyFromSections(sections: Section[], mirrorX = false): Proxy {
  const p = {
    ys: [] as number[],
    cx: [] as number[],
    cz: [] as number[],
    rx: [] as number[],
    rz: [] as number[],
  };
  for (const s of sections) {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let j = 0; j < s.pts.length; j += 2) {
      minU = Math.min(minU, s.pts[j]);
      maxU = Math.max(maxU, s.pts[j]);
      minV = Math.min(minV, s.pts[j + 1]);
      maxV = Math.max(maxV, s.pts[j + 1]);
    }
    const cx = (minU + maxU) / 2;
    p.ys.push(s.p);
    p.cx.push(mirrorX ? -cx : cx);
    p.cz.push((minV + maxV) / 2);
    p.rx.push((maxU - minU) / 2);
    p.rz.push((maxV - minV) / 2);
  }

  // Sections arrive in sweep order, which is ascending, but domes are appended
  // at both ends -- sort so the lookup and interpolation stay monotonic.
  const order = p.ys.map((_, i) => i).sort((a, b) => p.ys[a] - p.ys[b]);
  const pick = (src: number[]) => order.map((i) => src[i]);
  const ys = pick(p.ys);
  const cx = pick(p.cx);
  const cz = pick(p.cz);
  const rx = pick(p.rx);
  const rz = pick(p.rz);

  const pad = REACH * 3;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < ys.length; i++) {
    x0 = Math.min(x0, cx[i] - rx[i]);
    x1 = Math.max(x1, cx[i] + rx[i]);
    z0 = Math.min(z0, cz[i] - rz[i]);
    z1 = Math.max(z1, cz[i] + rz[i]);
  }

  const y0 = ys[0];
  const y1 = ys[ys.length - 1];
  const span = Math.max(1e-6, y1 - y0);
  const lookup = new Int32Array(LOOKUP_BUCKETS);
  for (let b = 0; b < LOOKUP_BUCKETS; b++) {
    const y = y0 + (span * b) / (LOOKUP_BUCKETS - 1);
    let i = 0;
    while (i < ys.length - 2 && ys[i + 1] < y) i++;
    lookup[b] = i;
  }

  return {
    ys, cx, cz, rx, rz,
    bounds: {
      x0: x0 - pad, x1: x1 + pad,
      y0: y0 - pad, y1: y1 + pad,
      z0: z0 - pad, z1: z1 + pad,
    },
    lookup,
    lookupY0: y0,
    lookupScale: (LOOKUP_BUCKETS - 1) / span,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Approximate distance from a point to a proxy's surface. Negative inside.
 * The cross-section is treated as an ellipse, which is close enough at the
 * scale occlusion is visible.
 */
function distanceTo(p: Proxy, x: number, y: number, z: number): number {
  const n = p.ys.length;
  let i = 0;
  let overhang = 0;
  if (y <= p.ys[0]) {
    overhang = p.ys[0] - y;
  } else if (y >= p.ys[n - 1]) {
    i = n - 2;
    overhang = y - p.ys[n - 1];
  } else {
    const b = Math.min(
      p.lookup.length - 1,
      Math.max(0, Math.round((y - p.lookupY0) * p.lookupScale)),
    );
    i = p.lookup[b];
    while (i < n - 2 && p.ys[i + 1] < y) i++;
    while (i > 0 && p.ys[i] > y) i--;
  }
  const span = p.ys[i + 1] - p.ys[i];
  const t = span > 0 ? Math.min(1, Math.max(0, (y - p.ys[i]) / span)) : 0;

  const cx = lerp(p.cx[i], p.cx[i + 1], t);
  const cz = lerp(p.cz[i], p.cz[i + 1], t);
  const rx = Math.max(1e-4, lerp(p.rx[i], p.rx[i + 1], t));
  const rz = Math.max(1e-4, lerp(p.rz[i], p.rz[i + 1], t));

  const dx = (x - cx) / rx;
  const dz = (z - cz) / rz;
  const radial = (Math.hypot(dx, dz) - 1) * Math.min(rx, rz);
  return Math.hypot(Math.max(0, radial), overhang);
}

/**
 * One grey value per vertex, ready to upload as a colour attribute. three
 * multiplies it into the material colour, so 1 means untouched.
 */
export function bakeOcclusion(
  positions: Float32Array,
  partOf: Uint8Array,
  proxies: { part: number; proxy: Proxy }[],
): Float32Array {
  const count = positions.length / 3;
  const colors = new Float32Array(count * 3);

  for (let v = 0; v < count; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const own = partOf[v];

    let occ = 0;
    for (const { part, proxy } of proxies) {
      if (part === own) continue;
      // Most vertices are nowhere near most parts; reject on the box first.
      const b = proxy.bounds;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1 || z < b.z0 || z > b.z1) continue;
      const d = distanceTo(proxy, x, y, z);
      // Gaussian, not a plain exponential. exp(-d/REACH) is at its steepest
      // exactly where two parts touch, so a contact crease gets painted as a
      // hard-edged band -- along the groin that reads as the waistband of a
      // pair of briefs rather than as shadow. A Gaussian is flat at d = 0 and
      // eases off, which is what a crease actually does to light.
      if (d < REACH * 3) {
        const k = Math.max(0, d) / REACH;
        occ += Math.exp(-k * k);
      }
    }

    let ao = 1 / (1 + occ * STRENGTH);
    // The floor bounces light back, so contact shadow eases off with height.
    ao *= lerp(0.9, 1, Math.min(1, y / GROUND_FADE));
    ao = Math.max(FLOOR, Math.min(1, ao));

    colors[v * 3] = ao;
    colors[v * 3 + 1] = ao;
    colors[v * 3 + 2] = ao;
  }
  return colors;
}
