# text-qwen36-a3b-llamacpp

Qwen3.6-35B-A3B on [llama.cpp], as a resident arm.

The arm is a small Python process with no third-party dependencies. It does not
run the model: it starts `llama-server.exe` as a child, keeps it alive between
jobs, and translates in both directions — the studio's job into a chat
completion, and the completion's stream into the studio's timeline.

Every flag this arm passes is taken from `llama-server -h` of the build in
`bin/`, and every number below was measured on this machine rather than read
off a model card.

## Why a wrapper, when llama-server already speaks OpenAI

The manifest format has an `openai` protocol, and the scaffold in
`text-llamacpp-cu124` declares it. Nothing implements it: the supervisor posts a
job to an arm's `/generate` and polls its `/progress`, and `llama-server` has
neither. Teaching the supervisor to relay `/v1/chat/completions` would also
mean teaching it what a chat completion is, which job a stream belongs to, and
how a thought differs from an answer — all of which is one arm's business.

So this arm is `native`, like the other two, and the translation stays here.
What that buys is a timeline: **Load model** with where the weights landed,
**Prompt processing** with a meter for a long prompt, **Think** and **Answer**
as separate steps, and a token meter with the child's live rate. A spinner
cannot tell ten seconds of thinking from a hang.

## Installing the runtime

Installed here: **b10919** (12 Sep 2026), the Windows **CUDA 13.3** build. To
reproduce or upgrade, download both archives from the [releases page][releases]
— `llama-<build>-bin-win-cuda-13.3-x64.zip` and
`cudart-llama-bin-win-cuda-13.3-x64.zip` — and unpack both into `bin/`:

```
arms/text-qwen36-a3b-llamacpp/
  arm.yaml
  params.schema.json
  bin/
    llama-server.exe     <- what this arm starts
    llama-bench.exe      <- handy for placing a model outside the studio
    cudart64_13.dll      <- from the cudart zip
    cublas64_13.dll
    ...
```

CUDA 13 rather than 12: the driver on this machine (616.92) supports it, the
build is 100 MB smaller, and the image arm's CUDA 12 runtime lives in its own
`bin/` regardless — Windows resolves DLLs from the executable's directory
first, so the two never meet.

`bin/` is git-ignored. Then create the interpreter the manifest names:

```powershell
cd arms/text-qwen36-a3b-llamacpp
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"   # pytest and ruff only
```

The arm itself needs nothing installed: `-e .[dev]` is for the tests.

## The weights

Two files, under `storage/models/qwen3.6-35b-a3b/`:

| file | size | what it is |
| --- | ---: | --- |
| `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` | 20.8 GiB | **the model**: Unsloth's dynamic 4-bit quant of Qwen3.6-35B-A3B |
| `mmproj-F16.gguf` | 0.8 GiB | the vision projector — loaded only when `vision` is true |

