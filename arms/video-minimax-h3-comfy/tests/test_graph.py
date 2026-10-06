"""The graph the arm hands ComfyUI, and the two grids it has to respect.

The wiring is the interesting part: H3 denoises one packed latent through two
VAEs, and a link into the wrong one produces a clip with no sound rather than
an error.
"""

from __future__ import annotations

import pytest

from arm_h3 import graph as graph_module
from arm_h3.graph import Models, Sampling, align_frames, build, frames_for_seconds, native_canvas


def models() -> Models:
    return Models(
        unet="minimax_h3_fl2va_int8_convrot.safetensors",
        clip="qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
        video_vae="minimax_h3_video_vae_fp16.safetensors",
        audio_vae="minimax_h3_audio_vae_fp32.safetensors",
        lora="minimax_h3_turbo_v4_step600_ema.safetensors",
    )


def sampling(**overrides: object) -> Sampling:
    defaults: dict = {
        "prompt": "a lone crane over a misty gorge",
        "negative_prompt": "",
        "width": 1344,
        "height": 768,
        "num_frames": 124,
        "steps": 6,
        "seed": 42,
    }
    return Sampling(**{**defaults, **overrides})  # type: ignore[arg-type]


def test_frame_counts_land_on_the_model_s_own_grid() -> None:
    # 17k + 5. The first latent block holds five frames and every one after it
    # holds seventeen, so nothing between those counts exists.
    assert align_frames(1) == 5
    assert align_frames(5) == 5
    assert align_frames(6) == 22
    assert align_frames(22) == 22
    assert align_frames(120) == 124
    assert align_frames(124) == 124


def test_seconds_become_frames_at_twenty_four_fps() -> None:
    assert frames_for_seconds(5) == 124
    assert frames_for_seconds(0) == 5
    # 15 seconds is the model's ceiling, and this is that on the grid.
    assert frames_for_seconds(15) == 362


def test_the_native_canvas_is_a_768_short_edge_under_an_area_cap() -> None:
    assert native_canvas(16, 9) == (1344, 768)
    assert native_canvas(9, 16) == (768, 1344)
    assert native_canvas(1, 1) == (768, 768)


def test_the_sampler_is_the_turbo_node_s_own() -> None:
    graph = build(models(), sampling(), "aistudio/x")

    # Not KSamplerSelect: H3 steps picture and audio on different flow
    # schedules, and this is the sampler that knows which ComfyUI it is on.
    assert graph["sampler_select"]["class_type"] == "MiniMaxH3TurboSampler"
    assert graph["sampler"]["inputs"]["sampler"] == ["sampler_select", 0]


def test_there_is_no_guidance_branch() -> None:
    graph = build(models(), sampling(negative_prompt="blurry"), "aistudio/x")

    # The released checkpoints are CFG-distilled: one transformer call per
    # step, so a guider rather than a positive/negative pair, and the negative
    # prompt has nowhere to go.
    assert graph["guider"]["class_type"] == "BasicGuider"
    assert "negative" not in graph["guider"]["inputs"]
    assert "blurry" not in graph["cond"]["inputs"].values()


def test_the_two_streams_decode_through_their_own_vaes() -> None:
    graph = build(models(), sampling(), "aistudio/x")

    assert graph["decode_video"]["inputs"] == {"samples": ["sampler", 0], "vae": ["video_vae", 0]}
    assert graph["decode_audio"]["inputs"] == {"samples": ["sampler", 0], "vae": ["audio_vae", 0]}
    # Both halves reach the muxer, because the audio is the point of this model.
    assert graph["create"]["inputs"]["audio"] == ["decode_audio", 0]
    assert graph["create"]["inputs"]["images"] == ["decode_video", 0]


def test_the_sigmas_read_the_shifted_model() -> None:
    graph = build(models(), sampling(shift_video=9.0, shift_audio=4.0), "aistudio/x")

    assert graph["shift"]["inputs"]["shift_video"] == 9.0
    assert graph["shift"]["inputs"]["shift_audio"] == 4.0
    # The schedule is computed from `model_sampling`, which the shift node
    # replaced -- reading the unshifted model here would sample on the wrong
    # sigmas and nothing would say so.
    assert graph["sigmas"]["inputs"]["model"] == ["shift", 0]
    assert graph["guider"]["inputs"]["model"] == ["shift", 0]


def test_the_lora_mode_is_the_node_s_low_vram_switch() -> None:
    assert build(models(), sampling(), "x")["lora"]["inputs"]["low_vram"] is False

    merged = Models(**{**vars(models()), "lora_mode": "merge"})
    assert build(merged, sampling(), "x")["lora"]["inputs"]["low_vram"] is True


def test_no_keyframe_is_plain_text_to_video() -> None:
    graph = build(models(), sampling(), "aistudio/x")

    # Absent, not null: a null would be a link to nothing and ComfyUI refuses
    # the whole prompt for it.
    assert "first_frame" not in graph["cond"]["inputs"]
    assert "last_frame" not in graph["cond"]["inputs"]
    assert not any(key.startswith("keyframe") for key in graph)


def test_keyframes_are_positional() -> None:
    graph = build(models(), sampling(keyframes=["a.png", "b.png"]), "aistudio/x")

    assert graph["keyframe0"]["inputs"]["image"] == "a.png"
    assert graph["cond"]["inputs"]["first_frame"] == ["keyframe0", 0]
    assert graph["cond"]["inputs"]["last_frame"] == ["keyframe1", 0]


def test_one_keyframe_is_a_first_frame() -> None:
    graph = build(models(), sampling(keyframes=["a.png"]), "aistudio/x")

    assert graph["cond"]["inputs"]["first_frame"] == ["keyframe0", 0]
    assert "last_frame" not in graph["cond"]["inputs"]


def test_a_third_keyframe_is_refused() -> None:
    with pytest.raises(ValueError, match="at most 2 keyframes"):
        build(models(), sampling(keyframes=["a.png", "b.png", "c.png"]), "aistudio/x")


def test_the_length_is_rounded_before_it_reaches_the_node() -> None:
    graph = build(models(), sampling(num_frames=100), "aistudio/x")

    assert graph["cond"]["inputs"]["length"] == align_frames(100)


def test_the_clip_loader_asks_for_h3_s_own_tokenizer() -> None:
    graph = build(models(), sampling(), "aistudio/x")

    # "minimax", not "qwen_image": the repack adds special tokens the
    # transformer's per-token modality tags depend on.
    assert graph["clip"]["inputs"]["type"] == "minimax"


def test_the_container_is_named_rather_than_left_to_auto() -> None:
    graph = build(models(), sampling(), "aistudio/run")

    assert graph["save"]["inputs"]["filename_prefix"] == "aistudio/run"
    # Flat, not nested. `format` is a dynamic combo: its value is the bare
    # option key and the codec it unlocks rides a dotted path beside it. A
    # nested object makes the option lookup miss, and the node is then called
    # without `format` at all.
    assert graph["save"]["inputs"]["format"] == graph_module.OUTPUT_FORMAT
    assert graph["save"]["inputs"]["format.codec"] == "auto"


def ref_models() -> Models:
    return Models(**{**vars(models()), "ref_unet": "minimax_h3_ref2va_int8_convrot.safetensors"})


def test_ref2v_loads_the_ref2va_weights_under_the_reference_node() -> None:
    graph = build(ref_models(), sampling(mode="ref2v", keyframes=["a.png", "b.png", "c.png"]), "x")

    assert graph["unet"]["inputs"]["unet_name"] == "minimax_h3_ref2va_int8_convrot.safetensors"
    assert graph["cond"]["class_type"] == "MiniMaxH3ReferenceToVideo"
    inputs = graph["cond"]["inputs"]
    # Autogrow slots, spelled as their dotted path under the group: the only
    # spelling ComfyUI turns back into the dict the node receives.
    assert inputs["ref_images.ref_image_0"] == ["reference0", 0]
    assert inputs["ref_images.ref_image_2"] == ["reference2", 0]
    assert "ref_images.ref_image_3" not in inputs
    assert inputs["ref_image_size"] == "match"
    assert inputs["audio_vae"] == ["audio_vae", 0]
    # No first or last frame: a reference is cited, not started on.
    assert "first_frame" not in inputs
    assert graph["reference1"] == {"class_type": "LoadImage", "inputs": {"image": "b.png"}}
    assert not any(key.startswith("keyframe") for key in graph)


def test_ref2v_shares_everything_downstream_of_the_conditioning() -> None:
    fl2v = build(ref_models(), sampling(keyframes=["a.png"]), "x")
    ref2v = build(ref_models(), sampling(mode="ref2v", keyframes=["a.png"]), "x")

    for node in ("lora", "shift", "guider", "sampler_select", "sigmas", "sampler", "decode_audio", "save"):
        assert fl2v[node] == ref2v[node]
    # fl2v still loads fl2va even when a ref2va checkpoint is configured.
    assert fl2v["unet"]["inputs"]["unet_name"] == "minimax_h3_fl2va_int8_convrot.safetensors"


def test_ref2v_without_its_checkpoint_is_refused() -> None:
    with pytest.raises(ValueError, match="ref2va checkpoint"):
        build(models(), sampling(mode="ref2v", keyframes=["a.png"]), "x")


def test_ref2v_takes_nine_references_and_no_more() -> None:
    build(ref_models(), sampling(mode="ref2v", keyframes=[f"{i}.png" for i in range(9)]), "x")
    with pytest.raises(ValueError, match="at most 9 reference images"):
        build(ref_models(), sampling(mode="ref2v", keyframes=[f"{i}.png" for i in range(10)]), "x")


def test_an_unknown_mode_is_refused() -> None:
    with pytest.raises(ValueError, match="mode must be one of"):
        build(models(), sampling(mode="t2v"), "x")
