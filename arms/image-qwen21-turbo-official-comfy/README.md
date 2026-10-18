# image-qwen21-turbo-official-comfy

Qwen's own **Qwen-Image-2.1-Turbo** (released 2026-10-09) on [ComfyUI], as a
resident arm. The sibling of `image-qwen21-turbo-comfy` — same job schema, same
text encoder and VAE, same ComfyUI checkout — with a different model and a
different schedule: a distilled checkpoint of its own, eight unguided steps on
a fixed sigma list, and no LoRA and no custom node.

It is the reference step of the 3D character pipeline (`/char3d`): one
2048×1024 sheet with the character's front, left profile and back, drawn from
the original as `<image1>`. See [docs/char3d.md](../../docs/char3d.md).

> **Licence.** Qwen-Image 2.1 weights are under Qwen's research licence:
> non-commercial use.

## Why this arm and not the viggle one

On the character pipeline, the step that matters is whether the sheet's arms
and hands come out as asked. Measured there:

- **Turbo, not Lightning.** Given an original whose hands are open,
  Qwen-Image-2.1 + the Lightning 4-step LoRA copied the open hand into the
  front view (0 of 20 fists) and spread the front's hands even at 1536×1024;
  Turbo on the same sheet prompt closed them 4 of 4. Four steps follow
  `<image1>` more closely than the prompt.
- viggle-turbo was replaced by this checkpoint in companion-web the day it
  came out; the sheet prompt was never measured on it.

## The schedule is fixed

`model_index.json` of `Qwen/Qwen-Image-2.1-Turbo` lists `sample_sigmas`:

```
1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568
```

diffusers (PR #14950) hands that list to
`FlowMatchEulerDiscreteScheduler.set_timesteps(sigmas=...)`; the checkpoint's
scheduler has `use_dynamic_shifting: false` and `shift: 1.0`, so the shift is
the identity — the pipeline computes `mu` from the frame and the scheduler
ignores it. The list goes into `ManualSigmas` as it is, plus the closing 0, in
fixed-point decimals (the node's parser does not read `1e-05`).

This is the opposite of viggle-turbo, whose raw nodes are shifted by the
frame's token count. **Do not share a sigma function between the two arms.**

`steps`, `cfgScale`, `scheduler` and `flowShift` arrive in the job, as the
shared schema has them, and are ignored; a job that asked for other than
eight steps says so on its timeline. The studio's image console was written
for the edit and viggle arms and will show its own step and CFG fields for
this one too — they change nothing here.

## The graph

The shape of ComfyUI's `image_qwen_image_2_1_t2i` / `_image_edit` templates,
subgraph flattened, prompt-enhancer branch kept as a graph of its own:

```
UNETLoader (int8, default dtype) ─ QwenImage21Cache ─┐
CLIPLoader (Qwen3-VL 8B) ─┬ TextEncodeQwenImage21 ───┴ BasicGuider ─┐
VAELoader ────────────────┘        ▲                                │
LoadImage ─────────────────────────┘ (image_1..image_3)  RandomNoise ┤
                                                      KSamplerSelect ┤
ManualSigmas (the eight, then 0) ───────────────────────────────────┤
EmptyLatentImage ───────────────────────────── SamplerCustomAdvanced ─ VAEDecode ─ SaveImage
```

## Runtime

None of its own: the `image-qwen21-turbo-comfy` arm's `.venv` and
`vendor/ComfyUI`. Install that arm first. Its `custom_nodes/viggle_turbo` is
not loaded here — ComfyUI starts with every custom node disabled.

## Weights

Relative to managed storage. The text encoder and VAE are the viggle arm's
files.

| Parameter | Default | Source | Bytes |
| --- | --- | --- | ---: |
| `diffusionModel` | `models/qwen-image-2.1/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors` | [Comfy-Org/Qwen-Image-2.1] @ `b42e6c76` | 7,256,783,064 |
| `textEncoder` | `models/qwen-image-2.1/text_encoders/qwen3vl_8b_int8_convrot.safetensors` | the same repo | 9,350,798,360 |
| `vae` | `models/qwen-image-2.1/vae/qwen_image_2.1_vae_bf16.safetensors` | the same repo | 675,509,688 |

**Pin the transformer's revision.** Comfy-Org re-uploaded
`qwen_image_2.1_turbo_int8_convrot.safetensors` after the character pipeline
was measured: at `b42e6c76` it is 7,256,783,064 bytes (LFS `85d32441…`), at
the head of `main` today 7,256,787,829 (`8144a018…`). The newer file has not
been run. Download with `revision="b42e6c7675686a74ac3c517eda2ebf2f2a545539"`.

## Not measured yet

- Peak VRAM on this arm (`vramEstimateMb` is the viggle arm's: same encoder
  and VAE, a smaller transformer).
- On companion-web's card: 70 s for a batch of sheets plus 0.5 s to split
  them (one run, r70), with the cross-check at 0.4% width and 0.8% height.

## Tests

```powershell
..\image-qwen21-turbo-comfy\.venv\Scripts\python.exe -m pytest
..\image-qwen21-turbo-comfy\.venv\Scripts\python.exe -m ruff check .
```

[ComfyUI]: https://github.com/comfyanonymous/ComfyUI
[Comfy-Org/Qwen-Image-2.1]: https://huggingface.co/Comfy-Org/Qwen-Image-2.1
