/**
 * Shape parameters -> cross-sections.
 *
 * This is the middle of the pipeline. `anthropometry.ts` says what a body is
 * (shoulders this wide, calf this heavy, a bicep here); `buildBody.ts` says how
 * much of the user's mass lands where. This file turns the two into rings.
 *
 * The one idea worth knowing is the split between **stations** and **relief**.
 *
 * A station is a silhouette control point — the pelvis is this wide, the waist
 * is this deep — and stations are interpolated with a monotone spline, so the
 * outline passes through them and never bulges between them.
 *
 * Relief is everything that sits *on* that outline: pectorals, a spine, the two
 * heads of a calf, knuckles. It is applied per-vertex as a radial push in a
 * Gaussian window over height and angle, and then the contour is renormalised
 * back to the area it had before. That renormalisation is load-bearing in two
 * ways. It keeps the volume solver exact -- relief can never quietly add
 * kilograms -- and it means muscle reads as muscle: a bicep that bulges forward
 * makes the arm narrower across, the way a real one does, instead of just
 * inflating it.
 */

import {
  ANGLE,
  ArmShape,
  FootShape,
  HeadShape,
  LimbNode,
  NeckShape,
  Relief,
  ShapeParams,
  Station,
  TorsoShape,
} from './anthropometry';
import { Section, polygonArea, spline } from './mesh';

/**
 * Mesh density. Relief sets the floor here, not the silhouette: the tightest
 * features are the linea alba and the gluteal cleft at an arc of about 0.13
 * radians, and a Gaussian that narrow needs roughly four samples across it to
 * survive. 56 segments gives 0.11 radians of spacing, which clears it. Going
 * further is paid for on every slider frame -- vertex count drives the mesh
 * assembly, the normals and the occlusion bake all at once.
 */
export const TORSO_RINGS = 88;
export const TORSO_SEGMENTS = 56;
export const LIMB_RINGS = 56;
export const LIMB_SEGMENTS = 28;
export const HEAD_RINGS = 30;
export const HEAD_SEGMENTS = 28;
export const FOOT_SEGMENTS = 20;

/**
 * A ring before the volume solver has decided how much to inflate it.
 *
 * The outline is *not* materialised here, only `area` is. Relief responds to
 * body fat -- abdominal definition disappears under it, a love handle appears --
 * so the outline can only be resolved once lambda is known, and the caller gets
 * it from `rebuild` at that point. Resolving it late is safe precisely because
 * relief preserves area: it cannot invalidate the volume the solver balanced.
 *
 * It is also most of why a rebuild is cheap. The solver samples every stack
 * twice, once to calibrate and once to distribute, and neither pass needs an
 * outline -- so relief is evaluated exactly once per ring per body, on the way
 * out, instead of four times.
 */
export interface Ring {
  y: number;
  area: number;
  /** Fat affinity, the `w` of the volume solver. */
  fat: number;
  /** Where surplus goes: +1 depth, -1 width, 0 both. */
  bias: number;
  /** Centre of the ring. */
  cx: number;
  cz: number;
  /** Sagittal translation per unit of surplus scale: belly, buttocks. */
  project: number;
  /** How far the centre drifts outward as the ring inflates. */
  spread: number;
  /** Regenerate `base` for a given surplus. Area is unchanged by construction. */
  rebuild: (surplus: number) => number[];
}

/* ------------------------------- contours ------------------------------- */

/** A superellipse: 2 is a pure ellipse, higher is more slab-like. */
function superellipse(a: number, b: number, n: number, segments: number): number[] {
  const pts: number[] = new Array(segments * 2);
  const e = 2 / n;
  for (let j = 0; j < segments; j++) {
    const th = (2 * Math.PI * j) / segments;
    const c = Math.cos(th);
    const s = Math.sin(th);
    pts[j * 2] = a * Math.sign(c) * Math.pow(Math.abs(c), e);
    pts[j * 2 + 1] = b * Math.sign(s) * Math.pow(Math.abs(s), e);
  }
  return pts;
}

