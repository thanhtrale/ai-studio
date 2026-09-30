"""Parsing a job, and reading what the rewriter answers.

The job body arrives over HTTP from another process. Every path in it is a
path someone chose, and every number in it reaches a sampler.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from arm_qwen21.generation import (
    JobError,
    parse_job,
    parse_rewrite,
    paths_for,
    rewrite_request,
    seeds_for,
    system_prompt_for,
)


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    out_dir = tmp_path / "outputs"
    in_dir = tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    return out_dir, in_dir


def parse(body: dict, roots: tuple[Path, Path]):
    return parse_job({"prompt": "a paper crane", "outPath": "a.png", **body}, *roots)


def test_the_defaults_are_the_lora_s(roots: tuple[Path, Path]) -> None:
    job = parse({}, roots)

    assert (job.steps, job.sampler, job.batch) == (6, "euler", 1)
    assert (job.width, job.height) == (1024, 1024)
    assert job.enhance_prompt is False


def test_guidance_and_scheduler_are_accepted_and_ignored(roots: tuple[Path, Path]) -> None:
    # A console that switches between this arm and the edit arm sends one
    # request shape. Refusing the fields this arm cannot use would make that
    # console's job harder for no gain -- the graph simply has nowhere to put
    # guidance, a scheduler or a flow shift.
    job = parse({"cfgScale": 4.0, "scheduler": "beta", "flowShift": 3.1}, roots)

    assert job.steps == 6


def test_an_output_path_may_not_leave_the_output_root(roots: tuple[Path, Path]) -> None:
    with pytest.raises(JobError, match="resolves outside"):
        parse({"outPath": "../escape.png"}, roots)


def test_edges_land_on_the_latent_s_own_grid(roots: tuple[Path, Path]) -> None:
    # 2.1's latent is a sixteenth scale with a further factor of two in the
    # VAE, so 16 is not enough here even though it was for the edit arm.
    with pytest.raises(JobError, match="multiple of 32"):
        parse({"width": 1024 + 16}, roots)

    assert parse({"width": 1376, "height": 768}, roots).width == 1376


def test_a_reference_is_named_relative_to_comfy_s_input_directory(roots: tuple[Path, Path]) -> None:
    _, in_dir = roots
    (in_dir / "nested").mkdir()
    (in_dir / "nested" / "ref.png").write_bytes(b"\x89PNG")

    assert parse({"refImages": ["nested/ref.png"]}, roots).references == ["nested/ref.png"]


def test_a_fourth_reference_says_why(roots: tuple[Path, Path]) -> None:
    _, in_dir = roots
    for name in ("a.png", "b.png", "c.png", "d.png"):
        (in_dir / name).write_bytes(b"\x89PNG")

    with pytest.raises(JobError, match="no more than three"):
        parse({"refImages": ["a.png", "b.png", "c.png", "d.png"]}, roots)


def test_a_requested_seed_walks_upwards_through_the_batch(roots: tuple[Path, Path]) -> None:
    assert seeds_for(parse({"seed": 100, "batch": 3}, roots)) == [100, 101, 102]


def test_an_unset_seed_is_drawn_once_per_image(roots: tuple[Path, Path]) -> None:
    seeds = seeds_for(parse({"seed": -1, "batch": 4}, roots))

    assert len(set(seeds)) == 4


def test_a_batch_suffixes_everything_after_the_first(roots: tuple[Path, Path]) -> None:
    out_dir, _ = roots
    job = parse({"outPath": "day/a.png", "batch": 3}, roots)

    assert paths_for(job) == [
        out_dir / "day" / "a.png",
        out_dir / "day" / "a-2.png",
        out_dir / "day" / "a-3.png",
    ]


def test_the_rewriter_is_told_the_frame_for_text_to_image(roots: tuple[Path, Path]) -> None:
    job = parse({"width": 1376, "height": 768}, roots)

    # It is expected to answer with a ratio, so it is told the one it is
    # writing for rather than left to pick its own.
    assert rewrite_request(job) == "a paper crane\nAspect ratio: 1376:768"


def test_the_edit_rewriter_is_asked_for_english(roots: tuple[Path, Path]) -> None:
    _, in_dir = roots
    (in_dir / "ref.png").write_bytes(b"\x89PNG")
    job = parse({"refImages": ["ref.png"]}, roots)

    assert rewrite_request(job).endswith("(Write the description in English.)")


def test_the_system_prompt_follows_whether_there_are_references(roots: tuple[Path, Path]) -> None:
    _, in_dir = roots
    (in_dir / "ref.png").write_bytes(b"\x89PNG")

    assert "Image Prompt Rewriting Expert" in system_prompt_for(parse({}, roots))
    assert "Edit Prompt Enhancer" in system_prompt_for(parse({"refImages": ["ref.png"]}, roots))


def test_a_rewrite_is_read_out_of_the_json_it_was_asked_for() -> None:
    answer = '{"wh_ratio": "3:2", "rewritten_prompt": "A wide photograph of a paper crane."}'

    assert parse_rewrite(answer) == "A wide photograph of a paper crane."


def test_a_fenced_rewrite_still_reads() -> None:
    answer = '```json\n{"rewritten_prompt": "A crane."}\n```'

    assert parse_rewrite(answer) == "A crane."


def test_a_rewrite_that_is_not_json_is_taken_as_the_prompt_itself() -> None:
    assert parse_rewrite("A wide photograph of a paper crane.") == "A wide photograph of a paper crane."


def test_nothing_usable_is_nothing() -> None:
    # None, not an exception: a rewrite is an improvement, and losing it is no
    # reason to fail a job that already has a perfectly good prompt.
    assert parse_rewrite("") is None
    assert parse_rewrite("   ") is None
    assert parse_rewrite('{"wh_ratio": "3:2"}') is None
    assert parse_rewrite('{"rewritten_prompt": ""}') is None