Both from [unsloth/Qwen3.6-35B-A3B-GGUF], which is not gated. Fetched with the
`hf` CLI (the video arm's venv has one):

```powershell
$dest = "storage/models/qwen3.6-35b-a3b"
hf download unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf mmproj-F16.gguf --local-dir $dest
Remove-Item -Recurse $dest/.cache
```

The model is a mixture of experts: 35B parameters, 256 experts per layer, 8
active, so **3B parameters run per token**. That is why it generates at 60
tok/s on a card it does not fit on — the experts that are not on the card are
mostly not needed for any given token. It was trained to a 262 144-token
context and thinks by default. The same repo carries every quantisation from
IQ1_M (9.4 GiB) to Q8_0 (34 GiB); the `cpuMoe` default below was measured for
this one and would want retuning for another.

## Placing the weights: the number that matters

A 20.8 GiB file on a 16 GiB card. Something has to live in RAM, and llama.cpp
offers two ways to decide what:

- **`--fit on`**, the child's default, which measures free VRAM and moves
  expert weights off the card until the rest fits, and
- **`--n-cpu-moe N`**, which pins the experts of the first N layers in RAM and
  puts everything else — attention, norms, the dense parts of every layer — on
  the card.

This arm uses the second, with **`--fit off`**, and the reason is a
measurement rather than a preference. Same model, same card, same 65k context,
one request of 1 521 prompt tokens and 128 generated:

| placement | load | card | prompt | generation |
| --- | ---: | ---: | ---: | ---: |
| `--fit on` (child decides), mmap | 10.8 s | 15 917 MiB | 89 tok/s | 29 tok/s |
| `--fit on`, `--load-mode none` | 13.3 s | 15 917 MiB | 96 tok/s | 24 tok/s |
| `--n-cpu-moe 20`, mmap | 6.6 s | 15 659 MiB | 641 tok/s | 48 tok/s |
| `--n-cpu-moe 20`, `--load-mode none` | 10.7 s | 15 659 MiB | 1 281 tok/s | 64 tok/s |
| **`--n-cpu-moe 22`, `--load-mode none`** | 11.2 s | **14 733 MiB** | **1 351 tok/s** | **63 tok/s** |
| `--n-cpu-moe 22`, `--load-mode none`, q8_0 KV | 12.3 s | 14 133 MiB | 1 332 tok/s | 61 tok/s |
| `--n-cpu-moe 24`, `--load-mode none` | 12.9 s | 13 807 MiB | 1 202 tok/s | 61 tok/s |

"Card" is whole-card use with a desktop already holding 2 190 MiB of it.

Two things in that table decided the defaults:

**The child's own placement is 14× slower at prompts and 2.6× slower at
generation.** Its log shows it splitting layers by fraction ("41 layers, 20
overflowing, GATE") and filling the card to 15 917 of 16 376 MiB. Under WDDM
that last half-gigabyte is where the driver starts paging VRAM to system memory
without saying so, and the per-token time collapsing is what that looks like.
Pinning 22 layers' experts in RAM leaves 1.6 GiB free, which is the difference.

**Memory-mapping the file halves the prompt speed.** The child warns about it
itself — *tensor overrides to CPU are used with mmap enabled - consider using
--load-mode none* — and the numbers agree: with `--load-mode none` the CPU
share of the weights is read into pinned host memory (`CUDA_Host` in the log)
rather than faulted in from the page cache, and the batched prompt path that
streams those experts across PCIe gets the 1.72× pinned-memory advantage the
hardware baseline measured. It costs four seconds at load.

`cpuMoe` is the lever if the card is not this card. Each layer's experts are
about 470 MiB; 20 is as far as this card goes, 24 buys 0.9 GiB of headroom for
5% of prompt speed.

## How much context fits

The model was trained to **262 144 tokens**, and the whole of it fits on this
card — not by default, but by moving more experts to RAM. Only 10 of the 40
layers are full attention (the other 30 are Gated DeltaNet, whose state is a
fixed 63 MiB), so the KV cache is cheap: **20 KiB per token at f16**, 5 120
MiB for the full 262k, half that at q8_0. Each layer's experts are about 470
MiB, so every 24k tokens of f16 context costs one more layer in RAM.

Measured by actually filling the context — a 240 028-token prompt, then a
short answer — rather than by loading an empty one, because an empty 256k
cache costs nothing until it is touched and the spill only shows when it is:

| context | KV | `cpuMoe` | card at load | full prompt | generation after it | verdict |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 65 536 | f16 | 22 | 14 733 MiB | 1 703 tok/s (7k) | 39 tok/s | **the default** |
| 131 072 | f16 | 22 | 15 181 MiB | 1 704 tok/s (120k) | 37 tok/s | fits, 1.2 GiB from the edge |
| 131 072 | f16 | 26 | 13 327 MiB | 1 446 tok/s (120k) | 30 tok/s | fits |
| 262 144 | q8_0 | 22 | 15 813 MiB | 1 431 tok/s (240k) | **17 tok/s, wrong answer** | spills |
| 262 144 | f16 | 22 | 15 885 MiB | — | 23 tok/s on a short prompt | spills at load |
| **262 144** | **q8_0** | **26** | **13 959 MiB** | **1 052 tok/s (240k)** | **45 tok/s** | **fits** |
| 262 144 | f16 | 30 | 14 159 MiB | 1 042 tok/s (240k) | 42 tok/s | fits |

"Spills" is the WDDM failure: `nvidia-smi` still reads under 16 GiB because
the overflow is in system memory, nothing errors, and the only symptoms are
generation falling to a third and — at 240k — the model answering "1" to a
question it answered correctly in every configuration that fit.

So: **for the full 262k, set `contextSize` 262144, `kvCacheType` q8_0 and
`cpuMoe` 26** (or f16 and 30). It costs 12% of short-context generation
speed (55 against 63 tok/s) and nothing else. Beyond 262 144 the model needs
YaRN rope scaling, which this arm does not expose and has not tried.

Two caveats on the generation figures at long context. They fall with the
context regardless of placement — attention over 240k tokens is real work,
and 60 tok/s at 25 tokens becomes 45 at 240k. And they were measured while
another arm held 29 GB of host RAM: with `--load-mode none` this child wants
the file in the page cache *and* the RAM-resident experts pinned, about 33 GB,
so the machine was short, and the same configuration varied between 18 and
30 tok/s from one run to the next. On a quiet machine expect the higher end.

## What a job looks like

The supervisor posts to the arm's `/generate`; there is no text console yet,
so today the caller is the supervisor's own job route:

```json
{
  "jobId": "job-1",
  "params": {},
  "job": {
    "system": "Trả lời bằng tiếng Việt.",
    "messages": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
    "prompt": "Viết một câu haiku về mưa Sài Gòn.",
    "thinking": false,
    "maxTokens": 256
  }
}
```

Per job: `prompt` (the turn being asked; appended as the last user message),
`system`, `messages` (the conversation so far), `maxTokens`, `thinking`,
`reasoningBudget`, `seed`, and the sampler — `temperature`, `topP`, `topK`,
`minP`, `presencePenalty`, `repeatPenalty`. `maxTokens` is capped by the loaded
context rather than by a constant. Start parameters — the model, `contextSize`,
`cpuMoe`, `kvCacheType`, `vision` — travel with the job as `params`, and the
supervisor restarts the arm if the loaded one does not match them.

### Silence picks the model card's numbers

Qwen's card gives one set of sampler values for thinking ("temperature 1.0,
top-p 0.95, top-k 20, presence penalty 1.5") and another for instruct mode
("0.7, 0.8, 20, 1.5"). A job that says nothing about sampling gets the set
that matches its `thinking` flag, and the report carries what was used. A job
may set any of them.

### Thinking

`thinking` defaults to **true**, because that is how the model was released.
It is the chat template's own `enable_thinking` switch, so off means no
thought block at all rather than an empty one. The child is started with
`--reasoning-format deepseek`, which returns the thought as
`reasoning_content` separate from the answer — that separation is what makes
**Think** and **Answer** two steps on the timeline and `reasoning` and `text`
two fields in the report.

`reasoningBudget` caps the thought in tokens. It is passed only when set; the
child's default is unrestricted.

### The report

```
text, reasoning, finish_reason, model, thinking, seed,
tokens_prompt, tokens_cached, tokens_generated, tokens_reasoning,
seconds_total, seconds_prompt, seconds_generate, seconds_to_first_token,
prompt_tokens_per_second, generate_tokens_per_second,
context_size, peak_vram_gib, vram_scope, sampling, stages
```

The counts and rates are the child's own `timings`, not measured from outside.
`tokens_reasoning` is the one exception: it is a count of stream chunks that
carried a thought, which is one per token in this build.

## Measured

An RTX 4080 (16 376 MiB), the defaults: `cpuMoe` 22, 65 536 context, f16 KV,
flash attention auto. Through the supervisor, so the broker's own steps are
included.

| job | broker | load | prompt | think | answer | generation | card peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 25-token question, thinking, cold | 0.4 s | 12.5 s | 0.3 s | 10.2 s (605 tok) | 1.3 s | 59.6 tok/s | 14 403 MiB |
| 34-token haiku, no thinking, warm | 0.0 s | — | 0.5 s | — | 0.3 s | 58.0 tok/s | 14 403 MiB |
| 7 022-token prompt, no thinking, warm | 0.0 s | — | 4.1 s | — | 0.1 s | 38.7 tok/s | 14 411 MiB |

The first job pays 12.5 s to read the file and the broker 0.4 s to start the
arm; the second is brokered in 0.0 s onto the loaded child. That is the whole
argument for a resident arm.

**The 7 022-token prompt runs at 1 703 tok/s** — against 83 tok/s for the same
prompt under the child's own placement, the first thing this arm was run with.
Generation slows to 38.7 tok/s at that context because attention is now over
seven thousand tokens; at a short context it is 60.

Four more things worth keeping:

**Thinking is most of a thinking job.** 605 of 687 tokens on the first run
went to the thought, at the same rate as the answer. Turning it off for a task
that does not need it is a 10× difference in wall time, not a marginal one.

**Whole-card use sits at 14.4 GiB and does not move.** The KV cache is
reserved at load — 1 280 MiB for 65k at f16 — so a long prompt costs nothing
extra on the card; the 7k prompt peaked 8 MiB above the 25-token one.

**The prompt meter is late.** The child logs prompt progress every 2 048
tokens, but writes its log through a pipe that it buffers, so the meter can
appear seconds after the batch it reports. On a 7k prompt that is most of the
prompt step; on a 60k prompt it is a fair picture. The first streamed token
sets the exact count either way.

**Load is 11–13 s warm.** That is the file coming off the page cache. The
first load after a reboot reads 20.8 GB off NVMe on top, and the arm allows
fifteen minutes for it before it gives up.

## VRAM, and what this machine will not tell you

Taken from the image arm unchanged, because the situation is: a GeForce card
under Windows runs in WDDM mode, where `nvidia-smi` answers `[N/A]` for every
process's memory, including this arm's child. So the arm measures the *scope*
of what it can read and carries the answer with every number — `card` on this
machine, `process` where the driver attributes, `unavailable` where there is
no `nvidia-smi` — and a stored peak can never later be read as one arm's
share. See `vram.py`.

## The child cannot outlive the arm

Also from the image arm, where it was learned the hard way: `atexit` does not
run when the supervisor has to `taskkill /F` an arm, and a child started
normally then survives its parent, holding fourteen gigabytes nobody can
reach. The child goes into a Win32 job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`jobobject.py`), so when this process
dies by any means its last handle closes and the kernel kills the child.
Checked after every real run here: stopping the arm left the card at its
desktop baseline and no `llama-server.exe` in the process list.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q     # 39 tests
.\.venv\Scripts\python.exe -m ruff check .
```

These do not run under `npm test`, which is vitest. Four files:

- `test_logscan.py` — the log parser, against lines a real b10919 wrote.
- `test_generation.py` — job validation, and the sampler defaults following
  the thinking switch.
- `test_arm_end_to_end.py` — the whole arm against `fake_llama_server.py`: the
  child is started and waited for through its 503-then-200 health check, its
  load log becomes the placement note, a completion is streamed into steps and
  a token meter, thought and answer come back apart, a second job reuses the
  running child, and a second job *during* the first is a 409 rather than a
  queue.
- `test_jobobject.py` — that closing the job object kills what is in it.

The stand-in imitates the surface the arm depends on, taken from a real run
rather than from documentation. It is not a substitute for the real thing: the
placement table above is the kind of finding no stand-in produces.

[llama.cpp]: https://github.com/ggml-org/llama.cpp
[releases]: https://github.com/ggml-org/llama.cpp/releases
[unsloth/Qwen3.6-35B-A3B-GGUF]: https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF
