# image-qwen21-lightning-comfy

Qwen-Image 2.1 with lightx2v's [Lightning] 4-step LoRA, on [ComfyUI], as a resident arm.

It replaced `image-qwen21-turbo-comfy` (viggle-turbo, six steps; removed, still in git history):
same code, same graph, same job schema, a different LoRA and four steps by default. Measured on the
RTX 4080 with a warm model at 1024x1024: about 4.6 s for four steps against 6.6 s for viggle-turbo's
six, and running viggle-turbo at four steps ghosts the arms and hands -- that is why this arm exists.

> **Licence.** Lightning is a derivative of Qwen-Image 2.1, whose weights are under the Qwen RESEARCH
> LICENSE: **non-commercial use only**. The Lightning model card states no licence of its own.

## What is different from the viggle-turbo arm

| | `image-qwen21-turbo-comfy` | this arm |
| --- | --- | --- |
| LoRA | viggle-turbo v0.2.1, rank 256, attention + MLP + modulation | Lightning, rank 16, attention q/k/v/out only (67 MB) |
| Steps | 6 | 4 (`sigma_nodes(4)` = `[1.0, 0.75, 0.5, 0.25]`, Lightning's training schedule) |
| Shift | dynamic exponential, 256..8192 tokens, 0.5..0.9 | the same -- `ViggleTurboSigmas` matches the Lightning card exactly |
| Scratch | `cache/comfy21` | `cache/comfy21-lightning` |

**The LoRA file is renamed, not retrained.** Hugging Face ships `pytorch_lora_weights.safetensors` with
PEFT `...lora.down.weight` / `...lora.up.weight` keys; `ViggleTurboLora` reads `...lora_A.weight` /
`...lora_B.weight` and silently applies nothing to keys it does not recognise. The default file is the
same tensors and metadata under the `lora_A`/`lora_B` names:

```python
from safetensors import safe_open
from safetensors.torch import save_file
with safe_open("pytorch_lora_weights.safetensors", "pt") as s:
    out = {k.replace(".lora.down.weight", ".lora_A.weight").replace(".lora.up.weight", ".lora_B.weight"): s.get_tensor(k)
           for k in s.keys()}
    save_file(out, "Qwen-Image-2.1-Lightning-4step-r16.safetensors", metadata=s.metadata())
```

**Runtime.** `.venv/`, `vendor/` and `custom_nodes/` were moved here from the turbo arm when it was
removed. The venv's console-script launchers (`pip.exe`, `pytest.exe`) still point at the old folder; use
`.venv\Scripts\python.exe -m pip` / `-m pytest`, or rebuild per "Installing the runtime".

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

The studio's image console does not use this flag. Its "Enhance prompt" button
sends the same two files, read from this folder, to the `text.vision` arm
(`/api/enhance/image`) and puts the rewrite in the prompt box to be read first —
the same arrangement as the MiniMax-H3 enhancer in the video console.

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
| `turboLora` | `models/qwen-image-2.1/loras/Qwen-Image-2.1-Lightning-4step-r16.safetensors` | 67 MB |

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
[Lightning]: https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning
