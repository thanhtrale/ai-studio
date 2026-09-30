"""The graph the arm builds, checked against ComfyUI's own Qwen 2511 blueprint.

Nothing here runs ComfyUI. What it protects is the wiring: a graph with a node
connected to the wrong slot is accepted by `/prompt`, runs, and produces an
image that is quietly not the one the blueprint produces.
"""

from __future__ import annotations

import pytest

from arm_qwen_comfy.graph import MAX_REFERENCES, Models, Sampling, build

MODELS = Models(unet="unet.safetensors", clip="clip.safetensors", vae="vae.safetensors")


def sampling(**overrides: object) -> Sampling:
    base = {
        "prompt": "a cat",
        "negative_prompt": "",
        "width": 1024,
        "height": 1024,
        "steps": 20,
        "cfg": 2.5,
        "seed": 42,
    }
    base.update(overrides)
    return Sampling(**base)  # type: ignore[arg-type]


def test_the_loaders_carry_bare_filenames() -> None:
    graph = build(MODELS, sampling(), "aistudio/x")

    # Not paths. ComfyUI resolves these against the search paths the arm writes
    # into extra_model_paths.yaml, so a graph never names a location.
    assert graph["unet"]["inputs"]["unet_name"] == "unet.safetensors"
    assert graph["clip"]["inputs"]["clip_name"] == "clip.safetensors"
    assert graph["clip"]["inputs"]["type"] == "qwen_image"
    assert graph["vae"]["inputs"]["vae_name"] == "vae.safetensors"


def test_the_model_runs_through_the_shift_and_the_cfg_norm() -> None:
    graph = build(MODELS, sampling(shift=3.1), "aistudio/x")

    assert graph["shift"]["inputs"] == {"model": ["unet", 0], "shift": 3.1}
    assert graph["cfgnorm"]["inputs"]["model"] == ["shift", 0]
    # The sampler takes the patched model, not the raw loader: skipping either
    # patch is a graph that runs and produces a different image.
    assert graph["sampler"]["inputs"]["model"] == ["cfgnorm", 0]


def test_the_latent_is_the_size_the_job_asked_for() -> None:
    graph = build(MODELS, sampling(width=1344, height=768), "aistudio/x")

    assert graph["latent"]["class_type"] == "EmptySD3LatentImage"
    assert graph["latent"]["inputs"] == {"width": 1344, "height": 768, "batch_size": 1}
    # One image per prompt, always. A batch dimension would give four files one
    # seed between them, and no way to reproduce the third on its own.
    assert graph["sampler"]["inputs"]["latent_image"] == ["latent", 0]


def test_without_references_the_reference_plumbing_is_absent() -> None:
    graph = build(MODELS, sampling(), "aistudio/x")

    assert "ref0" not in graph
    assert "scale0" not in graph
    assert "positive_ref" not in graph
    # Wired straight to the encoders rather than through nodes carrying nothing.
    assert graph["sampler"]["inputs"]["positive"] == ["positive", 0]
    assert graph["sampler"]["inputs"]["negative"] == ["negative", 0]
    assert "vae" not in graph["positive"]["inputs"]


def test_the_first_reference_is_scaled_and_the_rest_are_not() -> None:
    graph = build(MODELS, sampling(references=["a.png", "b/c.png"]), "aistudio/x")

    assert graph["ref0"]["inputs"]["image"] == "a.png"
    assert graph["ref1"]["inputs"]["image"] == "b/c.png"
    assert graph["scale0"]["inputs"]["image"] == ["ref0", 0]

    # image1 is the anchor and goes through the Kontext resolution table; the
    # others are seen by the encoder at their own size.
    assert graph["positive"]["inputs"]["image1"] == ["scale0", 0]
    assert graph["positive"]["inputs"]["image2"] == ["ref1", 0]
    assert "image3" not in graph["positive"]["inputs"]
    # Reference latents need the VAE, which is why it is wired only when there
    # is something to encode.
    assert graph["positive"]["inputs"]["vae"] == ["vae", 0]


def test_references_route_both_conditionings_through_the_latent_method() -> None:
    graph = build(MODELS, sampling(references=["a.png"]), "aistudio/x")

    assert graph["positive_ref"]["inputs"]["conditioning"] == ["positive", 0]
    assert graph["negative_ref"]["inputs"]["conditioning"] == ["negative", 0]
    assert graph["sampler"]["inputs"]["positive"] == ["positive_ref", 0]
    assert graph["sampler"]["inputs"]["negative"] == ["negative_ref", 0]


def test_the_negative_prompt_gets_the_same_references() -> None:
    graph = build(MODELS, sampling(negative_prompt="blurry", references=["a.png"]), "aistudio/x")

    assert graph["negative"]["inputs"]["prompt"] == "blurry"
    # Same images on both sides, as the blueprint has them: the negative
    # conditioning is a contrast against the same scene, not against nothing.
    assert graph["negative"]["inputs"]["image1"] == ["scale0", 0]


def test_the_sampler_carries_the_job_verbatim() -> None:
    graph = build(
        MODELS,
        sampling(steps=8, cfg=4.0, seed=7, sampler="euler_ancestral", scheduler="beta"),
        "aistudio/x",
    )

    assert graph["sampler"]["inputs"] | {} == {
        "model": ["cfgnorm", 0],
        "positive": ["positive", 0],
        "negative": ["negative", 0],
        "latent_image": ["latent", 0],
        "seed": 7,
        "steps": 8,
        "cfg": 4.0,
        "sampler_name": "euler_ancestral",
        "scheduler": "beta",
        "denoise": 1.0,
    }


def test_the_save_prefix_is_the_one_the_caller_chose() -> None:
    graph = build(MODELS, sampling(), "aistudio/job-1")

    assert graph["save"]["inputs"] == {"images": ["decode", 0], "filename_prefix": "aistudio/job-1"}


def test_a_fourth_reference_is_refused() -> None:
    with pytest.raises(ValueError, match=f"at most {MAX_REFERENCES}"):
        build(MODELS, sampling(references=["a.png", "b.png", "c.png", "d.png"]), "aistudio/x")
