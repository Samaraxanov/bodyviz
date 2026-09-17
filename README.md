# BodyViz

Enter height, weight and sex; get a proportioned 3D body you can spin, tilt and
zoom. The figure is generated from the numbers — there is no downloaded model
and no scan — so it responds immediately when you change any of them.

<!-- Screens: setup (sex, units, height, weight, BMI) → model (3D viewer + measurements) -->

## Running it

Yarn (Classic) is the package manager — `packageManager` in `package.json`
pins it, and `yarn.lock` is committed.

```bash
yarn install
yarn start              # then press i / a, or scan the QR code with Expo Go
```

No custom dev build is needed: the app uses only modules bundled with Expo Go.

### Scripts

| Command | What it does |
| --- | --- |
| `yarn start` | Metro dev server |
| `yarn start:clear` | same, with the Metro cache cleared |
| `yarn ios` / `yarn android` | start and open the project in Expo Go |
| `yarn web` | run in the browser |
| `yarn typecheck` | TypeScript over the app *and* `tools/` |
| `yarn doctor` | `expo-doctor` — config and dependency-version checks |
| `yarn measure` | print the girth table for a spread of bodies (see below) |
| `yarn model <cm> <kg> <male\|female> [out.png]` | render a four-up preview of the mesh |
| `yarn clean` | drop Expo/Metro caches and restart |
| `yarn build:ios` / `build:android` | native builds — see the caveat at the end |

`yarn measure` and `yarn model` are the two worth knowing. They run the body
solver in plain Node, with no simulator involved, so a change to the profiles
can be checked in about a second:

```bash
yarn measure                       # girths vs. published means, 11 bodies
yarn model 165 88 female out.png   # front / left / back / right contact sheet
```

The preview caught two bugs a device screenshot had hidden: both feet landing
on the same side of the body, and a neck wider than the head's jaw.

## Why React Native

The app has to draw a real 3D mesh at 60fps on both platforms from one codebase.

- **React Native + three.js** (chosen) — three.js is the most complete mesh
  toolkit in any language that runs on both platforms, and `expo-gl` gives it a
  genuine GPU context. One codebase, no per-platform 3D work.
- **Native iOS (SceneKit/RealityKit)** — the best rendering of the three, but
  it is iOS only; Android would be a second app.
- **Flutter / Dart** — the weakest fit. Real-time 3D is still not first-class:
  `flutter_scene` is experimental and `model_viewer_plus` is a WebView wrapper.
  You would spend the project fighting the framework rather than the anatomy.

## How the body is generated

`src/body/` is the interesting part, and it is plain TypeScript with no
dependency on three or React — you can run and test it in Node.

The pipeline has four stages, and the point of splitting them is that each one
can be reasoned about on its own:

```
height / weight / sex
       |
  shape parameters      anthropometry.ts -- named dials for a lean body
       |
  calibration           make that lean shape weigh BMI_REF at this height
       |
  mass distribution     one lambda, spread over the dials by fat affinity
       |
  cross-sections        sections.ts -- stations interpolated, relief laid on
       |
  mesh + baked occlusion
```

**`anthropometry.ts`** holds no rings and no mesh. It describes a body as named
dials — `torso.shoulder.width`, `torso.chest.depth`, `torso.bellyProjection`,
`leg.calf.volume`, `arm.bicep.volume`, `neck.width` — every length a fraction of
stature, the way the standard proportion tables are written. There is one set
per sex, and it describes a *lean* body: shape only, never absolute size. This
is the file to edit. You can widen a pelvis without hunting through a table of
eighty rings, and you can read the difference between the two sexes off the
page.

Each dial also carries two numbers that decide what happens when mass arrives:
`fat`, how eagerly it takes surplus, and `bias`, whether that surplus goes into
depth or width. `bias` is why the same kilogram lands as a belly on the male
profile and as hips on the female one, and it costs nothing — it only chooses
the aspect of a slice whose area is already fixed.

**`buildBody.ts`** calibrates and distributes:

1. **Calibrate.** Scale every girth dial so the untouched shape really does
   weigh `BMI_REF` at the requested height. This is what lets the dials be
   edited for proportion alone — get one wrong and the calibration absorbs it
   instead of the model silently gaining weight.

2. **Distribute the mass.** The user's weight implies a target volume
   (`mass / density`, density falling with BMI). Scaling a dial by
   `s = sqrt(1 + lambda·w)` scales the area it controls by exactly
   `(1 + lambda·w)`, so total volume is *linear* in lambda and the lambda that
   hits the target is one division — no iteration, no search.

**`sections.ts`** turns the dials into rings, and it is where the model stops
looking like a mannequin. The division that matters is between **stations** and
**relief**.

A station is a silhouette control point — the pelvis is this wide, the waist is
this deep. Stations are interpolated with a *monotone* cubic, so the outline
passes through them and never bulges between them. (Plain Catmull-Rom does:
feed it chest 0.094 / armpit 0.097 / shoulder 0.111 and it overshoots past
0.111 somewhere above the shoulder, which is a lump of nothing hanging off the
trapezius.)

Relief is everything that sits *on* that outline: pectorals, a spinal furrow,
scapulae, the two heads of a calf and their asymmetry, a patella, knuckles, the
cleft between the buttocks. Each one is a radial push inside a Gaussian window
over height and angle, and features respond to body fat — `withFat` fades
abdominal definition out under it and swells a love handle in.

Two properties of relief are load-bearing:

- **It is mean-free.** The features at a given height are summed into one field
  and its average is removed before anything moves. An arm carries nothing but
  bulges — a bicep, a tricep, a deltoid, and no comparable hollows — so applied
  as written they inflate the whole outline. Taking the mean out first means a
  bicep pushes the front of the arm out and pulls its sides *in*, which is both
  what a bicep does and what leaves the station's silhouette alone.

- **It is area-preserving.** The contour is renormalised afterwards, so relief
  can never quietly add kilograms. Mass belongs to the dials; relief only
  decides where the surface sits. That is also what lets relief be resolved
  *after* lambda is known, which is how a belly can project forward and the abs
  on it disappear without any of it being re-solved.

**Assembly.** Torso, neck, head, arms, legs and feet are separate watertight
stacks that interpenetrate. Ends are rounded rather than capped flat, and both
of the torso's caps are kept short — a long lower dome hangs a lobe of pelvis
down between the thighs, and a long upper one closes over the shoulders as a
cone wide enough to swallow the neck inside it.

The arms swing outwards as the body broadens, so a heavier figure doesn't end up
with its forearms inside its hips — but the swing is driven by how deeply the
body would *bury* the arm, not by a fixed stand-off, and the allowance tightens
from shoulder to hand. An upper arm really does lie against the ribs and is
mostly hidden there; a forearm beside a hip is not. Holding every part of the
arm clear of the torso instead makes the figure widest at the armpits rather
than at the deltoids, which is the loudest way to read as a slab with sticks
attached rather than as a body. `yarn measure` prints that width in the `shldr`
column for exactly this reason.

**Bake occlusion** (`occlusion.ts`). The places a body goes dark — armpit,
crotch, under the chin, where a hand rests against a hip — are exactly the
places two parts come close. Each part keeps a coarse proxy, and every vertex is
darkened by its distance to the parts it does *not* belong to, on a Gaussian
falloff. The Gaussian is deliberate: a plain exponential is at its steepest
exactly where two parts touch, so a contact crease gets painted as a hard-edged
band, and along the groin that reads as the waistband of a pair of briefs rather
than as shadow.

Reported chest/waist/hip/thigh/arm girths are measured off the generated mesh,
not looked up, so they always agree with what you see. They land within a few
centimetres of published population means across the BMI range — run
`yarn measure` after touching a dial, because the two constraints pull against
each other: a smooth convex slice is a shorter path than a tape takes over a
real ribcage, so matching a published circumference with a plain superellipse
buys it with a silhouette several centimetres too wide. Relief is part of how
that tension is paid off, since it lengthens the perimeter without widening the
silhouette.

### What it is not

A visual estimate built from population averages. Two people of the same height,
weight and sex get the same figure, because those three numbers are all it
knows. It is not a measurement of anyone's body and not a medical instrument.

## Rendering

