# Choosing an arm's runtime stack

How a model becomes an arm on this machine. The procedure is arithmetic against
the numbers in [hardware-baseline.md](./hardware-baseline.md), followed by one
measurement to confirm it.

Nothing here is a preference. Each rule exists because a measured ceiling makes
the alternative slower or impossible.

## The procedure

**1. Size the weights.** `W = bytes / 2³⁰` GiB, per component, at the precision
you intend to run. Read the sizes from the repo — do not estimate them from a
parameter count, and do not trust a summary of the file list:

```bash
curl -s -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/api/models/<repo>?blobs=true" | jq '
    [.siblings[] | {(.rfilename): .size}] | add'
```

This endpoint answers for gated repos too — only file *content* is gated, not
metadata — so the budget can be worked out before asking for access.

Watch for redundant files. Large repos routinely ship the same weights twice:
two shard layouts of one tensor set, or a sharded set beside a single-file
version. Summing a directory therefore overstates what a run needs, sometimes
by 2×.

**2. Check the VRAM budget.** Resident budget is ~13 GiB of the 16 GiB card;
the remaining ~3 GiB goes to CUDA context, activations and fragmentation.

- `W ≤ 13` — resident. This is the only class that reaches the full
  103 TFLOP/s. Prefer it whenever a quantization gets you there without
  unacceptable quality loss.
- `W > 13` — streaming. Cost floor per forward pass is `(W − 13) / 22.27` s with
  pinned memory. Block-level offload with a small resident window approaches
  `W / 22.27` s, because blocks are evicted before they are reused.

**3. Check the RAM budget, and count pinning twice.** Sum every component that
must be host-resident at once. Over ~45 GiB they cannot coexist: the arm must load
and free in stages, or quantize.

Pinning does not convert a buffer in place. `ModuleGroup._to_cpu` allocates a new
pinned tensor while the module still references the original, so **a pinned
component costs its own size twice**. This is the trap that actually bit here:
fp8 looked comfortable at 28.8 GiB and was not, because pinned it is 57.66 GiB.
Budget `2W` for anything you intend to pin.

**4. Budget for quantization, not just for the quantized result.** Loading a bf16
checkpoint under `TorchAoConfig` does **not** convert shard by shard: diffusers
materialises the whole component in bf16 and then builds the quantized copy, so
peak host RAM is `W_bf16 + W_quant`, not `W_quant`. For the LTX-2.5 transformer
that is 35.38 + 17.69 = 53 GiB to *reach* a model that only occupies 17.69.
On-the-fly quantization is therefore unavailable on a 64 GB machine no matter how
small the result is. Use a checkpoint that ships already quantized, or quantize
once on a larger machine and save it.

**5. Pick precision against the silicon, not against the checkpoint hub.** This
card is Ada (sm_89): native FP8 (E4M3/E5M2) tensor cores, **no FP4**. NVFP4
checkpoints target Blackwell (sm_120) and are dequantized on the way in here,
costing memory *and* speed. On this machine FP8 is the floor for native
throughput.

**6. Pin, and stream.** In diffusers' group offloading, the staging buffer is
pinned only when `use_stream=True`, and `low_cpu_mem_usage=True` turns pinning
off. So an offload config without a side stream is *both* unoverlapped and
pageable — it pays the 1.72× pageable penalty on every byte. Verify in
`diffusers/hooks/group_offloading.py`; the flags do not read that way.

Also note that streams force `num_blocks_per_group=1`: diffusers logs
*"Using streams is only supported for num_blocks_per_group=1 … Setting it to 1"*
and overrides whatever you passed. The group-size knob only has an effect on the
unstreamed path, so it is not a tuning lever in any configuration worth running.

**When neither RAM nor VRAM is enough, spend disk.** `enable_group_offload`
takes `offload_to_disk_path`, writes each block to safetensors and drops its host
copy — verified in `ModuleGroup._offload_to_disk`. Applied to the transformer
*before* the pipeline is built, it is what finally made LTX-2.5 run here: host RAM
stayed near 30 GB, the card filled to 16.0 GiB, and the GPU reached 100%
utilisation. It costs ~66 GB of scratch space and reads at 6.57 GiB/s instead of
22.27, so it is the slowest option that works — and on this machine it is the
only one that works at all.

**7. Measure before believing.** On WDDM a model that does not fit does not
crash; it silently runs on system RAM. Assert against
`torch.cuda.mem_get_info()` and record wall-clock per step.

## Worked example: LTX-2.5 distilled

Target: `Lightricks/LTX-2.5-Diffusers` (gated), distilled transformer, diffusers
`LTX2Pipeline`, 22B DiT + Gemma-4-12B text encoder, joint video + audio.
Implemented as [`arms/video-ltx25-diffusers`](../arms/video-ltx25-diffusers/).

Verified against diffusers `0.41.0.dev0`:

- distilled schedule is **8 steps**, driven by explicit sigmas, not a step count:
  `[1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875]`
- unguided — `guidance_scale=1.0`, `stg_scale=0.0`, so **one transformer call per
  step**, not two
- VAE compresses 32× spatially and 8× temporally
- offload order:
  `prompt_enhancer → text_encoder → connectors → duration_head → transformer → vae → audio_vae → vocoder`
- `prompt_enhancer`, `processor` and `duration_head` are the only optional
  components; `diffusion_decoder` is listed in `model_index.json` and required
- output is muxed by `diffusers.utils.encode_video`, which needs **PyAV**

### Component sizes (exact, computed from the HF blob API)

| item | GB | GiB | needed? |
| --- | ---: | ---: | --- |
| `transformer`, 4-shard set | 37.976 | **35.37** | yes — this is the set the index names |
| `transformer`, 8-shard set | 37.986 | 35.38 | **no — same weights, other layout** |
| `transformer_full` | 37.977 | 35.37 | no — non-distilled |
| `text_encoder` (Gemma-4-12B) | 23.920 | **22.28** | yes |
| `connectors`, sharded | 6.344 | 5.91 | yes — one form only |
| `connectors`, single file | 6.344 | 5.91 | **no — duplicate** |
| `vae` + `vocoder` + `audio_vae` + `duration_head` + tokenizer + processor | 1.885 | 1.76 | yes |
| `diffusion_decoder` | 0.834 | 0.78 | yes — a listed, non-optional component |
| `latent_upsampler` + `temporal_latent_upsampler` | 1.258 | 1.17 | no — not `LTX2Pipeline` components |
| `prompt_enhancer` | 10.209 | 9.51 | optional — skip, it only rewrites prompts |
| distilled LoRA (bf16) | 9.699 | 9.03 | no — already baked into the distilled transformer |

- **Minimal runnable set: 70.96 GB / 66.09 GiB.**
- **Whole repo: 174.43 GB / 162.45 GiB** — 2.5× the minimum. Never clone it.

Which transformer layout is live is decided by
`transformer/diffusion_pytorch_model.safetensors.index.json`, not by the file
names — on this revision it names the 4-shard set. Read the index before
choosing what to fetch.

That is **~18 minutes** at the measured 61.0 MiB/s with
`HF_HUB_ENABLE_HF_TRANSFER=1` (30 minutes without it), and ~10 s of NVMe read per
cold start.

### Step 2 — VRAM

Both large components exceed the 13 GiB resident budget:

| precision | transformer | vs budget | streamed per step | s/step (pinned) | s per 8-step clip |
| --- | ---: | --- | ---: | ---: | ---: |
| bf16 | 35.38 | 2.7× over | 22.4 – 35.4 | 1.00 – 1.59 | 8.0 – 12.7 |
| fp8 / int8 | 17.69 | 1.4× over | 4.7 – 17.7 | 0.21 – 0.79 | 1.7 – 6.4 |
| int4 / NVFP4 | 8.84 | **fits** | 0 | 0 | 0 |

Ranges span best case (a perfect resident working set) to worst (every block
evicted each pass).

### Step 3 — RAM

This is the constraint that actually decides the design. Free RAM is 49.2 GB,
usable budget ~45 GiB:

| configuration | transformer | text encoder | total | fits ~45 GiB? |
| --- | ---: | ---: | ---: | --- |
| bf16, unpinned, both resident | 35.38 | 22.28 | 57.7 | no — but see below, they need not both be |
| fp8 DiT, bf16 encoder, unpinned | 17.69 | 22.28 | 40.0 | tight |
| **fp8 both, unpinned** | 17.69 | 11.14 | **28.8** | **yes** |
| fp8 both, **pinned** | 35.38 | 22.28 | **57.7** | **no — measured 63.4/63.6 GB** |
| int4 DiT, fp8 encoder, unpinned | 8.84 | 11.14 | 20.0 | yes |

The pinned fp8 row was measured, not predicted: it drove host RAM to 63.4 of
63.6 GB and the run never reached the GPU. Pinning is therefore off by default in
the arm despite being worth 1.72× on transfer speed — the two large components
cannot both be pinned in 64 GB.

A way to buy it back: the text encoder runs **once per prompt** rather than once
per step, so it is the component to move off RAM. `accelerate.disk_offload` does
this for a transformers model; `enable_group_offload(offload_to_disk_path=...)`
is the diffusers equivalent for the transformer.

**This is what the table above gets wrong, and it decided the whole design.**
Read as "bf16 needs 57.7 GiB resident, so bf16 is out", it sent this document
down a quantization path that turned out to be both slower and less accurate.
The row is arithmetically correct and the conclusion does not follow: the two
components never have to be live at once. Measured, bf16 end-to-end peaks at
57.6 GiB of system RAM with the encoder on disk and the transformer streaming
block by block from RAM, and runs a clip in 93.8 s against 99.0 s for the
quantized stack.

The lever is *use frequency*, not size. Eight uses per clip against one per
prompt is what decides which component keeps its RAM residency — and measured,
that choice is worth 4.24 s per step against 32.1 s.

(The 6.57 GiB/s NVMe figure this section originally used to price the disk tier
was itself wrong; see `hardware-baseline.md`. The real sustained rate is
1.74 GiB/s, which makes the encoder's disk residency cost ~17 s per prompt
rather than ~1.7 s — still the right trade, but for narrower reasons.)

### Step 4 — compute

Estimate only, pending measurement. At 960×544×121 the latent grid is
30 × 17 × 16 = **8160 tokens**. First-order forward cost `2·P·T` ≈ 359 TFLOP per
step, and attention adds to that. At 103 TFLOP/s with an assumed 40% MFU that is
≈ 8.7 s/step, so **≈ 70 s for 8 steps**, plus VAE decode.

If that estimate survives measurement the conclusion is notable: at bf16 the
8.0–12.7 s of streaming is roughly **15% overhead on a compute-bound run**, not
the disaster a 2.7× VRAM shortfall suggests. Streaming a large model is tolerable
here. What is not tolerable is streaming through pageable memory, or letting the
WDDM driver improvise the placement.

### What actually happened when it was run

Everything above is arithmetic. This is measurement, and it did not agree.

| attempt | host RAM | VRAM | result |
| --- | --- | --- | --- |
| fp8 on-the-fly, pipeline-level quantization | **63.4 / 63.6 GB** | 0 | never reached the GPU |
| fp8 on-the-fly, per-component quantization | **63.4 GB** | 0 | never reached the GPU |
| fp8, pinned staging | **63.4 GB** | 0 | never reached the GPU |
| bf16 + `group-disk`, 960x544x121 | 36 GB (fine) | 15.66 GB on card **+ 22.22 GB in system RAM** | ran 12 min, no clip, silently spilled |
| bf16 + `group-disk`, 512x288x49 | 30 GB (fine) | **+3.49 GB in system RAM** | aborted by the spill watchdog |

**LTX-2.5 distilled at bf16 does not fit a 16 GiB card through diffusers group
offloading -- at any resolution tested.** Cutting the latent grid 8x (8160 to 1008
tokens) reduced the spill from 22.22 GiB to 3.49 GiB but did not remove it, which
says the overflow is weights and offload machinery, not activations. Tiling the
VAE and the diffusion decoder did not change it either, because the spill happens
during denoising rather than decode.

The disk-offload path is still the right shape -- host RAM stayed near 30 GB where
every RAM-based configuration exhausted 64 GB -- but it does not by itself make a
35.38 GiB transformer fit alongside a 22.28 GiB text encoder on this card.

#### How to see a spill at all

`nvidia-smi --query-gpu=memory.used` reports **dedicated** memory only. During the
22.22 GiB spill it read a healthy 15994 MiB at 100% utilisation, which is why the
run looked fine for twelve minutes. The counter that tells the truth on Windows is
`Non Local Usage` under `GPU Process Memory`:

```powershell
(Get-Counter "\GPU Process Memory(*)\Non Local Usage").CounterSamples
```

In-process, `torch.cuda.memory_reserved()` above the card's physical size is the
same signal, and is what `arm_ltx25.loading.vram_spill_gib()` reports.

A check at the end of each denoising step is too slow to be useful: once a run
spills, one step takes minutes, and spill reached 9.8 GiB before the first step
finished. The arm therefore runs `SpillWatchdog`, a thread sampling every two
seconds that ends the process on breach.

### The configuration that works

Measured 2026-09-11, eight distilled steps, video + audio, unquantized bf16,
spill 0.00 GiB at every stage. Two 960x544x121 clips back to back in one process:

| | first clip | second clip |
| --- | ---: | ---: |
| encode | 22.3 s / 9.73 GiB | 20.5 s / 10.19 GiB |
| denoise, 8 steps | 41.7 s / 12.96 GiB | 34.3 s / 14.70 GiB |
| decode | 3.9 s / 13.09 GiB | 3.1 s / 12.91 GiB |
| **clip** | **60.2 s** | **60.2 s** |

Cold load 30.9 s. Peak VRAM 14.70 GiB, peak host RAM 52.2 GiB of 59.2 available.
Step time 4.23 s, flat, against a 3.54 s arithmetic floor.

Three things carry that result, and removing any one of them breaks it:

1. **The transformer streams from host RAM, not from NVMe.** 4.24 s per step
   against 32.1 s. Both components cannot be in RAM together (35.38 + 22.28 =
   57.7 GiB against ~48 free), so the text encoder goes to disk instead: it runs
   once per prompt where the transformer runs eight times per clip.
