/**
 * Sanity table for the body solver: builds a spread of heights, weights and
 * sexes and prints what came off each mesh, so a change to the shape parameters
 * or to the volume solver can be checked against published population means
 * without launching anything.
 *
 *   yarn measure
 *
 * `shldr` is the widest point of the whole figure and the column most worth
 * watching. It should land near the bideltoid breadth (~46 cm for a 178 cm
 * male) and it should occur at the deltoid. When it drifts up towards 55 the
 * arms have been pushed outboard of the ribs and the figure has gone back to
 * reading as a slab with sticks attached.
 */
import { BodyResult, buildBody } from '../src/body/buildBody';
import { signedVolume } from '../src/body/mesh';

/** Widest point of the figure across the shoulder region, and where it is. */
function shoulderBreadth(b: BodyResult): { cm: number; t: number } {
  const H = b.metrics.height;
  let best = 0;
  let bestT = 0;
  for (let t = 0.70; t <= 0.86; t += 0.004) {
    const y = t * H;
    const tol = 0.005 * H;
    let x = 0;
    for (let i = 0; i < b.positions.length; i += 3) {
      if (Math.abs(b.positions[i + 1] - y) > tol) continue;
      x = Math.max(x, Math.abs(b.positions[i]));
    }
    if (x > best) {
      best = x;
      bestT = t;
    }
  }
  return { cm: best * 200, t: bestT };
}

const cases: [number, number, 'male' | 'female'][] = [
  [180, 70, 'male'], [180, 60, 'male'], [180, 80, 'male'], [180, 95, 'male'], [180, 120, 'male'],
  [165, 50, 'female'], [165, 58, 'female'], [165, 70, 'female'], [165, 95, 'female'],
  [150, 45, 'female'], [200, 100, 'male'],
];

console.log(
  ['case', 'BMI', 'tgtL', 'meshL', 'calib', 'lam', 'chest', 'waist', 'hip', 'WHR', 'thigh', 'arm', 'shldr', '@t'].join('\t'),
);
for (const [h, w, s] of cases) {
  const b = buildBody({ heightCm: h, weightKg: w, sex: s });
  const m = b.metrics;
  const d = b.debug;
  const sh = shoulderBreadth(b);
  console.log(
    [
      `${h}/${w}/${s[0]}`, m.bmi.toFixed(1), m.volumeL.toFixed(1),
      (signedVolume(b.positions, b.indices) * 1000).toFixed(1),
      d.calib.toFixed(3), d.lambda.toFixed(3),
      m.chest.toFixed(1), m.waist.toFixed(1), m.hip.toFixed(1), m.whr.toFixed(2),
      m.thigh.toFixed(1), m.upperArm.toFixed(1),
      sh.cm.toFixed(1), sh.t.toFixed(3),
    ].join('\t'),
  );
}
