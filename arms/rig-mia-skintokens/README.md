# rig-mia-skintokens

The 3D character pipeline's rig step, as a resident arm: a character GLB in
(a Pixal3D mesh from `mesh-pixal3d-comfy`), the same mesh out on a 65-bone
`mixamorig` skeleton with skin weights and a set of Mixamo clips — `rigged.glb`,
`rigged.fbx`, `rest.glb`.

```
GLB ─ prep: voxel remesh 0.0015·H → one closed shell, drop crumbs, decimate ~60K, hanging hair cut off
    ─ Make-It-Animatable v2: joints and the pose to T (on the prepped shell, head shrunk to 20%)
    ─ SkinTokens / TokenRig: weights for MIA's 22 bones (fingers folded)
    ─ weights copied back to the ORIGINAL mesh (4 nearest), texture kept
    ─ Blender (bpy 4.3): bind, reset rest to T, arm roll to Mixamo's convention,
      clips with arm space 30° and torso clearance, GLB without the occlusion map
```

Why each stage exists, and the measurements behind every default, are in
[docs/char3d.md](../../docs/char3d.md). This README is about installing it.

**This is not `rig-make-it-animatable`.** That arm is the rig console's (draft,
review in the rig editor, bind); it stays as it is. This one is the pipeline
companion-web measured on chibi characters — prep, SkinTokens, the three
chibi fixes, arm space, torso clearance — and it serves `mesh.character-rig`,
which only the `/char3d` page sends.

## Layout

```
arms/rig-mia-skintokens/
  arm.yaml  params.schema.json  weights.json
  src/arm_mia_st/        the HTTP server: validates a job, runs one script, reports the timeline
  scripts/               the work, vendored from companion-web (commit 5afbdcb) as it was measured
    rig.py prep.py st_skin.py st_env.py st_shim/   rig step
    render.py reproject.py split_sheet.py           the tools arm's tasks
    cliplib.py mixamo_fetch.py catalog.py           the clip library, run by hand
    fetch.py                                        weights, run by hand
  requirements-rig.lock.txt         .venv, frozen from the venv it ran in
  requirements-skintokens.lock.txt  .venv-skintokens, likewise
  vendor/make-it-animatable/   git-ignored: Make-It-Animatable, branch v2
  vendor/SkinTokens/           git-ignored: SkinTokens
  .venv/  .venv-skintokens/    git-ignored
```

The scripts are companion-web's, changed only where they read paths: they
read `arm.json` and `E:/` there, environment variables here (`MIA_DIR`,
`SKINTOKENS_DIR`, `SKINTOKENS_PYTHON`, `AISTUDIO_MODELS_DIR`), set by the
server from its start parameters. Their comments are still Vietnamese; they
are the record of what was measured, and are not restyled. Each reads one
JSON job and writes JSON lines (`stage`, `step`, `done`, `error`) on stdout,
which is the protocol `src/arm_mia_st/runner.py` turns into the timeline.

`mesh-char3d-tools` is the same package started with `--role tools`, on this
arm's venv, declaring no GPU: split, re-project and render are CPU work, and
running them on a GPU arm would evict the mesh arm between every step.

## Runtime

