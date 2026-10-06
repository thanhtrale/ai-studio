# mesh-hunyuan3d-comfy

Hunyuan3D 2.1 image-to-shape on [ComfyUI], as a resident arm. One photograph in,
an untextured GLB that three.js loads as is out.

The arm is the same shape as `image-qwen-edit-comfy`: a small Python process
with no dependencies of its own that starts ComfyUI as a child, keeps it warm
between jobs, builds the node graph, and turns ComfyUI's console output into
the studio's timeline.

## No runtime of its own

This arm has no `vendor/` and no `.venv/`. It runs on the
`image-qwen-edit-comfy` arm's interpreter and ComfyUI checkout:

- `arm.yaml` launches `../image-qwen-edit-comfy/.venv/Scripts/python.exe`
- `--comfy-dir` defaults to `../image-qwen-edit-comfy/vendor/ComfyUI`

That checkout (`fb2315f1`, 29 Sep 2026) already carries every node the graph
uses — Hunyuan3D, BiRefNet, `ImageCropToMask`, `RotateMesh`, `DecimateMesh`,
`SaveGLB` — so a second clone would only be a second torch install to keep in
step. Install that arm first; nothing else is needed. The two never run at once
(both are `gpu: exclusive`), and each has its own scratch directory.

## Weights

Relative to managed storage:

| Parameter    | Default                                            | Source |
| ------------ | -------------------------------------------------- | ------ |
| `checkpoint` | `models/hunyuan3d-2.1/hunyuan_3d_v2.1.safetensors` | [Comfy-Org/hunyuan3D_2.1_repackaged] (7.4 GB) |
| `bgModel`    | `models/birefnet/birefnet.safetensors`              | [Comfy-Org/BiRefNet] (444 MB) |

The checkpoint is the DiT, the DINOv2 image encoder and the shape VAE in one
file, loaded by `ImageOnlyCheckpointLoader`.

`models/hunyuan3d-2mv/hunyuan3d-dit-v2-mv_fp16.safetensors` is also downloaded,
for the multi-view case this arm does not do yet.

## The graph

The core is ComfyUI's own `blueprints/Image to Model (Hunyuan3d 2.1).json`:
shift 1.0, 30 euler steps at CFG 5, a 4096-token latent, octree 256, surface
nets at 0.6. Around it:

```
LoadImage ─┬─ RemoveBackground (BiRefNet) ─ ImageCropToMask (1024², +15%, white)
           │                                        │
ImageOnlyCheckpointLoader ─ CLIPVisionEncode ───────┘
       │                         │
       │                  Hunyuan3Dv2Conditioning
       ├─ ModelSamplingAuraFlow ─ KSampler ─ VAEDecodeHunyuan3D ─ VoxelToMesh
       │                                                              │
       │                         RotateMesh (−90° about Y) ───────────┘
       │                               │
       │                         DecimateMesh (optional) ─ SaveGLB
```

- **Cut-out.** Hunyuan3D was trained on renders of one object on a plain
  background; a photograph's floor and shadow come out as geometry. BiRefNet
  masks the object and `ImageCropToMask` centres it on white with a margin.
  `removeBackground: false` skips this for an image that is already clean.
- **Orientation.** Hunyuan3D puts an object's front along +X whatever angle the
  photo was taken from. glTF — and three.js — expect +Z, so the mesh is turned
  −90° about Y. Measured on a chair, not taken from a paper.
- **Decimation.** Octree 256 gives a few hundred thousand faces (366K and
  6.5 MB for the test chair). `targetFaces` brings that down; QEM stops below
  the target, so asking for 50K gave 35K.

The output is untextured: Hunyuan3D's paint stage is not in ComfyUI. The GLB
carries positions and indices only, with a grey `doubleSided` material.

## Job schema

| Field              | Default | |
| ------------------ | ------- | - |
| `outPath`          | —       | must end in `.glb`, under `outputDir` |
| `refImages`        | —       | exactly one path, under `inputDir` |
| `seed`             | −1      | −1 draws one per mesh |
| `batch`            | 1       | up to 8; one seed and one file per mesh |
| `steps`, `cfgScale`, `sampler`, `scheduler` | 30, 5, euler, normal | |
| `octreeResolution` | 256     | 128, 192, 256, 320, 384 |
| `latentTokens`     | 4096    | 1024, 2048, 3072, 4096 |
| `targetFaces`      | 0       | 0 keeps the raw surface |
| `removeBackground` | true    | |

The report lists each mesh with `vertices` and `faces` read back from the GLB.

## Measured

RTX 4080, warm child, the chair above: 34–37 s per mesh at the defaults, peak
8.7–9.1 GiB on the whole card.

## Progress

Two sources, because each knows something the other does not:

- **ComfyUI's websocket** (`comfyws.py`, a stdlib RFC 6455 client): every
  prompt is queued with the arm's `client_id`, so `executing` names each node
  as it starts, `progress` counts any node's own steps and `progress_text`
  carries a node's own line ("faces: 7.33M → 50K"). Each named node in
  `graph.NODE_LABELS` becomes a step on the timeline, and each node that counts
  steps gets its own meter -- four samplers are four bars, not one bar refilled
  four times.
- **The console log**: the only place model loads are described.

While the socket is up, the log's tqdm bar is ignored. If it drops, the arm
reconnects and falls back to that bar; completion is always decided by
`/history`, never by the socket.

## Tests

```powershell
..\image-qwen-edit-comfy\.venv\Scripts\python.exe -m pytest
..\image-qwen-edit-comfy\.venv\Scripts\python.exe -m ruff check .
```

`tests/fake_comfy.py` speaks the endpoints the arm uses and writes a minimal
GLB, so the whole translation runs with no GPU.

[ComfyUI]: https://github.com/comfyanonymous/ComfyUI
[Comfy-Org/hunyuan3D_2.1_repackaged]: https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged
[Comfy-Org/BiRefNet]: https://huggingface.co/Comfy-Org/BiRefNet