/** Shortest angular distance between two directions, in [0, PI]. */
function angleGap(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/**
 * Direction of each point of a contour, measured once. The outline of a ring
 * never changes between rebuilds -- only how hard the relief pushes on it --
 * so these are computed with the plain contour and reused.
 */
function contourAngles(pts: number[]): Float64Array {
  const angles = new Float64Array(pts.length / 2);
  for (let j = 0; j < angles.length; j++) {
    angles[j] = Math.atan2(pts[j * 2 + 1], pts[j * 2]);
  }
  return angles;
}

/** Accumulate one feature's radial push into a per-point field. */
function gather(
  field: Float64Array,
  angles: Float64Array,
  around: number,
  arc: number,
  amount: number,
): void {
  for (let j = 0; j < field.length; j++) {
    const g = angleGap(angles[j], around) / arc;
    if (g > 3) continue;
    field[j] += amount * Math.exp(-(g * g));
  }
}

/** Never let a hollow eat more than this fraction of the local radius. */
const MAX_HOLLOW = 0.55;

/**
 * Apply every relief that reaches height `t`. `surplus` is the local inflation
 * the solver applied, which is what fades muscle definition out under fat and
 * swells soft tissue in.
 *
 * The features are summed into one field first and their **mean is removed**
 * before anything moves. That matters more than it looks. Relief is a
 * redistribution of the surface, not an addition to it, and an arm carries
 * nothing but bulges — a bicep, a tricep, a deltoid, and no comparable
 * hollows. Applied as written they inflate the whole outline, and the area
 * renormalisation then shrinks it back uniformly, so the arm ends up *thinner*
 * than the dial asked for while the muscles barely show. Taking the mean out
 * first means a bicep pushes the front of the arm out and pulls its sides in,
 * which is both what a bicep does and what leaves the dial's silhouette alone.
 */
function applyRelief(
  pts: number[],
  angles: Float64Array,
  relief: Relief[],
  t: number,
  surplus: number,
): number[] {
  const n = pts.length / 2;
  const field = new Float64Array(n);
  let touched = false;

  for (const f of relief) {
    const dt = (t - f.at) / f.rise;
    if (Math.abs(dt) > 3) continue;
    const reach = Math.exp(-(dt * dt));
    // A feature can fade to nothing under fat but never invert.
    const gain = Math.max(0, 1 + (f.withFat ?? 0) * surplus);
    const amount = f.depth * reach * gain;
    if (Math.abs(amount) < 1e-4) continue;
    gather(field, angles, f.around, f.arc, amount);
    if (f.paired) gather(field, angles, Math.PI - f.around, f.arc, amount);
    touched = true;
  }
  if (!touched) return pts;

  let mean = 0;
  for (let j = 0; j < n; j++) mean += field[j];
  mean /= n;

  const area0 = polygonArea(pts);
  for (let j = 0; j < n; j++) {
    const k = Math.max(1 - MAX_HOLLOW, 1 + field[j] - mean);
    pts[j * 2] *= k;
    pts[j * 2 + 1] *= k;
  }

  // Removing the mean leaves only a second-order area error; clear it so the
  // volume the solver balanced is exactly the volume that gets built.
  const area1 = polygonArea(pts);
  if (area1 > 1e-12) {
    const k = Math.sqrt(area0 / area1);
    for (let j = 0; j < pts.length; j++) pts[j] *= k;
  }
  return pts;
}

/* -------------------------------- torso --------------------------------- */

const TORSO_STATIONS: (keyof TorsoShape)[] = [
  'crotch',
  'pelvis',
  'lowerBelly',
  'waist',
  'ribs',
  'chest',
  'armpit',
  'shoulder',
  'trapezius',
  'neckBase',
];

/** A Gaussian window, used to spread a scalar dial over a range of heights. */
function window(t: number, at: number, rise: number): number {
  const d = (t - at) / rise;
  return Math.exp(-(d * d));
}

export function torsoRings(torso: TorsoShape, H: number): Ring[] {
  const stations = TORSO_STATIONS.map((k) => torso[k] as Station);
  const ts = stations.map((s) => s.t);
  const at = (key: keyof Station) => stations.map((s) => s[key] as number);
  const widths = at('width');
  const depths = at('depth');
  const corners = at('corner');
  const shifts = at('shift');
  const fats = at('fat');
  const biases = at('bias');

  // The small of the back is a hollow, not a translation of the whole slice --
  // shifting the slice would carry the navel backwards with it.
  const lumbar: Relief = {
    name: 'lumbar',
    at: torso.lowerBelly.t + 0.033,
    rise: 0.030,
    around: ANGLE.back,
    arc: 0.62,
    depth: -torso.lumbarTuck / Math.max(1e-4, torso.waist.depth),
    withFat: -0.8,
  };
  const relief = [...torso.relief, lumbar];

  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  const rings: Ring[] = [];
  for (let i = 0; i < TORSO_RINGS; i++) {
    const t = t0 + ((t1 - t0) * i) / (TORSO_RINGS - 1);
    const a = spline(ts, widths, t) * H;
    const b = spline(ts, depths, t) * H;
    const corner = spline(ts, corners, t);

    // Belly forward, buttocks back. Both are translations of the slice, and
    // both grow with mass -- which is the difference between a heavier figure
    // and a uniformly scaled one.
    const bellyAt = window(t, torso.waist.t - 0.045, 0.075);
    const gluteAt = window(t, torso.pelvis.t, 0.045);
    const staticShift =
      spline(ts, shifts, t) * H +
      torso.bellyProjection * bellyAt * H -
      torso.gluteProjection * gluteAt * H;
    const project = (torso.bellyGain * bellyAt - torso.gluteGain * gluteAt) * H;

    const plain = superellipse(a, b, corner, TORSO_SEGMENTS);
    const angles = contourAngles(plain);
    const rebuild = (surplus: number) =>
      applyRelief(plain.slice(), angles, relief, t, surplus);

    rings.push({
      y: t * H,
      area: polygonArea(plain),
      fat: spline(ts, fats, t),
      bias: spline(ts, biases, t),
      cx: 0,
      cz: staticShift,
      project,
      spread: 0,
      rebuild,
    });
  }
  return rings;
}

/* -------------------------------- limbs --------------------------------- */

/** An ellipse: limbs are not round, and a hand is a paddle. */
function ellipse(r: number, flat: number, segments: number): number[] {
  const pts: number[] = new Array(segments * 2);
  for (let j = 0; j < segments; j++) {
    const th = (2 * Math.PI * j) / segments;
    pts[j * 2] = r * Math.cos(th);
    pts[j * 2 + 1] = r * flat * Math.sin(th);
  }
  return pts;
}

function limbRings(
  nodes: LimbNode[],
  relief: Relief[],
  H: number,
  count: number,
  spread: number,
): Ring[] {
  // Nodes are authored top-down; the spline wants ascending knots.
  const asc = [...nodes].sort((l, r) => l.t - r.t);
  const ts = asc.map((n) => n.t);
  const volumes = asc.map((n) => n.volume);
  const xs = asc.map((n) => n.x);
  const zs = asc.map((n) => n.z);
  const flats = asc.map((n) => n.flat);
  const fats = asc.map((n) => n.fat);

  const rings: Ring[] = [];
  for (let i = 0; i < count; i++) {
    const t = ts[0] + ((ts[ts.length - 1] - ts[0]) * i) / (count - 1);
    const r = Math.max(0.002, spline(ts, volumes, t)) * H;
    const flat = Math.max(0.2, spline(ts, flats, t));

    const plain = ellipse(r, flat, LIMB_SEGMENTS);
    const angles = contourAngles(plain);
    const rebuild = (surplus: number) =>
      applyRelief(plain.slice(), angles, relief, t, surplus);

    rings.push({
      y: t * H,
      area: polygonArea(plain),
      fat: spline(ts, fats, t),
      bias: 0,
      cx: spline(ts, xs, t) * H,
      cz: spline(ts, zs, t) * H,
      project: 0,
      spread,
      rebuild,
    });
  }
  return rings;
}

const ARM_NODES: (keyof ArmShape)[] = [
  'acromion',
  'deltoid',
  'bicep',
  'elbow',
  'forearm',
  'wrist',
  'knuckle',
  'fingertip',
];

const LEG_NODES: (keyof LegShapeKeys)[] = [
  'hipJoint',
  'glute',
  'thigh',
  'knee',
  'calf',
  'shin',
  'ankle',
];
type LegShapeKeys = ShapeParams['leg'];

export function armRings(arm: ArmShape, H: number): Ring[] {
  const nodes = ARM_NODES.map((k) => arm[k] as LimbNode);
  return limbRings(nodes, arm.relief, H, LIMB_RINGS, 0.35);
}

export function legRings(leg: ShapeParams['leg'], H: number): Ring[] {
  const nodes = LEG_NODES.map((k) => leg[k] as LimbNode);
  return limbRings(nodes, leg.relief, H, LIMB_RINGS, 0.4);
}

export function neckRings(neck: NeckShape, H: number): Ring[] {
  const count = 14;
  const rings: Ring[] = [];
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    const t = neck.base + (neck.top - neck.base) * u;
    // A neck is a column that narrows and leans forward as it rises.
    const r = (neck.width + (neck.topWidth - neck.width) * u) * H;
    const plain = ellipse(r, neck.flat, LIMB_SEGMENTS);
    const angles = contourAngles(plain);
    const rebuild = (surplus: number) =>
      applyRelief(plain.slice(), angles, neck.relief, t, surplus);
    rings.push({
      y: t * H,
      area: polygonArea(plain),
      fat: neck.fat,
      bias: 0,
      cx: 0,
      cz: (-neck.lean + 2 * neck.lean * u) * H,
      project: 0,
      spread: 0,
      rebuild,
    });
  }
  return rings;
}

