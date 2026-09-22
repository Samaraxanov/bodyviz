/**
 * (height, weight, sex) -> a watertight body mesh.
 *
 * The pipeline, in order:
 *
 *     height / weight / sex
 *            |
 *     shape parameters        anthropometry.ts -- named dials for a lean body
 *            |
 *     calibration             make the lean shape weigh BMI_REF at this height
 *            |
 *     mass distribution       one lambda, spread over the dials by affinity
 *            |
 *     cross-sections          sections.ts -- stations interpolated, relief laid on
 *            |
 *     mesh + baked occlusion
 *
 * The distribution step is the interesting one and it has a closed form. The
 * shape gives a baseline volume V0; the user's mass implies a target Vt. Every
 * dial carries a fat affinity `w`, and scaling a dial by s = sqrt(1 + lambda*w)
 * scales the area it controls by exactly (1 + lambda*w). Volume is therefore
 * *linear* in lambda, so the lambda that reproduces Vt is one division -- no
 * iteration, no search. The affinities are the sex-specific fat pattern, so the
 * same 3 kg lands on a man's waist and a woman's hips.
 *
 * Two things are deliberately kept out of that sum. Relief (sections.ts) is
 * area-preserving, so muscle and grooves cannot disturb the balance. And `bias`
 * only chooses whether a dial's surplus goes into width or depth, which leaves
 * the area alone. Both can therefore be resolved *after* lambda is known, which
 * is what lets a belly project forward and abdominal definition disappear under
 * it without any of it being re-solved.
 */

import {
  LANDMARK,
  Sex,
  ShapeParams,
  Station,
  bodyDensity,
  shapeFor,
} from './anthropometry';
import {
  LIMB_SEGMENTS,
  Ring,
  armRings,
  earSections,
  footSections,
  headSections,
  legRings,
  neckRings,
  torsoRings,
} from './sections';
import { MeshBuilder, MeshData, Section, polygonPerimeter } from './mesh';
import { Proxy, bakeOcclusion, proxyFromSections } from './occlusion';

export interface BodyInput {
  heightCm: number;
  weightKg: number;
  sex: Sex;
}

export interface BodyMetrics {
  bmi: number;
  /** Target body volume in litres. */
  volumeL: number;
  /** Circumferences in centimetres, measured off the generated mesh. */
  chest: number;
  waist: number;
  hip: number;
  thigh: number;
  upperArm: number;
  /** Waist-to-hip ratio — the shape number BMI can't see. */
  whr: number;
  /** Total model height in metres (== heightCm / 100). */
  height: number;
}

export interface BodyResult extends MeshData {
  /** Baked ambient occlusion, one grey triple per vertex. */
  colors: Float32Array;
  metrics: BodyMetrics;
  /** Solver internals, handy when retuning the shapes. */
  debug: { calib: number; lambda: number; refVolumeL: number };
}

/* --------------------------- tuning constants --------------------------- */

/** Keeps extreme inputs from producing a mesh that self-destructs. */
const MIN_SCALE = 0.62;
const MAX_SCALE = 2.3;

/**
 * How strongly `Station.bias` skews a slice as it inflates. At 0.45 a waist
 * with bias 0.6 on a heavy figure ends up about a sixth deeper and a sixth
 * narrower than an evenly inflated one — an belly rather than a barrel.
 * Area, and therefore mass, is identical either way.
 */
const BIAS_GAIN = 0.45;

/**
 * How much of an arm is allowed to disappear inside the torso, as a fraction of
 * its own diameter, from the shoulder down to the hand. The upper arm really
 * does lie against the ribs and is mostly hidden there; a forearm beside a hip
 * is not. Anything the body would bury deeper than this is pushed out until it
 * isn't.
 */
const ARM_BURY_SHOULDER = 0.78;
const ARM_BURY_HAND = 0.12;

/**
 * The BMI the authored shape is meant to depict. Dials are auto-calibrated so
 * the untouched shape really does weigh this much, which means the numbers in
 * anthropometry.ts only ever control *proportion*, never absolute size.
 */
const BMI_REF = 21.5;

