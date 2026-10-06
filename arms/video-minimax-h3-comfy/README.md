# video-minimax-h3-comfy

[MiniMax-H3] with the [Turbo LoRA], on [ComfyUI], as a resident arm.

The video sibling of `image-qwen21-turbo-comfy`: same shape, same ComfyUI child,
same distilled-student bargain. Four to eight transformer passes instead of
twenty, no classifier-free guidance, and picture and **stereo audio denoised
together** in one packed latent rather than layered on afterward.

> **Licence.** MiniMax-H3 is released under the MiniMax H3 Community License
> Agreement, not an OSI licence. Commercial use of locally generated output
> needs a separate commercial licence. The Turbo LoRA itself is Apache-2.0, but
> it is useless without the base.

## Why the un-pruned checkpoint

Comfy-Org repacks H3 twice over: a full checkpoint and a *pruned* one that drops
the AdaLN branches (about 13B of the 33B parameters, precomputable for
inference-only use). The pruned files are half the size and they are not the
same model to a LoRA: the Turbo adapter's AdaLN update lives in a 2688-dimension
`silu(t_emb)` space the pruned base has collapsed into an eight-point curve, so
the node has to re-interpolate it from a bundled grid at run time.

That re-injection works, and it is an approximation of an update that is exact
on the full base. The Turbo LoRA's own repository also ships *separate* pruned
conversions with the mismatched adapters stripped out, and says in as many words
that they "should not be assumed to behave identically". So this arm defaults to
the full `fl2va` checkpoint and the plain (non-converted) LoRA, and pays for it
in gigabytes.

`int8_convrot` rather than `bf16` for the same 34 GB against 66 GB reason the
image arms quantise: both are un-pruned, and Comfy-Org's own note is to prefer
`int8_convrot` where torch is new enough for its kernels. `weightDtype` therefore
defaults to `default`, not `fp8`: the checkpoint already carries its
quantisation and casting it again would quantise it twice.

| | full (this arm) | pruned |
| --- | --- | --- |
| `fl2va` bf16 | 66.3 GB | 40.2 GB |
| `fl2va` int8_convrot | **34 GB** | 21 GB |
| AdaLN branches | present | collapsed to a curve |
| Turbo LoRA | applied directly | re-injected per forward |

## What is different from the LTX arm

| | `video-ltx25-diffusers` | this arm |
| --- | --- | --- |
| Runtime | Diffusers, in-process | ComfyUI child process |
| Transformer | LTX-2.5 distilled, 22B | MiniMax-H3, 33B |
| Text encoder | Gemma-4 12B | Qwen3-VL 32B |
| Steps | 8, fixed schedule | 4–8, `BasicScheduler` on `simple` |
| Frame grid | `8n+1`, any fps | `17k+5` at 24 fps |
| Spatial grid | 32 | 32 |
| Keyframes | first frame | fl2v: first, last or both · ref2v: up to 9 references |
| Batch | one clip | up to 16, each its own seed and file |
| Upsamplers | spatial, temporal | none (2K is a hosted service) |
| Prompt enhancer | Gemma rewrites the caption | Qwen3-VL 8B, on its own arm, before the job |

## Two modes

| | `fl2v` (default) | `ref2v` |
| --- | --- | --- |
| Checkpoint | `diffusionModel` (fl2va) | `ref2vaModel` (ref2va) |
| Conditioning node | `MiniMaxH3ImageToVideo` | `MiniMaxH3ReferenceToVideo` |
| `refImages` | 0–2, positional: first frame, last frame | 1–9, cited in the prompt as `<Picture 1>`… |
| Extra job field | — | `refImageSize`: `match` (default) or `max` |

A job says `"mode": "ref2v"`; anything else, or nothing, is fl2v. Everything
downstream of the conditioning node — LoRA, shift, sampler, both decoders — is
the same graph. The two checkpoints are loaded by the same `UNETLoader` by
name, so switching modes is not an arm restart; ComfyUI swaps the transformer
in and out of RAM.

