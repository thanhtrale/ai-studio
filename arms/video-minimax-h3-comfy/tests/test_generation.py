"""Parsing a job.

The job body arrives over HTTP from another process. Every path in it is a
path someone chose, and every number in it reaches a sampler that will hold the
card for minutes.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from arm_h3.generation import JobError, parse_job, paths_for, seeds_for


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    out_dir = tmp_path / "outputs"
    in_dir = tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    return out_dir, in_dir


def parse(body: dict, roots: tuple[Path, Path]):
    return parse_job({"prompt": "a lone crane", "outPath": "a.mp4", **body}, *roots)


def test_the_defaults_are_the_model_s_native_canvas(roots: tuple[Path, Path]) -> None:
    job = parse({}, roots)

    assert job.mode == "fl2v"
    assert job.ref_image_size == "match"
    assert (job.width, job.height) == (1344, 768)
    assert (job.num_frames, job.steps, job.batch) == (124, 6, 1)
    assert job.scheduler == "simple"
    assert (job.shift_video, job.shift_audio) == (12.0, 3.0)


def test_guidance_and_sampler_are_accepted_and_ignored(roots: tuple[Path, Path]) -> None:
    # One console drives both the image arms and this one. Refusing the fields
    # this arm cannot use would make that console's job harder for no gain --
    # the graph has nowhere to put guidance, and the turbo node supplies the
    # only sampler that steps the audio correctly.
    job = parse({"cfgScale": 4.0, "sampler": "dpmpp_2m", "frameRate": 30}, roots)

    assert job.steps == 6


def test_an_output_path_may_not_leave_the_output_root(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="resolves outside"):
        parse({"outPath": "../escape.mp4"}, roots)


def test_an_output_path_has_to_be_a_container_this_arm_writes(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match=r"must end in \.mp4"):
        parse({"outPath": "a.webm"}, roots)


def test_edges_land_on_the_vae_s_grid(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="multiple of 32"):
        parse({"width": 1344 + 16}, roots)

    assert parse({"width": 768, "height": 1344}, roots).width == 768


def test_a_frame_count_off_the_grid_is_rounded_rather_than_refused(
    roots: tuple[Path, Path],
) -> None:
    # The grid is the model's, the console already rounds to it, and a caller
    # that did not should get a clip rather than a 400. 107 rather than 124:
    # rounding goes up to the next length that exists, not to the nearest
    # round-looking one.
    assert parse({"numFrames": 100}, roots).num_frames == 107


def test_a_clip_longer_than_the_model_was_trained_for_is_refused(
    roots: tuple[Path, Path],
) -> None:
    with pytest.raises(JobError, match="numFrames must be between"):
        parse({"numFrames": 500}, roots)


def test_a_keyframe_is_named_relative_to_comfy_s_input_directory(
    roots: tuple[Path, Path],
) -> None:
    _, in_dir = roots
    (in_dir / "nested").mkdir()
    (in_dir / "nested" / "first.png").write_bytes(b"\x89PNG")

    assert parse({"refImages": ["nested/first.png"]}, roots).keyframes == ["nested/first.png"]


def test_the_single_image_spelling_still_works(roots: tuple[Path, Path]) -> None:
    # What the LTX arm's job schema calls a conditioning image. Kept so a
    # caller that only knows that one keeps working.
    _, in_dir = roots
    (in_dir / "first.png").write_bytes(b"\x89PNG")

    assert parse({"image": "first.png"}, roots).keyframes == ["first.png"]


def test_a_third_keyframe_says_why(roots: tuple[Path, Path]) -> None:
    _, in_dir = roots
    for name in ("a.png", "b.png", "c.png"):
        (in_dir / name).write_bytes(b"\x89PNG")

    with pytest.raises(JobError, match="first frame and a last frame"):
        parse({"refImages": ["a.png", "b.png", "c.png"]}, roots)


def test_a_requested_seed_walks_upwards_through_the_batch(roots: tuple[Path, Path]) -> None:
    assert seeds_for(parse({"seed": 100, "batch": 3}, roots)) == [100, 101, 102]


def test_an_unset_seed_is_drawn_once_per_clip(roots: tuple[Path, Path]) -> None:
    assert len(set(seeds_for(parse({"seed": -1, "batch": 4}, roots)))) == 4


def test_a_batch_suffixes_everything_after_the_first(roots: tuple[Path, Path]) -> None:
    out_dir, _ = roots
    job = parse({"outPath": "day/a.mp4", "batch": 3}, roots)

    assert paths_for(job) == [
        out_dir / "day" / "a.mp4",
        out_dir / "day" / "a-2.mp4",
        out_dir / "day" / "a-3.mp4",
    ]


def _images(roots: tuple[Path, Path], count: int) -> list[str]:
    names = [f"ref{index}.png" for index in range(count)]
    for name in names:
        (roots[1] / name).write_bytes(b"png")
    return names


def test_ref2v_takes_several_references_in_order(roots: tuple[Path, Path]) -> None:
    names = _images(roots, 4)
    job = parse({"mode": "ref2v", "refImages": names, "refImageSize": "max"}, roots)

    assert job.mode == "ref2v"
    assert job.keyframes == names
    assert job.ref_image_size == "max"


def test_three_images_in_fl2v_point_at_ref2v(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="several references are ref2v"):
        parse({"refImages": _images(roots, 3)}, roots)


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"mode": "ref2v"}, "at least one reference image"),
        ({"mode": "t2v"}, "mode must be one of"),
        ({"refImageSize": "huge"}, "refImageSize must be one of"),
    ],
)
def test_bad_modes_are_named(roots: tuple[Path, Path], body: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse(body, roots)


def test_ref2v_stops_at_nine(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="at most 9 reference images"):
        parse({"mode": "ref2v", "refImages": _images(roots, 10)}, roots)