/**
 * Fat loss is less regionally selective than fat gain, so weight contrast is
 * damped when the solver has to remove volume rather than add it.
 */
const LOSS_CONTRAST = 0.6;

/** Measurement heights (fraction of stature) used for the reported girths. */
const MEASURE = {
  chest: LANDMARK.chest,
  waist: LANDMARK.waist,
  hip: LANDMARK.hip,
  thigh: LANDMARK.midThigh,
  upperArm: LANDMARK.upperArm,
};

/* ----------------------------- calibration ------------------------------ */

/**
 * Scale every girth dial by `k`, leaving the skeleton alone.
 *
 * Heights, and the lengths measured along a limb, are set by stature and must
 * not move; everything cross-sectional does. Doing the calibration on the dials
 * rather than on the finished rings is what keeps relief correct — relief is
 * expressed as a fraction of the local radius, so it has to be generated from
 * dials that are already the right size.
 */
function calibrateShape(shape: ShapeParams, k: number): ShapeParams {
  const station = (s: Station): Station => ({
    ...s,
    width: s.width * k,
    depth: s.depth * k,
    shift: s.shift * k,
  });
  const t = shape.torso;
  const limb = <T extends { x: number; z: number; volume: number }>(n: T): T => ({
    ...n,
    x: n.x * k,
    z: n.z * k,
    volume: n.volume * k,
  });

  return {
    torso: {
      ...t,
      crotch: station(t.crotch),
      pelvis: station(t.pelvis),
      lowerBelly: station(t.lowerBelly),
      waist: station(t.waist),
      ribs: station(t.ribs),
      chest: station(t.chest),
      armpit: station(t.armpit),
      shoulder: station(t.shoulder),
      trapezius: station(t.trapezius),
      neckBase: station(t.neckBase),
      bellyProjection: t.bellyProjection * k,
      gluteProjection: t.gluteProjection * k,
      lumbarTuck: t.lumbarTuck * k,
    },
    arm: {
      ...shape.arm,
      acromion: limb(shape.arm.acromion),
      deltoid: limb(shape.arm.deltoid),
      bicep: limb(shape.arm.bicep),
      elbow: limb(shape.arm.elbow),
      forearm: limb(shape.arm.forearm),
      wrist: limb(shape.arm.wrist),
      knuckle: limb(shape.arm.knuckle),
      fingertip: limb(shape.arm.fingertip),
    },
    leg: {
      ...shape.leg,
      hipJoint: limb(shape.leg.hipJoint),
      glute: limb(shape.leg.glute),
      thigh: limb(shape.leg.thigh),
      knee: limb(shape.leg.knee),
      calf: limb(shape.leg.calf),
      shin: limb(shape.leg.shin),
      ankle: limb(shape.leg.ankle),
    },
    neck: {
      ...shape.neck,
      width: shape.neck.width * k,
      topWidth: shape.neck.topWidth * k,
      lean: shape.neck.lean * k,
    },
    head: {
      ...shape.head,
      width: shape.head.width * k,
      depth: shape.head.depth * k,
    },
    foot: {
      ...shape.foot,
      height: shape.foot.height * k,
      width: shape.foot.width * k,
    },
  };
}

/* ------------------------------- volume --------------------------------- */

interface Stacks {
  torso: Ring[];
  arm: Ring[];
  leg: Ring[];
  neck: Ring[];
}

function sampleAll(shape: ShapeParams, H: number): Stacks {
  return {
    torso: torsoRings(shape.torso, H),
    arm: armRings(shape.arm, H),
    leg: legRings(shape.leg, H),
    neck: neckRings(shape.neck, H),
  };
}

/**
 * Prismatoid volume of a ring stack, restricted to segments whose midpoint sits
 * inside [yMin, yMax]. The clipping is how we stop limb volume from being
 * double-counted where a limb is buried inside the torso.
 */
