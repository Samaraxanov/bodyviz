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
/**
 * Arms are sampled finer than legs, and only because of the hand. A leg is an
 * ellipse that changes slowly and 28 segments draw it exactly; a hand carries
 * a thumb, a knuckle row and three finger gaps, and the gaps are the binding
 * constraint. 36 specifically, and not 34 or 38: the gaps are placed at
 * multiples of 2*PI/9 around an evenly spaced outline, so a multiple of 9 is
 * what centres each of them on a vertex -- anything else drops them between
 * vertices, where they become noise instead of fingers. The extra density is
 * confined to the arms, so the legs, which are the larger stacks, pay nothing.
 *
 * Along the limb the hand is only a tenth of the arm's length, and the ring
 * count has to fit a palm, a knuckle row and a finger block inside that tenth:
 * 72 gives it seven rings, 56 gave it five.
 */
export const ARM_RINGS = 72;
export const ARM_SEGMENTS = 36;
export const HEAD_RINGS = 46;
export const HEAD_SEGMENTS = 32;
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

/**
 * Resample a closed contour to `segments` points spaced evenly along it.
 *
 * Sampling a superellipse at uniform parameter is fine while it is roughly
 * round, and wrong as soon as it is not. On the 3.6:1 slab a finger row wants,
 * uniform parameter spends six of its ten points per quadrant on the outer
 * quarter of the face and leaves the whole inner half to two of them -- so the
 * face shades in bands, and no feature can be placed across it, because across
 * most of it there is nothing to move. Even spacing puts the points where the
 * surface is, which is what makes the finger gaps possible at all.
 */
function byArcLength(pts: number[], segments: number): number[] {
  const n = pts.length / 2;
  const cum = new Float64Array(n + 1);
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    const du = pts[k * 2] - pts[j * 2];
    const dv = pts[k * 2 + 1] - pts[j * 2 + 1];
    // Math.hypot guards against overflow that cannot happen at these
    // magnitudes and costs several times a plain sqrt; this runs once per
    // oversampled point on every ring of every rebuild.
    cum[j + 1] = cum[j] + Math.sqrt(du * du + dv * dv);
  }
  const total = cum[n];
  const out: number[] = new Array(segments * 2);
  let seg = 0;
  for (let i = 0; i < segments; i++) {
    const target = (total * i) / segments;
    while (seg < n - 1 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg];
    const f = span > 1e-12 ? (target - cum[seg]) / span : 0;
    const k = (seg + 1) % n;
    out[i * 2] = pts[seg * 2] + (pts[k * 2] - pts[seg * 2]) * f;
    out[i * 2 + 1] = pts[seg * 2 + 1] + (pts[k * 2 + 1] - pts[seg * 2 + 1]) * f;
  }
  return out;
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

/**
 * Accumulate one feature's radial push into a per-point field.
 *
 * `where` is either the direction of each point or its position along the
 * outline, both wrapped to 2*PI -- see `Relief.alongContour`. On a round
 * section the two are the same thing; on a flat one they are not, and which
 * one a feature wants depends on whether it is pinned to a direction (a bicep
 * faces forward) or spaced across a surface (the gaps between four fingers).
 */
