/**
 * Tiny mesh-assembly helpers. Deliberately dependency-free (no three import)
 * so the geometry can be generated and verified in plain Node.
 */

export interface Section {
  /** Position along the sweep axis. */
  p: number;
  /** Closed cross-section outline in the two remaining axes. */
  pts: number[]; // flat [u0, v0, u1, v1, ...]
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export class MeshBuilder {
  private pos: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  private push(x: number, y: number, z: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    return i;
  }

  /**
   * Sweeps a closed outline along `axis`. Every section must carry the same
   * number of points, wound consistently, so rings can be stitched pairwise.
   *
   * `domeStart` / `domeEnd` round the ends off instead of capping them flat,
   * which is the difference between a limb that grows out of the body and one
   * that looks stuck on. The value is the dome's reach as a multiple of the end
   * ring's mean radius.
   */
  addStack(
    sections: Section[],
    axis: 'y' | 'z',
    opts: {
      capStart?: boolean;
      capEnd?: boolean;
      domeStart?: number;
      domeEnd?: number;
      offset?: [number, number, number];
      flipX?: boolean;
    } = {},
  ): { start: number; end: number } {
    const first = this.vertexCount;
    const { capStart = true, capEnd = true, offset = [0, 0, 0], flipX = false } = opts;
    if (opts.domeStart) sections = [...buildDome(sections[0], -1, opts.domeStart), ...sections];
    if (opts.domeEnd) {
      sections = [...sections, ...buildDome(sections[sections.length - 1], 1, opts.domeEnd)];
    }
    const [ox, oy, oz] = offset;
    const sx = flipX ? -1 : 1;
    const n = sections[0].pts.length / 2;
    const ringStart: number[] = [];

    for (const s of sections) {
      ringStart.push(this.vertexCount);
      for (let j = 0; j < n; j++) {
        const u = s.pts[j * 2];
        const v = s.pts[j * 2 + 1];
        if (axis === 'y') this.push(sx * (u + ox), s.p + oy, v + oz);
        else this.push(sx * (u + ox), v + oy, s.p + oz);
      }
    }

    // Winding flips with the mirror so normals keep pointing outwards.
    const quad = (a: number, b: number, c: number, d: number) => {
      if (flipX) this.idx.push(a, c, b, a, d, c);
      else this.idx.push(a, b, c, a, c, d);
    };

    for (let i = 0; i < sections.length - 1; i++) {
      const lo = ringStart[i];
      const hi = ringStart[i + 1];
      for (let j = 0; j < n; j++) {
        const k = (j + 1) % n;
        quad(lo + j, lo + k, hi + k, hi + j);
      }
    }

    const cap = (ringIndex: number, atStart: boolean) => {
      const base = ringStart[ringIndex];
      const s = sections[ringIndex];
      let cu = 0;
      let cv = 0;
      for (let j = 0; j < n; j++) {
        cu += s.pts[j * 2];
        cv += s.pts[j * 2 + 1];
      }
      cu /= n;
      cv /= n;
      const c =
        axis === 'y'
          ? this.push(sx * (cu + ox), s.p + oy, cv + oz)
          : this.push(sx * (cu + ox), cv + oy, s.p + oz);
      for (let j = 0; j < n; j++) {
        const k = (j + 1) % n;
        const forward = atStart !== flipX;
        if (forward) this.idx.push(c, base + k, base + j);
        else this.idx.push(c, base + j, base + k);
      }
    };

    if (capStart) cap(0, true);
    if (capEnd) cap(sections.length - 1, false);

    return { start: first, end: this.vertexCount };
  }

  build(): MeshData {
    const positions = new Float32Array(this.pos);
    const indices = new Uint32Array(this.idx);
    // Every part is built the same way, so one global orientation check is
    // enough to guarantee outward-facing normals.
    if (signedVolume(positions, indices) < 0) {
      for (let i = 0; i < indices.length; i += 3) {
        const t = indices[i + 1];
        indices[i + 1] = indices[i + 2];
        indices[i + 2] = t;
      }
    }
    return { positions, normals: computeNormals(positions, indices), indices };
  }
}

/** Mean distance of a ring's points from its own centroid. */
function meanRadius(pts: number[]): { r: number; cu: number; cv: number } {
  const n = pts.length / 2;
  let cu = 0;
  let cv = 0;
  for (let j = 0; j < n; j++) {
    cu += pts[j * 2];
    cv += pts[j * 2 + 1];
  }
  cu /= n;
  cv /= n;
  let r = 0;
  for (let j = 0; j < n; j++) r += Math.hypot(pts[j * 2] - cu, pts[j * 2 + 1] - cv);
  return { r: r / n, cu, cv };
}

/**
 * A quarter-turn of rings that shrink the end ring to a point, so a stack
 * finishes in a rounded cap rather than a flat disc.
 */
function buildDome(end: Section, dir: 1 | -1, reach: number, steps = 5): Section[] {
  const { r, cu, cv } = meanRadius(end.pts);
  const extent = r * reach;
  const out: Section[] = [];
  for (let k = 1; k <= steps; k++) {
    const a = (Math.PI / 2) * (k / steps);
    const shrink = Math.cos(a);
    const pts = new Array<number>(end.pts.length);
    for (let j = 0; j < end.pts.length; j += 2) {
      pts[j] = cu + (end.pts[j] - cu) * shrink;
      pts[j + 1] = cv + (end.pts[j + 1] - cv) * shrink;
    }
    out.push({ p: end.p + dir * extent * Math.sin(a), pts });
  }
  return dir === -1 ? out.reverse() : out;
}

/** Signed volume of a closed mesh via the divergence theorem. */
export function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let v = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    v +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}

