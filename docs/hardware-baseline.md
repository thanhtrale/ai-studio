# Hardware baseline

Measured ceilings of the development machine. Every number below came from
`scripts/probe-hardware.py`, not from a spec sheet. An arm's runtime stack is
chosen against these numbers, so re-run the probe when the machine changes and
update this file.

```powershell
uv venv .probe --python 3.12
uv pip install --python .probe/Scripts/python.exe torch numpy --index-url https://download.pytorch.org/whl/cu130
.probe/Scripts/python.exe scripts/probe-hardware.py storage/cache
```

Measured 2026-09-10.

## The machine

| | |
| --- | --- |
| CPU | Intel i9-13900K, 24 cores / 32 threads |
| RAM | 63.6 GB (2 × 32 GB DDR5-5600), **49.2 GB free** at probe time |
| GPU | NVIDIA GeForce RTX 4080, 16376 MiB, sm_89, 76 SMs |
| Driver | 595.95 (CUDA 13.2) |
| Disk | WD PC SN810 NVMe, 1906.7 GB total, **1602.0 GB free** |
| OS | Windows 11 Enterprise 26200, WDDM |
| Stack | torch 2.14.0+cu130, cuDNN 9.24, Python 3.12.14 |

## Measured ceilings

### Compute

| workload | throughput |
| --- | --- |
| bf16 matmul, 8192³ | **103.1 TFLOP/s** |
| fp16 matmul, 8192³ | 105.7 TFLOP/s |
| fp32 matmul, 4096³ | 37.8 TFLOP/s |

bf16 and fp16 are within 2.5% of each other, so precision choice is a memory
decision on this card, not a speed one.

### PCIe — the number that decides offloading

| direction | pinned | pageable |
| --- | --- | --- |
| host → device | **22.27 GiB/s** | 12.93 GiB/s |
| device → host | 24.46 GiB/s | 12.28 GiB/s |

Pinned host memory is **1.72× faster** than pageable. Any offload configuration
that does not pin its staging buffers pays that factor on every byte of every
step. This is the single largest controllable cost for a model that does not fit
in VRAM.

### VRAM — and a Windows trap

| | |
| --- | --- |
| reported total | 15.99 GiB |
| reported free | 14.68 GiB |
| **allocated before CUDA refused** | **61.25 GiB** |

The third row is not a typo and not usable memory. On WDDM the NVIDIA driver
silently backs allocations with system RAM once the card is full, so a 36 GiB
model does **not** raise `torch.OutOfMemoryError` — it loads, runs, and every
layer access crosses PCIe at pageable speed with no diagnostic. A run that looks
merely slow is often this.

Consequences for arms:

- Never treat "it did not OOM" as "it fits". Assert against
  `torch.cuda.mem_get_info()`, not against the absence of an exception.
- Prefer an explicit offload policy (group offload with pinned staging) over
  letting the driver improvise one, because the explicit path can overlap
  transfer with compute and the driver's cannot.
- To make benchmarks honest, set *CUDA — Sysmem Fallback Policy* to
  *Prefer No Sysmem Fallback* for the arm's interpreter in the NVIDIA Control
  Panel. Real OOMs are more useful than silent 10× slowdowns.

### Host memory and storage

| | |
| --- | --- |
| host↔host memcpy, single thread | 16.26 GiB/s |
| NVMe sequential write, 4 GiB probe (page-cached) | 1.56 GiB/s |
| NVMe sequential write, 34 GiB cold | **1.22 GiB/s** |
| NVMe sequential read, 4 GiB probe (page-cached) | 6.57 GiB/s |
| NVMe sequential read, 35.4 GiB cold | **1.74 GiB/s** |
| HuggingFace CDN, single stream | 39.3 MB/s (≈ 37.5 MiB/s) |
| HuggingFace CDN, `hf_transfer` parallel | **64.0 MB/s** (≈ 61.0 MiB/s) |

