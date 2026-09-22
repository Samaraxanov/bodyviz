/**
 * Anthropometric reference data — the *shape parameters* of a body.
 *
 * This file holds no mesh and no rings. It describes a body as a set of named
 * dials: how wide the shoulders are, how deep the chest is, how far the belly
 * projects, how much volume the calf carries. `sections.ts` turns those dials
 * into cross-sections, and `buildBody.ts` decides how the user's mass moves
 * them. Keeping the three apart is what makes the model steerable: you can ask
 * for a wider pelvis without hunting through a table of eighty rings.
 *
 * Two conventions run through everything here:
 *
 * - **Every length is a fraction of stature (H).** That is how the classic
 *   proportion tables are written (Drillis & Contini, NASA-STD-3000, ANSUR II),
 *   and it means one canonical skeleton scales to any height by multiplication.
 *
 * - **The dials describe a *lean* reference body**, near BMI 21.5. Absolute
 *   size never lives here. The user's mass is applied on top, per dial, by the
 *   solver — see `fat` below.
 */

export type Sex = 'male' | 'female';

/* ------------------------------ the dials ------------------------------- */

/**
 * A named horizontal station of the torso. The stations are the silhouette;
 * everything between them is interpolated, and everything *on* them is relief.
 */
export interface Station {
  /** Height above the floor, as a fraction of stature. */
  t: number;
  /** Half-width, lateral (left-right). */
  width: number;
  /** Half-depth, sagittal (front-back). */
  depth: number;
  /** Superellipse exponent: 2 is a pure ellipse, higher is more slab-like. */
  corner: number;
  /** Static forward (+) / backward (-) offset of the slice centre. */
  shift: number;
  /**
   * Fat affinity: how eagerly this station takes on surplus mass. This is the
   * `w` the volume solver distributes over. A station at 1.0 gains its even
   * share; the waist of the male profile is near 2, the male shoulder near 0.5.
   */
  fat: number;
  /**
   * Where the surplus goes once it arrives: +1 puts all of it into depth (a
   * belly that projects), -1 into width (hips that spread), 0 splits it evenly.
   * Volume is identical either way — this only chooses the aspect — and it is
   * most of the visible difference between an android and a gynoid figure.
   */
  bias: number;
}

/**
 * A raised or sunken feature on the surface: a muscle belly, a groove, a bony
 * landmark. Relief is what stops a swept solid reading as a mannequin, and it
 * is deliberately separate from the stations, because the two want opposite
 * treatment — stations should interpolate smoothly, relief should stay local
 * and crisp.
 *
 * Relief is **area-preserving**: `sections.ts` renormalises each contour after
 * applying it, so adding a bicep never quietly adds kilograms. Mass belongs to
 * the dials; relief only decides where the surface sits.
 */
export interface Relief {
  /** What it is. Carried for readability when retuning. */
  name: string;
  /** Centre height, fraction of stature (limbs: along the limb's own axis). */
  at: number;
  /** Vertical extent, as a Gaussian sigma. */
  rise: number;
  /** Angular centre. See ANGLE below. */
  around: number;
  /** Angular extent, as a Gaussian sigma, in radians. */
  arc: number;
  /** Peak radial change as a fraction of the local radius. Positive bulges. */
  depth: number;
  /** Also place a mirrored copy on the other side of the midline. */
  paired?: boolean;
  /**
   * Read `around` and `arc` as a position *along* the outline rather than as a
   * direction. Both are still in radians over a full turn, and on a round
   * section they mean the same thing.
   *
   * The difference only matters on a flat one, and then it matters completely.
   * A bicep is pinned to a direction: it faces forwards, wherever the surface
   * happens to be. The gaps between four fingers are not -- they are spaced
   * across the back of the hand, and on a 3.6:1 section the whole of that
   * surface lies between 0.9 and 1.6 radians of *direction*, so placing them
   * by direction stacks all three on top of each other. Along the contour they
   * are three evenly spaced points, which is what they are on a hand.
   */
  alongContour?: boolean;
  /**
   * How the feature responds to body fat, per unit of surplus scale.
   * Negative fades it out (muscle definition disappears under fat), positive
   * grows it (love handles, a softening lower belly). 0 holds it constant.
   */
  withFat?: number;
}

/** Angular reference directions for `Relief.around`, in the slice's own frame. */
export const ANGLE = {
  /** +z, towards the viewer. */
  front: Math.PI / 2,
  /** -z, away from the viewer. */
  back: -Math.PI / 2,
  /** +x, out towards the body's own side. */
  side: 0,
  /** -x, in towards the midline. On a hanging arm this is the palm. */
  inward: Math.PI,
} as const;

/** A named node of a limb: where its centre-line is and how much it carries. */
export interface LimbNode {
  /** Height, fraction of stature. */
  t: number;
  /** Lateral offset of the centre-line from the midline. */
  x: number;
  /** Sagittal offset of the centre-line. */
  z: number;
  /**
   * The volume dial: cross-section half-width at this node. Named per muscle
   * on the shapes below, so `arm.bicep.volume` is the bicep's volume.
   */
  volume: number;
  /** Depth as a fraction of width. 1 is circular; a hand is a flat paddle. */
  flat: number;
  /**
   * Superellipse exponent, as on Station; 2 (the default) is a pure ellipse.
   * A thigh really is an ellipse and wants nothing else. A hand is not: a palm
   * has a back, a front and two edges, and an ellipse gives it none of them --
   * swept at 2.8:1 it is a lens, which is why the old hand read as a blade.
   */
  corner?: number;
  /**
   * Rotation of the section about the limb's own axis, in radians, positive
   * turning the outboard face forwards. Everything above the elbow is round
   * enough not to care. The hand is not: a forearm at rest is half pronated,
   * so the palm faces the thigh *and* slightly back, and the back of the hand
   * faces forwards and out. Built without it the hand is exactly edge-on to
   * the camera in the view the app opens at, and 9 cm of hand is drawn as a
   * 3 cm sliver -- which is what made it read as a flipper rather than a hand.
   */
  roll?: number;
  /** Fat affinity, as on Station. */
  fat: number;
}

export interface TorsoShape {
  /** Bottom of the pelvic mass, where the thighs part. */
  crotch: Station;
  /** Widest point of the pelvis: the buttocks seen from the front. */
  pelvis: Station;
  lowerBelly: Station;
  waist: Station;
  /** Lower edge of the ribcage. */
  ribs: Station;
  chest: Station;
  /** Where the arm leaves the body. */
  armpit: Station;
  /** Biacromial breadth — the skeletal shoulder, before the deltoid. */
  shoulder: Station;
  /** The slope from the shoulder up to the neck. */
  trapezius: Station;
  neckBase: Station;

  /** Forward throw of the belly at reference mass, and again per unit surplus. */
  bellyProjection: number;
  bellyGain: number;
  /** Rearward throw of the buttocks, and its gain with mass. */
  gluteProjection: number;
  gluteGain: number;
  /** Depth of the small of the back. */
  lumbarTuck: number;

  relief: Relief[];
}

export interface ArmShape {
  /** Buried under the deltoid; sets where the arm is anchored. */
  acromion: LimbNode;
  deltoid: LimbNode;
  bicep: LimbNode;
  elbow: LimbNode;
  forearm: LimbNode;
  wrist: LimbNode;
  /** The heel of the hand, where it widens out of the wrist. */
  palm: LimbNode;
  /** The metacarpal heads: the widest and squarest section of the hand. */
  knuckle: LimbNode;
  /** The four-finger row, narrower and thinner than the palm that carries it. */
  fingers: LimbNode;
  fingertip: LimbNode;
  relief: Relief[];
}

export interface LegShape {
  /** Buried in the pelvis. */
  hipJoint: LimbNode;
  glute: LimbNode;
  thigh: LimbNode;
  knee: LimbNode;
  calf: LimbNode;
  shin: LimbNode;
  ankle: LimbNode;
  relief: Relief[];
}

export interface NeckShape {
  /** The named dial: neck half-width at its base. */
  width: number;
  /** Half-width where it disappears into the jaw. */
  topWidth: number;
  /** Depth as a fraction of width — a neck is deeper than it is wide. */
  flat: number;
  base: number;
  top: number;
  /** Forward lean of the column, bottom to top. */
  lean: number;
  fat: number;
  relief: Relief[];
}

export interface HeadShape {
  /** Centre height. */
  t: number;
  /** Half-width, half-depth, half-height. */
  width: number;
  depth: number;
  height: number;
  shift: number;
  /** Width held at the jaw, as a fraction of the cranium's. */
  jaw: number;
  /** Forward throw of the chin, as a fraction of head depth. */
  chin: number;
  /** Rearward swell of the occiput. */
  occiput: number;
  /** Half-size of the ears. */
  ear: number;
}

export interface FootShape {
  /** Heel centre height. */
  t: number;
  length: number;
  height: number;
  width: number;
  /** How far the heel sits behind the ankle. */
  heel: number;
  /** Lift of the medial arch, as a fraction of foot height. */
  arch: number;
  /** Width at the ball of the foot, relative to `width`. */
  ball: number;
  /** Outward splay of the forefoot, in radians. */
  splay: number;
}

/** Everything the mesh builder needs, and nothing it doesn't. */
export interface ShapeParams {
  torso: TorsoShape;
  arm: ArmShape;
  leg: LegShape;
  neck: NeckShape;
  head: HeadShape;
  foot: FootShape;
}

/**
 * Skeletal landmarks, as fractions of stature (Drillis & Contini). The shapes
 * are laid out against these and the builder measures girths at them.
 */
export const LANDMARK = {
  ankle: 0.039,
  knee: 0.285,
  crotch: 0.48,
  hip: 0.505,
  midThigh: 0.43,
  waist: 0.62,
  chest: 0.72,
  upperArm: 0.74,
  shoulder: 0.818,
  neckBase: 0.845,
  chin: 0.87,
  top: 1.0,
} as const;

/* ------------------------------ male shape ------------------------------ */

