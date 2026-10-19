# mesh-pixal3d

[Pixal3D](https://github.com/TencentARC/Pixal3D) (TencentARC, SIGGRAPH 2026, MIT) as a resident arm: one
image in, a textured GLB (PBR base colour / metallic / roughness) out, facing +Z.

Pixal3D is TRELLIS.2 with pixel-aligned conditioning: DINOv3 features are back-projected into the voxel
grid instead of attended to globally, so the shape follows the picture closely. On a full-body character it
is the only engine here that gives separate fingers and a face with real eye sockets, nose and lips
(Hunyuan3D 2.1 / 2mv and TRELLIS.2 fuse the fingers at this scale).

## Runtime

TRELLIS.2's CUDA extensions are prebuilt for one exact torch: torch 2.10 + cu130 on Python 3.13, with the
Windows wheels from [ComfyUI-Trellis2](https://github.com/visualbruno/ComfyUI-Trellis2)
(`wheels/Windows/Torch2100/CUDA 13.1`: cumesh, flex_gemm, natten, nvdiffrast, nvdiffrec_render, o_voxel).

```powershell
uv venv --python 3.13 .venv
uv pip install --python .venv\Scripts\python.exe torch==2.10.0 torchvision --index-url https://download.pytorch.org/whl/cu130
uv pip install --python .venv\Scripts\python.exe <the six wheels> trimesh>=4.11 "triton-windows>=3.6,<3.7" `
  pillow imageio imageio-ffmpeg tqdm easydict opencv-python-headless transformers==4.57.3 zstandard `
  kornia timm diffusers accelerate plyfile scipy einops huggingface_hub rembg onnxruntime `
  https://github.com/LDYang694/Storages/releases/download/20260430/utils3d-0.0.2-py3-none-any.whl
# MoGe pins FlexGEMM from git (a CUDA build): install it without dependencies
uv pip install --python .venv\Scripts\python.exe --no-deps git+https://github.com/microsoft/MoGe.git `
  git+https://github.com/EasternJournalist/utils3d-moge.git
git clone --depth 1 https://github.com/TencentARC/Pixal3D vendor\Pixal3D
```

## Weights (`storage/models/pixal3d`, ~25 GB)

- `Pixal3D/`: `TencentARC/Pixal3D` without the `*_mv` files.
- `hf/`: `camenduru/dinov3-vitl16-pretrain-lvd1689m` (an ungated mirror of DINOv3) and `Ruicheng/moge-2-vitl`.
- `torch/`: `valeoai/NAF`, fetched by torch.hub on the first run.

The pipeline's own background removal is RMBG-2.0 (gated); the arm cuts out with rembg's
`birefnet-general` instead, shared with the Hunyuan arm.

## Job

`refImages` (exactly one), `outPath`, `seed`, `resolution` (512 | 1024 | 1536; 1024 is what fits a 16 GB card),
`ssSteps` / `shapeSteps` / `texSteps` (12), `ssGuidance` / `shapeGuidance` (7.5), `targetFaces` (150000),
`textureSize` (4096), `fov` (radians; default: estimated by MoGe-2).