function gather(
  field: Float64Array,
  where: Float64Array,
  around: number,
  arc: number,
  amount: number,
): void {
  for (let j = 0; j < field.length; j++) {
    const g = angleGap(where[j], around) / arc;
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
  along: Float64Array | null,
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
    const where = f.alongContour && along ? along : angles;
    gather(field, where, f.around, f.arc, amount);
    if (f.paired) gather(field, where, Math.PI - f.around, f.arc, amount);
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
      applyRelief(plain.slice(), angles, null, relief, t, surplus);

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

/**
 * A limb cross-section: half-width `r`, half-depth `r * flat`, and `corner`
 * deciding how squarely the two meet. At 2 this is the plain ellipse a thigh
 * or a forearm wants; the hand takes it past 3, which is what gives a palm a
 * back, a front and two edges instead of the lens an ellipse makes of it.
 */
function limbSection(r: number, flat: number, corner: number, segments: number): number[] {
  // Drawn dense and then spaced evenly around its own outline; `byArcLength`
  // says why. The error in a resampled point falls with the square of the
  // chord spacing, so 3x is already well under a tenth of a millimetre, and
  // every extra multiple is two more Math.pow per point on every ring.
  return byArcLength(superellipse(r, r * flat, corner, segments * 3), segments);
}

/**
 * Position of each point *along* the contour, scaled to 2*PI so it can be
 * written and compared exactly like a direction. Points are evenly spaced by
 * construction, so this is just the index -- which is the whole point: a
 * feature placed here lands on a vertex, and `ARM_SEGMENTS` is chosen so the
 * finger gaps do.
 */
function contourPositions(segments: number): Float64Array {
  const out = new Float64Array(segments);
  for (let j = 0; j < segments; j++) out[j] = (2 * Math.PI * j) / segments;
  return out;
}

function limbRings(
  nodes: LimbNode[],
  relief: Relief[],
  H: number,
  count: number,
  spread: number,
  segments: number,
): Ring[] {
  // Nodes are authored top-down; the spline wants ascending knots.
  const asc = [...nodes].sort((l, r) => l.t - r.t);
  const ts = asc.map((n) => n.t);
  const volumes = asc.map((n) => n.volume);
  const xs = asc.map((n) => n.x);
  const zs = asc.map((n) => n.z);
  const flats = asc.map((n) => n.flat);
  const corners = asc.map((n) => n.corner ?? 2);
  const rolls = asc.map((n) => n.roll ?? 0);
  const fats = asc.map((n) => n.fat);

  const along = contourPositions(segments);
  const rings: Ring[] = [];
  for (let i = 0; i < count; i++) {
    const t = ts[0] + ((ts[ts.length - 1] - ts[0]) * i) / (count - 1);
    const r = Math.max(0.002, spline(ts, volumes, t)) * H;
    const flat = Math.max(0.2, spline(ts, flats, t));
    const corner = Math.max(2, spline(ts, corners, t));

    const plain = limbSection(r, flat, corner, segments);
    const angles = contourAngles(plain);

    // Relief is authored in the limb's own frame -- a thumb is on the thumb
    // side whatever the wrist is doing -- so the roll is applied after it, to
    // the finished contour. The scale the solver applies later is uniform on a
    // limb, so it commutes with the rotation and the area survives untouched.
    const roll = spline(ts, rolls, t);
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const rebuild = (surplus: number) => {
      const pts = applyRelief(plain.slice(), angles, along, relief, t, surplus);
      if (roll === 0) return pts;
      for (let j = 0; j < pts.length; j += 2) {
        const u = pts[j];
        const v = pts[j + 1];
        pts[j] = u * cos - v * sin;
        pts[j + 1] = u * sin + v * cos;
      }
      return pts;
    };

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
  'palm',
  'knuckle',
  'fingers',
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
  return limbRings(nodes, arm.relief, H, ARM_RINGS, 0.35, ARM_SEGMENTS);
}

export function legRings(leg: ShapeParams['leg'], H: number): Ring[] {
  const nodes = LEG_NODES.map((k) => leg[k] as LimbNode);
  return limbRings(nodes, leg.relief, H, LIMB_RINGS, 0.4, LIMB_SEGMENTS);
}

export function neckRings(neck: NeckShape, H: number): Ring[] {
  const count = 14;
  const rings: Ring[] = [];
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    const t = neck.base + (neck.top - neck.base) * u;
    // A neck is a column that narrows and leans forward as it rises.
    const r = (neck.width + (neck.topWidth - neck.width) * u) * H;
    const plain = limbSection(r, neck.flat, 2, LIMB_SEGMENTS);
    const angles = contourAngles(plain);
    const rebuild = (surplus: number) =>
      applyRelief(plain.slice(), angles, null, neck.relief, t, surplus);
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
 * Head stations, from under the jaw (u = 0) to the vertex (u = 1): half-width
 * and half-depth as fractions of the head's own, the sagittal shift of the
 * slice centre as a fraction of half-depth, and the superellipse exponent.
 *
 * The head used to be an ellipsoid with a width floor bolted underneath to stop
 * it tapering to a point. That is why it read as an egg: a cranium and a face
 * are different shapes and an ellipsoid is neither of them. The cranium is
 * widest well above the ears and nearly spherical; the face narrows from the
 * cheekbones down to a chin; and the two meet at a jaw that is squarer in
 * section than anything above it.
 *
 * `shift` is the column doing the quiet work. The mandible hangs *forward* of
 * the cervical spine, and without that the chin lands behind the throat -- so
 * the neck reads as a collar swallowing the jaw, which is precisely what the
 * old head did in profile. The first station is deliberately tucked back and
 * small: it is buried inside the neck, and only the stations above it emerge.
 */
//                  u     width  depth  shift  corner
const HEAD_PROFILE: [number, number, number, number, number][] = [
  [0.000, 0.18, 0.24, 0.14, 2.50],
  [0.050, 0.42, 0.46, 0.30, 2.60],
  [0.100, 0.58, 0.58, 0.28, 2.70],
  [0.160, 0.70, 0.70, 0.24, 2.70],
  [0.260, 0.80, 0.82, 0.16, 2.60],
  [0.380, 0.91, 0.91, 0.08, 2.40],
  [0.500, 0.97, 0.97, 0.02, 2.30],
  [0.620, 0.99, 1.00, -0.02, 2.20],
  [0.740, 1.00, 0.99, -0.05, 2.15],
  [0.860, 0.89, 0.88, -0.05, 2.10],
  [0.940, 0.68, 0.66, -0.04, 2.05],
  [0.985, 0.34, 0.33, -0.04, 2.00],
  [1.000, 0.10, 0.10, -0.04, 2.00],
];

/**
 * The features that turn a skull-shaped solid into a face. Heights are in the
 * head's own u, so they move with the head rather than with stature.
 */
function headRelief(head: HeadShape): Relief[] {
  return [
    { name: 'occiput', at: 0.720, rise: 0.160, around: ANGLE.back, arc: 0.95, depth: head.occiput * 1.5 },
    { name: 'temple', at: 0.585, rise: 0.055, around: ANGLE.side, arc: 0.28, depth: -0.035, paired: true },
    { name: 'brow', at: 0.545, rise: 0.040, around: ANGLE.front, arc: 0.55, depth: 0.038 },
    { name: 'eyeSocket', at: 0.495, rise: 0.028, around: ANGLE.front + 0.46, arc: 0.22, depth: -0.035, paired: true },
    { name: 'noseBridge', at: 0.475, rise: 0.055, around: ANGLE.front, arc: 0.17, depth: 0.042 },
    { name: 'nose', at: 0.400, rise: 0.055, around: ANGLE.front, arc: 0.17, depth: 0.085 },
    { name: 'nostril', at: 0.335, rise: 0.028, around: ANGLE.front, arc: 0.21, depth: 0.045 },
    { name: 'cheekbone', at: 0.400, rise: 0.055, around: ANGLE.front + 0.82, arc: 0.34, depth: 0.040, paired: true },
    { name: 'mouth', at: 0.270, rise: 0.026, around: ANGLE.front, arc: 0.20, depth: 0.030 },
    { name: 'jawAngle', at: 0.215, rise: 0.048, around: ANGLE.front + 1.32, arc: 0.32, depth: 0.045 * head.jaw, paired: true },
    { name: 'chin', at: 0.120, rise: 0.040, around: ANGLE.front, arc: 0.34, depth: head.chin * 1.2 },
  ];
}

/**
 * Head relief, applied in place. Unlike the torso's this is deliberately *not*
 * renormalised back to the contour's original area. The head sits outside the
 * volume solver -- it barely tracks body mass at all -- so a nose is free to
 * add the few millilitres a nose adds. Area-preserving relief would pull the
 * cheeks in by exactly as much as it pushed the nose out, which is how you get
 * a face that looks pinched around a beak.
 */
function applyHeadRelief(pts: number[], relief: Relief[], u: number): void {
  const angles = contourAngles(pts);
  const n = pts.length / 2;
  const field = new Float64Array(n);
  let touched = false;

  for (const f of relief) {
    const dt = (u - f.at) / f.rise;
    if (Math.abs(dt) > 3) continue;
    const amount = f.depth * Math.exp(-(dt * dt));
    if (Math.abs(amount) < 1e-4) continue;
    gather(field, angles, f.around, f.arc, amount);
    if (f.paired) gather(field, angles, Math.PI - f.around, f.arc, amount);
    touched = true;
  }
  if (!touched) return;

  for (let j = 0; j < n; j++) {
    const k = Math.max(1 - MAX_HOLLOW, 1 + field[j]);
    pts[j * 2] *= k;
    pts[j * 2 + 1] *= k;
  }
}

/** Where the ear canal sits in head-u: behind and a little below the eyes. */
const EAR_AT = 0.44;

/** Ear outline from lobe (0) to the top of the helix (1). */
const EAR_PROFILE_U = [0.00, 0.10, 0.25, 0.45, 0.65, 0.82, 0.93, 1.00];
const EAR_PROFILE_R = [0.20, 0.50, 0.76, 0.93, 1.00, 0.94, 0.72, 0.28];

export function headSections(head: HeadShape, H: number, calib: number, girth: number): Section[] {
  // The head barely tracks body mass; a light touch keeps proportions believable.
  const k = 1 + (girth - 1) * 0.16;
  const a = head.width * H * calib * k;
  const b = head.depth * H * calib * k;
  const c = head.height * H * k;
  const bottom = head.t * H - c;
  const span = 2 * c;

  const us = HEAD_PROFILE.map((r) => r[0]);
  const ws = HEAD_PROFILE.map((r) => r[1]);
  const ds = HEAD_PROFILE.map((r) => r[2]);
  const zs = HEAD_PROFILE.map((r) => r[3]);
  const ns = HEAD_PROFILE.map((r) => r[4]);
  const relief = headRelief(head);

  const sections: Section[] = [];
  for (let i = 0; i < HEAD_RINGS; i++) {
    const u = i / (HEAD_RINGS - 1);
    // The jaw dial broadens or narrows the lower face and leaves the skull
    // alone -- a heavy jaw is a different face, not a different sized head.
    const jawF = 1 + (head.jaw - 0.85) * 1.1 * Math.max(0, 1 - u / 0.42);

    const ring = superellipse(
      Math.max(1e-4, a * spline(us, ws, u) * jawF),
      Math.max(1e-4, b * spline(us, ds, u)),
      spline(us, ns, u),
      HEAD_SEGMENTS,
    );
    applyHeadRelief(ring, relief, u);

    const zShift = head.shift * H + spline(us, zs, u) * b;
    for (let j = 1; j < ring.length; j += 2) ring[j] += zShift;

    sections.push({ p: bottom + u * span, pts: ring });
  }
  return sections;
}

/** Ears. Small, but they are most of what says "head" rather than "egg". */
export function earSections(head: HeadShape, H: number, calib: number, girth = 1): Section[][] {
  const k = 1 + (girth - 1) * 0.16;
  const a = head.width * H * calib * k;
  const b = head.depth * H * calib * k;
  const c = head.height * H * k;
  const bottom = head.t * H - c;
  const span = 2 * c;

  const earH = head.ear * H * 2.4;
  const midY = bottom + EAR_AT * span;
  // Against the widest part of the lower skull, and well behind mid-depth: the
  // canal sits behind the eye line, not level with it.
  const earX = a * 0.93;
  const earZ = head.shift * H - b * 0.20;
  const out = head.ear * H * calib * 0.44;
  const deep = head.ear * H * calib * 0.62;

  return [1, -1].map((side) => {
    const ear: Section[] = [];
    const steps = 13;
    for (let i = 0; i < steps; i++) {
      const u = i / (steps - 1);
      // Fullest through the upper helix and tapering to a small lobe. A
      // symmetric bulge -- widest in the middle, pointed at both ends -- is
      // what made the old ear read as a leaf stuck on the side of the skull.
      const f = spline(EAR_PROFILE_U, EAR_PROFILE_R, u);
      const pts = superellipse(out * f, deep * f, 2.3, 14);
      // Rake the whole thing backwards as it rises, and let it stand slightly
      // further off the skull at the helix than at the lobe.
      for (let j = 0; j < pts.length; j += 2) {
        pts[j] += side * (earX + out * 0.30 * f);
        pts[j + 1] += earZ - b * 0.10 * u;
      }
      ear.push({ p: midY - earH * 0.45 + u * earH, pts });
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
