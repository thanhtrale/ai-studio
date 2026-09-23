# text-gemma4-26b-a4b-llamacpp

Gemma 4 26B-A4B on [llama.cpp], as a resident arm.

Structurally the same arm as `text-qwen36-a3b-llamacpp`: a small Python process
with no third-party dependencies that starts `llama-server.exe` as a child,
keeps it alive between jobs, and translates in both directions — the studio's
job into a chat completion, and the completion's stream into the studio's
timeline. Read that arm's README for the reasoning behind the wrapper, the job
object, and the VRAM scope; none of it is repeated here.

What is different is the model, and the difference is worth the second arm.

The numbers below were measured on this card. Where an earlier estimate is
still quoted it is quoted in order to say how wrong it was.

## Why this model, for this feature

The requirements analysis reads a design digest and a ticket, and both grow
with the size of the block. Gemma 4 26B-A4B is unusually cheap at long context,
and not by a small margin.

From its own `config.json`:

| layer group | layers | kv heads | head dim | grows with context? |
| --- | ---: | ---: | ---: | --- |
| `full_attention` | 5 | 2 | 512 | **yes** |
| `sliding_attention`, window 1024 | 25 | 8 | 256 | **no** |

Only 5 of 30 layers are full attention, and `attention_k_eq_v` is true — K and
V share one tensor, so the cache holds one copy rather than two. The cache that
grows with context is therefore `5 × 2 × 512 = 5120` values per token: about
**10 KiB/token at f16, 5 KiB at q8_0**. The 25 sliding layers cost a fixed
~105 MiB whatever the context.

At the trained maximum of **262 144 tokens** that is roughly **1.4 GiB of KV at
q8_0**. The same context on the Qwen arm costs 5 120 MiB, because every one of
its 40 layers is paying.

### `--swa-full` must never be passed

llama.cpp defaults it to false, which is what keeps those 25 layers at their
1024-token window. Turning it on allocates the full context for all of them —
`25 × 8 × 256 × 262144 × 2 B` is **25.6 GiB** of KV on a 16 GiB card. Nothing
errors; the model just does not fit, and the reason appears nowhere in the log.

The manifest does not expose it, `runtime.py` says why at the point the
argument list is built, and `tests/test_runtime_flags.py` fails if it ever
appears. That is three places for one flag, deliberately: it is the kind of
requirement that is invisible in a diff.

## The weights

Two files, under `storage/models/gemma-4-26b-a4b/`:

| file | size | what it is |
| --- | ---: | --- |
| `gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf` | 13.27 GiB | **the model** |
| `mmproj-F16.gguf` | 1.11 GiB | the vision projector — loaded only when `vision` is true |

From [unsloth/gemma-4-26B-A4B-it-qat-GGUF]. Google publishes the model as
safetensors; llama.cpp reads GGUF only, and conversion is unnecessary because
Google, `ggml-org` and Unsloth all publish one.

**Why the QAT build.** It is quantisation-aware trained, so its 4-bit quality
is much closer to bf16 than a post-training quant of the same size — and it is
*also* 2.6 GiB smaller than the same publisher's non-QAT `UD-Q4_K_XL` (15.84
GiB). There is no trade to make, and on a 16 GiB card that 2.6 GiB converts
directly into KV cache and into experts that stay on the card. It is the same
publisher and the same dynamic-quant scheme as the installed Qwen model, so the
`cpuMoe` intuition carries over.

The alternatives, for the record:

| repo → file | size | |
| --- | ---: | --- |
| `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` → `gemma-4-26B_q4_0-it.gguf` | 13.45 GiB | first-party, flat Q4_0 |
| `ggml-org/gemma-4-26B-A4B-it-GGUF` → `Q4_0` | 13.61 GiB | llama.cpp's own org |
| `unsloth/gemma-4-26B-A4B-it-GGUF` → `UD-Q4_K_XL` | 15.84 GiB | not QAT; 2.6 GiB for nothing |

