# video-ltx25-diffusers

Resident video arm running **LTX-2.5 distilled** (22B DiT + Gemma-4-12B text
encoder, joint video + audio) through Hugging Face Diffusers inside its own
Python interpreter.

The model does not fit this machine's GPU at any precision, so most of what this
arm contains is a deliberate placement policy rather than pipeline plumbing. The
reasoning and the measured numbers behind every default are in
[`docs/stack-selection.md`](../../docs/stack-selection.md) and
[`docs/hardware-baseline.md`](../../docs/hardware-baseline.md).

| | |
| --- | --- |
| transformer at bf16 | 35.38 GiB — 2.7× the 16 GiB card |
| transformer at fp8 | 17.69 GiB — still 1.4× over |
| text encoder at bf16 | 22.28 GiB |
| minimal weight set on disk | 70.96 GB / 66.09 GiB |
| denoising steps | 8, fixed by the distilled sigma schedule |

## Setting up the environment

From this directory:

```powershell
uv venv --python 3.12
uv pip install torch --index-url https://download.pytorch.org/whl/cu130
uv pip install -e ".[runtime]"
```

`cu130` matches driver 595.95 (CUDA 13.2). The manifest launches
`./.venv/Scripts/python.exe` directly, so this CUDA build is used by this arm and
no other.

## Fetching the weights

The repo is **gated**. Two separate things are needed, and a missing either one
looks identical from the outside (HTTP 403):

1. Accept the licence on `Lightricks/LTX-2.5-Diffusers` itself. Accepting on
   `Lightricks/LTX-2.5` does **not** carry over.
2. Use a token that can read gated third-party repos — a **Read**-role token, or
   a fine-grained one with *Read access to contents of all public gated repos you
   can access*. A fine-grained token scoped only to your own user entity reads
   public repos fine and returns 403 here, even with `canReadGatedRepos: true`.

Check before committing to the download:

```powershell
$env:HF_TOKEN = "hf_..."
curl.exe -s -o NUL -w "%{http_code}`n" -H "Authorization: Bearer $env:HF_TOKEN" `
  "https://huggingface.co/Lightricks/LTX-2.5-Diffusers/raw/main/model_index.json"
```

### Why not just clone it

The repo is 174.43 GB but a run needs 70.96 GB. The difference is not all
optional extras — `transformer/` ships **two shard layouts of the same weights**
(a 4-shard set and an 8-shard set, ~37.98 GB each) and `connectors/` ships a
sharded set beside an identical single file. Only one of each is read.

So: fetch the index first, let it name the shards, then fetch exactly those.

```powershell
$MODEL = "../../storage/models/ltx-2.5-distilled"

# 1. Small files only, including the index that names the live transformer shards.
#    model_index.json is fetched by name: `--include` patterns do not match files
#    at the repository root, and the pipeline will not load without it.
hf download Lightricks/LTX-2.5-Diffusers --local-dir $MODEL `
  model_index.json
hf download Lightricks/LTX-2.5-Diffusers --local-dir $MODEL `
  --include "scheduler/*" "tokenizer/*" "processor/*" "*/config.json" "*/*.index.json"

# 2. See which layout the index actually points at.
python -c "import json;print(sorted(set(json.load(open(r'$MODEL/transformer/diffusion_pytorch_model.safetensors.index.json'))['weight_map'].values())))"

# 3. Fetch the components, naming the transformer shards from step 2.
hf download Lightricks/LTX-2.5-Diffusers --local-dir $MODEL `
  --include "text_encoder/*" "connectors/diffusion_pytorch_model-*" "vae/*" `
            "audio_vae/*" "vocoder/*" "duration_head/*" `
            "transformer/diffusion_pytorch_model-0000?-of-00004.safetensors"
```

Deliberately left out:

- `transformer_full/` (35.37 GiB) — the non-distilled model, a different arm
- `prompt_enhancer/` (9.51 GiB) — a Gemma that only rewrites prompts; the loader
  passes `prompt_enhancer=None` when the directory is absent
- `ltx-2.5-22b-distilled-lora-450-bf16.safetensors` (9.03 GiB) — the distillation
  LoRA, already baked into the distilled transformer
- `connectors/diffusion_pytorch_model.safetensors` — duplicate of the shards
- `latent_upsampler/`, `temporal_latent_upsampler/` (1.17 GiB) — two-stage
  upscaling, not components of `LTX2Pipeline`

- `diffusion_decoder/` (0.78 GiB) — the DiT video decoder. `model_index.json`
  lists it, but the loader passes `diffusion_decoder=None`: decoding here goes
  through `vae` alone, and this decoder could not run on this machine anyway.
  It resolves a NATTEN kernel through `get_kernel("shi-labs/natten")`, and that
  repository is not reachable.

`--local-dir` matters. Developer Mode is off on this machine, so
`huggingface_hub` cannot create symlinks and its default blob cache would keep a
second copy of every file — 132 GiB instead of 66.

## Start parameters

Everything in `params.schema.json` is fixed at start, because each value decides
how the transformer is placed and that cannot change without reloading it.

| parameter | default | note |
| --- | --- | --- |
| `model` | `models/ltx-2.5-distilled` | pipeline directory, inside `storage/` |
| `outputDir` | `outputs` | root that every job output path is confined to |
| `inputDir` | `inputs` | root that a job's conditioning image is confined to |
| `offloadDir` | `cache/ltx25-offload` | scratch root: `offload=group-disk`, and the bf16 text encoder either way |
| `precision` | `bf16` | `bf16` \| `fp8` \| `int8` — bf16 is both the reference and the fastest here |
| `offload` | `group-stream` | `group-stream` \| `group` \| `model` \| `sequential` \| `none` |
| `blocksPerGroup` | `1` | transformer blocks moved as one unit; larger is strictly slower |
| `pinWeights` | `false` | pin the staging buffer — see below before turning it on |

`group-stream` is the default because in diffusers' group offloading the staging
buffer is pinned **only** when a side stream exists. `group` without the stream is
both unoverlapped and pageable, which costs 1.72× on every transferred byte; it
is kept so that difference can be measured.

`pinWeights` is off by default, and that is a measured result rather than caution.
Pinning is worth 1.72× on transfer speed, but diffusers pins by allocating a
*second* tensor while the module still holds the first — so a pinned component
costs its own size twice:

| | fp8 | + pinned copy |
| --- | ---: | ---: |
| transformer | 17.69 | 35.38 |
| text encoder | 11.14 | 22.28 |
| total | **28.8 GiB** | **57.7 GiB** |

against ~45 GiB usable. Turning it on drove host RAM to 63.4 of 63.6 GB and the
run never reached the GPU.

The way to buy pinning back is `offload_to_disk_path`, which
`enable_group_offload` accepts. The text encoder runs once per *job* while the
transformer streams once per *step*, so moving the encoder to NVMe frees 11.14 GiB
and leaves room to pin the part that matters. Not implemented yet.

`offload=none` will not raise if the model does not fit — on WDDM the driver
silently backs the overflow with system RAM. It is there for a future card, not
for this one.

## Job requests

Generation values are sent to the running arm, not passed at start. The studio's
job contract is still being designed, so this endpoint is **provisional** and
shaped to be easy to retire.

```
POST /generate
{ "prompt": "...", "outPath": "clip.mp4",
  "negativePrompt": "...", "width": 960, "height": 544,
  "numFrames": 121, "frameRate": 24, "seed": 42,
  "image": "frame.png",
  "enhancePrompt": false, "spatialUpsample": false, "temporalUpsample": false }
```

The response is the run's own report: per-stage seconds, peak VRAM and spill,
`seed` (the one actually used, which matters when the request was `-1`), and
`prompt_used` — what reached the model, which differs from `prompt` when the
enhancer ran and is otherwise unknowable to the caller.

`width` and `height` must be multiples of 32 and `numFrames` must be `8n+1`,
matching the VAE's compression; the pipeline would otherwise round them silently.
`outPath` is resolved inside `outputDir` and anything escaping it is rejected —
job requests do not pass through the supervisor's parameter resolver, so the arm
enforces confinement itself.

`image` is optional and switches the job to image-to-video. It is resolved inside
`inputDir`, which is a separate root from `outputDir` because the arm *reads* this
path where it *writes* the other one; sharing one directory would turn the output
root into an arbitrary read. It must exist and end in `.png`, `.jpg`, `.jpeg` or
`.webp`.

### Prompt enhancement and the two upsampling rounds

All three come from `Lightricks/LTX-2.5-Diffusers` itself rather than from a
substitute, and each is loaded for the jobs that ask and freed again.

`enhancePrompt` runs the repository's own `prompt_enhancer/` -- a 9.51 GiB Gemma
-- over the request, with the LTX-2.5 system prompts diffusers ships, and passes
an image job its conditioning frame so the caption starts from what it will
actually see. It is run before the encode stage rather than through the
pipeline's own `enable_prompt_enhancement`, which never fires here because the
arm supplies `prompt_embeds` and the pipeline therefore skips its own encoding.

It needs the card to itself. Loading it while the pipeline held its usual 7.85
GiB reached a 17.17 GiB peak on a 16 GiB card -- a 1.17 GiB spill, under the
watchdog's 2 GiB abort threshold and so silent. The stage now hands the card back
first.

`spatialUpsample` is the documented two-stage recipe: the request describes stage
one, `latent_upsampler/` doubles each edge in latent space, and a three-sigma tail
runs at the new size. `temporalUpsample` is the same shape of operation in time,
with `temporal_latent_upsampler/` through the same `LTX2LatentUpsamplePipeline`
and a four-sigma tail. Both redraw rather than interpolate, which is what the
second denoising round buys; `width`, `height` and `numFrames` always describe
stage one, so each upsampler doubles what comes out of it.

Deliberately *not* `LTX2DFRTemporalRefinePipeline`, despite its name and its
`temporal_latent_upsampler` argument. That pipeline belongs to the
distilled-frame-rate chain and requires `keyframes_latents` and
`keyframe_positions` from a previous DFR pass, which a plain `LTX2Pipeline` run
does not produce.

The temporal round doubles the **frame rate**, not the runtime. The audio forces
that reading: audio latents are sized from the clip's seconds, so a round that
stretched the duration would leave them the wrong length, while one that only
raises the frame rate leaves them exactly right. The output file is written at
the raised rate.

Both shapes run on one loaded pipeline. `LTX2Pipeline` has no image input, so an
image job is served by `LTX2ImageToVideoPipeline` built over the same components
— no second copy of any weight, and the transformer keeps the group-offload hooks
already attached to it. It is built from `pipe.components` rather than with
`from_pipe`, which re-applies a dtype to everything it takes and leaves the
connectors in float32 against bf16 activations.

Image conditioning costs about 4% per step — 4.41 s against 4.23 s at
960x544x121 — and peaks *lower* than text-to-video, 12.91 GiB against 13.09.

That is only true because the connectors are released mid-call. They run once,
before the denoising loop, and would otherwise hold 5.91 GiB for the whole of it.
Image conditioning needs roughly 3 GiB more than text-to-video, which without
that release took peak VRAM to 15.57 GiB of 16 and the step to 8.5 s; a job
following another in the same process reached 15.88 GiB and 19.0 s.

**Nothing raised in either case.** `memory_reserved()` stayed under the card's
capacity, so the spill watchdog saw nothing while the driver was already evicting
behind it. The watchdog catches allocation past the card; it does not catch
running so close to the card that the driver starts making room. Treat a peak
above roughly 15 GiB as a failure even when it completes, and read step time as
the real indicator: it is flat to two decimal places when the card is not under
pressure, and roughly doubles when it is.

`GET /healthz` answers as soon as the process is up. `GET /stats` reports the load
report, a VRAM snapshot and host RSS.

Weights load on the **first job**, not at startup: reading 66 GiB and pinning it
would outlast any sane health-check timeout, and the supervisor's contract is that
a started arm is reachable, not that it is warm.

Guidance is not a parameter. The distilled schedule is trained to run unguided, so
`guidance_scale` is pinned at 1.0 and `stg_scale` at 0.0 — raising either would
double the cost per step and degrade the result.

## Known state

**Working**, unquantized, serving repeated jobs, with no VRAM spill at any stage.
Two 960x544x121 clips back to back in one process:

| | first clip | second clip |
| --- | ---: | ---: |
| encode | 22.3 s / 9.73 GiB | 20.5 s / 10.19 GiB |
| denoise, 8 steps | 41.7 s / 12.96 GiB | 34.3 s / 14.70 GiB |
| decode | 3.9 s / 13.09 GiB | 3.1 s / 12.91 GiB |
| **clip** | **60.2 s** | **60.2 s** |

Step time is 4.23 s, flat across every step of both runs. Peak VRAM 14.70 GiB,
peak host RAM 52.2 GiB of 59.2 available, cold load 30.9 s. Both clips decode to
121 frames at 960x544, 24 fps, 48 kHz stereo, byte-for-byte identical to each
other and matching what the same weights produce outside the arm.

### Every guidance has to be turned off by name

The distilled model is unguided, and `pipe.__call__`'s defaults are the **SFT**
values. Anything left unstated silently re-enables a guidance the distillation
removed. `modality_scale` defaults to `3.0`, and `do_modality_isolation_guidance`
is `modality_scale > 1.0`, so omitting it runs a second full transformer forward
on every step: 7.93 s per step against 4.23 s. The cost that matters more is not
the time -- it is that the model is then being run in a mode it was not distilled
for. `guidance_scale`, `audio_guidance_scale`, `stg_scale`, `audio_stg_scale`,
`modality_scale` and `audio_modality_scale` all have to be passed.

### Why bf16 rather than a quantized checkpoint

The arm used to default to a Q6_K GGUF transformer plus an fp8 text encoder, on
the reasoning that 35.38 GiB of bf16 weights could not be made to fit. That
reasoning was wrong, and the quantized stack was slower as well as less accurate:

| | bf16 | Q6_K + fp8 |
| --- | ---: | ---: |
| denoise, per step | **4.24 s** | 11.5 s |
| conditioning cosine vs bf16 | 1.0 | 0.999881 |
| clip | **93.8 s** | 99.0 s |

GGUF has no fused matmul available here -- the CUDA kernel it wants is published
for `x86_64-linux` only, and even with it diffusers' fused path is commented out
upstream -- so every weight is dequantized in torch on each call, which costs
more than the PCIe bytes it saves.

### The measured floor

Splitting step time against latent token count over two resolutions gives
`t = 7.10 + 4.34e-4 x N`: a fixed 7.10 s of weight movement and 3.54 s of
arithmetic at 960x544x121. Streaming hides 90% of the fixed part, which is what
takes a step from 10.64 s to 4.24 s. The remaining gap between that 4.24 s and
the 8.14 s the arm actually achieves is host RAM pressure from parking
components on the CPU between stages -- see the note above `STAGE_MODULES`.

See
[`docs/stack-selection.md`](../../docs/stack-selection.md) for how each of the
four required changes was found; the short version is that the last and largest
one was not a weight-size problem at all but three copies of a 49-layer
hidden-state stack inside `_get_gemma_prompt_embeds`.

```powershell
# transformer: 18.62 GB, ungated, the most-downloaded LTX-2.5 quant
hf download Abiray/LTX-2.5-Distilled-GGUF LTX-2.5-Distilled-Q6_K.gguf `
  --local-dir ../../storage/models/ltx-2.5-gguf

# text encoder: one-time conversion, ~33 GiB peak, run with nothing else loaded
.venv/Scripts/python.exe quantize_text_encoder.py `
  --model ../../storage/models/ltx-2.5-distilled `
  --out ../../storage/models/ltx-2.5-text-encoder-fp8
```

`offload=group-disk` writes ~66 GB of scratch to `storage/cache/ltx25-offload`,
and names each group by a hash of its Python object id -- so a new run writes new
files rather than reusing the old ones. Clear the directory between runs. With the
quantized checkpoints `group-stream` is enough and needs no scratch at all.

## Measuring

```powershell
.venv/Scripts/python.exe bench.py --model ../../storage/models/ltx-2.5-distilled `
  --config fp8:group-stream --config bf16:group-stream
```

Each configuration is loaded cold in its own subprocess and reports load time,
median step time, clip wall-clock, peak reserved VRAM and peak system RAM. Results
land in `storage/outputs/bench/report.json`.
