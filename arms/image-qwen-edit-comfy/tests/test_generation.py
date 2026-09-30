"""Parsing a job, which is the arm's whole security boundary.

The job body arrives over HTTP from another process. Every path in it is a path
someone chose, and every number in it reaches a sampler.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from arm_qwen_comfy.generation import JobError, parse_job, paths_for, seeds_for


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    out_dir = tmp_path / "outputs"
    in_dir = tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    return out_dir, in_dir


def parse(body: dict, roots: tuple[Path, Path]):
    return parse_job({"prompt": "a cat", "outPath": "a.png", **body}, *roots)


def test_the_defaults_are_the_blueprint_s(roots: tuple[Path, Path]) -> None:
    job = parse({}, roots)

    # Unlike the sd.cpp arm there is no "let the model decide": ComfyUI's
    # KSampler has no such value, so an unset sampler falls back to what
    # ComfyUI's own Qwen 2511 blueprint ships with.
    assert (job.sampler, job.scheduler, job.shift) == ("euler", "simple", 3.1)
    assert (job.width, job.height, job.steps, job.batch) == (1024, 1024, 20, 1)


def test_an_output_path_may_not_leave_the_output_root(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="resolves outside"):
        parse({"outPath": "../escape.png"}, roots)


def test_an_absolute_output_path_is_refused(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="must be relative"):
        parse({"outPath": "C:/windows/a.png"}, roots)


def test_only_png_is_written(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match=r"must end in \.png"):
        parse({"outPath": "a.jpg"}, roots)


def test_edges_land_on_the_model_s_own_grid(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="multiple of 16"):
        parse({"width": 1000}, roots)


def test_a_reference_is_named_relative_to_comfy_s_input_directory(roots: tuple[Path, Path]) -> None:
    _, in_dir = roots
    (in_dir / "nested").mkdir()
    (in_dir / "nested" / "ref.png").write_bytes(b"\x89PNG")

    job = parse({"refImages": ["nested/ref.png"]}, roots)

    # Forward-slashed whatever this platform uses: that is how LoadImage names
    # a file in a subfolder of its input directory.
    assert job.references == ["nested/ref.png"]


def test_a_reference_outside_the_input_root_is_refused(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="resolves outside"):
        parse({"refImages": ["../outputs/a.png"]}, roots)


def test_a_reference_that_is_not_there_is_refused(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="is not there"):
        parse({"refImages": ["missing.png"]}, roots)


def test_a_fourth_reference_says_why(roots: tuple[Path, Path]) -> None:
    _, in_dir = roots
    for name in ("a.png", "b.png", "c.png", "d.png"):
        (in_dir / name).write_bytes(b"\x89PNG")

    with pytest.raises(JobError, match="image1 through image3"):
        parse({"refImages": ["a.png", "b.png", "c.png", "d.png"]}, roots)


def test_a_requested_seed_walks_upwards_through_the_batch(roots: tuple[Path, Path]) -> None:
    job = parse({"seed": 100, "batch": 3}, roots)

    assert seeds_for(job) == [100, 101, 102]


def test_an_unset_seed_is_drawn_once_per_image(roots: tuple[Path, Path]) -> None:
    job = parse({"seed": -1, "batch": 4}, roots)

    seeds = seeds_for(job)
    assert len(seeds) == 4
    # Four random images sharing one seed would be four copies of one image.
    assert len(set(seeds)) == 4
    assert all(seed >= 0 for seed in seeds)


def test_a_batch_of_one_keeps_the_name_the_caller_planned(roots: tuple[Path, Path]) -> None:
    out_dir, _ = roots
    job = parse({"outPath": "day/a.png"}, roots)

    assert paths_for(job) == [out_dir / "day" / "a.png"]


def test_a_batch_suffixes_everything_after_the_first(roots: tuple[Path, Path]) -> None:
    out_dir, _ = roots
    job = parse({"outPath": "day/a.png", "batch": 3}, roots)

    assert paths_for(job) == [
        out_dir / "day" / "a.png",
        out_dir / "day" / "a-2.png",
        out_dir / "day" / "a-3.png",
    ]


def test_a_sampler_name_that_is_not_one_is_refused(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="not a sampler or scheduler name"):
        parse({"sampler": "euler; rm -rf /"}, roots)


def test_an_empty_sampler_falls_back_rather_than_reaching_the_child(roots: tuple[Path, Path]) -> None:
    job = parse({"sampler": "", "scheduler": ""}, roots)

    assert (job.sampler, job.scheduler) == ("euler", "simple")