`ref2vaModel` is not read at start. An arm without the file still runs fl2v,
and a ref2v job is refused with the missing path before ComfyUI is started.

**The Turbo LoRA on ref2va is unmeasured.** Its README describes the fl2va line
only. It is applied the same way here; if ref2v output is visibly worse at six
steps, that is the first suspect.

## The prompt enhancer

H3's own rewriter, **H3-Context-IR**, is a hosted multi-stage system and not
part of the open release, and this arm still rewrites nothing. The studio's
enhancer runs **before** the job, on a separate arm:
[`text-qwen3vl-8b-llamacpp`](../text-qwen3vl-8b-llamacpp). The video console
sends it the user's note, the draft prompt and the reference images; the
instructions (in `apps/web/server/enhance/h3.ts`) ask for the shape H3's own
example prompts take — a look paragraph, a `Timeline:` of `[0s-2s]` shots, a
camera line, an `Audio:` line, a constraints line — with `<Picture i>` tags in
ref2v. The user reads the result in the prompt box before generating.

H3's own encoder cannot do this job: the repack is truncated at layer 50, so
there is no head left to generate text with.

`prompt_used` is reported as the prompt submitted, so the library's record
reads the same across arms.

## The graph

From Larryvrh's `example_workflows/minimax_h3_t2v_turbo.json`, not assembled from
first principles.

```
UNETLoader ─ MiniMaxH3TurboLoRA ─ MiniMaxH3SigmaShift ─┬ BasicGuider ────────┐
                                                       └ BasicScheduler ───┐ │
CLIPLoader ──┬ MiniMaxH3ImageToVideo ─┬ (positive) ────────────────────────┘ │
             │  (ref2v: MiniMaxH3ReferenceToVideo, ref_images.ref_image_N)  │
VAELoader ───┘  ▲                     └ (packed AV latent) ──────────────────┤
(video)      LoadImage  (first_frame / last_frame)       RandomNoise ────────┤
                                                MiniMaxH3TurboSampler ──────┤
                                                      SamplerCustomAdvanced ─┤
                            ┌─ VAEDecode      (video VAE) ───────────────────┤
                            └─ VAEDecodeAudio (audio VAE) ───────────────────┘
                                          └─ CreateVideo ─ SaveVideo
```

Three things worth knowing:

- **One latent, two decoders.** H3's sampler output is a nested pair — video at
  `[B,24,T,H/16,W/16]` and audio at `[B,32,2,T40]`. Both decoders read the *same*
  sampler output; linking the audio decode to the video VAE produces a silent
  clip and no error.
- **The sampler is not a `KSampler`.** The two streams ride different flow
  schedules (video shift 12, audio shift 3). Recent ComfyUI carries that natively
  through `ModelSamplingAV`; older ComfyUI does not, and a stock sampler
  over-steps the audio into noise at four steps. `MiniMaxH3TurboSampler` detects
  which build it is on, so the graph asks for it rather than for
  `KSamplerSelect`.
- **The LoRA is not merged.** `loraMode: bypass` applies it as `Wx + BAx` at run
  time. Merging a low-rank update back into an int8 base requantises most of it
  away; `merge` exists for when the card cannot afford the bypass path, and it
  is visibly softer.

## The two grids

Both are the model's and neither is negotiable, so
[graph.py](src/arm_h3/graph.py) implements them and the console rounds to them
before it asks:

- **Size** is a multiple of **32**. The native canvas is a 768-pixel short edge
  under a `768×1344` area cap — that is `1344×768` at 16:9. Above it the model is
  being asked for a resolution it was never trained at; 2K comes from
  `H3-Regenerate-2K`, which is not open.
- **Length** is `17k + 5` frames at **24 fps**: 5, 22, 39 … 124 (≈5 s) … 362
  (≈15 s). The trained range is 124–362. A frame count off the grid is rounded up
  rather than refused, because the grid is the model's rather than the caller's
  mistake.

