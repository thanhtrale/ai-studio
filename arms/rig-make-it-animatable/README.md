# rig-make-it-animatable

Auto-rigging for humanoid meshes, as a resident arm. A GLB from the library
in; the same mesh out with a Mixamo skeleton, skin weights and a set of clips,
one GLB that three.js plays with an `AnimationMixer`.

The model is [Make-It-Animatable] v2 (CVPR 2025, MIT): three networks on a
Hunyuan3D 2.1 ShapeVAE encoder that predict, from 32K points of the surface,
the 52 Mixamo joints, per-vertex skin weights, and the pose that takes the
character to a T-pose. Blender, as the `bpy` module, binds the skin, resets the
rest to that T-pose, retargets the clips and writes the GLB.

## Runtime

Python 3.11, because that is what Blender's `bpy` 4.3 wheel is built for.

```powershell
uv venv --python 3.11 .venv
uv pip install --python .venv\Scripts\python.exe torch==2.7.0 torchvision==0.22.0 `
  --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv\Scripts\python.exe `
  https://download.blender.org/pypi/bpy/bpy-4.3.0-cp311-cp311-win_amd64.whl `
  "https://github.com/MiroPsota/torch_packages_builder/releases/download/pytorch3d-0.7.8%2B5043d15/pytorch3d-0.7.8%2B5043d15pt2.7.0cu128-cp311-cp311-win_amd64.whl" `
  "https://data.pyg.org/whl/torch-2.7.0%2Bcu128/torch_cluster-1.6.3%2Bpt27cu128-cp311-cp311-win_amd64.whl"
uv pip install --python .venv\Scripts\python.exe -e ".[dev]"
git clone --depth 1 -b v2 --recursive https://github.com/jasongzy/Make-It-Animatable vendor\MIA
git -C vendor\MIA -c core.longpaths=true submodule update --init util/Hunyuan3D_21
```

The checkout is used as cloned (`bbd8b15`, 8 Sep 2026). Two directory
junctions put the weights where it looks for them:

```powershell
mklink /J vendor\MIA\output\best  <storage>\models\make-it-animatable\output\best
mklink /J vendor\MIA\data\Mixamo  <storage>\models\make-it-animatable\data\Mixamo
mklink /J <storage>\cache\hy3dgen\tencent\Hunyuan3D-2.1  <storage>\models\hunyuan3d-2.1-official
```

`bpy` must be imported before `trimesh` (with its extras) or `pymeshlab`,
whose DLLs otherwise leave it unable to load ("the specified procedure could
not be found"). `vendor.install()` does that first.

## Weights

| | Where | Source |
| --- | --- | --- |
| Rig networks | `models/make-it-animatable/output/best/v2/` | [jasongzy/Make-It-Animatable] (3.3 GB) |
| ShapeVAE | `models/hunyuan3d-2.1-official/hunyuan3d-vae-v2-1` | the paint arm's, shared |
| Template skeleton | `models/make-it-animatable/data/Mixamo/bones.fbx` | `data/Standard Run.fbx` from the same repo |
| Clips | `models/mixamo-clips/*.fbx` | Mixamo, see below |

The authors' template is `bones.fbx` from their Mixamo dataset, which is
gated. A Mixamo clip FBX carries the same 65-bone `mixamorig` armature at the
same 0.01 scale, so `Standard Run.fbx` -- in the ungated model repo -- serves
as the template; its animation is cleared before anything is bound to it.

## Clips

- **Built in** (`builtin_clips.py`): Idle, Nod, Wave. Keyframed onto the rig
  after its rest is the T-pose, so they need no retargeting. Small, and the
  arm can ship them.
- **Mixamo**: any clip from mixamo.com, downloaded for X Bot as *FBX, without
  skin*, dropped in `clipDir`. The file name is the clip's name. Retargeted
  through Auto-Rig Pro's remapper (bundled by the checkout). Mixamo's terms
  allow using them in a project, not redistributing them, so none is in this
  repo; `Run` is the authors' `Standard Run.fbx`.

## A job

```
GLB ─ WebP maps → PNG (trimesh drops EXT_texture_webp) ─ [shell, if not closed]
    ─ MIA: joints, weights for the mesh's vertices, T-pose ─ weights cleaned
    ─ blend.py (subprocess): template armature, bind, reset rest to T-pose,
      rigid hands, one NLA track per clip, GLB ─ maps → WebP
```

MIA learnt from Mixamo skins, closed and facing out. Two passes make an
image-to-3D mesh look enough like one:

- **Shell** (`surface.py`), for a mesh that is not closed. TRELLIS.2 writes
  a thin two-sided shell in a hundred-odd pieces, half its faces wound
  inwards; sampled as it is, every coarse joint lands in the chest and the rig
  comes out upside down. The mesh is voxelised (256 along its longest side),
  filled and meshed again, and the networks read that; the weights still go
  to the mesh's own vertices. About 4 s on 100K faces. A closed mesh --
  Hunyuan3D's -- is read as it is: there the shell measurably hurts.
- **Weights** (`weights.py`), for every mesh. Vertices split along UV seams
  get one set of weights between them, so seams stay shut; a vertex owned by
  a bone none of its neighbours follow takes theirs; a shell-read mesh is
  smoothed a little along its edges. With the fingers folded, everything past
  the wrist goes over to the hand: the network weights fingers well into the
  forearm, and a wave smeared them.

Measured as edges stretched past twice their rest length over a clip, on the
TRELLIS.2 character above: wave 198 → 13 (longest 13x → 2.4x), run 867 → 232
(18x → 4.4x).

Blender runs in a process per job: `bpy` holds global state, wants the main
thread, and on this build faults at interpreter exit (0xC0000005) after the
file is written, so `blend.py` leaves with `os._exit` once it has printed its
result.

| Field | Default | |
| --- | --- | --- |
| `meshPath` | — | a GLB under `inputDir` |
| `outPath` | — | `.glb` under `outputDir` |
| `clips` | [] | built-in names and Mixamo file names, up to 16 |
| `removeFingers` | true | fold the 30 finger bones into the hands: 22 bones left |
| `inPlace` | true | locomotion stays on the spot |
| `compressTextures`, `textureQuality` | true, 100 | WebP after Blender |

## Measured

RTX 4080, a Hunyuan3D Paint character in A-pose (40K faces, 2K maps), four
clips: read 0.4 s, predict 2.8 s, Blender 3.1 s, WebP 4.3 s -- 10.5 s, plus
about 12 s to load the networks on the first job. 5.4 MB out.

## What it cannot do

It is trained on Mixamo characters. A mesh far from that fails quietly: a
character in a long robe holding a sword came back with its coarse joints
piled in the chest and the body laid on its side. Ask the image model for a
front-on, full-body A-pose in fitted clothes and nothing in the hands.

## Tests

```powershell
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe -m ruff check .
```

[Make-It-Animatable]: https://github.com/jasongzy/Make-It-Animatable
[jasongzy/Make-It-Animatable]: https://huggingface.co/jasongzy/Make-It-Animatable
