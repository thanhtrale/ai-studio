# 3D characters — reference → sheet → mesh → Mixamo rig (`/char3d`)

What to know **before** deciding anything about this pipeline. It was built and
measured in companion-web and moved here with its arms; the numbers are
companion-web's, on an RTX 5070 12 GB, unless a line says otherwise. Run
numbers (r38, r196 …) are entries in [log/char3d.md](log/char3d.md), which is
the evidence and is kept verbatim, in Vietnamese. A conclusion that changes is
corrected here, never in the log.

```
reference ─(Qwen-Image-2.1-Turbo)→ three-view A-pose sheet ─(Pixal3D)→ textured GLB ─(MIA v2 + SkinTokens + bpy)→ Mixamo rig + clips
```

Four arms: `image-qwen21-turbo-official-comfy` (sheet), `mesh-pixal3d-comfy`
(mesh), `rig-mia-skintokens` (rig), `mesh-char3d-tools` (split, re-project,
render — CPU, no GPU). Code: `apps/web/server/char3d/` (store, prompts,
runner), `apps/web/app/pages/char3d/`, `apps/web/app/components/char3d/`.

## The page: three separate steps and a gallery

- Tabs **Reference → Mesh → Rig**, and **All runs**. Each tab: pick the input
  from the previous step's GALLERY → Generate → runs in flight or waiting for
  review → this step's gallery. The person decides what goes on.
- **The gallery holds only outputs that passed.** A `pass` review adds a run
  (for a sheet run: the sheet matching the review's `picks`; with no picks,
  every sheet that passed the cross-check); a later retry or fail takes it out
  again, unless it was added by hand. By hand: `POST|DELETE
  /api/char3d/<id>/gallery {run, set?}`. A run that did not pass is only under
  All runs — low scores are not shown as options.
- **One run is one step.** Each is looked at and scored before the next step
  uses it: a sheet that is not good enough is generated again, not pushed on
  to a mesh. A run records `parent`, so the chain reads backwards.