const MALE: ShapeParams = {
  torso: {
    crotch:     { t: 0.458, width: 0.042, depth: 0.043, corner: 2.00, shift: -0.008, fat: 0.55, bias:  0.1 },
    pelvis:     { t: 0.505, width: 0.095, depth: 0.064, corner: 2.20, shift: -0.015, fat: 1.00, bias: -0.2 },
    lowerBelly: { t: 0.545, width: 0.088, depth: 0.059, corner: 2.20, shift: -0.007, fat: 1.35, bias:  0.4 },
    waist:      { t: 0.620, width: 0.080, depth: 0.055, corner: 2.10, shift:  0.001, fat: 1.90, bias:  0.6 },
    ribs:       { t: 0.680, width: 0.087, depth: 0.061, corner: 2.15, shift:  0.004, fat: 1.40, bias:  0.5 },
    chest:      { t: 0.730, width: 0.094, depth: 0.063, corner: 2.20, shift:  0.003, fat: 1.05, bias:  0.2 },
    armpit:     { t: 0.775, width: 0.099, depth: 0.055, corner: 2.20, shift: -0.001, fat: 0.58, bias:  0.0 },
    shoulder:   { t: 0.818, width: 0.111, depth: 0.052, corner: 2.10, shift: -0.005, fat: 0.46, bias:  0.0 },
    trapezius:  { t: 0.838, width: 0.078, depth: 0.050, corner: 2.10, shift: -0.005, fat: 0.39, bias:  0.0 },
    neckBase:   { t: 0.854, width: 0.050, depth: 0.047, corner: 2.10, shift: -0.003, fat: 0.32, bias:  0.0 },

    bellyProjection: 0.002,
    bellyGain: 0.105,
    gluteProjection: 0.006,
    gluteGain: 0.030,
    lumbarTuck: 0.009,

    relief: [
      // Front. The pectoral shelf is the single most male thing about a torso:
      // a pair of slabs that overhang the ribs and stop at the sternum.
      { name: 'pectoral', at: 0.748, rise: 0.028, around: ANGLE.front + 0.62, arc: 0.44, depth: 0.142, paired: true, withFat: -0.55 },
      { name: 'sternum', at: 0.745, rise: 0.045, around: ANGLE.front, arc: 0.15, depth: -0.067, withFat: -0.6 },
      // The costal margin: the ribcage stops, and the belly starts under it.
      { name: 'costalArch', at: 0.672, rise: 0.020, around: ANGLE.front, arc: 0.85, depth: -0.057, withFat: -1.0 },
      { name: 'lineaAlba', at: 0.640, rise: 0.055, around: ANGLE.front, arc: 0.13, depth: -0.072, withFat: -1.2 },
      { name: 'navel', at: 0.603, rise: 0.010, around: ANGLE.front, arc: 0.10, depth: -0.104, withFat: -0.3 },
      // Back. A spine and a pair of shoulder blades: the difference between a
      // back and a plank.
      { name: 'spine', at: 0.700, rise: 0.130, around: ANGLE.back, arc: 0.26, depth: -0.133, withFat: -0.25 },
      { name: 'scapula', at: 0.778, rise: 0.028, around: ANGLE.back + 0.60, arc: 0.36, depth: 0.085, paired: true, withFat: -0.8 },
      { name: 'trapRidge', at: 0.832, rise: 0.016, around: ANGLE.back + 0.40, arc: 0.50, depth: 0.050, paired: true, withFat: -0.4 },
      { name: 'lumbarDimple', at: 0.556, rise: 0.012, around: ANGLE.back + 0.44, arc: 0.20, depth: -0.085, paired: true, withFat: -0.9 },
      // The buttocks, as two masses with a cleft between them rather than one
      // rounded shelf.
      { name: 'gluteLobe', at: 0.503, rise: 0.034, around: ANGLE.back + 0.52, arc: 0.44, depth: 0.152, paired: true, withFat: 0.35 },
      { name: 'gluteCleft', at: 0.492, rise: 0.034, around: ANGLE.back, arc: 0.17, depth: -0.247 },
      { name: 'gluteFold', at: 0.462, rise: 0.012, around: ANGLE.back + 0.45, arc: 0.40, depth: -0.104, paired: true },
      // Sides. The flank narrows above the iliac crest and flares over it; on a
      // heavier figure the same place becomes the roll that sits on the belt.
      { name: 'latSweep', at: 0.726, rise: 0.040, around: ANGLE.side, arc: 0.32, depth: 0.076, paired: true, withFat: -0.7 },
      { name: 'obliqueTuck', at: 0.598, rise: 0.028, around: ANGLE.side, arc: 0.36, depth: -0.057, paired: true, withFat: -1.4 },
      { name: 'iliacFlare', at: 0.548, rise: 0.022, around: ANGLE.side, arc: 0.40, depth: 0.057, paired: true, withFat: 0.9 },
      { name: 'clavicle', at: 0.826, rise: 0.010, around: ANGLE.front + 0.58, arc: 0.34, depth: -0.067, paired: true, withFat: -1.0 },
    ],
  },

  arm: {
    acromion:  { t: 0.826, x: 0.061, z: -0.002, volume: 0.018, flat: 1.00, fat: 0.50 },
    deltoid:   { t: 0.795, x: 0.093, z: -0.002, volume: 0.034, flat: 1.00, fat: 0.70 },
    bicep:     { t: 0.740, x: 0.099, z: -0.002, volume: 0.027, flat: 1.00, fat: 0.95 },
    elbow:     { t: 0.633, x: 0.102, z:  0.001, volume: 0.022, flat: 1.06, fat: 0.46 },
    forearm:   { t: 0.598, x: 0.102, z:  0.003, volume: 0.024, flat: 1.10, roll: 0.18, fat: 0.56 },
    wrist:     { t: 0.487, x: 0.110, z:  0.008, volume: 0.0116, flat: 1.38, corner: 2.15, roll: 0.48, fat: 0.14 },
    palm:      { t: 0.470, x: 0.111, z:  0.011, volume: 0.0095, flat: 2.15, corner: 2.80, roll: 0.60, fat: 0.13 },
    knuckle:   { t: 0.435, x: 0.112, z:  0.013, volume: 0.0086, flat: 2.85, corner: 3.30, roll: 0.63, fat: 0.12 },
    fingers:   { t: 0.408, x: 0.112, z:  0.013, volume: 0.0060, flat: 3.65, corner: 3.50, roll: 0.63, fat: 0.08 },
    fingertip: { t: 0.387, x: 0.112, z:  0.013, volume: 0.0045, flat: 3.30, corner: 3.10, roll: 0.63, fat: 0.06 },
    relief: [
      // The deltoid caps the shoulder from outside; the bicep and tricep face
      // each other across the upper arm, and the bicep sits higher.
      { name: 'deltoidCap', at: 0.792, rise: 0.022, around: ANGLE.side, arc: 0.70, depth: 0.162, withFat: -0.4 },
      { name: 'bicep', at: 0.722, rise: 0.034, around: ANGLE.front, arc: 0.62, depth: 0.145, withFat: -0.55 },
      { name: 'tricep', at: 0.700, rise: 0.042, around: ANGLE.back, arc: 0.66, depth: 0.105, withFat: -0.35 },
      // The elbow is a hard landmark: the olecranon points backwards and the
      // soft tissue in front of it hollows out.
      { name: 'olecranon', at: 0.633, rise: 0.012, around: ANGLE.back, arc: 0.40, depth: 0.142, withFat: -0.2 },
      { name: 'cubitalFossa', at: 0.641, rise: 0.014, around: ANGLE.front, arc: 0.45, depth: -0.104, withFat: -0.5 },
      // Forearm: the flexor mass is bulky and high, and it drains into a wrist
      // that is nearly bone.
      { name: 'brachioradialis', at: 0.600, rise: 0.028, around: ANGLE.front - 0.35, arc: 0.55, depth: 0.152, withFat: -0.5 },
      { name: 'flexorBelly', at: 0.588, rise: 0.030, around: ANGLE.back + 0.30, arc: 0.55, depth: 0.104, withFat: -0.4 },
      { name: 'ulnarRidge', at: 0.545, rise: 0.045, around: ANGLE.back, arc: 0.22, depth: -0.057 },
      // The hand. It hangs with the palm against the thigh, so in the slice's
      // own frame the back of the hand faces `side` (+x, outboard), the palm
      // faces `inward`, the thumb edge is `front` and the little finger
      // `back`. The old set had the knuckles on the little-finger edge and the
      // palm hollow on the back of the hand -- both a quarter turn out, which
      // is most of why the hand read as a featureless blade.
      //
      // The block does most of the work -- a squared palm, a narrower finger
      // row, a blunt end -- with a thumb on the corner and three grooves down
      // the finger row. See the note on those grooves below: they are the one
      // feature here whose angles are pinned to the segment count.
      { name: 'ulnarStyloid', at: 0.484, rise: 0.014, around: ANGLE.inward - 1.30, arc: 0.30, depth: 0.075 },
      { name: 'thumb', at: 0.462, rise: 0.019, around: ANGLE.inward - 1.05, arc: 0.40, depth: 0.300 },
      { name: 'thenar', at: 0.450, rise: 0.020, around: ANGLE.inward - 0.55, arc: 0.36, depth: 0.180 },
      { name: 'hypothenar', at: 0.452, rise: 0.024, around: ANGLE.inward + 0.60, arc: 0.36, depth: 0.120 },
      { name: 'palmHollow', at: 0.448, rise: 0.018, around: ANGLE.inward, arc: 0.26, depth: -0.140 },
      { name: 'knuckleRidge', at: 0.437, rise: 0.014, around: ANGLE.side, arc: 0.55, depth: 0.100 },
      // Individual fingers, which is the one thing that separates a hand from
      // a mitten. `alongContour` is what makes them possible -- see the note
      // on it -- and the placement is then arithmetic: the outline carries 36
      // evenly spaced points, so 0 and +/-2pi/9 are vertices 0, 4 and 32, and
      // `paired` puts their mirrors on 18, 14 and 22. Every groove is centred
      // on a vertex with a vertex either side, so a 0.2 radian Gaussian
      // resolves cleanly. Move ARM_SEGMENTS off a multiple of 9 and they fall
      // between vertices and turn into noise.
      //
      // `depth` scales each point's own radius, and a point in the middle of
      // the back of the hand is only its half-thickness from the centre-line.
      // 0.40 of that is a 3 mm groove: enough to read as four fingers at the
      // distance the whole figure is looked at, not enough to carve the hand
      // into strips when someone zooms in on it.
      { name: 'fingerGapMid', at: 0.404, rise: 0.020, alongContour: true, around: ANGLE.side, arc: 0.20, depth: -0.400, paired: true },
      { name: 'fingerGapIn', at: 0.404, rise: 0.020, alongContour: true, around: ANGLE.side + (2 * Math.PI) / 9, arc: 0.20, depth: -0.350, paired: true },
      { name: 'fingerGapOut', at: 0.404, rise: 0.020, alongContour: true, around: ANGLE.side - (2 * Math.PI) / 9, arc: 0.20, depth: -0.350, paired: true },
    ],
  },

  leg: {
    hipJoint: { t: 0.560, x: 0.042, z: -0.004, volume: 0.022, flat: 1.00, fat: 0.90 },
    glute:    { t: 0.505, x: 0.046, z: -0.004, volume: 0.046, flat: 1.00, fat: 0.95 },
    thigh:    { t: 0.430, x: 0.047, z: -0.003, volume: 0.046, flat: 0.98, fat: 1.00 },
    knee:     { t: 0.285, x: 0.042, z:  0.000, volume: 0.032, flat: 1.00, fat: 0.35 },
    calf:     { t: 0.228, x: 0.041, z: -0.006, volume: 0.034, flat: 1.06, fat: 0.55 },
    shin:     { t: 0.140, x: 0.038, z: -0.003, volume: 0.025, flat: 1.06, fat: 0.32 },
    ankle:    { t: 0.039, x: 0.036, z: -0.001, volume: 0.019, flat: 1.00, fat: 0.10 },
    relief: [
      // Thigh. The outer sweep runs high and long, the teardrop over the inner
      // knee sits low — get those two wrong and a leg looks like a pipe.
      { name: 'vastusLateralis', at: 0.408, rise: 0.055, around: ANGLE.side, arc: 0.60, depth: 0.123, withFat: -0.55 },
      { name: 'rectusFemoris', at: 0.395, rise: 0.060, around: ANGLE.front, arc: 0.55, depth: 0.085, withFat: -0.6 },
      { name: 'vastusMedialis', at: 0.322, rise: 0.026, around: ANGLE.front + 1.05, arc: 0.50, depth: 0.142, withFat: -0.7 },
      { name: 'hamstring', at: 0.400, rise: 0.055, around: ANGLE.back, arc: 0.60, depth: 0.085, withFat: -0.35 },
      { name: 'adductor', at: 0.430, rise: 0.045, around: ANGLE.front + 1.45, arc: 0.45, depth: 0.067, withFat: 0.5 },
      // Knee: a cap in front, a hollow behind it.
      { name: 'patella', at: 0.288, rise: 0.014, around: ANGLE.front, arc: 0.42, depth: 0.114, withFat: -0.3 },
      { name: 'poplitealFossa', at: 0.292, rise: 0.016, around: ANGLE.back, arc: 0.36, depth: -0.104, withFat: -0.4 },
      // Calf. The medial head is bigger and sits higher than the lateral one;
      // that asymmetry is most of what reads as a calf rather than a cone.
      { name: 'gastrocMedial', at: 0.236, rise: 0.034, around: ANGLE.back + 0.55, arc: 0.50, depth: 0.199, withFat: -0.35 },
      { name: 'gastrocLateral', at: 0.216, rise: 0.030, around: ANGLE.back - 0.55, arc: 0.45, depth: 0.142, withFat: -0.35 },
      { name: 'tibialCrest', at: 0.150, rise: 0.060, around: ANGLE.front, arc: 0.20, depth: 0.057 },
      { name: 'achilles', at: 0.075, rise: 0.030, around: ANGLE.back, arc: 0.45, depth: -0.133 },
      { name: 'malleolus', at: 0.041, rise: 0.010, around: ANGLE.side, arc: 0.35, depth: 0.142 },
    ],
  },

  neck: {
    width: 0.036,
    topWidth: 0.026,
    flat: 1.12,
    base: 0.838,
    top: 0.890,
    lean: 0.005,
    fat: 0.35,
    relief: [
      { name: 'sternocleidomastoid', at: 0.856, rise: 0.016, around: ANGLE.front + 0.55, arc: 0.36, depth: 0.060, paired: true, withFat: -0.6 },
      { name: 'throat', at: 0.862, rise: 0.014, around: ANGLE.front, arc: 0.22, depth: 0.030, withFat: -0.8 },
      { name: 'nape', at: 0.872, rise: 0.020, around: ANGLE.back, arc: 0.24, depth: -0.104 },
    ],
  },

  head: {
    t: 0.933,
    width: 0.043,
    depth: 0.055,
    height: 0.068,
    shift: 0.004,
    jaw: 0.86,
    chin: 0.09,
    occiput: 0.07,
    ear: 0.017,
  },

  foot: {
    t: 0.030,
    length: 0.152,
    height: 0.042,
    width: 0.052,
    heel: 0.030,
    arch: 0.42,
    ball: 1.06,
    splay: 0.07,
  },
};