/* --------------------------------- head --------------------------------- */

/**
 * The head, as a stack of rings rather than a bare ellipsoid: the cranium is
 * fuller at the back, the jaw holds a width so the neck has something to meet,
 * and the chin comes forward.
 */
export function headSections(head: HeadShape, H: number, calib: number, girth: number): Section[] {
  // The head barely tracks body mass; a light touch keeps proportions believable.
  const k = 1 + (girth - 1) * 0.16;
  const a = head.width * H * calib * k;
  const b = head.depth * H * calib * k;
  const c = head.height * H * k;

  const sections: Section[] = [];
  for (let i = 0; i < HEAD_RINGS; i++) {
    const phi = -Math.PI / 2 + (Math.PI * i) / (HEAD_RINGS - 1);
    const v = Math.sin(phi);
    let rf = Math.cos(phi);
    // An ellipsoid tapers to nothing at the chin, which leaves the neck wider
    // than the head it joins and shows as a collar. Hold a jaw width instead,
    // and only collapse it over the last sliver.
    if (v < 0) {
      const jaw =
        v > -0.9 ? head.jaw : head.jaw * Math.max(0, 1 - (-v - 0.9) / 0.1) ** 0.7;
      rf = Math.max(rf, jaw);
    }
    // Temples narrow, cheekbones don't: pinch the width a little above the jaw.
    const widthF = rf * (1 - 0.06 * Math.exp(-(((v - 0.2) / 0.28) ** 2)));

    const ring = superellipse(
      Math.max(1e-4, a * widthF),
      Math.max(1e-4, b * rf),
      2.1,
      HEAD_SEGMENTS,
    );

    // Skulls are not front-back symmetric: the occiput swells behind, the chin
    // juts forward, the brow sits over a slightly recessed mid-face.
    const occiput = -head.occiput * b * Math.exp(-(((v - 0.15) / 0.5) ** 2));
    const chin = head.chin * b * Math.exp(-(((v + 0.68) / 0.26) ** 2));
    const zShift = head.shift * H + occiput + chin;
    for (let j = 1; j < ring.length; j += 2) ring[j] += zShift;

    sections.push({ p: head.t * H + v * c, pts: ring });
  }
  return sections;
}