/** Area-weighted vertex normals — smooth because rings share their seam vertex. */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }
  return normals;
}

/** Signed area of a closed polygon given as a flat [u,v,...] list. */
export function polygonArea(pts: number[]): number {
  let area = 0;
  const n = pts.length / 2;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    area += pts[j * 2] * pts[k * 2 + 1] - pts[k * 2] * pts[j * 2 + 1];
  }
  return Math.abs(area) / 2;
}

export function polygonPerimeter(pts: number[]): number {
  let p = 0;
  const n = pts.length / 2;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    p += Math.hypot(pts[k * 2] - pts[j * 2], pts[k * 2 + 1] - pts[j * 2 + 1]);
  }
  return p;
}

/**
 * Monotone cubic (Fritsch-Carlson) interpolation over non-uniform knots.
 *
 * This is the "controlled curvature" half of the shape system. Plain
 * Catmull-Rom overshoots: run it through chest 0.094 / armpit 0.097 /
 * shoulder 0.111 and it bulges past 0.111 somewhere above the shoulder, which
 * is a lump of nothing hanging off the trapezius. Limiting the tangents keeps
 * the curve inside the values it was given, so the silhouette is exactly the
 * stations and the *detail* comes from relief laid on top -- rather than the
 * two fighting each other.
 */
export function spline(knots: number[], values: number[], t: number): number {
  const n = knots.length;
  if (t <= knots[0]) return values[0];
  if (t >= knots[n - 1]) return values[n - 1];
  let i = 0;
  while (i < n - 2 && knots[i + 1] < t) i++;

  const t0 = knots[i];
  const t1 = knots[i + 1];
  const h = t1 - t0;
  const s = (t - t0) / h;

  const vPrev = values[Math.max(0, i - 1)];
  const tPrev = knots[Math.max(0, i - 1)];
  const vNext = values[Math.min(n - 1, i + 2)];
  const tNext = knots[Math.min(n - 1, i + 2)];

  // Finite-difference tangents, scaled into the local parameter.
  let m0 = i === 0 ? (values[i + 1] - values[i]) / h : (values[i + 1] - vPrev) / (t1 - tPrev);
  let m1 =
    i + 2 > n - 1 ? (values[i + 1] - values[i]) / h : (vNext - values[i]) / (tNext - t0);

  // Fritsch-Carlson limiter. The secant is the only slope the segment is
  // allowed to lean on: at a local extremum the tangents go flat, and
  // elsewhere they are clipped to three times the secant, which is the
  // classical bound for staying monotone.
  const secant = (values[i + 1] - values[i]) / h;
  if (secant === 0) {
    m0 = 0;
    m1 = 0;
  } else {
    const a0 = m0 / secant;
    const a1 = m1 / secant;
    if (a0 < 0) m0 = 0;
    if (a1 < 0) m1 = 0;
    const cap = 3;
    if (a0 > cap) m0 = cap * secant;
    if (a1 > cap) m1 = cap * secant;
  }

  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * values[i] +
    (s3 - 2 * s2 + s) * h * m0 +
    (-2 * s3 + 3 * s2) * values[i + 1] +
    (s3 - s2) * h * m1
  );
}
