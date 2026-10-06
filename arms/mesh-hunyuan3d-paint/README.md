# mesh-hunyuan3d-paint

Hunyuan3D 2.1 end to end, shape **and** texture, as a resident arm. One
photograph in, a GLB with a PBR material (base colour, metallic, roughness)
out, which three.js loads as a `MeshStandardMaterial` with no code of its own.

Hunyuan3D's paint stage is not in ComfyUI, so this arm runs Tencent's own
code instead: both stages, in this
process, on this arm's own venv.

## Runtime

```powershell
uv venv --python 3.13 .venv
uv pip install --python .venv\Scripts\python.exe torch==2.11.0 torchvision==0.26.0 `
  --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv\Scripts\python.exe -e ".[dev]"
git clone --depth 1 https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1 vendor\Hunyuan3D-2.1
```

The checkout is used as cloned (tested at `82920d6`, 17 Oct 2025). Nothing in
it is edited, and nothing in it is built.

### What is not built, and what stands in for it

Upstream needs two compiled extensions, Blender and basicsr. None of them is
installed here, so this machine needs no nvcc and no MSVC:

| Upstream | Here | |
| --- | --- | --- |
| `custom_rasterizer` (CUDA) | `raster.py` | The same z-buffer: `scatter_reduce(amin)` on the kernel's own 64-bit depth-and-face token, same pixel centres, same tie rule. Tested against the kernel's loop written out in Python, and the output is identical. |
| `mesh_inpaint_processor` (pybind11) | `inpaint.py` | The same vertex-colour diffusion on a sparse adjacency matrix. It uses Jacobi updates where upstream uses Gauss-Seidel: more passes, the same colours. |
| `bpy`, for OBJ → GLB | `glb.py` | The GLB is written directly. |
| basicsr + realesrgan | spandrel | Loads the same `RealESRGAN_x4plus.pth`. |

`vendor.py` registers the two stand-ins under the module names the vendored
code imports, so `MeshRender` finds them through its own `import` statements.

### One upstream bug, not reproduced

The paint model draws its metallic-roughness views in the glTF layout:
roughness in G, metallic in B, and R always white (see
`hy3dpaint/train_examples/*/render_tex/*_mr.png`). Upstream's
`MeshRender.get_texture_mr` reads R as metallic and G as roughness, so its
exported meshes come out fully metallic. `engine.py` takes G and B.

## Weights

Relative to managed storage:

| Parameter | Default | Source |
| --- | --- | --- |
| `shapeDir` | `models/hunyuan3d-2.1-official/hunyuan3d-dit-v2-1` | [tencent/Hunyuan3D-2.1] (7.4 GB: DiT, shape VAE, DINOv2-L) |
| `paintDir` | `models/hunyuan3d-2.1-official/hunyuan3d-paintpbr-v2-1` | [tencent/Hunyuan3D-2.1] (6.9 GB) |
| `dinoDir` | `models/dinov2-giant` | [facebook/dinov2-giant], `model.safetensors` only (4.5 GB) |
| `upscaler` | `models/realesrgan/RealESRGAN_x4plus.pth` | [Real-ESRGAN v0.1.0] (67 MB) |
| `rembgDir` | `models/rembg` | rembg downloads `birefnet-general` here on first use |

Comfy-Org's `hunyuan_3d_v2.1.safetensors` is the same shape model repackaged
for ComfyUI; its key names are ComfyUI's, so Tencent's loader needs the
original checkpoint.

## A job

```
photo ─ rembg cut-out ─┬─ shape DiT (30 steps, CFG 5) ─ octree 256 surface
                       │        └ floaters, degenerate faces, QEM to targetFaces
                       │
                       └─ paint: xatlas unwrap ─ view selection ─ normal + position renders
                                 ─ multiview UNet (15 UniPC steps, CFG 3): albedo + MR per view
                                 ─ Real-ESRGAN x4 ─ back-project and bake at 2× ─ inpaint
                                 ─ GLB ─ WebP
```

Only one stage is on the card at a time. Both stay in system memory between
jobs (about 16 GB), and `Engine.place` moves the idle one off before the other
runs, which is what upstream's `--low_vram_mode` does without the reload.

- **Orientation.** Hunyuan3D's shapes face +X; the GLB is turned −90° about Y
  so the front faces +Z, as glTF expects. A `meshPath` mesh is turned the other
  way on the way in.
- **Bake size.** The texture is baked at twice the delivered size (capped at
  4096) and halved, as upstream bakes 4096 for a 2048 file: the back-projection
  is point sampled, and the halving is its antialiasing.

## Measured

RTX 4080 16 GB, the test chair, Web defaults (40K faces, six views at 512,
2048 texture, WebP lossless), through the studio's route:

| Step | s |
| --- | --- |
| Cut out (rembg, BiRefNet on CUDA) | 9.8 |
| Sample shape, 30 steps + octree 256 decode | 25.7 |
| Clean & decimate, 373K → 40K | 4.4 |
| Unwrap UVs (xatlas) | 5.0 |
| Pick views, render normals & positions | 1.0 |
| Paint views, 15 steps | 17.6 |
| Upscale 12 views | 4.9 |
| Bake | 2.2 |
| Inpaint | 4.6 |
| Write GLB + WebP | 5.1 |
| **Total** | **83** |

The first job also loads the shape model (~20 s) and the paint models
(~11 s). Peak is 12.9 GiB reserved, during the shape decode; paint peaks at
10.4 GiB. Three things keep it there, each measured, because without them
the paint stage reserved 20.9 GiB and Windows spilled it into shared memory
at a third of the speed:

- the rembg session is opened and dropped per cut-out (onnxruntime's CUDA
  arena otherwise keeps a few GB)
- DINOv2-giant visits the card only for its one call
- the rasterizer's cache is emptied before the UNet, and the VAE decodes one
  view at a time

## Job schema

| Field | Default | |
| --- | --- | --- |
| `outPath` | — | must end in `.glb`, under `outputDir` |
| `refImages` | — | exactly one path, under `inputDir` |
| `meshPath` | — | optional GLB under `inputDir` to paint instead of making a shape |
| `seed` | −1 | −1 draws one per mesh |
| `batch` | 1 | up to 4 |
| `steps`, `cfgScale` | 30, 5 | shape sampler |
| `octreeResolution` | 256 | 128, 192, 256, 320, 384 |
| `targetFaces` | 40000 | 5K–300K; the mesh the texture is painted onto |
| `removeBackground` | true | off uses the image's own alpha |
| `texture` | true | false stops after the shape and never loads the paint models |
| `paintViews` | 6 | 6–9 |
| `paintResolution` | 512 | 512 or 768 per view |
| `paintSteps`, `paintGuidance` | 15, 3 | |
| `textureSize` | 2048 | 1024, 2048, 4096 |
| `upscale` | true | Real-ESRGAN before the bake |
| `compressTextures`, `textureQuality` | true, 100 | WebP via `EXT_texture_webp`; 100 is lossless |

## Tests

```powershell
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe -m ruff check .
```

The rasterizer, the inpainting, the GLB writer and job validation are tested
with no weights.

[tencent/Hunyuan3D-2.1]: https://huggingface.co/tencent/Hunyuan3D-2.1
[facebook/dinov2-giant]: https://huggingface.co/facebook/dinov2-giant
[Real-ESRGAN v0.1.0]: https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.1.0
