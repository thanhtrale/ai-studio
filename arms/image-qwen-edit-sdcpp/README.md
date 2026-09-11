# image-qwen-edit-sdcpp

Qwen-Image-Edit on [stable-diffusion.cpp], as a resident arm.

The arm is a small Python process with no third-party dependencies. It does not
run the model: it starts `sd-server.exe` as a child, keeps it alive between
jobs, and translates in both directions — the studio's job schema into the
child's API, and the child's log into the studio's timeline.

> **Not yet run against real weights.** Everything here is verified against a
> stand-in child (`tests/fake_sd_server.py`) that speaks the same API and prints
> the same log. What is unverified is the part only the real binary can answer:
> whether these flags load these files, and what the card actually holds while
> it does. The `vramEstimateMb` in the manifest is an estimate and says so.

## Why the server build, not the CLI

`sd-cli` exits after every image, so every job would re-read the whole model. The
supervisor's broker is built on the opposite assumption — a job whose start
parameters match the loaded arm is brokered onto the card in 0.0 s against a
cold load — and only the server build can honour that. The end-to-end test
asserts it directly: a second job does not restart the child.

The cost is a second process. The supervisor kills an arm's whole process tree
(`taskkill /T`), so the child goes with it; `serve()` and an `atexit` hook cover
the other ways this process can end.

## Installing the runtime

Download the **Windows CUDA 12** build from the [releases page][releases] — at
the time of writing `sd-master-b68d586-bin-win-cuda12-x64.zip`, plus
`cudart-sd-bin-win-cu12-x64.zip` for the CUDA runtime — and unpack both into
`bin/`:

```
arms/image-qwen-edit-sdcpp/
  arm.yaml
  params.schema.json
  bin/
    sd-server.exe        <- what this arm starts
    sd-cli.exe           <- handy for checking a model outside the studio
    cudart64_12.dll      <- from the cudart zip
    ...
```

`bin/` is git-ignored. Then create the interpreter the manifest names:

```powershell
cd arms/image-qwen-edit-sdcpp
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"   # pytest and ruff only
```

The arm itself needs nothing installed: `-e .[dev]` is for the tests.

## The weights

Four files, under `storage/models/qwen-image-edit-2511/` by default:

| file | what it is |
| --- | --- |
| `qwen-image-edit-2511-Q4_K_M.gguf` | the transformer, ~12 GiB at Q4_K_M |
| `qwen_image_vae.safetensors` | the VAE, shared across every Edit release |
| `qwen_2.5_vl_7b.safetensors` | the Qwen2.5-VL text encoder |
| `Qwen2.5-VL-7B-Instruct.mmproj-Q8_0.gguf` | vision tower — **only** for a GGUF encoder |

The mmproj file is optional. A launch placeholder cannot be omitted
conditionally, so `llmVision` always resolves to a path; the arm passes
`--llm_vision` only when that file is actually there, which is what makes the
`.safetensors` encoder (which carries its own vision tower) the no-configuration
case.

The quantisation of the transformer is the main VRAM lever. Q8_0 is roughly
double Q4_K_M and will not sit on a 16 GiB card beside a 7B text encoder.

### Which Edit release

`modelArgs` defaults to `qwen_image_zero_cond_t=true`, which upstream requires
for **2511 specifically**. On 2509 or the original Edit release, clear it.

## What a job looks like

The web console sends the studio's own vocabulary; the arm turns it into the
child's. Per-job: `prompt`, `negativePrompt`, `outPath`, `width`, `height`,
`steps`, `cfgScale`, `sampler`, `scheduler`, `flowShift`, `seed`, `batch`,
`refImages`. Start parameters — the model paths, `offloadToCpu`,
`flashAttention`, `threads`, `modelArgs` — travel with the job too, and the
supervisor restarts the arm if the loaded one does not match them.

### Sizes are 16-pixel blocks, not 32

Qwen-Image has an 8× VAE with a 2× patch embed on top, so the grid is 16. The
video console snaps to 32 because the video model needs it; snapping images to
32 as well would refuse sizes this model takes — at 3:4 and 0.75 MP the
difference is 752×1008 against 736×992.

### The batch

`batch_count` in one request, so one load produces several images. The first
keeps the name the caller planned and the rest are suffixed (`a.png`,
`a-2.png`, `a-3.png`), which means a batch of one is indistinguishable from a
single generation — the library record the caller planned still points at a
file.

Each image is filed separately, with the seed it actually used, so "use these
settings" on one image of a batch reproduces **that image** rather than the
batch it arrived in.

## Where the timeline comes from

The child's job API reports `queued`, `generating`, `completed` — and nothing
in between. For a run that spends thirty seconds reading weights and another
thirty denoising, that is indistinguishable from a hang.

So the arm reads the child's stdout and turns it into steps: `loading model
from …` opens the load, `<phase> completed, taking 1.23s` closes a named phase,
`generating image: 2/4 - seed 12345` drives the batch meter *and* is where the
per-image seeds come from, and the sampler's progress bar drives the denoise
meter. The bar redraws with a carriage return rather than a newline, which is
why the reader splits on both.

This is a log, not an interface anyone promised to keep. Every pattern is
optional: an unrecognised line becomes the running step's detail, and a build
that renames a phase loses a label rather than failing a job. `tests/
test_logscan.py` pins the shapes.

The seed is worth the trouble. A request of `-1` means "choose one", and the
child's API never says which one it chose — the log is the only place that
number exists.

## VRAM

Two meters, as everywhere else in the studio, and neither is a subtraction of
the other:

- the **machine** meter is nvidia-smi's whole-card figure, sampled by the
  supervisor;
- the **arm** meter is nvidia-smi's per-process figure for the child's pid.

There is no torch here to ask for `memory_reserved`, which is what the video arm
reports. Per-process accounting is the closest equivalent: what this arm put on
the card, rather than what the card holds. It is sampled once a second by a
fresh `nvidia-smi` — the compute-apps query prints a variable number of rows per
iteration with nothing between them, so a long-lived `--loop` reader cannot tell
where one iteration ends.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q     # 35 tests
.\.venv\Scripts\python.exe -m ruff check .
```

These do not run under `pnpm test`, which is vitest. Three files:

- `test_logscan.py` — the log parser, line by line.
- `test_generation.py` — job validation, which is this arm's security boundary:
  a job's `outPath` and `refImages` are paths chosen by the caller.
- `test_arm_end_to_end.py` — the whole arm against `fake_sd_server.py`: the
  child is started and waited for, its log becomes a timeline, a job is
  submitted and polled, images come back base64 and are written where the caller
  asked, and a second job reuses the running child.

The stand-in exists because the translation is the part that can be wrong in
ways reading does not catch, and none of it needs twelve gigabytes of weights to
be wrong.

[stable-diffusion.cpp]: https://github.com/leejet/stable-diffusion.cpp
[releases]: https://github.com/leejet/stable-diffusion.cpp/releases