Two venvs, both Python 3.11 (Blender's `bpy` 4.3 wheel is cp311 only), because
Make-It-Animatable v2 pins transformers 4.46 and SkinTokens needs ≥ 4.57.
Measured with torch 2.8.0+cu128 (an RTX 5070, sm_120, needs cu128).

```powershell
cd arms\rig-mia-skintokens

# the code, as tested
git clone -b v2 --recursive https://github.com/jasongzy/Make-It-Animatable vendor\make-it-animatable
git -C vendor\make-it-animatable checkout bbd8b15
git -C vendor\make-it-animatable -c core.longpaths=true submodule update --init --recursive
git clone https://github.com/VAST-AI-Research/SkinTokens vendor\SkinTokens
git -C vendor\SkinTokens checkout 273b691

# .venv -- the server, MIA, bpy, and the tools
uv venv --python 3.11 .venv
uv pip install --python .venv\Scripts\python.exe torch==2.8.0 torchvision==0.23.0 `
  --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv\Scripts\python.exe `
  "https://github.com/MiroPsota/torch_packages_builder/releases/download/pytorch3d-0.7.9/pytorch3d-0.7.9%2Bpt2.8.0cu128-cp311-cp311-win_amd64.whl" `
  torch-cluster==1.6.3 --find-links https://data.pyg.org/whl/torch-2.8.0+cu128.html
uv pip install --python .venv\Scripts\python.exe -r requirements-rig.lock.txt `
  --extra-index-url https://download.pytorch.org/whl/cu128 --find-links https://data.pyg.org/whl/torch-2.8.0+cu128.html
uv pip install --python .venv\Scripts\python.exe -e ".[dev]"

# .venv-skintokens -- SkinTokens only
uv venv --python 3.11 .venv-skintokens
uv pip install --python .venv-skintokens\Scripts\python.exe -r requirements-skintokens.lock.txt `
  --extra-index-url https://download.pytorch.org/whl/cu128
```

pytorch3d and torch-cluster have no Windows wheels on PyPI; the two above are
the builds the lock file names (`pytorch3d==0.7.9+pt2.8.0cu128`,
`torch-cluster==1.6.3+pt28cu128`). The lock files were frozen from the venvs
that ran in companion-web; nothing above was run on the machine this arm was
written on.

Two hard requirements of this stack, both handled in the scripts and both
worth knowing before debugging anything else:

- **`import bpy` must come before `trimesh[easy]` or `pymeshlab`.** The other
  order fails with "DLL load failed ... procedure could not be found". Every
  script that needs both imports bpy first.
- **No flash-attn on Windows.** `st_env.py` puts a stand-in `flash_attn`
  (`st_shim/`, which calls SDPA) on the path and switches transformers'
  `flash_attention_2` to `sdpa`. Peak is 3.8 GB this way; SkinTokens' own
  README quotes 14 GB, which is with flash-attn and a large beam.

## Weights

Everything goes under the studio's models directory (`storage/models` by
default), in `rig/`, and `weights.json` lists every file with its repo,
pinned revision and exact byte count (read from the Hugging Face API, not from
a size label).

```powershell
.venv\Scripts\python.exe scripts\fetch.py --check   # what is there
.venv\Scripts\python.exe scripts\fetch.py           # 5.2 GiB
.venv\Scripts\python.exe scripts\fetch.py --anims   # + 784 MiB, the Mixamo dataset's 1000 clips
```

- **`jasongzy/Mixamo` is gated.** Accept it on its Hugging Face page, with the
  account whose token is in `HF_HOME`, before fetching. `bones.fbx` (the
  template skeleton) and the default clips come from it; do not take them
  from a mirror.
- The ShapeVAE is the same file the Hunyuan3D paint arm reads; when
  `models/hunyuan3d-2.1-official/hunyuan3d-vae-v2-1/model.fp16.ckpt` is there
  at the same size, it is hard-linked rather than downloaded again.

The two checkouts find their weights where they look for them through
directory junctions into the models directory:

```powershell
$m = (Resolve-Path ..\..\storage\models).Path
New-Item -ItemType Directory -Force vendor\make-it-animatable\output, vendor\make-it-animatable\data, vendor\SkinTokens\models
cmd /c mklink /J vendor\make-it-animatable\output\best "$m\rig\make-it-animatable\output\best"
cmd /c mklink /J vendor\make-it-animatable\data\Mixamo "$m\rig\mixamo"
cmd /c mklink /J vendor\SkinTokens\experiments "$m\rig\skintokens\experiments"
cmd /c mklink /J vendor\SkinTokens\models\Qwen3-0.6B "$m\rig\skintokens\models\Qwen3-0.6B"
```

That is the layout companion-web ran with, junction for junction.

## The default clips

The rig step binds six clips, chosen by eye on the first chibi character
(`DEFAULT_RIG_ANIMATIONS` in `apps/web/server/char3d/runner.ts`): Idle, Walk,
Run, Jump, Wave, Dance. The dataset names clips by hash, and those hashes are
what the defaults name. Run is the authors' `Standard Run.fbx`, because the
catalog's "run" hunches. **Walk is the check clip**: it ends with both hands
pressed behind the hips, which is where a chibi's hand sinks into its waist;
`render.py` measures `handInBody` on every clip after every rig.

A default clip that is not on disk is left out and the run says which; a clip
a run names itself must be there.

`scripts/catalog.py` measures the dataset's clips and labels them roughly
(idle/walk/run/jump/wave/dance/low) into `rig/mixamo/catalog.json`. The labels
are for filtering only — "run" catches a crouched run.

## The clip library (animation review page)

`/char3d/review` plays any Mixamo clip on a saved character in the browser.
Its library is built by hand, once:

```powershell
# the token: sign in at mixamo.com, F12 → Console → localStorage.access_token,
# into .mixamo-token.txt here (git-ignored), or MIXAMO_TOKEN_FILE. It expires in about a day.
.venv\Scripts\python.exe scripts\mixamo_fetch.py list    # every motion → products.json
.venv\Scripts\python.exe scripts\mixamo_fetch.py fetch   # FBX + gif + meta, skipping what is there
.venv\Scripts\python.exe scripts\cliplib.py convert      # FBX → skeleton-and-clip GLB
.venv\Scripts\python.exe scripts\cliplib.py index        # → index.json, tags
.venv\Scripts\python.exe scripts\cliplib.py seed-hf      # or only the six default clips, to try the page
```

The dataset's clips cannot be used for this: they are named by hash, and the
hash is not the name's md5 (tried). Clips are stored unmodified; arm space is
applied in the page, on the character's own skeleton.

## Job schema

| Field | | |
| --- | --- | --- |
| `task` | `rig` | the only task of this role |
| `meshPath` | — | a GLB under `inputDir` |
| `outDir` | — | a directory under `outputDir` |
| `animations` | `[]` | `[{name, path}]`, path relative to the models directory, `.fbx` |
| `predFrom`, `skinFrom` | — | a previous run's `mia_raw.pkl` / `st_out.npz` under `inputDir`, to compare two fixes on the same sample — neither MIA nor SkinTokens is deterministic on the GPU |
| `options` | `{}` | `rig.py`'s switches, passed through; anything else is refused |

`options`, with the defaults `rig.py` applies (the arm itself adds
`restPose: "A-pose"` and `noFingers: true`, which `rig.py` leaves to its caller):

| Option | Default | |
| --- | --- | --- |
| `restPose` | `A-pose` | `T-pose` keeps the input pose as the rest |
| `noFingers` | true | fold the finger bones into the hand |
| `weights` | `skintokens` | `heat` (Blender bone heat on a voxel proxy), `mia` (the network's own) |
| `prep` | true | or `{voxel, faces, minPart, hairCut, texture}` |
| `canonical`, `headTarget`, `weightFix` | true, 0.2, true | the three chibi fixes |
| `armSpace` | 30 | degrees |
| `torsoClear` | true | |
| `kneeRaise` | 0 | 0.08 for baggy trousers; measured on one character |
| `sleeveSkinFix`, `faceFromRef` | off | `faceFromRef` was rejected — leave it off |
| `armSmooth`, `legSmooth`, `rigidHand`, `retarget`, `inplace`, `seed` | 150, 0, = noFingers, false, true, 0 | |

The report's `result` is `rig.py`'s own `done`: `path`, `fbx`, `rest`, `clips`,
`bones`, `peakVramMiB`, `phaseMs`; `info.json` beside them has everything it
decided.

## Measured

On the character pipeline (RTX 5070 12 GB): ~55 s a rig, the Blender bind
(~14 s) the longest part; SkinTokens ~53 s more, after MIA's networks are
released; peak ~8.6 GB.

## Tests

```powershell
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe -m ruff check .
```

Validation and the script protocol are tested against stand-in scripts; no
weights, no bpy.