`src/components/BodyViewer.tsx` drives three.js against an `expo-gl` context
directly. Three things there are deliberate and worth knowing before you touch
them — all three produce a *silently black* canvas, with no error and correct
draw-call counts, if removed:

- **`gl.getError()` once per frame.** expo-gl batches GL calls and flushes them
  asynchronously. `endFrameEXP()` alone does not force the queue out, so frames
  are drawn and never presented. `getError()` returns a value, so it blocks
  until the queue drains.
- **Hiding `globalThis.WebGLRenderingContext` while constructing the renderer.**
  three r163+ rejects any context that is `instanceof WebGLRenderingContext`, on
  the assumption it must be WebGL 1. expo-gl's WebGL 2 context subclasses it;
  browsers keep the two interfaces separate, so the guard misfires.
- **`metro.config.js` resolving `three` to its ES build.** three's CommonJS
  entry calls `process.emitWarning()`, which React Native's `process` shim does
  not implement, so requiring it throws at import time.

The flush is limited to the first few frames (`PRIME_FRAMES`) and re-armed when
the app returns from the background. That limit matters: `getError()` blocks the
JS thread on a round-trip to the GL thread, measured at **~24 ms per frame**, so
flushing every frame pins the scene at well under 20fps. Priming only at the
start gives a steady 60fps with ~0.3 ms of render time per frame.

Rebuilding a body writes into the existing vertex buffers rather than allocating
new ones — the ring counts are fixed, so the vertex count never changes — which
is what keeps dragging a slider smooth.

The solver itself is the other half of that budget: a full rebuild is about
12 ms on a laptop for a ~15k-vertex mesh, and vertex count is the lever, because
it drives mesh assembly, normals and the occlusion bake at once. Relief is
evaluated exactly once per ring per body — the two sampling passes the solver
needs (calibrate, then distribute) only ever read a ring's *area*, which relief
cannot change, so neither of them has to build an outline at all.

The viewer reports its first presented frame through `onFirstFrame`, and the
model screen holds a loader over the canvas until then (with a timeout, so a
surface that never reports cannot strand the user behind a spinner).

`@react-three/fiber` is deliberately *not* used: its native canvas renders
nothing on current Expo SDKs, and doing the scene by hand is about a hundred
lines.

Orbit and pinch live on a plain transparent `View` laid *over* the canvas, not
on the canvas's container. `GLView` is a native surface — a `GLKView` on iOS, a
`TextureView` on Android — and hanging the responder off an ancestor of one
means every touch has to come back out of native hit-testing before the
responder negotiation sees it. An ordinary RN view on top is a touch target the
responder system owns end to end. The responder also refuses termination, so a
drag can't be taken over mid-gesture, and fling speed is derived in radians per
*second* rather than per frame — derived per frame it scales with the frame
rate, and the same flick coasts twice as far on a slow device as on a fast one.

## Layout

```
tools/
  render-body.ts       offline rasteriser behind `yarn model`
  measure.ts           girth table behind `yarn measure`
src/
  body/
    anthropometry.ts   named shape dials, fat affinities, surface relief
    sections.ts        dials -> cross-sections; stations, relief, contours
    buildBody.ts       calibration, the volume solver, mesh assembly
    mesh.ts            dependency-free ring-stack builder, monotone spline
  components/
    BodyViewer.tsx     expo-gl + three.js scene, orbit/pinch gestures
    Slider.tsx         pure-JS slider (keeps the app free of native modules)
    ui.tsx             segmented control, labelled slider, stat, button
  screens/
    SetupScreen.tsx    sex, units, height, weight, live BMI
    ModelScreen.tsx    viewer, measurements, live adjustment
  theme.ts, units.ts
```

`three` is pinned exactly: the renderer depends on the interop details above.
Bump it deliberately and check the canvas still draws.

## Caveat: native builds

`yarn build:ios` currently fails on Xcode 26.x toolchains — not in this
project's code, but inside Expo's own `expo-modules-jsi`, which uses `weak let`
in `~Copyable` structs that Swift 6.2 rejects. SDK 57 has no patch for it.

This is why the app deliberately carries no third-party native modules (the
slider is hand-written rather than `@react-native-community/slider`): everything
it needs ships inside Expo Go, so `yarn start` is a complete workflow and the
native build is optional.