## Installing the runtime

`vendor/`, `.venv/` and `custom_nodes/` are git-ignored. From this directory:

```powershell
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git vendor/ComfyUI

py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip setuptools wheel
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python.exe -m pip install -r vendor/ComfyUI/requirements.txt
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"

# The turbo nodes, as a package ComfyUI will load. The clone carries
# h3_silu_temb_grid.safetensors beside the node, which is why this is a clone
# and not a single file.
git clone --depth 1 https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo.git `
  custom_nodes\minimax_h3_turbo
```

ComfyUI is started with `--disable-all-custom-nodes --whitelist-custom-nodes
minimax_h3_turbo`, and `custom_nodes/` reaches it as a search path in the
`extra_model_paths.yaml` the arm writes on every start. Nothing is copied into
the vendored checkout, so a job means the same thing on every machine.

ComfyUI 0.30.0 or newer: the native `MiniMaxH3*` nodes landed there.

## Weights

Relative to managed storage, and matching the defaults in
[params.schema.json](params.schema.json):

| Parameter | Default | Size |
| --- | --- | --- |
| `diffusionModel` | `models/minimax-h3/diffusion_models/minimax_h3_fl2va_int8_convrot.safetensors` | 31.70 GiB |
| `ref2vaModel` | `models/minimax-h3/diffusion_models/minimax_h3_ref2va_int8_convrot.safetensors` | not yet downloaded |
| `textEncoder` | `models/minimax-h3/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | 25.28 GiB |
| `videoVae` | `models/minimax-h3/vae/minimax_h3_video_vae_fp16.safetensors` | 4.85 GiB |
| `audioVae` | `models/minimax-h3/vae/minimax_h3_audio_vae_fp32.safetensors` | 0.56 GiB |
| `turboLora` | `models/minimax-h3/loras/minimax_h3_turbo_v4_step600_ema.safetensors` | 0.73 GiB |

63.12 GiB on disk, measured rather than quoted.

```powershell
$MODELS = "..\..\storage\models\minimax-h3"

hf download Comfy-Org/MiniMax-H3 --local-dir $MODELS `
  --include "diffusion_models/minimax_h3_fl2va_int8_convrot.safetensors" `
            "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors" `
            "vae/minimax_h3_video_vae_fp16.safetensors" `
            "vae/minimax_h3_audio_vae_fp32.safetensors"

# ref2v only. Check the exact name in the repository first; if it differs,
# set ref2vaModel to it.
hf download Comfy-Org/MiniMax-H3 --local-dir $MODELS `
  --include "diffusion_models/minimax_h3_ref2va_int8_convrot.safetensors"

hf download larryvrh/MiniMax-H3-Turbo-Lora --local-dir "$MODELS\loras" `
  --include "minimax_h3_turbo_v4_step600_ema.safetensors"
```

`--local-dir` rather than the blob cache, because WDDM cannot create symlinks.

The two VAEs must sit in the same directory: ComfyUI's `VAELoader` has one search
path, and the arm derives it from `videoVae`.

### What this costs on a 16 GiB card

63 GiB of weights against 16 GiB of VRAM. ComfyUI's dynamic VRAM manager streams
the transformer block by block over PCIe, which is why `vramMode` defaults to
`dynamic` and the arm is patient with its timeouts. `textEncoderDevice: cpu`
takes Qwen3-VL 32B off the card entirely and costs one slower prompt encode per
job.

`attention: sage` roughly halves sampling time and needs its own wheel in this
arm's venv; it is not the default because it is not installed by default.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m ruff check .
```

`tests/fake_comfy.py` answers the graph the arm builds and prints the log lines
it parses, so the whole translation — start, queue, poll, move the file, build
the timeline — runs on a machine with no GPU at all.

[ComfyUI]: https://github.com/comfyanonymous/ComfyUI
[MiniMax-H3]: https://huggingface.co/MiniMaxAI/MiniMax-H3
[Turbo LoRA]: https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora
