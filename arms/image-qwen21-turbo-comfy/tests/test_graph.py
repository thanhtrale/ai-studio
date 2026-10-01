"""The graph the arm builds, checked against Viggle's own turbo workflows.

Nothing here runs ComfyUI. What it protects is the wiring: a graph with a node
connected to the wrong slot is accepted by `/prompt`, runs, and produces an
image that is quietly not the one the workflow produces.
"""

from __future__ import annotations

from itertools import pairwise

import pytest

from arm_qwen21.graph import (
    DEFAULT_STEPS,
    MAX_REFERENCES,
    Models,
    Sampling,
    build,
    build_rewrite,
    sigma_nodes,
)

MODELS = Models(
    unet="qwen_image_2.1_bf16.safetensors",
    clip="qwen3vl_8b_int8_convrot.safetensors",
    vae="qwen_image_2.1_vae_bf16.safetensors",
    lora="viggle-turbo-r256.safetensors",
)


def sampling(**overrides: object) -> Sampling:
    base = {
        "prompt": "a paper crane",
        "negative_prompt": "",
        "width": 1024,
        "height": 1024,
        "steps": DEFAULT_STEPS,
        "seed": 42,
    }
    base.update(overrides)
    return Sampling(**base)  # type: ignore[arg-type]


def test_the_six_step_schedule_is_the_one_the_lora_shipped_with() -> None:
    assert sigma_nodes(6) == [1.0, 0.9375, 0.875, 0.75, 0.5, 0.25]


def test_the_documented_alternatives_come_out_of_the_same_rule() -> None:
    # The README gives 5 and 7 explicitly. They are not special cases here:
    # the nodes below 0.875 are fixed and the extra steps subdivide the first,
    # highest-noise segment, which is what the author says to do.
    assert sigma_nodes(5) == [1.0, 0.875, 0.75, 0.5, 0.25]
    assert sigma_nodes(7) == [1.0, 0.958333, 0.916667, 0.875, 0.75, 0.5, 0.25]


def test_four_steps_is_the_training_schedule() -> None:
    assert sigma_nodes(4) == [1.0, 0.75, 0.5, 0.25]


def test_every_schedule_has_one_node_per_step_and_descends() -> None:
    for steps in range(4, 17):
        nodes = sigma_nodes(steps)
        assert len(nodes) == steps
        assert nodes[0] == 1.0
        assert all(later < earlier for earlier, later in pairwise(nodes))


def test_the_loaders_carry_bare_filenames() -> None:
    graph = build(MODELS, sampling(), "aistudio/x")

    assert graph["unet"]["inputs"]["unet_name"] == MODELS.unet
    assert graph["clip"]["inputs"]["clip_name"] == MODELS.clip
    # Still qwen_image: the loader decides 2.1 from the encoder being Qwen3-VL.
    assert graph["clip"]["inputs"]["type"] == "qwen_image"
    assert graph["vae"]["inputs"]["vae_name"] == MODELS.vae
    assert graph["lora"]["inputs"]["lora_name"] == MODELS.lora


def test_the_lora_is_applied_unmerged_at_full_strength() -> None:
    graph = build(MODELS, sampling(), "aistudio/x")

    # Not LoraLoaderModelOnly: merging this adapter into bf16 weights keeps
    # about seventy per cent of its update.
    assert graph["lora"]["class_type"] == "ViggleTurboLora"
    assert graph["lora"]["inputs"]["model"] == ["unet", 0]
    assert graph["lora"]["inputs"]["strength"] == 1.0


def test_the_model_reaches_the_guider_through_the_lora_and_the_cache() -> None:
    graph = build(MODELS, sampling(), "aistudio/x")

    assert graph["cache"]["inputs"]["model"] == ["lora", 0]
    assert graph["guider"]["inputs"]["model"] == ["cache", 0]


def test_sampling_is_unguided() -> None:
    graph = build(MODELS, sampling(negative_prompt="blurry"), "aistudio/x")

    # BasicGuider, not CFGGuider: the student was distilled to run without
    # classifier-free guidance, and the negative branch has nothing to do.
    assert graph["guider"]["class_type"] == "BasicGuider"
    assert graph["guider"]["inputs"]["conditioning"] == ["encode", 0]
    # Still carried, so a job that sent one can see where it went.
    assert graph["encode"]["inputs"]["negative_prompt"] == "blurry"


def test_the_sampler_runs_on_the_turbo_schedule() -> None:
    graph = build(MODELS, sampling(steps=6, seed=7, sampler="euler"), "aistudio/x")

    assert graph["sigmas"]["class_type"] == "ViggleTurboSigmas"
    assert graph["sigmas"]["inputs"]["nodes"] == "1, 0.9375, 0.875, 0.75, 0.5, 0.25"
    # The schedule's shift is computed from the frame, so it must be given the
    # same latent the sampler gets.
    assert graph["sigmas"]["inputs"]["latent"] == ["latent", 0]
    assert graph["sampler"]["inputs"] == {
        "noise": ["noise", 0],
        "guider": ["guider", 0],
        "sampler": ["sampler_select", 0],
        "sigmas": ["sigmas", 0],
        "latent_image": ["latent", 0],
    }
    assert graph["noise"]["inputs"]["noise_seed"] == 7
    assert graph["sampler_select"]["inputs"]["sampler_name"] == "euler"


def test_the_latent_is_the_size_the_job_asked_for() -> None:
    graph = build(MODELS, sampling(width=1376, height=768), "aistudio/x")

    assert graph["latent"]["inputs"] == {"width": 1376, "height": 768, "batch_size": 1}


def test_without_references_the_vae_is_not_wired_to_the_encoder() -> None:
    graph = build(MODELS, sampling(), "aistudio/x")

    assert "ref0" not in graph
    assert "vae" not in graph["encode"]["inputs"]
    assert "images.image_1" not in graph["encode"]["inputs"]


def test_references_arrive_one_per_numbered_slot() -> None:
    graph = build(MODELS, sampling(references=["a.png", "b/c.png"]), "aistudio/x")

    assert graph["ref0"]["inputs"]["image"] == "a.png"
    assert graph["ref1"]["inputs"]["image"] == "b/c.png"
    # Dotted, because the encoder declares one growable input called `images`
    # and ComfyUI matches its rows on the path. A flat `image_1` reaches the
    # node as an unexpected keyword and the prompt is refused -- which is
    # exactly what the first real edit job did.
    assert graph["encode"]["inputs"]["images.image_1"] == ["ref0", 0]
    assert graph["encode"]["inputs"]["images.image_2"] == ["ref1", 0]
    assert "images.image_3" not in graph["encode"]["inputs"]
    # Reference latents need the VAE, which is why it is wired only when there
    # is something to encode.
    assert graph["encode"]["inputs"]["vae"] == ["vae", 0]


def test_a_fourth_reference_is_refused() -> None:
    with pytest.raises(ValueError, match=f"at most {MAX_REFERENCES}"):
        build(MODELS, sampling(references=["a.png", "b.png", "c.png", "d.png"]), "aistudio/x")


def test_the_rewriter_reuses_the_image_graph_s_own_text_encoder() -> None:
    graph = build_rewrite(MODELS, "a paper crane", "# rules", [])

    # The whole point of doing it this way: the enhancer costs no extra model
    # on the card, because it is the encoder the image graph already loads.
    assert graph["clip"]["inputs"]["clip_name"] == MODELS.clip
    assert graph["rewrite_generate"]["inputs"]["clip"] == ["clip", 0]
    assert graph["rewrite_generate"]["inputs"]["prompt"] == "a paper crane"
    assert graph["rewrite_generate"]["inputs"]["system_prompt"] == "# rules"
    # Sampling off, so a prompt rewrites to the same thing every time.
    assert graph["rewrite_generate"]["inputs"]["sampling_mode"] == "off"
    # PreviewAny is the one node that puts a string where /history can be read.
    assert graph["rewrite_out"]["inputs"]["source"] == ["rewrite_generate", 0]


def test_the_edit_rewriter_is_shown_the_references_as_one_batch() -> None:
    graph = build_rewrite(MODELS, "make it snow", "# rules", ["a.png", "b.png"])

    # Zero-based here, because BatchImagesNode grows from a prefix rather than
    # from a list of names.
    assert graph["rewrite_batch"]["inputs"] == {
        "images.image0": ["ref0", 0],
        "images.image1": ["ref1", 0],
    }
    assert graph["rewrite_generate"]["inputs"]["image"] == ["rewrite_batch", 0]


def test_the_rewriter_has_no_images_when_there_are_no_references() -> None:
    graph = build_rewrite(MODELS, "a paper crane", "# rules", [])

    assert "rewrite_batch" not in graph
    assert "image" not in graph["rewrite_generate"]["inputs"]