2. **`use_stream=True`, `num_blocks_per_group=1`.** Overlapping each block's
   transfer with the previous block's compute takes a step from 10.64 s to
   4.24 s against a 3.54 s arithmetic floor -- 90% of the transfer hidden.
   Larger groups are strictly worse (2 -> 11.78 s, 4 -> 14.12 s, 8 -> 131.66 s
   with 0.23 GiB of spill), and any stream mode forces the group size to 1 anyway.
3. **Every guidance is turned off by name.** `pipe.__call__` defaults to the SFT
   values, so a distilled run has to state all six. `modality_scale` defaults to
   3.0 and gates a second full transformer forward per step -- 7.93 s against
   4.23 s, and a generation mode the model was not distilled for. This one is
   worth generalising: **a pipeline's defaults belong to whichever variant its
   author had in mind, and a checkpoint that changes the inference regime does
   not change them.** Read the signature, do not infer the list.
4. **The text encoder is offloaded by `accelerate`, not by diffusers.** Pointed
   at a transformers model, diffusers' group offloading breaks four ways: its
   block scan sees only direct children so all 22.28 GiB becomes one group; the
   lazy hook does not check for duplicate registration and Gemma's chain contains
   `model` twice; `send_to_device` rebuilds `shared_kv_states` and the rope
   shapes stop matching; and `lm_head`'s weight tying breaks once the embedding
   it aliases is released. The first three have workarounds. The fourth does not.

### Verdict for this machine

| stack | verdict |
| --- | --- |
| diffusers bf16, transformer group-streamed from RAM, encoder on disk | **recommended** — fastest and the quality reference, 4.24 s/step |
| diffusers bf16 + `enable_model_cpu_offload()` | does not fit — that call wants every component host-resident |
| diffusers bf16, transformer streamed from NVMe | works, 32.1 s/step; already 63% of the drive's real cold read rate, so nothing to tune |
| diffusers fp8 weight-only via TorchAo | works, 12.60 GiB on card, but slower than bf16 and no quality gain |
| diffusers + `GGUFQuantizationConfig` | works, smallest on disk, **slowest** — 11.5 s/step, no fused kernel available on this platform |
| bitsandbytes NF4 | smallest and fastest *encoder* (7.28 GiB, 0.28 s forward), untested on the transformer |
| diffusers int4 / NVFP4 | sm_89 has no FP4 — dequantized on the way in, quality risk, no native gain |
| ComfyUI int8-convrot | outside the diffusers backend this project targets |

**The quantization branch of this document was justified by a false premise.**
An earlier revision recorded bf16 as *impossible* on the grounds that transformer
plus text encoder need 57.7 GiB host-resident against ~45 available. The
arithmetic was right; the premise was not. The two never have to be live at the
same time, and neither has to be fully resident: whichever is used less often
streams from disk, and the other streams block by block from RAM. Every
conclusion built on top of that -- pre-quantized checkpoints being the only way
in, GGUF being necessary, on-the-fly quantization being the blocker -- followed
from it and was wrong in the same direction.

The general form, worth applying before the next stack decision:

- Summing component sizes answers "do these fit together", which is rarely the
  question. Ask instead **which components must be live simultaneously**, and
  for how long each is used.
- A component that runs once per request and one that runs once per step do not
  deserve the same tier of memory. Rank by use frequency, not by size.
- "Does not fit in RAM" is not the same as "does not fit". Disk is a tier, and a
  file-backed one costs a read where anonymous memory costs a write and a read.

Measure with [`arms/video-ltx25-diffusers/bench.py`](../arms/video-ltx25-diffusers/bench.py),
which loads each configuration in a cold subprocess and reports load time, median
step time, peak reserved VRAM and peak system RAM.

## Access and credentials

`Lightricks/LTX-2.5-Diffusers` is gated (`gated: auto`). Two separate things are
required, and both have already cost this project time:

1. **Per-repo acceptance.** Accepting on `Lightricks/LTX-2.5` does not grant
   `Lightricks/LTX-2.5-Diffusers`. Accept on the exact repo.
2. **A token whose scope covers it.** A fine-grained token scoped to your own
   user entity returns 200 on ordinary public repos and **403 on gated
   third-party repos**, even with `canReadGatedRepos: true` — the `scoped` list
   names only your own entity. Use a Read-role token, or tick *Read access to
   contents of all public gated repos you can access*.

Verify before spending 30 minutes of download:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/Lightricks/LTX-2.5-Diffusers/raw/main/model_index.json"
```

`HF_TOKEN` belongs in `.env`. The supervisor spawns arms with
`env: { ...process.env, ...spec.env }`, so anything in the supervisor's
environment reaches every arm without the manifest naming it.

## Related

- [Hardware baseline](./hardware-baseline.md) — the measured numbers behind all of this.
