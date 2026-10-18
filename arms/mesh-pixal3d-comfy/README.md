# mesh-pixal3d-comfy

Pixal3D (TencentARC, SIGGRAPH 2026, MIT) on [ComfyUI], as a resident arm:
one image or several named views of one character in, a textured GLB out.
It is the mesh step of the 3D character pipeline (`/char3d`); see
[docs/char3d.md](../../docs/char3d.md) for how it is used and why.

Pixal3D is TRELLIS.2's latent space with a pixel-aligned conditioning: the
mesh lands where the input's pixels are. That is what lets the pipeline
project the input views' colours back onto it afterwards
(`mesh-char3d-tools`, task `reproject`).

## No runtime of its own

Like `mesh-trellis2-comfy`, this arm runs on the `image-qwen-edit-comfy`
arm's interpreter and ComfyUI checkout. Pixal3D, TRELLIS.2, MoGe and BiRefNet
are ComfyUI's own nodes (`comfy_extras/nodes_trellis2.py`, the mesh
post-processing nodes) from commit `8d53494` on — no custom node. The
character pipeline was measured on `b53f77a` (0.41.2); if the checkout is
older than `8d53494`, update it, or the graph is refused at the first node.

## Weights

Relative to managed storage. Sizes are bytes from the Hugging Face API.

| Parameter | Default | Source | Bytes |
| --- | --- | --- | ---: |
| `multiviewModel` | `models/pixal3d/pixal3d_multiview_bf16.safetensors` | [Comfy-Org/Pixal3D] `diffusion_models/` | 10,999,317,704 |
| `singleModel` | `models/pixal3d/pixal3d_int8_convrot.safetensors` | the same | 5,584,555,824 |
| `clipVision` | `models/pixal3d/dino_v3_L_naf_fp32.safetensors` | the same, `clip_vision/` | 1,215,214,176 |
| `shapeVae` | `models/trellis2/trellis_2_shape_vae_bf16.safetensors` | shared with `mesh-trellis2-comfy` | 1,095,844,024 |
| `textureVae` | `models/trellis2/trellis_2_texture_vae_bf16.safetensors` | shared with `mesh-trellis2-comfy` | 948,461,364 |
| `bgModel` | `models/birefnet/birefnet.safetensors` | [Comfy-Org/BiRefNet] `background_removal/` | 444,473,596 |
| `mogeModel` | `models/moge/moge_2_vitl_normal_fp16.safetensors` | [Comfy-Org/MoGe] `geometry_estimation/` | 661,859,924 |

Revisions the pipeline ran on: Comfy-Org/Pixal3D `f37641be`, Comfy-Org/MoGe
`14849852`, Comfy-Org/BiRefNet `25511f87`.

- **The VAEs are shared, not duplicated.** `vae/trellis_2_*_bf16.safetensors`
  in Comfy-Org/Pixal3D and in Comfy-Org/TRELLIS.2 have the same sha256
  (`de0cb494…`, `714e5ebf…`).
- **The DINOv3 is not.** Pixal3D's `dino_v3_L_naf_fp32` is a different file
  from TRELLIS.2's `dino_v3_vit_l`.
- `pixal3d_multiview_int8_convrot.safetensors` (5,584,555,824 B) is the int8
  alternative for `multiviewModel`. The pipeline does not use it by default:
  on the same character and sheet, int8 passed 0 of 12 (hair washed brown or
  moss green, clothes purple or pink) where bf16 passed 1 of 4 with clean
  colours. A run with `precision: "int8"` asks for it.
- `pixal3d_bf16.safetensors` (single view, bf16) exists upstream and is not
  used: the pipeline is multi-view.

## The graph

From Comfy-Org's templates `3d_pixal3d_trellis2_image_to_model` and
`3d_pixal3d_multi_views` (`comfyui_workflow_templates_json` 0.1.96), sampling
kept exactly — the CFG override and rescale, shift 5 on the structure pass,
the step counts.