/* ----------------------------- female shape ----------------------------- */

const FEMALE: ShapeParams = {
  torso: {
    crotch:     { t: 0.458, width: 0.042, depth: 0.043, corner: 2.00, shift: -0.010, fat: 0.95, bias:  0.0 },
    pelvis:     { t: 0.505, width: 0.098, depth: 0.066, corner: 2.10, shift: -0.024, fat: 1.40, bias: -0.6 },
    lowerBelly: { t: 0.545, width: 0.087, depth: 0.057, corner: 2.10, shift: -0.009, fat: 1.45, bias: -0.1 },
    waist:      { t: 0.620, width: 0.072, depth: 0.049, corner: 2.05, shift:  0.001, fat: 1.80, bias:  0.2 },
    ribs:       { t: 0.680, width: 0.079, depth: 0.055, corner: 2.10, shift:  0.004, fat: 1.40, bias:  0.2 },
    chest:      { t: 0.725, width: 0.083, depth: 0.062, corner: 2.15, shift:  0.008, fat: 1.20, bias:  0.5 },
    armpit:     { t: 0.770, width: 0.086, depth: 0.050, corner: 2.20, shift:  0.001, fat: 0.55, bias:  0.2 },
    shoulder:   { t: 0.818, width: 0.099, depth: 0.048, corner: 2.10, shift: -0.004, fat: 0.42, bias:  0.0 },
    trapezius:  { t: 0.838, width: 0.070, depth: 0.045, corner: 2.10, shift: -0.004, fat: 0.36, bias:  0.0 },
    neckBase:   { t: 0.854, width: 0.045, depth: 0.042, corner: 2.10, shift: -0.003, fat: 0.28, bias:  0.0 },

    bellyProjection: 0.002,
    bellyGain: 0.075,
    gluteProjection: 0.010,
    gluteGain: 0.045,
    lumbarTuck: 0.012,

    relief: [
      // The bust is a pair of hemispheres hung on the ribcage, lower and much
      // rounder than a pectoral, and it does not fade under fat — it grows.
      { name: 'bust', at: 0.727, rise: 0.026, around: ANGLE.front + 0.52, arc: 0.40, depth: 0.257, paired: true, withFat: 0.45 },
      { name: 'bustCleft', at: 0.724, rise: 0.030, around: ANGLE.front, arc: 0.16, depth: -0.142 },
      { name: 'infraMammary', at: 0.697, rise: 0.012, around: ANGLE.front + 0.50, arc: 0.40, depth: -0.095, paired: true, withFat: 0.4 },
      { name: 'costalArch', at: 0.668, rise: 0.020, around: ANGLE.front, arc: 0.80, depth: -0.048, withFat: -1.0 },
      { name: 'lineaAlba', at: 0.640, rise: 0.050, around: ANGLE.front, arc: 0.13, depth: -0.053, withFat: -1.2 },
      { name: 'navel', at: 0.603, rise: 0.010, around: ANGLE.front, arc: 0.10, depth: -0.095, withFat: -0.3 },
      { name: 'lowerBellyRound', at: 0.532, rise: 0.028, around: ANGLE.front, arc: 0.55, depth: 0.057, withFat: 0.8 },

      { name: 'spine', at: 0.700, rise: 0.130, around: ANGLE.back, arc: 0.26, depth: -0.104, withFat: -0.25 },
      { name: 'scapula', at: 0.775, rise: 0.026, around: ANGLE.back + 0.58, arc: 0.36, depth: 0.067, paired: true, withFat: -0.8 },
      { name: 'trapRidge', at: 0.832, rise: 0.016, around: ANGLE.back + 0.40, arc: 0.50, depth: 0.038, paired: true, withFat: -0.4 },
      { name: 'lumbarDimple', at: 0.556, rise: 0.012, around: ANGLE.back + 0.42, arc: 0.20, depth: -0.095, paired: true, withFat: -0.7 },
      { name: 'gluteLobe', at: 0.500, rise: 0.038, around: ANGLE.back + 0.50, arc: 0.46, depth: 0.18, paired: true, withFat: 0.5 },
      { name: 'gluteCleft', at: 0.490, rise: 0.036, around: ANGLE.back, arc: 0.18, depth: -0.257 },
      { name: 'gluteFold', at: 0.460, rise: 0.012, around: ANGLE.back + 0.45, arc: 0.40, depth: -0.095, paired: true },

      { name: 'latSweep', at: 0.720, rise: 0.038, around: ANGLE.side, arc: 0.32, depth: 0.048, paired: true, withFat: -0.6 },
      { name: 'waistTuck', at: 0.610, rise: 0.034, around: ANGLE.side, arc: 0.38, depth: -0.067, paired: true, withFat: -1.1 },
      { name: 'hipFlare', at: 0.540, rise: 0.028, around: ANGLE.side, arc: 0.44, depth: 0.085, paired: true, withFat: 1.1 },
      { name: 'clavicle', at: 0.826, rise: 0.010, around: ANGLE.front + 0.56, arc: 0.34, depth: -0.067, paired: true, withFat: -1.0 },
    ],
  },

  arm: {
    acromion:  { t: 0.826, x: 0.055, z: -0.002, volume: 0.017, flat: 1.00, fat: 0.50 },
    deltoid:   { t: 0.795, x: 0.085, z: -0.002, volume: 0.031, flat: 1.00, fat: 0.78 },
    bicep:     { t: 0.740, x: 0.090, z: -0.002, volume: 0.025, flat: 1.00, fat: 1.05 },
    elbow:     { t: 0.633, x: 0.093, z:  0.001, volume: 0.020, flat: 1.06, fat: 0.50 },
    forearm:   { t: 0.598, x: 0.094, z:  0.003, volume: 0.021, flat: 1.10, roll: 0.18, fat: 0.60 },
    wrist:     { t: 0.487, x: 0.101, z:  0.008, volume: 0.0100, flat: 1.36, corner: 2.15, roll: 0.48, fat: 0.14 },
    palm:      { t: 0.470, x: 0.102, z:  0.011, volume: 0.0082, flat: 2.12, corner: 2.80, roll: 0.60, fat: 0.13 },
    knuckle:   { t: 0.435, x: 0.103, z:  0.013, volume: 0.0074, flat: 2.80, corner: 3.30, roll: 0.63, fat: 0.12 },
    fingers:   { t: 0.408, x: 0.103, z:  0.013, volume: 0.0052, flat: 3.60, corner: 3.50, roll: 0.63, fat: 0.08 },
    fingertip: { t: 0.387, x: 0.103, z:  0.013, volume: 0.0039, flat: 3.25, corner: 3.10, roll: 0.63, fat: 0.06 },
    relief: [
      { name: 'deltoidCap', at: 0.792, rise: 0.022, around: ANGLE.side, arc: 0.70, depth: 0.133, withFat: -0.3 },
      { name: 'bicep', at: 0.722, rise: 0.034, around: ANGLE.front, arc: 0.62, depth: 0.105, withFat: -0.4 },
      { name: 'tricep', at: 0.700, rise: 0.045, around: ANGLE.back, arc: 0.66, depth: 0.100, withFat: 0.25 },
      { name: 'olecranon', at: 0.633, rise: 0.012, around: ANGLE.back, arc: 0.40, depth: 0.123, withFat: -0.2 },
      { name: 'cubitalFossa', at: 0.641, rise: 0.014, around: ANGLE.front, arc: 0.45, depth: -0.085, withFat: -0.5 },
      { name: 'brachioradialis', at: 0.600, rise: 0.028, around: ANGLE.front - 0.35, arc: 0.55, depth: 0.123, withFat: -0.4 },
      { name: 'flexorBelly', at: 0.588, rise: 0.030, around: ANGLE.back + 0.30, arc: 0.55, depth: 0.085, withFat: -0.3 },
      { name: 'ulnarRidge', at: 0.545, rise: 0.045, around: ANGLE.back, arc: 0.22, depth: -0.057 },
      { name: 'ulnarStyloid', at: 0.484, rise: 0.014, around: ANGLE.inward - 1.30, arc: 0.30, depth: 0.065 },
      { name: 'thumb', at: 0.462, rise: 0.019, around: ANGLE.inward - 1.05, arc: 0.40, depth: 0.280 },
      { name: 'thenar', at: 0.450, rise: 0.020, around: ANGLE.inward - 0.55, arc: 0.36, depth: 0.165 },
      { name: 'hypothenar', at: 0.452, rise: 0.024, around: ANGLE.inward + 0.60, arc: 0.36, depth: 0.115 },
      { name: 'palmHollow', at: 0.448, rise: 0.018, around: ANGLE.inward, arc: 0.26, depth: -0.130 },
      { name: 'knuckleRidge', at: 0.437, rise: 0.014, around: ANGLE.side, arc: 0.55, depth: 0.090 },
      { name: 'fingerGapMid', at: 0.404, rise: 0.020, alongContour: true, around: ANGLE.side, arc: 0.20, depth: -0.370, paired: true },
      { name: 'fingerGapIn', at: 0.404, rise: 0.020, alongContour: true, around: ANGLE.side + (2 * Math.PI) / 9, arc: 0.20, depth: -0.320, paired: true },
      { name: 'fingerGapOut', at: 0.404, rise: 0.020, alongContour: true, around: ANGLE.side - (2 * Math.PI) / 9, arc: 0.20, depth: -0.320, paired: true },
    ],
  },

  leg: {
    hipJoint: { t: 0.560, x: 0.045, z: -0.005, volume: 0.023, flat: 1.00, fat: 1.25 },
    glute:    { t: 0.505, x: 0.049, z: -0.005, volume: 0.047, flat: 1.00, fat: 1.35 },
    thigh:    { t: 0.430, x: 0.050, z: -0.004, volume: 0.050, flat: 0.98, fat: 1.40 },
    knee:     { t: 0.285, x: 0.045, z:  0.000, volume: 0.033, flat: 1.00, fat: 0.38 },
    calf:     { t: 0.228, x: 0.044, z: -0.006, volume: 0.034, flat: 1.06, fat: 0.58 },
    shin:     { t: 0.140, x: 0.041, z: -0.003, volume: 0.024, flat: 1.06, fat: 0.30 },
    ankle:    { t: 0.039, x: 0.038, z: -0.001, volume: 0.018, flat: 1.00, fat: 0.10 },
    relief: [
      { name: 'vastusLateralis', at: 0.408, rise: 0.055, around: ANGLE.side, arc: 0.60, depth: 0.095, withFat: -0.35 },
      { name: 'rectusFemoris', at: 0.395, rise: 0.060, around: ANGLE.front, arc: 0.55, depth: 0.057, withFat: -0.5 },
      { name: 'vastusMedialis', at: 0.322, rise: 0.026, around: ANGLE.front + 1.05, arc: 0.50, depth: 0.114, withFat: -0.6 },
      { name: 'hamstring', at: 0.400, rise: 0.055, around: ANGLE.back, arc: 0.60, depth: 0.085, withFat: 0.2 },
      { name: 'adductor', at: 0.430, rise: 0.045, around: ANGLE.front + 1.45, arc: 0.45, depth: 0.076, withFat: 0.7 },
      { name: 'patella', at: 0.288, rise: 0.014, around: ANGLE.front, arc: 0.42, depth: 0.104, withFat: -0.3 },
      { name: 'poplitealFossa', at: 0.292, rise: 0.016, around: ANGLE.back, arc: 0.36, depth: -0.095, withFat: -0.4 },
      { name: 'gastrocMedial', at: 0.236, rise: 0.034, around: ANGLE.back + 0.55, arc: 0.50, depth: 0.18, withFat: -0.3 },
      { name: 'gastrocLateral', at: 0.216, rise: 0.030, around: ANGLE.back - 0.55, arc: 0.45, depth: 0.123, withFat: -0.3 },
      { name: 'tibialCrest', at: 0.150, rise: 0.060, around: ANGLE.front, arc: 0.20, depth: 0.048 },
      { name: 'achilles', at: 0.075, rise: 0.030, around: ANGLE.back, arc: 0.45, depth: -0.133 },
      { name: 'malleolus', at: 0.041, rise: 0.010, around: ANGLE.side, arc: 0.35, depth: 0.133 },
    ],
  },

  neck: {
    width: 0.031,
    topWidth: 0.022,
    flat: 1.12,
    base: 0.838,
    top: 0.890,
    lean: 0.005,
    fat: 0.35,
    relief: [
      { name: 'sternocleidomastoid', at: 0.856, rise: 0.016, around: ANGLE.front + 0.55, arc: 0.36, depth: 0.050, paired: true, withFat: -0.6 },
      { name: 'throat', at: 0.862, rise: 0.014, around: ANGLE.front, arc: 0.22, depth: 0.020, withFat: -0.8 },
      { name: 'nape', at: 0.872, rise: 0.020, around: ANGLE.back, arc: 0.24, depth: -0.104 },
    ],
  },

  head: {
    t: 0.935,
    width: 0.040,
    depth: 0.052,
    height: 0.065,
    shift: 0.004,
    jaw: 0.84,
    chin: 0.08,
    occiput: 0.07,
    ear: 0.015,
  },

  foot: {
    t: 0.028,
    length: 0.142,
    height: 0.039,
    width: 0.047,
    heel: 0.028,
    arch: 0.46,
    ball: 1.06,
    splay: 0.07,
  },
};

export function shapeFor(sex: Sex): ShapeParams {
  return sex === 'female' ? FEMALE : MALE;
}

/**
 * Whole-body density in kg/L. Fat is less dense than lean tissue, so heavier
 * bodies at a given height float a little better — Siri/Brozek inverted into a
 * cheap linear fit over BMI, clamped to the physiological range.
 */
export function bodyDensity(bmi: number): number {
  return Math.min(1.07, Math.max(0.95, 1.075 - 0.0022 * bmi));
}

export function bmiCategory(bmi: number): { label: string; color: string } {
  if (bmi < 18.5) return { label: 'Underweight', color: '#5AA9E6' };
  if (bmi < 25) return { label: 'Healthy range', color: '#3DD68C' };
  if (bmi < 30) return { label: 'Overweight', color: '#F5B841' };
  if (bmi < 35) return { label: 'Obese (class I)', color: '#F2794B' };
  return { label: 'Obese (class II+)', color: '#EF5A5A' };
}
