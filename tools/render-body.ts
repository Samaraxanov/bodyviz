/**
 * Offline preview of the generated body: a z-buffered software rasteriser that
 * writes a four-up contact sheet (front / left / back / right) straight to PNG.
 *
 * It exists so the mesh can be inspected without a simulator round-trip — the
 * kind of thing a device screenshot hides, like a mirrored part landing on the
 * wrong side, shows up immediately here.
 *
 *   yarn model 178 76 male preview.png
 *   yarn model 178 76 male hands.png hand
 */
import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { buildBody, BodyResult } from '../src/body/buildBody';

const W = 300, H = 640;

function png(rgb: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => { raw[y * (w * 3 + 1) + 1 + i] = v; });
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let c = 0xffffffff;
    for (const b of td) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * `focusT` is what the camera looks at and `spanT` how much of the figure fills
 * the frame, both as fractions of stature. The defaults frame the whole body;
 * `yarn model 178 76 male out.png head` reframes onto the head, which is the
 * only way to actually judge a face at this resolution.
 */
function render(
  body: BodyResult,
  yaw: number,
  focusT = 0.52,
  spanT = 1.24,
  offsetT = 0,
): Uint8Array {
  const img = new Uint8Array(W * H * 3).fill(16);
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const stature = body.metrics.height;
  const focus = stature * focusT;
  const dist = (stature * (spanT / 2)) / Math.tan((32 * Math.PI) / 180 / 2);
  const cx = Math.sin(yaw) * dist, cz = Math.cos(yaw) * dist;
  const fwd = [-cx, 0, -cz].map((v) => v / dist);
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [0, 1, 0];
  const f = H / 2 / Math.tan((32 * Math.PI) / 180 / 2);
  const light = [0.45, 0.72, 0.53];

  const p = body.positions, n = body.normals, idx = body.indices, ao = body.colors;
  const proj = (i: number) => {
    const x = p[i] - cx, y = p[i + 1] - focus, z = p[i + 2] - cz;
    const vx = x * right[0] + y * right[1] + z * right[2];
    const vy = x * up[0] + y * up[1] + z * up[2];
    const vz = x * fwd[0] + y * fwd[1] + z * fwd[2];
    return [W / 2 + ((vx - offsetT * stature) / vz) * f, H / 2 - (vy / vz) * f, vz];
  };

  for (let t = 0; t < idx.length; t += 3) {
    const a = proj(idx[t] * 3), b = proj(idx[t + 1] * 3), c = proj(idx[t + 2] * 3);
    if (a[2] <= 0.05 || b[2] <= 0.05 || c[2] <= 0.05) continue;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (area >= 0) continue; // back-face
    // Average the three vertex normals and AO values so the preview shades the
    // way the app does, rather than showing every facet.
    let lambert = 0, occl = 0;
    for (let k = 0; k < 3; k++) {
      const ni = idx[t + k] * 3;
      lambert += Math.max(0, n[ni] * light[0] + n[ni + 1] * light[1] + n[ni + 2] * light[2]);
      occl += ao[ni];
    }
    lambert /= 3;
    occl /= 3;
    // AO belongs on the indirect term, the way three applies it.
    const shade = Math.min(255, Math.round(72 * occl + 178 * lambert));
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]);
        const w1 = (c[0] - b[0]) * (py - b[1]) - (px - b[0]) * (c[1] - b[1]);
        const w2 = (a[0] - c[0]) * (py - c[1]) - (px - c[0]) * (a[1] - c[1]);
        if (w0 > 0 || w1 > 0 || w2 > 0) continue;
        // Perspective-correct per-pixel depth. A single depth for the whole
        // triangle is enough for a silhouette but not for a surface seen at a
        // grazing angle: neighbouring triangles then sort by their centroids
        // and interleave, which paints diagonal creases across flat-on areas
        // like a cheek -- mesh defects that are not in the mesh.
        const sum = w0 + w1 + w2;
        const z = sum === 0
          ? (a[2] + b[2] + c[2]) / 3
          : sum / (w1 / a[2] + w2 / b[2] + w0 / c[2]);
        const o = y * W + x;
        if (z >= zbuf[o]) continue;
        zbuf[o] = z;
        img[o * 3] = shade * 0.88; img[o * 3 + 1] = shade * 0.92; img[o * 3 + 2] = shade;
      }
    }
  }
  return img;
}

const [hStr, wStr, sexArg, outArg, frameArg] = process.argv.slice(2);
if (!hStr || !wStr || (sexArg !== 'male' && sexArg !== 'female')) {
  console.error(
    'usage: yarn model <heightCm> <weightKg> <male|female> [out.png]' +
      ' [head|hand|focusT,spanT[,offsetT]]',
  );
  process.exit(1);
}
const out = outArg ?? `body-${hStr}-${wStr}-${sexArg}.png`;
const body = buildBody({ heightCm: +hStr, weightKg: +wStr, sex: sexArg });
// Named framings, or an explicit `<focusT>,<spanT>` pair. Head framing keeps a
// little neck in shot, because the jaw-to-throat junction is where most of what
// looks wrong about a head shows up; hand framing keeps the thigh in shot for
// the same reason -- what goes wrong with a hand is its relationship to the leg
// beside it, not the hand on its own.
// [focus height, how much of the figure fills the frame, sideways offset], all
// as fractions of stature. A hand is nowhere near the midline, so without the
// offset a close hand framing shows a thigh.
const FRAMES: Record<string, [number, number, number]> = {
  head: [0.945, 0.26, 0],
  hand: [0.437, 0.30, 0.062],
};
const [focusT, spanT, offsetT] = frameArg
  ? FRAMES[frameArg] ?? (frameArg.split(',').map(Number) as [number, number, number])
  : [0.52, 1.24, 0];
const views = [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((y) =>
  render(body, y, focusT, spanT, offsetT ?? 0),
);
const sheet = new Uint8Array(W * 4 * H * 3).fill(16);
views.forEach((v, k) => {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 3, d = (y * W * 4 + k * W + x) * 3;
      sheet[d] = v[s]; sheet[d + 1] = v[s + 1]; sheet[d + 2] = v[s + 2];
    }
});
writeFileSync(out, png(sheet, W * 4, H));
console.log('wrote', out, '(front / left / back / right)');