```
per view   LoadImage ─ RemoveBackground ─ ImageCropToMask (1024², pad 1.1, black) ─ SaveImage (view_<name>)
                                   │
one view   MoGe-2 → FOV ─ Pixal3DConditioning
views      Pixal3DMultiViewConditioning (front/left/back/right, fov 20)
                                   │
structure  KSampler 12 (CFG 7.5 over the last third, rescale 0.7, shift 5) ─ decode
shape      Trellis2ShapeStage ─ KSampler 20 ─ upsample to 1536 ─ KSampler 12
texture    Trellis2TextureStage ─ KSampler 12 (unguided) ─ decode
mesh       GetMeshInfo ─ RemeshMesh (UDF, 768) ─ DecimateMesh 300K ─ MeshSmoothNormals ─ UnwrapMesh 2048
bake       BakeTextureFromVoxel ─ BakeNormalMapFromMesh ≤2048 ─ BakeAmbientOcclusion 1024 ─ SaveGLB, SaveImage (basecolor)
```

Beside the GLB the arm leaves `<name>_views/<view>.png` — each view after the
cut-out, exactly what the model saw — and `<name>_basecolor.png`. Both are
what a reviewer traces a bad mesh back with, and what `reproject` reads.

- **"left" is the character's own left.** The camera stands at its left and
  the character faces the left edge of the image.
- **Every view is cropped to its mask's bounding box.** For a figure standing
  upright the height sets the scale in every view, which is what the
  multi-view rig assumes. A sheet whose views disagree in height breaks it.
- **The UDF remesh builds a two-layer shell.** Invisible at rest; once rigged,
  the inner layer pulls away where a sleeve bends. `dropInverted` and
  `dropEnclosed` are the remesh's own switches, off as in the templates: the
  rig step remeshes its own copy instead.

## Job schema

| Field | Default | |
| --- | --- | --- |
| `outPath` | — | must end in `.glb`, under `outputDir` |
| `views` | — | `{front, left?, back?, right?}`, images under `inputDir`; one view runs the single-view model through MoGe |
| `seed`, `batch` | −1, 1 | −1 draws a random seed per mesh; batch ≤ 8 |
| `structureSteps`, `shapeSteps`, `refineSteps`, `textureSteps` | 12, 20, 12, 12 | 24 texture steps measured no better than 12 |
| `structureCfg`, `shapeCfg` | 7.5, 7.5 | |
| `shapeResolution` | 1536 | 1024 or 1536 |
| `remeshResolution` | 768 | 256–1024 |
| `targetFaces` | 300000 | 20K–2M |
| `textureSize` | 2048 | 512–4096; 4096 measured no sharper than 2048 in close-ups |
| `fov`, `pad` | 20, 1.1 | the multi-view camera, and the crop margin |
| `dropInverted`, `dropEnclosed` | false | |
| `bakeNormals`, `bakeOcclusion` | true | |
| `compressTextures`, `textureQuality` | true, 100 | WebP via `EXT_texture_webp`. The pipeline turns it off: trimesh, which `reproject` and the rig read with, drops that extension |

The report has `mode` (`multi-view` / `single-view`), the transformer file it
loaded, and per mesh `out_path`, `seed`, `faces`, `vertices`, `views`,
`basecolor`.

## Measured

On the character pipeline (RTX 5070 12 GB, front + left + back, bf16): peak
~9.7 GB for the whole card, 135–145 s a mesh. Earlier runs logged ~95 s for one
image and ~120 s for two, peak ~11 GB. Not yet measured on this studio's 16 GB card.

## Tests

```powershell
..\image-qwen-edit-comfy\.venv\Scripts\python.exe -m pytest
..\image-qwen-edit-comfy\.venv\Scripts\python.exe -m ruff check .
```

`tests/fake_comfy.py` answers the graph and writes the GLB and the images its
save nodes name, so the whole translation runs with no GPU.

The runtime is the TRELLIS.2 arm's, with one fix: two websocket progress
ticks with the same clock reading divided by zero inside the socket thread,
which then heard nothing for the rest of the prompt. The TRELLIS.2 arm still
has it.

[ComfyUI]: https://github.com/comfyanonymous/ComfyUI
[Comfy-Org/Pixal3D]: https://huggingface.co/Comfy-Org/Pixal3D
[Comfy-Org/BiRefNet]: https://huggingface.co/Comfy-Org/BiRefNet
[Comfy-Org/MoGe]: https://huggingface.co/Comfy-Org/MoGe
