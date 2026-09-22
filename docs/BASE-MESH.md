# The base mesh

What the app needs from the human model, and why.

Run `yarn inspect-model <file.glb>` against any candidate. It checks everything
on this page and exits non-zero on anything blocking, so it settles the question
without a simulator round-trip.

## Why there are requirements at all

The figure is parametric: height, weight and sex reshape it. A `.glb` on its own
is a fixed sculpture, so the app has to deform it, and deformation needs to know
which part of the body each vertex is on. Skinning weights are how it knows — a
vertex weighted to `LeftForeArm` is on a forearm, even though it hangs at the
same height as the waist and sits a few centimetres from it. Without a skeleton
there is no way to tell those two apart, and a weight slider would inflate the
arms into the ribs.

That is the reason for most of what follows.

## Blocking

These fail the inspector. The app cannot use the model without them.

**Standing, Y-up, in metres, 1.2–2.3 m tall.** The whole camera rig, the floor
shadow and the fit distance are in metres with the floor at y=0. A model authored
in centimetres is the single most common thing to get back, and it is a one-click
fix in the exporter.

**Rigged, with the mesh skinned to it.** A skin whose primitives carry
`JOINTS_0` / `WEIGHTS_0`. The skeleton needs bones that are recognisable for:
hips, spine, neck, head, upper arm, forearm, hand, thigh, shin, foot. Naming does
not have to match anything exactly — the inspector matches loosely, and Mixamo,
Ready Player Me, MakeHuman and Rigify names all pass — it only has to be
consistent and not obfuscated. A fingers-and-toes rig is welcome but unnecessary;
nothing below the wrist is deformed.

## Strongly preferred

These pass with a warning, and each one costs something real.

**Body-shape morph targets.** Names like `weight`, `muscle`, `belly`, `bust`.
With them the weight slider drives the mesh the way the author intended and the
normals come out of the file correctly. Without them the app falls back to
displacing the skin radially away from the bone axis, which is a decent
approximation and visibly an approximation — it cannot know that fat lands on the
belly before it lands on the forearms.

This is the difference worth paying for. Facial blendshapes are not a substitute:
the ARKit 52-shape set that most avatar pipelines ship, and the 252 shapes on the
models in `hmthanh/3d-human-model`, are all face and do nothing for body shape.

**A-pose or arms-down, not a T-pose.** Shoulder deformation in a T-pose looks
wrong at every angle the user will actually rotate to.

**Nude or in close-fitting neutral clothing.** The figure is a body-composition
visualisation. Loose clothing hides the thing the sliders are changing, and
clothing geometry deforms badly when the body under it grows.

**No textures, no animations.** The viewer shades the body with a single flat
skin-toned material and bakes its own occlusion, so embedded textures are bundle
weight that never reaches the screen. A nude base mesh is usually 2–4 MB
untextured and 10 MB+ with them.

**15k–25k vertices.** Enough for smooth shoulders and a readable face at phone
size. Above ~40k the win stops being visible.

## Sex

Two files — `base-male.glb` and `base-female.glb` — are better than one mesh
pushed between the two. Skeletal proportion differs (shoulder-to-hip ratio, carrying
angle, ribcage depth) in ways that radial deformation cannot reach, and it is
exactly the thing the sex control is there to show.

If only one is available, supply it and the app will shape toward the other; say
which one it is.

## Licensing

The model ships inside the binary, so it needs a licence that allows
redistribution in a closed-source app. Worth stating explicitly, because two
common sources do not qualify: SMPL and its relatives are research/non-commercial
by default, and a Ready Player Me avatar is a likeness of a specific person
generated under their terms of service, not an asset to redistribute. MakeHuman's
base mesh (CC0) and most paid stock base meshes are fine.

## Where it goes

`assets/model/base-male.glb`, `assets/model/base-female.glb`.

`metro.config.js` already registers `.glb` as an asset extension and `app.json`
bundles everything under `assets/model`, so a file dropped there is picked up by
`require()` with no further configuration.
