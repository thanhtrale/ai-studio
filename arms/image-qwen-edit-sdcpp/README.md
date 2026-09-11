# image-qwen-edit-sdcpp

Qwen-Image-Edit on [stable-diffusion.cpp], as a resident arm.

The arm is a small Python process with no third-party dependencies. It does not
run the model: it starts `sd-server.exe` as a child, keeps it alive between
jobs, and translates in both directions — the studio's job schema into the
child's API, and the child's log into the studio's timeline.

Every flag this arm passes is taken from `sd-server -h` of the build in `bin/`,
not from upstream's documentation — the two differ in places, and the binary is
the one that has to accept them.

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

Installed here: **`master-853-b68d586`** (10 Sep 2026), the Windows CUDA 12
build. To reproduce or upgrade, download both archives from the
[releases page][releases] — `sd-master-<commit>-bin-win-cuda12-x64.zip` and
`cudart-sd-bin-win-cu12-x64.zip` — and unpack both into `bin/`:

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

To check the build's own flags at any time — which is where every flag below
came from:

```powershell
.\bin\sd-server.exe -h
```

## The weights

Four files, under `storage/models/qwen-image-edit-2511/` by default:

| file | size | from | what it is |
| --- | ---: | --- | --- |
| `qwen-image-edit-2511-Q4_K_M.gguf` | 13 GB | [unsloth/Qwen-Image-Edit-2511-GGUF] | the transformer |
| `qwen_image_vae.safetensors` | 243 MB | [Comfy-Org/Qwen-Image_ComfyUI] | the VAE, shared across every Edit release |
| `qwen_2.5_vl_7b.safetensors` | 16 GB | [Comfy-Org/Qwen-Image_ComfyUI] | the Qwen2.5-VL text encoder, bf16 |
| `Qwen2.5-VL-7B-Instruct.mmproj-Q8_0.gguf` | — | — | vision tower — **only** for a GGUF encoder |

Fetched with the `hf` CLI (any Hugging Face client will do; none of these repos
is gated):

```powershell
$dest = "storage/models/qwen-image-edit-2511"
hf download unsloth/Qwen-Image-Edit-2511-GGUF qwen-image-edit-2511-Q4_K_M.gguf --local-dir $dest
hf download Comfy-Org/Qwen-Image_ComfyUI split_files/vae/qwen_image_vae.safetensors --local-dir $dest
hf download Comfy-Org/Qwen-Image_ComfyUI split_files/text_encoders/qwen_2.5_vl_7b.safetensors --local-dir $dest
# The arm names four files in one directory, not a ComfyUI tree.
Move-Item $dest/split_files/vae/*.safetensors $dest
Move-Item $dest/split_files/text_encoders/*.safetensors $dest
Remove-Item -Recurse $dest/split_files
```

Swapping the bf16 encoder for `Qwen2.5-VL-7B-Instruct-Q8_0.gguf` halves that
16 GB, and is the case the mmproj file is for.

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
`flashAttention`, `threads`, `modelArgs`, `maxVram`, `mmap` — travel with the
job too, and the supervisor restarts the arm if the loaded one does not match
them.

### Defaults are upstream's, and silence is a value

`sd-server -h` gives `--steps` a default of 20 and documents the sampler as
model-specific, the scheduler as a model default, and `--flow-shift` as auto.
Upstream's own Qwen-Image-Edit examples then pass `--cfg-scale 2.5`,
`--sampling-method euler` and `--flow-shift 3`, which is where the console's
defaults come from.

The console can also say *nothing* about the sampler or the scheduler, and the
arm then omits the key rather than sending a null — leaving the checkpoint on
the choice it shipped with. Picking a value is a decision; a console that always
sends one has made that decision on the reader's behalf without saying so.

A distilled "rapid" merge of the same model wants the opposite numbers: four
steps at CFG 1.0, where the negative prompt does nothing because there is no
guidance to steer.

### Placing the weights

Three knobs, and they interact:

| parameter | the child's flag | what it does |
| --- | --- | --- |
| — | `--auto-fit` (**on by default**) | places weights on the GPU, then RAM, then disk, by what fits |
| `offloadToCpu` | `--offload-to-cpu` | forces the RAM step |
| `maxVram` | `--max-vram <GiB>` | caps the GPU budget; empty means "use live free VRAM" |
| `mmap` | `--mmap` | maps the weight file instead of reading it |

`maxVram` is empty by default because the studio's broker guarantees no other
arm holds the card. Set it if something outside the studio does.

`mmap` is off by default and is the one most likely to be worth turning on: it
is the same mechanism that makes the video arm's 36 GiB transformer "load" in
0.6 s, with the pages faulted in as they are touched. Left off until it has been
measured here, because a mapped file behaves differently under memory pressure
than a read one.

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

## Measured

Four jobs on an RTX 4080 (16376 MiB), Q4_K_M transformer, bf16 encoder,
`--offload-to-cpu`, flash attention on, 20 steps at CFG 2.5, euler, flow-shift 3:

| job | total | encode | sample | decode | per step | card peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1024×1024, cold | 79.1 s | 6.9 s | 70.0 s | 1.6 s | 3.12 s | 13640 MiB |
| 1024×576 + 1 reference | 84.0 s | 2.7 s | 79.2 s | 0.7 s | 3.89 s | **15256 MiB** |
| 1024×1024 again, warm | 66.9 s | 1.1 s | 63.7 s | 1.3 s | 3.19 s | 13778 MiB |
| 768×768 ×2 (one batch) | 62.4 s | 1.1 s | 29.7 s | 1.5 s | 1.44 s | 14584 MiB |

Four things worth keeping:

**The same prompt and seed twice gave byte-identical files.** Both runs of the
1024×1024 job hashed to `4845bba9…`, so anything that changes an output here is
a change, not noise — which is the property that makes a regression findable.

**The first job costs about twelve seconds more than the same job warm**, spread
across the prompt encode (6.9 → 1.1 s) and the sampling (70.0 → 63.7 s) rather
than appearing as a load step. The child answers its API 0.6 s after being
started and reports its own model load as 0.2 s, so the 29 GB of weights are
clearly not read up front; they arrive as they are touched. This is the same
shape as the video arm's memory-mapped transformer, and it is why `--mmap` is
worth measuring rather than assuming.

**An edit is dearer than a generation of the same size**, not cheaper: 3.89 s
per step against 3.12, because the reference's latents join the sequence the
transformer attends over.

**The edit job reached 93% of the card** — 15256 of 16376 MiB. It did not spill
(the per-step time stayed level, and Windows would have shown it as a
collapse rather than an error), but that is the headroom this configuration
actually has, and it is what `maxVram` is there for.

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

## VRAM, and what this machine will not tell you

The video arm's meter is torch's `memory_reserved` from inside the arm process:
what *that arm* holds, as distinct from what the card holds. There is no torch
here, so the intended equivalent was nvidia-smi's per-process accounting.

**It does not exist on this machine.** A GeForce card under Windows runs in
WDDM mode, where the display driver owns the allocations;
`--query-compute-apps=used_memory` answers `[N/A]` for every process, including
this arm's child. Only TCC mode reports per-process figures, and consumer cards
cannot enter it.

The first real run made this plain by reporting `peak vram 0.00 GiB` for a job
that had just put thirteen gigabytes on the card. So the arm now *measures the
scope* instead of assuming it, and carries the answer with every number:

| scope | meaning |
| --- | --- |
| `process` | this arm's child only — the same thing the video arm reports |
| `card` | the whole GPU, because the driver will not attribute |
| `unavailable` | nvidia-smi did not answer at all |

On this machine every reading is `card`, the console says so beside the peak,
and the library record keeps `peakVramScope` so a stored figure cannot later be
read as one arm's share. The two lines on the chart sit on top of each other,
which is the honest picture: there is only one measurement available, and
drawing it twice is better than drawing a subtraction and calling it the arm's.

Sampling is one fresh `nvidia-smi` a second, only while a job runs. A
long-lived `--loop` reader is not usable for the compute-apps query — it prints
a variable number of rows per iteration with nothing between them, so a
streaming reader cannot tell where one iteration ends.

## The child cannot outlive the arm

`atexit` does not run when a process is killed with `TerminateProcess`, which
is what `taskkill /F` does and therefore what happens to this arm whenever the
supervisor has to stop it hard. Observed, not theorised: a run left
`sd-server.exe` alive holding 444 MiB after its parent was terminated — an
orphan nobody is looking for, on a card the whole studio is trying to arbitrate.

So the child goes into a Win32 **job object** with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`jobobject.py`). When this process dies —
cleanly, by signal, or by `TerminateProcess` — its last handle to the job closes
and the kernel kills the child. No cooperation required from either side. After
the fix the same sequence leaves the card at 0 MiB, and `tests/
test_jobobject.py` asserts it directly.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q     # 39 tests
.\.venv\Scripts\python.exe -m ruff check .
```

These do not run under `pnpm test`, which is vitest. Four files:

- `test_logscan.py` — the log parser, line by line.
- `test_generation.py` — job validation, which is this arm's security boundary:
  a job's `outPath` and `refImages` are paths chosen by the caller.
- `test_arm_end_to_end.py` — the whole arm against `fake_sd_server.py`: the
  child is started and waited for, its log becomes a timeline, a job is
  submitted and polled, images come back base64 and are written where the caller
  asked, and a second job reuses the running child.

- `test_jobobject.py` — that closing the job object kills what is in it, and
  that a child in one otherwise runs normally.

The stand-in exists because the translation is the part that can be wrong in
ways reading does not catch, and none of it needs twelve gigabytes of weights to
be wrong. It is not a substitute for running the real thing: the two bugs that
mattered most — a zero VRAM reading and an orphaned child — were both invisible
to it and both obvious within one real run.

[unsloth/Qwen-Image-Edit-2511-GGUF]: https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF
[Comfy-Org/Qwen-Image_ComfyUI]: https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI

[stable-diffusion.cpp]: https://github.com/leejet/stable-diffusion.cpp
[releases]: https://github.com/leejet/stable-diffusion.cpp/releases