/** Ears. Small, but they are most of what says "head" rather than "egg". */
export function earSections(head: HeadShape, H: number, calib: number): Section[][] {
  const c = head.height * H;
  const a = head.width * H * calib;
  const b = head.depth * H * calib;
  const earH = head.ear * H * 2.1;
  const earY = head.t * H - c * 0.1;
  const earX = a * 0.95;
  const earZ = head.shift * H - b * 0.16;
  const earOut = head.ear * H * calib * 0.4;
  const earDepth = head.ear * H * calib * 0.58;

  return [1, -1].map((side) => {
    const ear: Section[] = [];
    const steps = 9;
    for (let i = 0; i < steps; i++) {
      const u = i / (steps - 1);
      // Rounder at the top than at the lobe, so it reads as an ear and not a leaf.
      const bulge = Math.max(0.08, Math.sin(Math.PI * Math.min(1, u * 1.12)) ** 0.5);
      const pts = superellipse(earOut * bulge, earDepth * bulge, 2.2, 14);
      for (let j = 0; j < pts.length; j += 2) {
        pts[j] += side * earX;
        pts[j + 1] += earZ;
      }
      ear.push({ p: earY - earH / 2 + u * earH, pts });
    }
    return ear;
  });
}

/* --------------------------------- foot --------------------------------- */

/**
 * A foot, swept from heel to toe. Three things separate this from a wedge: the
 * medial arch lifts clear of the floor, the forefoot is wider than the heel and
 * splays outward, and the toe end is a rounded block rather than a point.
 *
 * Sections sweep along z, so within a section `u` is lateral and `v` is up.
 */
export function footSections(foot: FootShape, H: number, calib: number, x: number): Section[] {
  const L = foot.length * H;
  const hh = foot.height * H * calib;
  const hw = foot.width * H * calib;
  const heel = foot.heel * H;

  // [along the foot, width, height, how much of the sole is lifted, toe block]
  //
  // The instep is the tallest part and sits just ahead of the ankle; the foot
  // then falls away to the ball and finishes in a blunt toe box. A foot that
  // tapers to a point from the ankle is the single thing that makes a figure
  // look like it is standing on wedges.
  const keys: [number, number, number, number, number][] = [
    [0.00, 0.62, 0.58, 0.0, 0.0],
    [0.08, 0.88, 0.92, 0.0, 0.0],
    [0.18, 0.98, 1.00, 0.2, 0.0],
    [0.34, 0.94, 0.88, 1.0, 0.0],
    [0.52, 0.96, 0.70, 0.9, 0.0],
    [0.68, 1.00, 0.54, 0.3, 0.3],
    [0.82, 1.00, 0.44, 0.0, 1.0],
    [0.93, 0.97, 0.39, 0.0, 1.0],
    [1.00, 0.86, 0.35, 0.0, 0.9],
  ];

  return keys.map(([u, wf, hf, lift, toes]) => {
    const ball = 1 + (foot.ball - 1) * Math.max(0, Math.min(1, (u - 0.4) / 0.28));
    const halfW = (hw / 2) * wf * ball;
    const halfH = (hh / 2) * hf;
    // Squarer through the toe box, rounder at the heel.
    const pts = superellipse(halfW, halfH, 3.0 + toes * 1.4, FOOT_SEGMENTS);

    // Lift the inner half of the sole into an arch. The foot is built for the
    // right side and mirrored, so the midline side is -u.
    if (lift > 0 && foot.arch > 0) {
      const cut = foot.arch * lift * halfH;
      for (let j = 0; j < pts.length; j += 2) {
        if (pts[j + 1] >= 0) continue;
        const medial = Math.max(0, -pts[j] / halfW);
        pts[j + 1] += cut * medial * (-pts[j + 1] / halfH);
      }
    }

    // The big toe carries more height and depth than the rest of the row, so
    // the toe end is asymmetric rather than a rounded brick.
    if (toes > 0) {
      for (let j = 0; j < pts.length; j += 2) {
        const medial = Math.max(0, -pts[j] / halfW);
        pts[j + 1] *= 1 + 0.22 * toes * medial;
      }
    }

    // Sit the sole on the floor, then splay the forefoot outwards.
    for (let j = 0; j < pts.length; j += 2) {
      pts[j + 1] += halfH;
      pts[j] += x + Math.sin(foot.splay) * L * Math.max(0, u - 0.25);
    }
    return { p: -heel + u * L, pts };
  });
}