Fetched with the `hf` CLI (the video arm's venv has one):

```powershell
$dest = "storage/models/gemma-4-26b-a4b"
hf download unsloth/gemma-4-26B-A4B-it-qat-GGUF `
  gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf mmproj-F16.gguf --local-dir $dest
Remove-Item -Recurse $dest/.cache
```

The repo also carries an MTP (multi-token prediction) draft model at 0.23 GiB,
which would drive speculative decoding. Not wired: it is a speed lever on a
running arm, and nothing should be tuned before it has been measured once.

## Installing the runtime

Same build as the Qwen arm — **b10919**, Windows **CUDA 13.3** — unpacked into
this arm's own `bin/`. Two arms wrapping the same runtime resolve their
libraries from their own directory and do not interfere, which is the whole
point of the per-arm layout. See that arm's README for the download.

That build is new enough, and it was worth checking before spending fourteen
gigabytes of download finding out: a GGUF names its architecture, and a
`llama-server` that does not know `gemma4` refuses the file. The architecture
names are string constants in `llama.dll`, so the question is answerable in a
second:

```powershell
Select-String -Path bin\llama.dll -Pattern 'gemma4' -Encoding Byte -AllMatches
# or, from Git Bash:
grep -aoE 'gemma[0-9a-z_-]{0,12}' bin/llama.dll | sort -u
```

b10919 lists `gemma`, `gemma2`, `gemma3`, `gemma3n`, `gemma4` and
`gemma4-assistant`.

```powershell
cd arms/text-gemma4-26b-a4b-llamacpp
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"   # pytest and ruff only
```

## Placing the weights: measured

The model is a mixture of experts: 30 layers, 128 experts each,
`moe_intermediate_size` 704 against a hidden size of 2816. That is about
761 M parameters of experts per layer — **roughly 12.5 of the file's 13.27 GiB**
— leaving under a gigabyte for everything else. So `cpuMoe` is the lever here
exactly as it is on the Qwen arm.

Measured on an RTX 4080 (16 376 MiB) with the desktop at **0 MiB**, so these
are very nearly the arm's own share rather than a whole-card figure inflated by
something else. `cpuMoe` 12, `kvCacheType` q8_0, flash attention auto:

| context | whole card | headroom | verdict |
| ---: | ---: | ---: | --- |
| **65 536** | **10 294 MiB** | 6.0 GiB | **the default** |
| **262 144** | **13 292 MiB** | 3.0 GiB | **fits**, and is the trained maximum |

Both were driven by a real four-pass analysis, not by loading an empty context
— an untouched KV cache costs nothing until it is used, and the spill only
shows when it is. Neither run showed the WDDM symptoms (generation collapsing,
long-context answers going wrong); the reading was flat at 13 292 MiB for the
whole of the 262 144 run.

### Where the arithmetic was wrong

This file previously predicted the 262 144 context would cost about **1.4 GiB**
of KV at q8_0, from the architecture: only 5 of 30 layers are full attention,
and `attention_k_eq_v` means K and V share one tensor, giving
`5 × 2 heads × 512 dim` ≈ 5 KiB per token.

The measurement says **15.6 KiB per token** — `(13 292 − 10 294) MiB` over
`262 144 − 65 536` tokens. Three times the estimate.

The prediction was wrong in direction, not just in magnitude: something in the
allocation does not behave as `attention_k_eq_v` and the layer split suggest —
K and V may not in fact be shared in this build, and the compute buffers grow
with context too. The conclusion survived (the full context fits), but only
because the estimate had 1.6 GiB of invented headroom in it. **That is the
argument for this repository's habit of measuring**: the reasoning was
plausible, specific, and out by 3×.

`cpuMoe` stays at 12 and `contextSize` at 65 536. Six gigabytes of headroom at
the default says a lower `cpuMoe` would put more experts on the card and run
faster — but that has not been measured, and an unmeasured default is what this
section exists to avoid.

## Measured against the Qwen arm, on one input

The same Figma frame and the same exported Jira ticket (CAP-59), through the
requirements analysis, on each arm. Both at their own defaults; the Qwen arm
was warm, this one paid a cold load inside pass 1.

| | Gemma 4 26B-A4B | Qwen3.6-35B-A3B |
| --- | ---: | ---: |
| Pass 1 · design inventory | 17.3 s | 10.0 s |
| Pass 2 · ticket claims | 64.4 s *(repaired)* | 92.0 s |
| Pass 3 · reconcile | 19.4 s | 53.0 s |
| Pass 4 · content model | 33.2 s | 18.0 s |
| **total** | **134 s** *(cold)* | **174 s** *(warm)* |
| claims extracted | 33 | 88 |
| requirements / gaps | 7 / 5 | 15 / 5 |
| whole card | 10 294 MiB | 14 403 MiB |

Two differences worth more than the timings.

**Gemma cites precisely; Qwen shotguns.** Qwen attached nearly every ticket
passage to nearly every requirement, which makes the evidence useless *as*
evidence. Gemma attached one or two. Since the whole feature rests on being
able to follow a statement back to its source, that is the more valuable
behaviour, and it is not visible in any speed number.

**Qwen extracts more, Gemma extracts more carefully.** 88 claims against 33 is
a real difference in recall, and on a ticket this dense the extra claims were
mostly real. Neither is simply better.

**Neither modelled the container filter correctly.** Both emitted a filter with
an empty `components` array where it should name the item component, and both
mixed a `container` field with a separate item definition. At the full 262 144
context Gemma failed pass 4 outright — it invented a nested `children` shape
with `resourceType` at the top level instead of the `plugins.xwalk.page`
wrapper — which the validator refused, kept the raw reply for, and reported as
`definitions[0].plugins must be an object`. The same model at 65 536 produced
the correct shape, so that is variance rather than incapacity. Pass 4 is the
least reliable of the four on both arms.

## Sampling

The defaults in `generation.py` are **carried over from the Qwen arm and have
not been checked against Gemma 4's model card.** They are a placeholder, not a
recommendation. A job may set any of `temperature`, `topP`, `topK`, `minP`,
`presencePenalty` and `repeatPenalty`, and the report carries what was used —
so a wrong default is visible in every record rather than silent.

## What a job looks like

Identical to the Qwen arm's contract: `prompt`, `system`, `messages`,
`maxTokens`, `thinking`, `seed` and the sampler. The requirements analysis
sends `messages` and `thinking: false` — its passes are extraction and
reconciliation against material already in the prompt, and a thought block
would be most of the wall time for none of the benefit.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q     # 42 tests
.\.venv\Scripts\python.exe -m ruff check .
```

`test_runtime_flags.py` is this arm's own: it pins `--fit off`,
`--load-mode none`, the KV cache type reaching both halves, and the absence of
`--swa-full`. The rest are inherited from the Qwen arm and exercise the wrapper
against `fake_llama_server.py`.

These do not run under `npm test`, which is vitest.

[llama.cpp]: https://github.com/ggml-org/llama.cpp
[unsloth/gemma-4-26B-A4B-it-qat-GGUF]: https://huggingface.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF
