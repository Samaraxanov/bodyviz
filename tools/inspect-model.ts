/**
 * Reports what is actually inside a .glb, and whether it can drive the
 * height / weight / sex sliders.
 *
 *   yarn inspect-model assets/model/base-body.glb
 *
 * The parametric figure needs more from a model than "it loads". It has to be
 * in metres with the feet on the floor, standing, and rigged with a skeleton
 * whose bones can be recognised -- because the bone a vertex is weighted to is
 * how the deformer knows a vertex is on a forearm and not on the waist behind
 * it. Body-shape morph targets, if the model carries them, make the weight
 * slider exact rather than approximated.
 *
 * The glTF container is read directly rather than through three: this runs in
 * plain Node, before anything is wired into the app, and the JSON chunk already
 * carries everything the checks need.
 */
import { readFileSync } from 'fs';

interface Gltf {
  asset: { generator?: string; version: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: {
    name?: string;
    mesh?: number;
    skin?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  meshes?: {
    name?: string;
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      targets?: Record<string, number>[];
    }[];
    extras?: { targetNames?: string[] };
  }[];
  skins?: { joints: number[]; skeleton?: number }[];
  accessors?: { count: number; min?: number[]; max?: number[]; type: string }[];
  materials?: { name?: string }[];
  images?: { name?: string; mimeType?: string }[];
  animations?: { name?: string }[];
}

function readGlb(path: string): Gltf {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} is not a .glb (bad magic)`);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
}

type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** glTF stores TRS or a matrix; both have to end up as the same column-major Mat4. */
function localMatrix(node: NonNullable<Gltf['nodes']>[number]): Mat4 {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transform(m: Mat4, p: number[]): number[] {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

interface Walked {
  /** World-space matrix per node index. */
  world: Map<number, Mat4>;
  meshNodes: number[];
}

function walk(g: Gltf): Walked {
  const world = new Map<number, Mat4>();
  const meshNodes: number[] = [];
  const nodes = g.nodes ?? [];
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);

  const visit = (i: number, parent: Mat4) => {
    const node = nodes[i];
    if (!node || world.has(i)) return;
    const m = multiply(parent, localMatrix(node));
    world.set(i, m);
    if (node.mesh !== undefined) meshNodes.push(i);
    for (const c of node.children ?? []) visit(c, m);
  };
  for (const r of roots) visit(r, IDENTITY);
  return { world, meshNodes };
}

interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * World-space bounds. glTF requires min/max on POSITION accessors, so the
 * extremes come from the header without ever decoding a vertex buffer -- the
 * corners of each primitive's local box, pushed through that node's world
 * matrix, bound the result.
 */
function bounds(g: Gltf, w: Walked): Box | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let any = false;

  for (const ni of w.meshNodes) {
    const m = w.world.get(ni)!;
    const mesh = g.meshes?.[g.nodes![ni].mesh!];
    for (const prim of mesh?.primitives ?? []) {
      const acc = g.accessors?.[prim.attributes.POSITION];
      if (!acc?.min || !acc?.max) continue;
      for (let corner = 0; corner < 8; corner++) {
        const local = [
          corner & 1 ? acc.max[0] : acc.min[0],
          corner & 2 ? acc.max[1] : acc.min[1],
          corner & 4 ? acc.max[2] : acc.min[2],
        ];
        const p = transform(m, local);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
        any = true;
      }
    }
  }
  return any ? { min, max } : null;
}

/**
 * Bones the deformer needs to find, and the substrings that identify each one
 * across the naming schemes that actually turn up (Mixamo, Ready Player Me,
 * MakeHuman, Blender's Rigify). Matching is case- and separator-insensitive and
 * ignores a `mixamorig:`-style prefix.
 */
const WANTED: { region: string; needles: string[] }[] = [
  { region: 'hips', needles: ['hips', 'pelvis'] },
  { region: 'spine', needles: ['spine', 'chest', 'torso'] },
  { region: 'neck', needles: ['neck'] },
  { region: 'head', needles: ['head'] },
  { region: 'upper arm', needles: ['upperarm', 'arm_upper', 'leftarm', 'rightarm', 'shoulder_l', 'upper_arm'] },
  { region: 'forearm', needles: ['forearm', 'lowerarm', 'elbow'] },
  { region: 'hand', needles: ['hand', 'wrist'] },
  { region: 'thigh', needles: ['upleg', 'thigh', 'upperleg', 'upper_leg'] },
  { region: 'shin', needles: ['leftleg', 'rightleg', 'shin', 'calf', 'lowerleg'] },
  { region: 'foot', needles: ['foot', 'ankle'] },
];

const normalise = (s: string) => s.toLowerCase().replace(/^.*:/, '').replace(/[_.\- ]/g, '');

/** Morph target names that change the body, as opposed to the face. */
const BODY_MORPH = /weight|fat|muscle|belly|bust|breast|hip|waist|chest|thick|thin|gain|shape|body|stomach|girth|bmi/i;
/** The ARKit / Ready Player Me face set, which is noise for our purposes. */
const FACE_MORPH = /brow|eye|jaw|mouth|cheek|nose|tongue|lip|smile|blink|squint|funnel|pucker|sneer|frown|viseme|phoneme/i;

function morphNames(g: Gltf): { mesh: string; names: string[] }[] {
  const out: { mesh: string; names: string[] }[] = [];
  for (const mesh of g.meshes ?? []) {
    const targets = mesh.primitives[0]?.targets;
    if (!targets?.length) continue;
    const names = mesh.extras?.targetNames ?? targets.map((_, i) => `target_${i}`);
    out.push({ mesh: mesh.name ?? '(unnamed)', names });
  }
  return out;
}

const ok = (s: string) => `  \u001b[32mok\u001b[0m    ${s}`;
const warn = (s: string) => `  \u001b[33mwarn\u001b[0m  ${s}`;
const bad = (s: string) => `  \u001b[31mFAIL\u001b[0m  ${s}`;

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: yarn inspect-model <model.glb>');
    process.exit(2);
  }
  const g = readGlb(path);
  const w = walk(g);
  const lines: string[] = [];
  let failures = 0;
  let warnings = 0;
  const fail = (s: string) => { failures++; lines.push(bad(s)); };
  const caution = (s: string) => { warnings++; lines.push(warn(s)); };

  // ---- inventory -------------------------------------------------------
  let tris = 0;
  let verts = 0;
  let skinned = 0;
  let prims = 0;
  for (const mesh of g.meshes ?? []) {
    for (const p of mesh.primitives) {
      prims++;
      const pos = g.accessors?.[p.attributes.POSITION];
      if (pos) verts += pos.count;
      if (p.indices !== undefined) tris += (g.accessors?.[p.indices]?.count ?? 0) / 3;
      else if (pos) tris += pos.count / 3;
      if (p.attributes.JOINTS_0 !== undefined) skinned++;
    }
  }

  console.log(`\n${path}`);
  console.log(`  generator   ${g.asset.generator ?? '(none)'}`);
  console.log(`  meshes      ${(g.meshes ?? []).length} (${prims} primitives)`);
  console.log(`  geometry    ${verts.toLocaleString()} verts, ${Math.round(tris).toLocaleString()} tris`);
  console.log(`  materials   ${(g.materials ?? []).length}   images ${(g.images ?? []).length}   animations ${(g.animations ?? []).length}`);
  console.log(`  skins       ${(g.skins ?? []).length}${g.skins?.length ? ` (${g.skins[0].joints.length} joints)` : ''}`);

  console.log('\nchecks');

  // ---- scale and placement --------------------------------------------
  const box = bounds(g, w);
  if (!box) {
    fail('no POSITION bounds in the file, so scale and pose cannot be checked');
  } else {
    const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
    const height = Math.max(...size);
    const up = size.indexOf(height);
    console.log(`  bounds      x ${box.min[0].toFixed(3)}..${box.max[0].toFixed(3)}  y ${box.min[1].toFixed(3)}..${box.max[1].toFixed(3)}  z ${box.min[2].toFixed(3)}..${box.max[2].toFixed(3)}`);

    if (up !== 1) {
      fail(`longest axis is ${'xyz'[up]}, not y -- the model is not Y-up, or it is not standing`);
    } else if (height < 1.2 || height > 2.3) {
      const guess = height > 20 ? 'centimetres' : height < 0.1 ? 'something much smaller than metres' : null;
      fail(`stature is ${height.toFixed(3)} units${guess ? `, which looks like ${guess}` : ''} -- expected 1.2..2.3 (metres)`);
    } else {
      lines.push(ok(`stature ${height.toFixed(3)} m, Y-up`));
    }

    const floor = box.min[1];
    if (Math.abs(floor) > 0.02) {
      caution(`feet sit at y=${floor.toFixed(3)} rather than 0 -- the loader will drop the figure to the floor`);
    } else {
      lines.push(ok('feet on the floor at y=0'));
    }

    const offCentre = Math.max(Math.abs(box.min[0] + box.max[0]) / 2, Math.abs(box.min[2] + box.max[2]) / 2);
    if (offCentre > 0.05) {
      caution(`not centred on the vertical axis (off by ${offCentre.toFixed(3)} m) -- the turntable will wobble`);
    }

    // A T-pose is as wide as it is tall; arms down is roughly a third.
    const spread = size[0] / height;
    if (spread > 0.85) caution(`arm span is ${(spread * 100).toFixed(0)}% of stature -- this is a T-pose; an A-pose or arms-down pose deforms far better`);
    else lines.push(ok(`pose looks like arms-down / A-pose (span ${(spread * 100).toFixed(0)}% of stature)`));
  }

  // ---- rigging ---------------------------------------------------------
  if (!g.skins?.length) {
    fail('no skin -- without a skeleton there is nothing to tell a forearm vertex from a waist vertex');
  } else if (skinned === 0) {
    fail('a skin exists but no primitive has JOINTS_0/WEIGHTS_0');
  } else {
    if (skinned < prims) caution(`${prims - skinned} of ${prims} primitives are not skinned; those will only scale, not reshape`);
    const joints = g.skins[0].joints.map((j) => normalise(g.nodes?.[j]?.name ?? ''));
    const missing = WANTED.filter((r) => !joints.some((j) => r.needles.some((n) => j.includes(n))));
    if (missing.length) {
      fail(`skeleton is missing bones for: ${missing.map((m) => m.region).join(', ')}`);
      console.log(`\n  joints found: ${g.skins[0].joints.map((j) => g.nodes?.[j]?.name ?? '?').join(', ')}\n`);
    } else {
      lines.push(ok(`skeleton covers every region the deformer needs (${g.skins[0].joints.length} joints)`));
    }
  }

  // ---- morph targets ---------------------------------------------------
  const morphs = morphNames(g);
  const all = morphs.flatMap((m) => m.names);
  const body = all.filter((n) => BODY_MORPH.test(n) && !FACE_MORPH.test(n));
  const face = all.filter((n) => FACE_MORPH.test(n));
  if (!all.length) {
    caution('no morph targets -- weight will be approximated by deforming the skin radially rather than driven exactly');
  } else if (!body.length) {
    caution(`${all.length} morph targets, but all of them look facial (${face.length} face-shaped names) -- none usable for body weight`);
  } else {
    lines.push(ok(`${body.length} body-shape morph targets: ${body.slice(0, 12).join(', ')}${body.length > 12 ? ', ...' : ''}`));
  }

  // ---- things that only cost us ---------------------------------------
  if ((g.images ?? []).length) {
    caution(`${g.images!.length} embedded textures -- the viewer shades the body with a flat material, so these are dead weight in the bundle`);
  }
  if ((g.animations ?? []).length) {
    caution(`${g.animations!.length} animations -- unused, and worth stripping`);
  }
  if (verts > 40000) {
    caution(`${verts.toLocaleString()} vertices is more than a phone needs for a body at this size; 15k-25k is plenty`);
  }

  console.log(lines.join('\n'));
  console.log(
    `\n${failures ? `\u001b[31m${failures} blocking problem${failures > 1 ? 's' : ''}\u001b[0m` : '\u001b[32musable\u001b[0m'}` +
      `${warnings ? `, ${warnings} thing${warnings > 1 ? 's' : ''} to look at` : ''}\n`,
  );
  process.exit(failures ? 1 : 0);
}

main();
