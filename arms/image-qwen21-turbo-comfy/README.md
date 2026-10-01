# image-qwen21-turbo-comfy

Qwen-Image 2.1 with the [viggle-turbo] LoRA, on [ComfyUI], as a resident arm.

The sibling of `image-qwen-edit-comfy`: same shape, same studio job schema,
different model and a very different sampler. Six transformer passes instead of
forty, no classifier-free guidance, and an explicit sigma schedule the LoRA was
distilled against.

> **Licence.** viggle-turbo is a derivative of Qwen-Image 2.1 and ships under the
> Qwen RESEARCH LICENSE: **non-commercial use only**. The base weights are under
> the same licence. Commercial use needs a separate licence from the licensor.

## What is different from the edit arm

| | `image-qwen-edit-comfy` | this arm |
| --- | --- | --- |
| Transformer | Qwen-Image-Edit 2511 | Qwen-Image 2.1 |
| Text encoder | Qwen2.5-VL 7B | Qwen3-VL 8B |
| VAE latent | 16 channels, ⅛ scale | 64 channels, ¹⁄₁₆ scale |
| Sampler | `KSampler`, CFG, a named scheduler | `SamplerCustomAdvanced` on `ViggleTurboSigmas`, unguided |
| Steps | 4 (distilled merge) or 20–40 | 6 |
| Edge multiple | 16 | 32 |
| References | up to 3 | up to 3 |
| Prompt enhancer | none | optional, on the same text encoder |

`cfgScale`, `scheduler` and `flowShift` arrive in the job and mean nothing here:
there is no guidance to scale, the schedule is the LoRA's own, and its shift is
computed from the frame. They are accepted rather than refused so one console
can drive both arms, and the job's step says so.

## The graph

From Viggle's own `comfyui/Qwen-Image-2.1-viggle-turbo-{t2i,edit}.json`, not
assembled from first principles.

```
UNETLoader ─ ViggleTurboLora ─ QwenImage21Cache ─┐
CLIPLoader ─┬ TextEncodeQwenImage21 ─────────────┴ BasicGuider ─┐
VAELoader ──┘         ▲                                          │
LoadImage ────────────┘ (image_1..image_3)          RandomNoise ─┤
                                                 KSamplerSelect ─┤
EmptyLatentImage ─┬ ViggleTurboSigmas ──────────────────────────┤
                  └─────────────────────────────── SamplerCustomAdvanced ─ VAEDecode ─ SaveImage
```

Two things worth knowing:

- **The LoRA is never merged.** `ViggleTurboLora` applies it as `Wx + BAx` at
  runtime. ComfyUI's stock loaders merge into the weights, and for this adapter
  round-to-nearest into bf16 keeps only about 70% of the update.
- **The schedule is not a scheduler.** `ViggleTurboSigmas` takes raw nodes and
  applies the pipeline's resolution-dependent shift. The nodes below `0.875` are
  where the student was trained to land; extra steps subdivide the first,
  highest-noise segment, which is where composition is decided. `sigma_nodes()`
  in [graph.py](src/arm_qwen21/graph.py) implements exactly that rule, so `steps`
  stays a number the console can offer.

## The prompt enhancer

Off unless a job sets `enhancePrompt`. It runs as a graph of its own —
`CLIPLoader` → `TextGenerate` → `PreviewAny` — against **the text encoder the
image graph already loads**, so it costs no extra model on the card. The
rewriter's instructions are Viggle's, saved verbatim in
[rewrite/](src/arm_qwen21/rewrite): `t2i.md` for text-to-image, `edit.md` when
there are references.

It runs once per job, not once per image: the rewrite does not depend on the
seed. What it produces is reported as `prompt_used`, which is the field the
studio's library already records for the video arm's enhancer.

A rewrite that comes back malformed is not an error. The job keeps the prompt as
typed and the timeline says so.

## Installing the runtime

`vendor/`, `.venv/` and `custom_nodes/` are git-ignored. From this directory:

```powershell
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git vendor/ComfyUI

py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip setuptools wheel
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python.exe -m pip install -r vendor/ComfyUI/requirements.txt
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"

# Viggle's two nodes, as a package ComfyUI will load
mkdir custom_nodes\viggle_turbo
curl -L -o custom_nodes\viggle_turbo\__init__.py `
  https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/resolve/main/comfyui/viggle_turbo.py
```

ComfyUI is started with `--disable-all-custom-nodes --whitelist-custom-nodes
viggle_turbo`, and `custom_nodes/` reaches it as a search path in the
`extra_model_paths.yaml` the arm writes on every start. Nothing is copied into
the vendored checkout, so a job means the same thing on every machine.

## Weights

Relative to managed storage, and matching the defaults in
[params.schema.json](params.schema.json):

| Parameter | Default | Size |
| --- | --- | --- |
| `diffusionModel` | `models/qwen-image-2.1/diffusion_models/qwen_image_2.1_bf16.safetensors` | 13.3 GB |
| `textEncoder` | `models/qwen-image-2.1/text_encoders/qwen3vl_8b_int8_convrot.safetensors` | 8.7 GB |
| `vae` | `models/qwen-image-2.1/vae/qwen_image_2.1_vae_bf16.safetensors` | 0.6 GB |
| `turboLora` | `models/qwen-image-2.1/loras/Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r256.safetensors` | 1.3 GB |

The base files are Comfy-Org's, the ones ComfyUI's own Qwen-Image 2.1 template
uses; `qwen3vl_8b_bf16.safetensors` (16.3 GB) is a drop-in swap for the text
encoder when there is room for it. `weightDtype` defaults to `fp8_e4m3fn`
because the bf16 transformer and the encoder together do not fit a 16 GiB card.

### The `int8_convrot` files and CUDA 12

ComfyUI says this on start with a cu128 torch:

> You need pytorch with cu130 or higher to use optimized CUDA operations.

`comfy_kitchen`'s CUDA backend is what dequantises `int8_convrot` weights
quickly, and it disables itself below cu130. The eager backend still has the
kernels, so the int8 text encoder works — it is just not as fast as it could
be. The int8 file is still the default because on a 16 GiB card the choice is
between a slower encoder and an encoder that streams off NVMe every prompt.
Rebuilding both arms' venvs on a cu130 wheel would settle it.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m ruff check .
```

`tests/fake_comfy.py` answers both graphs the arm builds and prints the log
lines it parses, so the whole translation — start, rewrite, queue, poll, move
the file, build the timeline — runs on a machine with no GPU at all.

[ComfyUI]: https://github.com/comfyanonymous/ComfyUI
[viggle-turbo]: https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo
