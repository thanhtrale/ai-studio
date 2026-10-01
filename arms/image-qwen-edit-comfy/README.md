# image-qwen-edit-comfy

Qwen-Image-Edit 2511 on [ComfyUI], as a resident arm.

The arm is a small Python process with no third-party dependencies of its own.
It does not run the model: it starts ComfyUI as a child, keeps it alive between
jobs, and translates in both directions — the studio's job schema into a node
graph, and ComfyUI's console output into the studio's timeline.

It replaces `image-qwen-edit-sdcpp` and takes the **same job schema**, so the
studio's web route did not have to learn anything about ComfyUI.

## Why ComfyUI, and why as a child process

ComfyUI owns a global torch device, a node registry and an asyncio server, and
it expects to be the program. Hosted in-process, this arm's `/progress`
endpoint would be a hostage to ComfyUI's event loop — and that endpoint is
exactly what you want when a sampler wedges.

The child stays warm between jobs. The supervisor's broker is built on that
assumption — a job whose start parameters match the loaded arm is brokered onto
the card in 0.0 s against a cold load — and the end-to-end test asserts it: a
second job does not restart ComfyUI.

The cost is a second process. The supervisor kills an arm's whole process tree
(`taskkill /T`), a Windows job object ties the child to this process even under
`TerminateProcess`, and `serve()` plus an `atexit` hook cover the rest.

## Installing the runtime

`vendor/` and `.venv/` are git-ignored. From this directory:

```powershell
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git vendor/ComfyUI

py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip setuptools wheel
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python.exe -m pip install -r vendor/ComfyUI/requirements.txt
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"   # pytest and ruff only
```

One venv for both: the arm launches ComfyUI with `sys.executable`, so there is
one interpreter and one torch build to reason about rather than two.

Installed here: ComfyUI `fb2315f1` (29 Sep 2026) with torch 2.11.0+cu128, which
is what an RTX 4080 (sm_89) wants.

ComfyUI is driven entirely through its HTTP API — `/prompt`, `/history`,
`/system_stats`. Its web UI is never opened, and the child is started with
`--disable-auto-launch`, `--disable-api-nodes` and `--disable-all-custom-nodes`
so that a job means the same thing on every machine.

## Weights

ComfyUI is never told a path. The arm writes an `extra_model_paths.yaml` into
its scratch directory on every start, naming the directory each of the three
files lives in, and the graph carries bare filenames. Defaults, relative to
managed storage:

| Parameter         | Default                                                    |
| ----------------- | ---------------------------------------------------------- |
| `diffusionModel`  | `models/qwen-image-edit-2511/qwenedit-aio-unet-v23.safetensors` |
| `textEncoder`     | `models/qwen-image-edit-2511/qwen_2.5_vl_7b.safetensors`    |
| `vae`             | `models/qwen-image-edit-2511/qwen_image_vae.safetensors`    |

The transformer is 19 GiB of bf16 against a 16 GiB card, which is why
`weightDtype` defaults to `fp8_e4m3fn` rather than to the checkpoint's own.

## The graph

Taken from ComfyUI's own `blueprints/Image Edit (Qwen 2511).json`, not assembled
from first principles: the AuraFlow shift at 3.1, the CFG norm, and
`index_timestep_zero` reference latents are what these weights were tuned
against.

```
UNETLoader ─ ModelSamplingAuraFlow ─ CFGNorm ─────────────┐
CLIPLoader ─┬ TextEncodeQwenImageEditPlus (positive) ─┐   │
            └ TextEncodeQwenImageEditPlus (negative) ─┤   │
VAELoader ──┘                                         │   │
LoadImage ─ FluxKontextImageScale ────────────────────┘   │
                     FluxKontextMultiReferenceLatentMethod ┴─ KSampler ─ VAEDecode ─ SaveImage
EmptySD3LatentImage ───────────────────────────────────────┘
```

Two deliberate departures from the blueprint:

- **The latent is empty**, at the size the job asked for, rather than a VAE
  encode of the first reference. The blueprint denoises at strength 1.0 from
  the reference's own shape, which makes the output size unchooseable.
- **One image per prompt**, never a batch dimension. ComfyUI derives a batch's
  noise from a single seed, so a batch of four would be four files with one
  seed between them and no way to reproduce the third on its own. Queuing four
  prompts costs nothing extra — ComfyUI caches the prompt encode across them —
  and every file gets a seed the library can record and replay.

With no references the reference plumbing is left out rather than wired to
nothing, and the job is plain text-to-image.

## Progress

ComfyUI's `/history` says nothing at all until a prompt is finished, and a cold
prompt here spends most of its time reading weights. The arm reads the child's
console output instead — `Requested to load …`, `loaded completely; … MB
loaded`, tqdm's sampler bar — and turns those into the studio's timeline.

Not the websocket: a socket that drops mid-job takes the only record of
completion with it, whereas `/history` is ComfyUI's own durable answer. The
websocket's one advantage, per-step granularity, is what the log gives anyway.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m ruff check .
```

`tests/fake_comfy.py` speaks the four endpoints the arm uses and prints the log
lines it parses, so the whole translation — start, queue, poll, move the file,
build the timeline — is exercised on a machine with no GPU at all.

[ComfyUI]: https://github.com/comfyanonymous/ComfyUI
