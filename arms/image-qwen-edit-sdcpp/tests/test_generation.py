"""Job validation, which is this arm's security boundary.

The job payload arrives over HTTP from another process, and two of its fields
are filesystem paths. Everything here is about what happens when those paths
are not what they should be.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from arm_qwen_edit.generation import Job, JobError, _paths_for, parse_job, request_body


def roots(tmp_path: Path) -> tuple[Path, Path]:
    out_dir = tmp_path / "outputs"
    in_dir = tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    return out_dir, in_dir


def test_a_minimal_job_takes_the_defaults(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    job = parse_job({"prompt": " a cat ", "outPath": "2026-09-11/a.png"}, out_dir, in_dir)

    assert job.prompt == "a cat"
    assert job.out_path == (out_dir / "2026-09-11" / "a.png").resolve()
    assert (job.width, job.height, job.batch, job.seed) == (1024, 1024, 1, -1)


def test_prompt_is_required(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    with pytest.raises(JobError, match="prompt is required"):
        parse_job({"outPath": "a.png"}, out_dir, in_dir)
    with pytest.raises(JobError, match="prompt is required"):
        parse_job({"prompt": "   ", "outPath": "a.png"}, out_dir, in_dir)


@pytest.mark.parametrize(
    "escape",
    ["../a.png", "../../storage/a.png", "sub/../../a.png", "C:/windows/a.png", "/etc/a.png"],
)
def test_output_paths_that_leave_the_root_are_refused(tmp_path: Path, escape: str) -> None:
    out_dir, in_dir = roots(tmp_path)
    with pytest.raises(JobError):
        parse_job({"prompt": "a", "outPath": escape}, out_dir, in_dir)


def test_output_must_be_a_png(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    with pytest.raises(JobError, match=r"must end in \.png"):
        parse_job({"prompt": "a", "outPath": "a.exe"}, out_dir, in_dir)


def test_a_reference_must_exist_inside_the_input_root(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    (in_dir / "ref.png").write_bytes(b"\x89PNG")

    job = parse_job(
        {"prompt": "a", "outPath": "a.png", "refImages": ["ref.png"]}, out_dir, in_dir
    )
    assert job.references == [(in_dir / "ref.png").resolve()]

    with pytest.raises(JobError, match="is not there"):
        parse_job({"prompt": "a", "outPath": "a.png", "refImages": ["missing.png"]}, out_dir, in_dir)

    with pytest.raises(JobError):
        parse_job({"prompt": "a", "outPath": "a.png", "refImages": ["../outputs/x.png"]}, out_dir, in_dir)


def test_sizes_must_be_whole_blocks(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    with pytest.raises(JobError, match="multiple of 16"):
        parse_job({"prompt": "a", "outPath": "a.png", "width": 1020}, out_dir, in_dir)


def test_numeric_bounds_are_enforced(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    # batch 9 is over the child's own max_batch_count of 8.
    for field, value in [("steps", 0), ("steps", 500), ("batch", 0), ("batch", 9), ("cfgScale", 99)]:
        with pytest.raises(JobError, match=field):
            parse_job({"prompt": "a", "outPath": "a.png", field: value}, out_dir, in_dir)


def test_an_unset_sampler_or_scheduler_is_left_to_the_model(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    job = parse_job({"prompt": "a", "outPath": "a.png"}, out_dir, in_dir)

    assert (job.sampler, job.scheduler, job.flow_shift) == (None, None, None)
    params = request_body(job)["sample_params"]
    # Absent, not null: upstream documents both as model-specific defaults, and
    # a null is a value the child would have to interpret.
    assert "sample_method" not in params
    assert "scheduler" not in params
    assert "flow_shift" not in params
    assert params["sample_steps"] == 20


def test_a_sampler_name_is_a_name(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    with pytest.raises(JobError, match="sampler"):
        parse_job({"prompt": "a", "outPath": "a.png", "sampler": "euler a; rm -rf"}, out_dir, in_dir)


def test_several_references_are_numbered(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    for name in ("a.png", "b.png"):
        (in_dir / name).write_bytes(b"\x89PNG" + name.encode())

    one = parse_job({"prompt": "p", "outPath": "o.png", "refImages": ["a.png"]}, out_dir, in_dir)
    # One reference has nothing to number, so the flag would only be noise.
    assert "increase_ref_index" not in request_body(one)

    two = parse_job(
        {"prompt": "p", "outPath": "o.png", "refImages": ["a.png", "b.png"]}, out_dir, in_dir
    )
    body = request_body(two)
    assert body["increase_ref_index"] is True
    assert len(body["ref_images"]) == 2
    # Order is the input's: a prompt referring to "image 2" means the second
    # one the console listed.
    assert body["ref_images"][0] != body["ref_images"][1]


def test_batch_names_keep_the_first_image_unsuffixed() -> None:
    job = Job(
        prompt="a",
        negative_prompt="",
        out_path=Path("/out/2026-09-11/120000-abcd.png"),
        width=1024,
        height=1024,
        steps=4,
        cfg_scale=1.0,
        sampler="euler",
        scheduler="discrete",
        flow_shift=3.0,
        seed=-1,
        batch=3,
        strength=0.75,
    )
    names = [path.name for path in _paths_for(job)]
    # The single-image case has to be indistinguishable from a batch of one, or
    # the library record the caller planned would point at nothing.
    assert names == ["120000-abcd.png", "120000-abcd-2.png", "120000-abcd-3.png"]

    job.batch = 1
    assert [path.name for path in _paths_for(job)] == ["120000-abcd.png"]


def test_request_body_speaks_the_child_dialect(tmp_path: Path) -> None:
    out_dir, in_dir = roots(tmp_path)
    (in_dir / "ref.png").write_bytes(b"hello")

    job = parse_job(
        {
            "prompt": "a cat",
            "outPath": "a.png",
            "width": 1024,
            "height": 1360,
            "steps": 4,
            "cfgScale": 1,
            "batch": 3,
            "seed": 7,
            "refImages": ["ref.png"],
        },
        out_dir,
        in_dir,
    )
    body = request_body(job)

    assert body["batch_count"] == 3
    assert body["sample_params"]["sample_steps"] == 4
    assert body["sample_params"]["guidance"]["txt_cfg"] == 1.0
    # Images go inline rather than as paths: the child is never told a
    # filesystem location this arm has not already read from itself.
    assert body["ref_images"] == ["aGVsbG8="]