function stackVolume(rings: Ring[], yMin: number, yMax: number): { v0: number; q: number } {
  let v0 = 0;
  let q = 0;
  for (let i = 0; i < rings.length - 1; i++) {
    const lo = rings[i];
    const hi = rings[i + 1];
    const mid = (lo.y + hi.y) / 2;
    if (mid < yMin || mid > yMax) continue;
    const d = (hi.y - lo.y) / 2;
    v0 += d * (lo.area + hi.area);
    q += d * (lo.area * lo.fat + hi.area * hi.fat);
  }
  return { v0, q };
}

function headVolume(shape: ShapeParams, H: number): number {
  const { width, depth, height } = shape.head;
  // Ellipsoid, discounted for the jaw taper and the part buried in the neck.
  return (4 / 3) * Math.PI * width * depth * height * H ** 3 * 0.84;
}

function footVolume(shape: ShapeParams, H: number): number {
  const f = shape.foot;
  return f.length * f.height * f.width * H ** 3 * 2.0 * 0.62;
}

function measureStacks(s: Stacks, H: number, torsoBottom: number, torsoTop: number) {
  const INF = Number.POSITIVE_INFINITY;
  const vT = stackVolume(s.torso, -INF, INF);
  const vA = stackVolume(s.arm, -INF, 0.775 * H);
  const vL = stackVolume(s.leg, -INF, torsoBottom);
  const vN = stackVolume(s.neck, torsoTop, INF);
  return {
    v0: vT.v0 + 2 * vA.v0 + 2 * vL.v0 + vN.v0,
    q: vT.q + 2 * vA.q + 2 * vL.q + vN.q,
  };
}

/* ------------------------------ mesh parts ------------------------------ */

/**
 * Turn rings into sections at the scale the solver decided on.
 *
 * Three things happen here, in this order, and the order matters: relief is
 * regenerated for the local fatness, the outline is scaled to carry its share
 * of the mass, and `bias` skews that scale between width and depth without
 * changing the area it just set.
 */
function shapedSections(rings: Ring[], scales: number[], pushX?: number[]): Section[] {
  return rings.map((ring, i) => {
    const s = scales[i];
    const surplus = Math.max(0, s - 1);
    const pts = ring.rebuild(surplus);
    const skew = Math.exp(ring.bias * BIAS_GAIN * surplus);
    const cx = ring.cx * (1 + ring.spread * surplus) + (pushX?.[i] ?? 0);
    const cz = ring.cz + ring.project * surplus;
    for (let j = 0; j < pts.length; j += 2) {
      pts[j] = (pts[j] * s) / skew + cx;
      pts[j + 1] = pts[j + 1] * s * skew + cz;
    }
    return { p: ring.y, pts };
  });
}

/**
 * The widest point of a ring stack at a given height, interpolated between
 * rings. Used to keep the arms outside the body rather than inside it.
 */
function silhouette(sections: Section[]): (y: number) => number {
  const ys = sections.map((s) => s.p);
  const xs = sections.map((s) => {
    let m = 0;
    for (let j = 0; j < s.pts.length; j += 2) m = Math.max(m, Math.abs(s.pts[j]));
    return m;
  });
  return (y: number) => {
    if (y <= ys[0] || y >= ys[ys.length - 1]) return 0;
    let i = 0;
    while (i < ys.length - 2 && ys[i + 1] < y) i++;
    const span = ys[i + 1] - ys[i];
    const f = span > 0 ? (y - ys[i]) / span : 0;
    return xs[i] + (xs[i + 1] - xs[i]) * f;
  };
}

/* -------------------------------- driver -------------------------------- */

export function buildBody({ heightCm, weightKg, sex }: BodyInput): BodyResult {
  const H = heightCm / 100;
  const bmi = weightKg / (H * H);
  const targetVolume = weightKg / (bodyDensity(bmi) * 1000); // m^3

  const lean = shapeFor(sex);
  const torsoBottom = lean.torso.crotch.t * H;
  const torsoTop = lean.torso.neckBase.t * H;

  /* -- 1. calibrate the authored shape to weigh exactly BMI_REF at this height -- */

  const raw = measureStacks(sampleAll(lean, H), H, torsoBottom, torsoTop);
  const rawFixed = headVolume(lean, H) + footVolume(lean, H);
  const refVolume = (BMI_REF * H * H) / (bodyDensity(BMI_REF) * 1000);
  const calib = Math.sqrt(Math.max(1e-6, refVolume / (raw.v0 + rawFixed)));

  const shape = calibrateShape(lean, calib);
  const stacks = sampleAll(shape, H);
  const { torso, arm, leg, neck } = stacks;

  /* -- 2. distribute the surplus (or deficit) implied by the user's mass -- */

  const cal = measureStacks(stacks, H, torsoBottom, torsoTop);
  const fixed = headVolume(shape, H) + footVolume(shape, H);
  const v0 = cal.v0 + fixed;
  // Volume-weighted mean affinity, so lambda has a clean physical meaning: at
  // w = 1 a dial scales by exactly sqrt(target / reference).
  const meanW = cal.q / cal.v0;
  const lambda = cal.q > 0 ? ((targetVolume - v0) * meanW) / cal.q : 0;
  const contrast = lambda < 0 ? LOSS_CONTRAST : 1;

  const scaleFor = (r: Ring) => {
    const w = 1 + (r.fat / meanW - 1) * contrast;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.sqrt(Math.max(0.05, 1 + lambda * w))));
  };

  const torsoScales = torso.map(scaleFor);
  const armScales = arm.map(scaleFor);
  const legScales = leg.map(scaleFor);
  const neckScales = neck.map(scaleFor);

  const torsoSections = shapedSections(torso, torsoScales);
  const legSections = shapedSections(leg, legScales);
  const neckSections = shapedSections(neck, neckScales);

  /* -- 3. assemble -- */

  const shoulderIdx = torso.reduce(
    (best, r, i) =>
      Math.abs(r.y - LANDMARK.shoulder * H) < Math.abs(torso[best].y - LANDMARK.shoulder * H)
        ? i
        : best,
    0,
  );

  // Arms hang beside the body, not inside it: as the torso and thighs broaden,
  // the arm swings out to stay clear. Without this the forearms of a heavier
  // figure disappear into the hips.
  //
  // The swing is driven by how deeply the body would bury the arm, not by a
  // fixed stand-off. A fixed stand-off pushes the upper arm outboard of the
  // *chest*, which makes the figure widest at the armpits instead of at the
  // deltoids -- the loudest way to read as a slab with sticks attached rather
  // than as a body. The shoulder end is exempt either way: its taper is meant
  // to sit under the deltoid.
  const torsoEdge = silhouette(torsoSections);
  const legEdge = silhouette(legSections);
  const swingIn = LANDMARK.shoulder * H;
  const swingFull = (LANDMARK.shoulder - 0.03) * H;
  const armTop = arm[arm.length - 1].y;
  const armPush = arm.map((ring, i) => {
    if (ring.y >= swingIn) return 0;
    const radius = Math.sqrt(ring.area / Math.PI) * armScales[i];
    const down = Math.min(1, Math.max(0, (armTop - ring.y) / (armTop - LANDMARK.hip * H)));
    const bury = ARM_BURY_SHOULDER + (ARM_BURY_HAND - ARM_BURY_SHOULDER) * down;
    const clearance = Math.max(torsoEdge(ring.y), legEdge(ring.y)) + radius * (1 - 2 * bury);
    const blend = ring.y <= swingFull ? 1 : (swingIn - ring.y) / (swingIn - swingFull);
    return Math.max(0, clearance - ring.cx) * blend;
  });
  const armSections = shapedSections(arm, armScales, armPush);

  const mb = new MeshBuilder();
  // Every part records the vertices it owns, so occlusion can tell "close to
  // another part" (a real crease) from "close to myself" (just curvature).
  const PART = { torso: 0, neck: 1, armL: 2, armR: 3, legL: 4, legR: 5, head: 6, feet: 7 };
  const ranges: { part: number; range: { start: number; end: number } }[] = [];

  // Rounded ends everywhere a part has to merge into another one: a flat cap
  // reads as a ledge the moment the camera moves off centre. Both of the
  // torso's caps are kept short. A long lower dome hangs a lobe of pelvis down
  // between the thighs, and a long upper one is worse -- it closes over the
  // shoulders as a cone wide enough to swallow the neck inside it, so what you
  // see above the collarbones is the torso rather than the throat.
  ranges.push({
    part: PART.torso,
    range: mb.addStack(torsoSections, 'y', { domeStart: 0.35, domeEnd: 0.22 }),
  });
  ranges.push({ part: PART.neck, range: mb.addStack(neckSections, 'y') });
  const armCaps = { domeStart: 0.9, domeEnd: 0.9 } as const;
  ranges.push({ part: PART.armR, range: mb.addStack(armSections, 'y', { ...armCaps }) });
  ranges.push({
    part: PART.armL,
    range: mb.addStack(armSections, 'y', { ...armCaps, flipX: true }),
  });
  const legCaps = { domeStart: 0.9, domeEnd: 0.9 } as const;
  ranges.push({ part: PART.legR, range: mb.addStack(legSections, 'y', { ...legCaps }) });
  ranges.push({
    part: PART.legL,
    range: mb.addStack(legSections, 'y', { ...legCaps, flipX: true }),
  });

  const headGirth = torsoScales[shoulderIdx];
  const head = headSections(shape.head, H, 1, headGirth);
  ranges.push({ part: PART.head, range: mb.addStack(head, 'y') });
  // Ears belong to the head for occlusion purposes, or the skull they sit in
  // would black them out. They take the same girth scaling as the skull, or
  // they drift off its surface on a heavier figure.
  for (const ear of earSections(shape.head, H, 1, headGirth)) {
    ranges.push({ part: PART.head, range: mb.addStack(ear, 'y') });
  }

  const ankleX =
    legSections[0].pts.reduce((sum, n, i) => (i % 2 === 0 ? sum + n : sum), 0) /
    (legSections[0].pts.length / 2);
  const foot = footSections(shape.foot, H, 1, ankleX);
  const footCaps = { domeStart: 0.65, domeEnd: 0.22 } as const;
  ranges.push({ part: PART.feet, range: mb.addStack(foot, 'z', { ...footCaps }) });
  ranges.push({
    part: PART.feet,
    range: mb.addStack(foot, 'z', { ...footCaps, flipX: true }),
  });

  const mesh = mb.build();

  const NO_PART = 255;
  const partOf = new Uint8Array(mesh.positions.length / 3).fill(NO_PART);
  for (const { part, range } of ranges) partOf.fill(part, range.start, range.end);

  const proxies: { part: number; proxy: Proxy }[] = [
    { part: PART.torso, proxy: proxyFromSections(torsoSections) },
    { part: PART.neck, proxy: proxyFromSections(neckSections) },
    { part: PART.armR, proxy: proxyFromSections(armSections) },
    { part: PART.armL, proxy: proxyFromSections(armSections, true) },
    { part: PART.legR, proxy: proxyFromSections(legSections) },
    { part: PART.legL, proxy: proxyFromSections(legSections, true) },
    { part: PART.head, proxy: proxyFromSections(head) },
  ];
  const colors = bakeOcclusion(mesh.positions, partOf, proxies);

  /* -- 4. measure the result -- */

  const girthAt = (sections: Section[], t: number) => {
    const yTarget = t * H;
    let best = 0;
    for (let i = 1; i < sections.length; i++) {
      if (Math.abs(sections[i].p - yTarget) < Math.abs(sections[best].p - yTarget)) best = i;
    }
    return polygonPerimeter(sections[best].pts) * 100;
  };

  const chest = girthAt(torsoSections, MEASURE.chest);
  const waist = girthAt(torsoSections, MEASURE.waist);
  const hip = girthAt(torsoSections, MEASURE.hip);

  return {
    ...mesh,
    colors,
    metrics: {
      bmi,
      volumeL: targetVolume * 1000,
      chest,
      waist,
      hip,
      thigh: girthAt(legSections, MEASURE.thigh),
      upperArm: girthAt(armSections, MEASURE.upperArm),
      whr: waist / hip,
      height: H,
    },
    debug: { calib, lambda, refVolumeL: refVolume * 1000 },
  };
}