- **The review is never the runner's.** It is written with `PATCH
  /api/char3d/<id>/runs/<run>` after looking at the outputs — by a person (the
  form on the run's page) or an agent, the same record either way. A model
  does not grade itself.
- `/char3d/review` is laid out like Mixamo: saved characters on the left, the
  clip library as animated cards in the middle, the viewer on the right.

## Store

`storage/char3d/<character>/` — `character.json` (profile, gallery, notes
learnt on this character), `ref.*` (the original), `runs/<rNN-step>/run.json`
and that run's files. Arms only read under `inputs/` and write under
`outputs/`; the runner hard-links a run's inputs into `inputs/.char3d/` and
moves what an arm wrote out of `outputs/.char3d/` into the run's directory.
The library does not list dot folders.

A run that says queued or running in its record but that this server process
is not working on was interrupted (a restart of the web server — in
development, any edit under `server/`) and reads as an error. Run it again.
Edit `apps/web/server/` only while no run is in flight.

## The standard flow (measured 2026-10-17, r196–r217) — read this first

1. **Input: ONE sheet of three views in ONE generation** (Qwen-Image-2.1,
   2048×1024, `<image1>` = the original). The prompt lists the whole outfit as
   in the original and spells out every one-sided detail (a belt tied in ONE
   knot at the front of the left hip → seen from behind, only the plain band),
   and "tops of the heads on one line, soles on one baseline". The sheet is cut
   on its white columns (`split`). **Do not assemble views from separate
   edits**: r192's front was 373 px wide and its back 484 px (arms in a
   different pose) → broken sleeves and hands on the mesh, four eyebrows; edit
   on edit (r154 → r164 → r180) drifts the pose every time.
2. **Cross-check before a mesh**: width front vs back within 5%, the three
   heights within 3%, and count the details (one hair tie, one set of belt
   tails, fists in all three views). Sheet r196: 0–1.8% / ≤ 2%. The page
   shows both numbers on every sheet.
3. **Mesh: front + left + back of the same sheet, RANDOM seed.** On the same
   seed, A/B: without the profile → cat-slit and striped eyes (r207, r208);
   24 texture steps no better than 12 (r205, r206).
4. **Review the mesh on the Detail sheet** (eyes and brows, hair tie, inside
   the sleeves) — only a pass gets rigged. Compare the eyes with the ORIGINAL,
   not with "nice eyes" in general: the girl has violet-grey eyes, and grey
   eyes were scored as a fault for the first ten runs. Pastel palettes: Pixal3D
   darkens the pinks 15–20% on EVERY seed (white stays white) — the person
   accepted it; the face is the criterion. The girl: 1 mesh in 20 passed on
   the face (r28).
5. With a sheet, sleeves, hair tie, hands and belt came out right 8/8
   (r197–r204). What remains is the FACE, a lottery of Pixal3D's texture pass
   (wrong colour, smeared, veined eyes) — keep generating random seeds until
   one passes.
6. **Pixal3D multi-view runs bf16** (the default since 2026-10-17), not int8
   convrot. Same character, same sheet: int8 0/12 passed (r27–r38, mostly
   41–55 points, hair drifting brown or moss green, clothes purple or pink);
   bf16 1/4 passed (r40–r43: 78/59/67/85) with clean colours on all four — the
   remaining fault only the eyes. Card peak ~9.7 GB for the whole machine,
   135–145 s a run. `precision: "int8"` goes back to the old build; one image
   (`views.front` only) is int8 regardless.

**Ref arm: Lightning does NOT replace Turbo for this step** (co-be-vo-sinh-hong
r03–r06, an original with open hands). On the 2048×1024 sheet Lightning drew
four figures 4/4; at 1536×1024 it drew three, but spread the front's hands
4/4. Separate views with prompt v3: front open-handed 3/4 (the one fist was a
T-pose), profile arm reaching forward 4/4, back drawn with the belt knot 3/4.
Turbo on the same sheet template: fists 4/4 (cau-be-vo-sinh-2 r01). Lightning's
four steps follow `<image1>` more closely than the prompt.

## Step 1 — the reference, in a WIDE A-pose (~50°)

- Arm: `image-qwen21-turbo-official-comfy` (Qwen-Image-2.1-Turbo — not the
  Qwen-Image-Edit 2511 arm). The character is `<image1>`. Prompts are English
  (Qwen follows English closer; a Vietnamese prompt set copied the
  reference's own pose); the templates are in `server/char3d/prompts.ts`.
- The default is `mode: "sheet"`: `SHEET_PROMPT` filled with the character's
  `subject` and `traits` (+ the run's `extra`, e.g. "remove the long hanging
  ribbon tails"), 2048×1024, batch 4, then split → `outputs.sets[]` (three
  views and `check`). A run with its own `prompts`, or `mode: "views"`, runs
  the old way, one image per view (896×1152, batch ≥ 2). r70: 70 s to
  generate + 0.5 s to split, width 0.4%, height 0.8%.
- **Traits must list the whole outfit and every one-sided detail.** Turbo draws
  the hidden side from the words, not from the image.
- Separate profile views often **face the wrong way** (1 in 2 on the first
  run). "left" on Pixal3D's rig is the character's LEFT side: the character
  faces the LEFT edge of the image.
- **The arm angle decides the armpits at rig time** (r27–r41), especially with
  wide sleeves:

  | reference pose | mesh | rig |
  |---|---|---|
  | A-pose ~35° | wide sleeves hang against the ribs → the remesh WELDS sleeve to torso, sleeve hem to belt | raising an arm tears a membrane / crumples — there is no geometry under the arm |
  | T-pose | sleeves separate cleanly | MIA puts the joints WRONG: the wrist mid-sleeve (x 0.40 against a true 0.60) → the sleeve stands out like a wing |
  | **A-pose ~50°** | sleeves clear of the ribs, the armpit gap visible | MIA's joints are right; clean bone heat |

- Cross-check front/back by a one-sided detail (a belt knot at the left hip →
  seen from behind it must be on the image's LEFT): r34 back_1 and r38 back_0
  were mirrored.

### Hands: FISTS in the reference (r121–r126)

A rig cannot rescue fingers: Pixal3D builds a hand as one slab, fingers fused,
so `noFingers` stays on. "Both hands closed into loose fists": 4/4 images in
fists, Pixal3D builds a tidy fist, punches and strikes look right. Side
effect: the inside of the sleeve is drawn closed → no skin strip on the
sleeve, no need for `sleeveSkinFix`. The cost: clips that want an open hand
(waving, clapping) stay fisted.

### Sleeves must match the ORIGINAL (r162–r170)

The v2 clause "short sleeves hang open" made Qwen draw flared open sleeves
with skin showing inside → a wrong mesh and a strip of skin on the sleeve.
Editing with `<image1>` = the original and saying "single-layer three-quarter
sleeves … halfway down the forearm … cuff wraps snugly … no inner layer, no
skin visible inside the sleeve": 4/4 meshes with correct sleeves, no skin
strip. The server's default prompt is v3 since 2026-10-17: fists, sleeves as
the original, no gendered pronoun.

### Changing one detail of a good reference: EDIT it, do not regenerate

Qwen with `<image2>` = the good image r38 and "redraw exactly, change only the
hands" (r154/r155) kept r38's face → a front + back mesh passed at once 1/4
(r157). Regenerating the whole image (r121) changes the face too, and the pass
rate fell to 1/27. (Edits for a detail — not for assembling views; see the
standard flow.)

## Step 2 — the mesh: Pixal3D

| input | face | back | when |
|---|---|---|---|
| front only | sharpest | **invents detail** (a logo on the back) | the back does not matter |
| front + back | good | right | — |
| **front + left + back** (one sheet) | good, no streaks under the chin | right | **default** |
| front + left + back + right | **blurred** | right | not with model-drawn profiles |

- Four views blur the face because Qwen's profiles never match the front
  exactly, and the camera rig blends them.
- **The seed decides the HAIR COLOUR and the expression** (same settings:
  brown / black / black hair; face fine / fine / frowning). One seed is one
  data point — choose on the face close-up.
- **The mesh's seed decides the RIG quality too**, not only the colours: same
  image r38, seed 7 rig p999 2.6–4.1; seed 42 4–10 (three identical rigs —
  the fault is in the mesh); seed 11 6–26. Rig at least two meshes and choose
  on the hand/armpit/hem close-ups.
- A 4096 atlas is no sharper than 2048 in close-ups: the softness comes from
  the colour voxels, not the atlas. Keep 2048.
- Earlier runs: ~95 s for one image, ~120 s for two; peak ~11 GB.

### Faces: Pixal3D REPAINTS by seed — review the face close-up before rigging (r123–r161)

Pixal3D does not copy the face from the reference: same input, a different face
per seed — slit pupils like a cat's, speckles, a streak across the forehead,
black dots, a missing eye. The page's thumbnails hide all of these; review on
`face_front` / `face_34`.

- On one fist reference (r121) + profile r122: **0/9** seeds with a clean face.
  Same images without the profile (front + back): the speckles and streaks
  went away, 1/4 passed (r135). Another 16 seeds on r121 (r140–r153, with and
  without a profile): still 0 — some references are just hard for Pixal3D.
  With a new reference, if the profile seems to hurt, try front + back.
- Projecting the front image's face straight onto the texture (`faceFromRef`,
  r128): pale face, smeared eyes (the face is ~160 px in a 1024 image), the
  decal shows at 3/4 — the person rejected it. The code is still in rig.py, off
  by default; **leave it off**. (This is not the re-projection below.)

### Re-projecting the input views' colours onto the WHOLE atlas (`reproject`, co-be-vo-sinh-hong r61–r63)

On by default, after Pixal3D, in the mesh run (`mesh-char3d-tools`, CPU,
~35 s). The original GLB is kept as `mesh_pixal.glb`; `reproject: false` turns
it off.

- Why: Pixal3D's shape is stable and its texture is a lottery. On sheet r38 the
  girl passed 1 seed in 18, and that pass was still rejected by the person
  (colour streaks in the hair, the gold hairpin shapeless, a pink face).
  `textureSteps` 12 → 24 on the same seed (r61): the same shape, another draw
  of the texture — no fix. Shape and texture separate; the shape is good.
- Cameras: azimuth known (±180° chosen by IoU), orthographic or perspective
  chosen by silhouette IoU — r43: IoU 0.88/0.90/0.92.
- Without optical flow: hair strands pick up skin colour, cheeks hair colour
  (a few px off). DIS flow median 7–15 px, clipped at 15 px.
- Texels no camera sees: nearest-neighbour from old colour to input colour. A
  global 3×4 affine grew a green hairpin — do not go back to it.
- UV island edges must be bled, or black cracks run across the face.
- **Hair**: an anime reference paints dark hair purple-tinted and BRIGHT
  (median 0.37) → in 3D that read as a pink cast (r62), then cement grey and
  white mould (r65). Hair = large connected dark, low-chroma regions (by the
  projected colour OR dark on the old texture; pupils are small, so they do
  not join) → chroma × `hairChroma` 0.25, median lightness moved to `hairLum`
  0.13 (the boy's Pixal3D hair is 0.12), stray highlights pulled to the hair
  colour. r67: mean RGB 35,34,34.
- **`retexture: "<mesh run>"`**: Pixal3D is NOT deterministic (the same seed
  gave different shapes in r43/r62/r64). To keep an approved shape and only
  change the texture, make a mesh run with `retexture`: the runner skips
  Pixal3D and takes that run's `mesh_pixal.glb` and views (~40 s). Re-rig with
  the old rig run's `predFrom`/`skinFrom`: rig.py takes the texture of the
  CURRENT input mesh.
- r62 (seed r43 + reproject) passed at 85: highlights in the eyes, smiling,
  the right pastel pink, a pink hairpin. Left: a grey patch in the hair behind
  the cheek (3/4), speckles in hidden hair, an extra hairpin from the shape.
  The person, 2026-10-18: "the face is good".

### Alternative mesh: Hunyuan3D-2.1 shape + paint (r67–r84)

One front image → a closed, single-layer SDF shell, ~1.5 min. Rigs better than
Pixal3D (r74: max stretch 3.7–6.2 against 5.7–9.2). The braid at the back is
guessed, bigger than the reference. No texture of its own, and the Hunyuan
mesh does NOT follow the input's pixels (silhouette IoU with the front 0.80;
Pixal3D 0.91) → projecting the reference onto it is off from the start. Its
texture has to be generated on the shape itself: Hunyuan3D-Paint 2.1 (here,
the `mesh-hunyuan3d-paint` arm). Shape + paint + rig (r84): the lowest
stretch yet (max 3.5–5.2), a texture that fits and covers; softer face than
Pixal3D, orange-smeared ears. On a 12 GB card, Paint as a texture fix for a
Pixal3D mesh was rejected (blurred face, colour drift, multi-view overflowed
to 13.7 GB). Not wired into `/char3d`; the studio's 3D console runs it.

## Step 3 — the rig: clean the mesh → Make-It-Animatable v2 JOINTS → SkinTokens WEIGHTS

Defaults (r51–r61): `prep: true`, `weights: "skintokens"`. Three stages, each
fixing one measured source of error:

| stage | what | why |
|---|---|---|
| `prep` (`prep.py`) | voxel remesh **0.0015·H** (0.003 holed thin shells → MIA put the wrist on the elbow, r97–r107) → one closed shell, drop pieces < 0.2% of vertices, decimate ~60K. MIA and the weights run on this; the weights are copied back to the ORIGINAL mesh (4 nearest vertices) — the texture is kept | a Pixal3D mesh is a TWO-LAYER shell: 61–68% of vertices have a back-facing face just inside (0.4% of the height), 1600–2500 non-manifold edges. MIA samples POINTS + NORMALS → inside and outside mixed. With prep: r49 p999 6–26 → 3.6–7.4 |
| joints: MIA | 22 Mixamo bones, no fingers; three chibi fixes below | right on a wide A-pose |
| weights: SkinTokens / TokenRig (VAST-AI, MIT) | "given skeleton" mode: MIA's skeleton becomes prefix tokens, the model generates only the weight tokens (`st_skin.py`, its own venv) | MIA's per-point weights tear loose clothes into strands. On the SAME prediction (`predFrom`): bone heat p999 r39 2.1–3.5 · r43 4.0–5.8 · r49 3.3–5.4; SkinTokens 2.0–3.8 · 1.8–3.9 · 1.6–3.0 — almost independent of the mesh |

By eye (r61): Wave — the sleeve follows the arm, smooth armpit; Run — belt
whole, a few grey spots on the hem; hands clean. Bone heat (`weights: "heat"`)
is the fallback (used automatically when the SkinTokens venv is missing): even
with SkinTokens on an easy mesh (r39 kept the belt tails tidier), clearly worse
on hard ones (r43, r49).

SkinTokens on Windows: no flash-attn wheel → `st_env.py` + `st_shim/` (a
stand-in `flash_attn` calling SDPA; transformers' `flash_attention_2` →
`sdpa`). Peak 3.8 GB (its README's 14 GB is with flash-attn and a large beam),
~53 s a run, AFTER MIA's networks are released in the same job.

Bone heat (`heat_weights`): on a raw Pixal3D mesh → "failed to find solution".
It works on a 0.006·H voxel proxy, largest connected piece, scaled ×100. On the
prepped shell, a second voxel pass can break thin parts (r53: 569 pieces, copy
P99 = 11% of the height) → it falls back to solving on the prepped shell when
the copy distance exceeds 3%.

TEXTURE faults (ear colour on the hair, a dark streak under the chin, skin at
the sleeve's edge) are on the original mesh — Pixal3D's, in regions the front
and back do not see — not the rig's.

**Skin strip on the sleeve** (r108): a reference with wide, OPEN sleeves shows
the forearm's skin inside, the mesh builds the sleeve as one layer with no
lining, and the skin is projected onto the cloth by the hem. A profile does not
fix it. `sleeveSkinFix: true` (rig.py, off by default): vertices farther than
0.032·H from the arm's axis, between mid-upper-arm and mid-forearm, are SLEEVE;
skin-coloured texels there are painted with the cloth around them (0.026 bit
into the forearm's skin). Long term: ask the reference for a closed sleeve
lining (now the default prompt). Nothing rescues a WELDED mesh (sleeve stuck to
the ribs, a 35° reference) — the cause is the reference.

**Weight leaks on the SkinTokens path** (r119–r120): the limb chain rule ran
only on the MIA path → r105/r108 had vertices past the right wrist with
0.02–0.06 `RightToeBase`, and kicks and jumps pulled the wrist with the foot
(80 clips: 64 with hand-region edges stretched > 3×, worst 11.9×). It now runs
after SkinTokens and after the copy back (with `weightFix`). A vertex dominated
by an UpLeg keeps the OTHER UpLeg too: forbidding it tore the crotch and the hem
between the legs (r119: Jump max 82).

`kneeRaise` (r116–r118): MIA puts a chibi's knee in baggy trousers at ~58% of
hip → ankle, so the leg bends at the gaiter. 0.08 brings it to ~50% — it bends
at the trouser's bulge, stretch level with the control. Default 0 (measured on
one character).

MIA is not deterministic on the GPU even with a seed → each run writes
`mia_raw.pkl` (~175 MB); `predFrom: <that pkl>` reuses it and skips MIA — to
compare two fixes on the SAME prediction. **SkinTokens is not deterministic
either** (top-k sampling on the GPU; with a seed, 16% of vertices still differ)
→ for an A/B keep the weights too: `skinFrom: <st_out.npz>` (with the same
`predFrom`). One weight run is one sample — if it is bad, run it again.

### Long hanging hair: `prep.hairCut` (co-be-vo-sinh-hong r29–r37)

MIA read hair hanging to the waist as an arm: Hips at 0.56·H (true ~0.43),
shoulders at 0.80·H INSIDE the head, the left arm pointing back into the hair
— two identical runs (r29, r30), torso clearance at its 70° ceiling on every
frame. `prep.py` now cuts hanging hair out of MIA's copy (on by default;
`prep: {"hairCut": false}` to disable; a number = the darkness threshold,
default 0.2): DARK faces flood-filled by distance (0.006·H) from the hair on the
head, the part below the CHIN dropped. The chin = the highest slice in a narrow
band, not the narrowest slice (hair round the neck keeps the width flat down to
the shoulders). Flooding from the hair leaves dark trousers and shoes alone.
Light hair (blonde, silver) is not caught yet.

Copied back to the original mesh: the cut hair goes STRAIGHT to Head → Spine2
by length (100% Head at the cut, 30% at the tips). Copying from the nearest
body vertex tore at the cut (r32: p999 18). Do not grow the hair region to
vertices next to it outside the shell (r34: p999 Walk 2.5 → 5.9). Two more
rules, both only removing: an arm-chain bone farther than 0.12·H from a vertex
is dropped (a lock of hair over the shoulder following RightArm → a slab
sticking out sideways on a swing); Head ≥ 0.25 drops the arm chain. r37:
skeleton like the boy's, handInBody 0/6, p999 2.2–4.6. Left: a small strip
behind the right shoulder in Walk; long hair follows the head and back, no
physics.

### Arm roll to Mixamo's convention (co-be-vo-sinh-hong r45–r47)

MIA sometimes predicts the arm pose TWISTED about the bone (r45: ~45°, r32:
~8°). The twist stays in the rest frame; Mixamo clips bound by name then turn in
the wrong frame → in Walk "arms down" became both arms held forward (r46),
although the rest pose looked right. rig.py now resets the roll of
Shoulder/Arm/ForeArm/Hand on both sides after the bind (Z pointing down in the
T-pose, as in the template skeleton; the boy r47, the girl r37). Changing the
rest roll does not move the mesh. `info.json` → `armRollFixed` (the correction
per bone). Quick check: in the Walk render the right arm hangs along the side;
torso clearance at 0° on every frame of Walk is a sign the arms are NOT near the
body as the clip has them.

### Joints: three fixes for chibi proportions

MIA learnt on Mixamo characters with HUMAN proportions. Straight on a chibi it
fails in three layers, each showing only once the one above is fixed
(r15–r20). All three are in rig.py, on by default:

| switch | fixes | why |
|---|---|---|
| `canonical` | drops the ROTATION to the "hip frame", keeps the translation | a frame built from 3 coarse joints is off on a chibi → the whole body tilts ~30°, the fine model predicts garbage. A Pixal3D mesh already stands upright (Y up, facing +Z) |
| `headTarget` 0.2 | shrinks the head about the neck (found as the narrowest section at 50–80% of the height) until it is ~20% of the height, predicts, then puts vertices and joints back | unshrunk, MIA puts the neck and SHOULDERS inside the head → the sleeves stay down at the T-pose, the hands fly off pulling thin strands |
| `weightFix` | three passes, all only removing: (1) drop a bone's weight on vertices far from it (near 0.04·H, far 0.1·H; a dominant bone too far → the nearest bone); (2) the arm/leg/torso chain rule; (3) a majority filter on the vertex graph (8 rounds, ≥ 60% of neighbours) | belt tails hanging at the hip weighted to Head like long hair; fingertips touching the trouser leg in the A-pose weighted to the leg → hands fanned out / spiky |

All three only DELETE weights or move coordinates and put them back; none
invents a joint. The one exception: a vertex whose dominant bone is too far
goes to the NEAREST bone (geometry, not a guess).

- **`noFingers` is on by default** (the runner): chibi fingers are tiny, and
  guessed finger joints crumple the hand when it bends.
- **The rigged GLB DROPS `occlusionTexture`**: Pixal3D's AO is baked for the
  rest pose = 0 inside the sleeve and the armpit; once the arm moves it shows as
  black patches in any PBR viewer. Workbench does not draw AO — so the
  Workbench check renders are NOT enough: always look in the web viewer too
  (Animated / Rest pose / Input mesh).
- Winding: the UDF remesh leaves 0.6% of faces against the original NORMAL;
  rig.py flips them back and carries the original NORMAL into Blender.
- `restPose: "A-pose"`: only the shoulders and upper arms are turned to the
  T-pose — right for an A-pose mesh. `"T-pose"` drops the predicted pose.
- Bones are `mixamorig:*` (52 with fingers) → Mixamo clips bind by name,
  `inplace` locks Hips' horizontal movement. No Auto-Rig Pro retarget needed.
- The objective measure: render.py's edge stretch per frame against the rest
  pose (edges under half the median ignored — the remesh leaves near-zero
  edges). A strip visible by eye ↔ p99 above ~2.5, or more than ~2% of edges
  past 2×.
- ~55 s a run (the Blender bind, ~14 s, the longest part), peak ~8.6 GB.

### Clips

The dataset `jasongzy/Mixamo` (the `bones.fbx` skeleton + 2453 clips) is gated
("auto"). Clips are named by hash and the FBX does not carry the name →
`catalog.py` measures each clip's motion and labels it roughly
(idle/walk/run/jump/wave/dance/low) into `rig/mixamo/catalog.json`. Labels are
for filtering only — "run" catches a crouched run. The default set
(`DEFAULT_RIG_ANIMATIONS` in `server/char3d/runner.ts`) was chosen by eye:
Idle, Walk, Run (= "Standard Run" shipped with MIA), Jump, Wave, Dance.

- **`armSpace` 30° by default** (like Mixamo's "Character Arm-Space", r62–r63):
  Mixamo clips are made for human proportions, arms hanging close to the body
  → a big chibi body and arms through it. Each frame the upper arm is turned
  towards horizontal by an angle proportional to how vertical the arm is (a
  horizontal arm is not touched). Forearm touching the body: Idle 39% → 11%,
  Wave 21% → 0.6%; stretch unchanged.
- **Torso clearance, `torsoClear`, on by default** (r44–r46): a fixed arm-space
  angle cannot undo hands on hips, arms round the back, or body turns on a big
  chibi torso (30° → 45°: 74 → 58 of 240 frames). `TorsoClearance` (rig.py; the
  review page runs the same algorithm and constants, "Body clearance"): the
  torso = a radius profile about the spine Hips → Neck, following the bones; on
  a frame where a hand is inside, the upper arm is RAISED about the shoulder
  along the torso's SIDEWAYS direction on that shoulder's side, by the smallest
  angle, angle and axis smoothed over time. Do not push along the hand
  (shoulder→hand × shoulder→spine, or spine→hand): an arm going from the hip
  round the back turns that direction half a circle in a few frames → the arm
  TWISTS a full turn (r46, caught by the person). r47: 0 of 180 frames, extra
  rotation ≤ 5.3°/frame, stretch unchanged.
- **The test after EVERY rig**: render.py measures `handInBody` on each clip
  (30 frames; hand vertices inside the torso by radius about the spine,
  measured independently of the clearance profile) →
  `outputs.renders.files.clips.<clip>.handInBody`. A rig review must read it —
  anything but 0 is a hand sinking in. Also `rigInfo.torsoClear[].Left/Right.maxStepDeg`
  (the largest frame-to-frame jump of the added rotation) — tens of degrees is
  a twisting arm. Both are on the run's page. The fixed check clip is **Walk**
  of the default set (it ends with the hands pressed behind the hips).

Chibi limits that remain: clips that raise the arms high bring the short hand
to or through the face (Mixamo clips are made for human proportions); a thin
flap under the arm in the T-pose. A GLB is ~55 MiB because the mesh has 300K
faces — lower `faces` at the mesh step for the web or a game.

## Check renders (`render.py`)

Workbench, orthographic: 8 texture angles (FLAT light — Studio greys the
whites), 4 clay angles, face close-ups, detail shots. The face centre is 36% of
the height from the top of the bounding box for a chibi (`faceFromTop`); a
human-proportioned character is ~0.08.

## Animation review (`/char3d/review`)

Rigged characters × Mixamo clips, put together IN THE BROWSER (three.js,
`components/char3d/AnimViewer.vue`) — no Blender run per clip.

- **Save** (on a finished rig run) stores a REFERENCE to
  `runs/<run>/rig/rest.glb` in `storage/char3d-review/saved.json` — no copy
  (~57 MB each). rest.glb and rigged.glb share the rest pose (compared).
- **Clip library** `storage/models/rig/mixamo-lib/` (`cliplib.py`): FBX → a GLB
  with only the skeleton and one clip, stored UNMODIFIED; `index.json` has the
  name, description and tags (keyword rules on name + description, groups
  locomotion/combat/weapon/dance/gesture/rest/interact/sports/style + length).
  Of 2446 Mixamo names, 19 clips get no tag (0.8%). "Standing …" is NOT idle
  (Mixamo uses it for walks, runs, shooting); bows ("With Bow", "Aim") have
  their own exclusion rule so they do not become `gun`/`bow-gesture` —
  `EXCLUDE` only removes tags.
- **The clip source**: the HF dataset has NO names (hashes, and not the md5 of
  the name — tried) → re-downloaded from mixamo.com with the person's token
  (`mixamo_fetch.py`; the token stays outside the repo). The six default clips
  can be seeded into the library from the dataset (`cliplib.py seed-hf`, tag
  `hf-dataset`) to try the page.
- **Retargeting** by bone name with a change of rest frame — each bone's rest
  pose differs between the character and the Mixamo skeleton, so values
  CANNOT be assigned directly: `q = rest_char · rest_clip⁻¹ · q_clip`; Hips
  `loc = rest_clip⁻¹ · (T − T_rest_clip)`, in place keeps loc.y. Against the
  clip Blender bound itself (r108 Walk): rotation ≤ 7e-7 on 20/22 bones, Hips
  8e-6; LeftArm/RightArm off by ~3° because arm space was computed on the
  Mixamo skeleton — which is why library clips are now unmodified and the page
  applies arm space itself. Root motion (in place off) does not scale with the
  character's size.
- **Arm space** (slider, 30° by default) is computed on the character's
  skeleton as rig.py's `arm_space` — a Python copy of the JS path matched
  Blender to 0.03°. It undoes hands touching the BODY (74 clips: 34% of frames →
  9% at 30°) but NOT the HEAD (13.6% at 0° → 14.8% at 60°): a chibi's hand
  reaches the head because the forearm folds the hand up to the face, and the
  head and hair are big.
- **Head clearance** (on by default): a hand point (the Hand joint, the
  fingertip, mid-forearm) within 0.025·H of the real head surface, or inside the
  0.8 ellipsoid core → the arm turns about the shoulder away from the head's
  centre, by the smallest angle, smoothed over time. The bounding ellipsoid
  alone misses the cheeks and chin. 60 clips: hand in head 7.2% of frames (16
  clips) → 0.05% (1 clip); rotation p90 23°, max 58°. Not in the rig step yet
  (rigged.glb has arm space only).
- Screenshots of the page mislead: Wave looks like a hand over the cheek from
  the front and is in front of the chest from the side — check a collision by
  turning the camera, or by measuring, never from one angle.

## Installing

Each arm's README: [image-qwen21-turbo-official-comfy](../arms/image-qwen21-turbo-official-comfy/README.md),
[mesh-pixal3d-comfy](../arms/mesh-pixal3d-comfy/README.md),
[rig-mia-skintokens](../arms/rig-mia-skintokens/README.md) (also covers
`mesh-char3d-tools` and the clip library). Nothing was downloaded or run with
weights on the machine this port was written on; the arms' own tests run
against stand-ins, and `apps/web/server/char3d/char3d.test.ts` runs the whole
chain against stand-in arms.