**Use 1.74 GiB/s, not 6.57.** The original 4 GiB probe fit entirely in page
cache, so its "cold" and "warm" numbers matched (6.57 vs 6.62 GiB/s) -- that
agreement is evidence the probe never reached the device, not evidence the
device is fast. Re-measured by reading 35.4 GiB, which exceeds free RAM, the
sustained rate is 1.74 GiB/s reading and 1.22 GiB/s writing.

The write figure is what makes file-backed offload the right choice over
letting the OS page anonymous memory: a clean file-backed page is dropped
for free, while an anonymous one must be written at 1.22 GiB/s before it
can be dropped, and read back at 1.62 GiB/s afterwards. For the 22.28 GiB
text encoder that is 18.3 s of writing per eviction cycle that the
file-backed path never pays.

File granularity costs almost as much as the medium. Reading 8 GiB gives:

| Layout | Files | Rate |
| --- | ---: | ---: |
| Original checkpoint shards | 4 | 2.65 GiB/s |
| `group_*.safetensors` from diffusers group offload | 49 | 1.93 GiB/s |
| Per-tensor `.dat` from `accelerate.disk_offload` | 678 | 1.59 GiB/s |

So a disk-offload layout that writes one file per tensor gives up 1.67x against
one that writes a few large ones.

Offloaded weights are **file-backed, never paged**. Across every run in this
directory `pagefile.sys` peaked at 76 MB while host RAM peaked at 50.7 GiB. That
is the property to preserve: a clean file-backed page is evicted for free and
re-read on demand, one direction of I/O, whereas anonymous memory that Windows
pages out must be written before it can be dropped and read back afterwards --
twice the I/O for the same bytes.

Note that single-thread memcpy (16.26 GiB/s) is *below* pinned H2D bandwidth
(22.27 GiB/s). An offload path that copies weights host-side before uploading is
bottlenecked on the CPU, not on PCIe. Weights should be pinned once at load and
uploaded from that buffer.

## Budget rules derived from the above

For a model with `P` parameters at `b` bytes per parameter, weights occupy
`W = P·b / 2³⁰` GiB.

**Does it fit?** Roughly 3 GiB of the card goes to CUDA context, activations and
fragmentation, so the resident budget is about **13 GiB**.

- `W ≤ 13 GiB` — resident. No streaming, full 103 TFLOP/s available.
- `W > 13 GiB` — every forward pass streams at least `W − 13` GiB across PCIe.
  Floor cost per pass: `(W − 13) / 22.27` seconds with pinned memory,
  `(W − 13) / 12.93` seconds without.

**Does it fit in RAM?** With 49.2 GB free, the sum of all pinned CPU-resident
components must stay under roughly 45 GiB. Components that exceed that together
must be loaded and freed in stages rather than held at once.

**Cold start.** Weight load from NVMe is `size / 1.74 GiB/s`; the 65.3 GiB
LTX-2.5 distilled set is ~38 s of pure I/O.

**Streaming from disk is near the device limit, so do not tune it -- avoid it.**
Measured, the bf16 transformer streamed per denoising step from NVMe runs at
35.38 GiB / 32.1 s = 1.10 GiB/s, which is 63% of the drive's real cold rate. The
same weights held in host RAM instead cost 10.3 s per step. Whichever component
cannot fit in RAM should be the one used least often -- the transformer runs
eight times per clip, the text encoder once per prompt.

**First install.** A single stream reaches 37.5 MiB/s; `HF_HUB_ENABLE_HF_TRANSFER=1`
raises that to 61.0 MiB/s, measured over a 71 GB download. Always set it — it is
worth 1.63x and costs nothing.

## Storage layout caveat

Developer Mode is off and the shell is not elevated, so `huggingface_hub` cannot
create symlinks. Its default blob cache would therefore keep **two** copies of
every weight file. Arms must download with `--local-dir` (which writes files
directly, no blob indirection) into `storage/models/`, or the 65.3 GiB LTX-2.5
distilled set costs 131 GiB on disk.

## Related

- [Stack selection](./stack-selection.md) — how these numbers pick a runtime.
