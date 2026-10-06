# text-qwen3vl-8b-llamacpp

Qwen3-VL 8B Instruct on [llama.cpp], as a resident arm that **reads images and
writes text**.

It exists for one job in the studio today: the video console's prompt
enhancer. Given the user's note, the reference images and the rules of the
mode it is writing for, it rewrites a prompt the way MiniMax-H3 was trained to
read one. Nothing in the arm knows that, though — the instructions arrive with
the job from the web app (`apps/web/server/enhance/`), so the arm is a plain
vision-language chat and could serve another console tomorrow.

It is a copy of `text-qwen36-a3b-llamacpp` with three differences:

| | `text-qwen36-a3b-llamacpp` | this arm |
| --- | --- | --- |
| Model | Qwen3.6-35B-A3B, MoE, 20.8 GiB | Qwen3-VL 8B Instruct, dense, 8.7 GiB |
| Images | projector optional, not in the job contract | projector always loaded, `images` in every job |
| Placement | `cpuMoe` — experts split between RAM and card | everything on the card |
| Thinking | on by default | off by default (the Instruct model has none) |
| Capability | `text.generate` | `text.vision` |

`text.vision` rather than `text.generate` on purpose: the requirements analysis
takes the first arm that declares `text.generate`, and an 8B model is the
wrong one to hand a sixty-thousand-token ticket.

## Why a separate arm, not H3's own encoder

H3 conditions on Qwen3-VL 32B, and ComfyUI can make a text encoder generate —
the Qwen-Image arm does exactly that. It does not work here: the H3 repack is
**truncated at layer 50** (its conditioning is that layer's hidden state), so
there is no head left to generate with. And H3's own rewriter, H3-Context-IR,
is a hosted service that is not part of the open release. So the rewrite runs
on a separate, smaller Qwen3-VL.

The cost of that is a model swap: both arms want the card exclusively, so the
supervisor stops H3's ComfyUI to run a rewrite and restarts it for the next
clip. ComfyUI is cold-started per arm start anyway; budget the transformer's
read off disk on the first clip after an enhance.

## The job

```json
{
  "jobId": "…",
  "system": "instructions",
  "prompt": "the user turn",
  "images": ["uploads/2026-10-05/a.png", "uploads/2026-10-05/b.jpg"],
  "maxTokens": 2048,
  "temperature": 0.7
}
```

`images` are relative to the arm's `inputDir` — the same root the image and
video arms read references from — and nothing outside it can be named. They
are attached to the last user turn in the order given and reach the child as
data URLs. At most 12, each at most 32 MiB.

PNG and JPEG are what llama.cpp's `stb_image` decodes. **WebP is passed through
but not verified**: if the installed build cannot decode it, the child's own
400 comes back as the job's error.

The report is the Qwen3.6 arm's, plus `images` (how many were shown).

## Installing the runtime

The same llama.cpp release as the Qwen3.6 arm (b10919, CUDA 13.3), unpacked
into this arm's own `bin/`. Qwen3-VL support in `llama-server --mmproj` has
been in llama.cpp since late 2025; an older build will refuse the projector.

```powershell
cd arms/text-qwen3vl-8b-llamacpp
Copy-Item -Recurse ..\text-qwen36-a3b-llamacpp\bin .\bin
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"   # pytest and ruff only
```

## The weights

Under `storage/models/qwen3-vl-8b/`, from Qwen's own
[Qwen/Qwen3-VL-8B-Instruct-GGUF]:

```powershell
$dest = "storage/models/qwen3-vl-8b"
hf download Qwen/Qwen3-VL-8B-Instruct-GGUF `
  Qwen3VL-8B-Instruct-Q8_0.gguf mmproj-Qwen3VL-8B-Instruct-F16.gguf --local-dir $dest
Remove-Item -Recurse $dest/.cache
```

Check the file names against the repository before downloading; if they
differ, set `model` and `mmproj` to what is there.

Q8_0 rather than a 4-bit file: at 8B the saving is four gigabytes the card
does not need, and a rewriter is judged on its wording.

## VRAM

Measured on 2026-10-05, RTX 4080 16 GiB, default parameters, during a rewrite
with one 1024×1536 reference image: **whole-card peak 12 315 MiB**, of which
the desktop held 308 MiB. `vramEstimateMb: 12100` in the manifest is that
figure.

| | measured |
| --- | ---: |
| first job (cold load + rewrite) | 20.9 s |
| later jobs (child already loaded) | 5–11 s |

## Quality, from real runs

Run against a character sheet with a short Vietnamese prompt, both modes:
English out every time, the five H3 parts in order, the timeline ending on the
clip length, `<Picture 1>` cited correctly in ref2v, the medium read correctly
off the image, sound effects tied to the actions. What an 8B model still does
from run to run: "a few swings" comes out as two strikes rather than three,
and an occasional unrequested detail (slow motion, a different end pose)
slips in. The user reads the rewrite before generating, which is why it
replaces the prompt box rather than going straight to H3.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m ruff check .
```

`tests/fake_llama_server.py` stands in for the child, including the image
parts: it answers with how many images it was shown, so the tests prove the
images reached it.

[llama.cpp]: https://github.com/ggml-org/llama.cpp
[Qwen/Qwen3-VL-8B-Instruct-GGUF]: https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF
