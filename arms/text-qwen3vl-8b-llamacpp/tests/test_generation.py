"""Job validation: what a caller may ask for, and what it gets by default."""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from arm_qwen3vl.generation import MAX_IMAGES, JobError, Sampling, _request, parse_job

CTX = 16384


@pytest.fixture
def inputs(tmp_path: Path) -> Path:
    root = tmp_path / "inputs"
    (root / "refs").mkdir(parents=True)
    (root / "refs" / "a.png").write_bytes(b"\x89PNG fake")
    (root / "refs" / "b.jpg").write_bytes(b"\xff\xd8 fake")
    (root / "notes.txt").write_text("not an image", encoding="utf-8")
    (tmp_path / "outside.png").write_bytes(b"\x89PNG")
    return root


def test_a_prompt_becomes_the_last_user_message(inputs: Path) -> None:
    job = parse_job({"prompt": "  hello  "}, CTX, inputs)
    assert job.messages == [{"role": "user", "content": "hello"}]
    assert job.prompt == "hello"
    # The Instruct model does not think; asking it to is a caller's choice.
    assert job.thinking is False
    assert job.max_tokens == 8192
    assert job.seed == -1
    assert job.images == []


def test_system_and_history_come_before_the_prompt(inputs: Path) -> None:
    job = parse_job(
        {
            "system": "Be brief.",
            "messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
            "prompt": "how are you",
        },
        CTX,
        inputs,
    )
    assert [turn["role"] for turn in job.messages] == ["system", "user", "assistant", "user"]
    assert job.messages[-1]["content"] == "how are you"


def test_images_ride_with_the_last_user_turn_in_order(inputs: Path) -> None:
    job = parse_job(
        {"system": "s", "prompt": "describe", "images": ["refs/a.png", "refs/b.jpg"]}, CTX, inputs
    )

    content = job.messages[-1]["content"]
    assert [part["type"] for part in content] == ["image_url", "image_url", "text"]
    first = content[0]["image_url"]["url"]
    assert first.startswith("data:image/png;base64,")
    assert base64.b64decode(first.split(",", 1)[1]) == b"\x89PNG fake"
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert content[2] == {"type": "text", "text": "describe"}

    # The record keeps the words and the names, not the bytes.
    assert job.prompt == "describe"
    assert job.images == ["refs/a.png", "refs/b.jpg"]
    # The system turn is untouched.
    assert job.messages[0] == {"role": "system", "content": "s"}


@pytest.mark.parametrize(
    ("images", "message"),
    [
        ("refs/a.png", "images must be a list"),
        (["../outside.png"], "resolves outside"),
        (["C:/Windows/win.ini"], "relative to the arm's input directory"),
        (["refs/missing.png"], "is not there"),
        (["notes.txt"], "not an image this arm reads"),
        ([5], "must be a path"),
        (["refs/a.png"] * (MAX_IMAGES + 1), f"at most {MAX_IMAGES} images"),
    ],
)
def test_bad_images_are_refused_by_name(inputs: Path, images: object, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job({"prompt": "x", "images": images}, CTX, inputs)


def test_history_alone_is_enough_when_it_ends_with_the_user(inputs: Path) -> None:
    job = parse_job({"messages": [{"role": "user", "content": "hi"}]}, CTX, inputs)
    assert job.prompt == "hi"


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"prompt": "   "},
        {"system": "only a system message"},
        {"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]},
    ],
)
def test_a_job_with_nothing_to_answer_is_refused(inputs: Path, body: dict) -> None:
    with pytest.raises(JobError, match=r"prompt is required|last message"):
        parse_job(body, CTX, inputs)


def test_sampling_defaults_are_the_vision_language_ones(inputs: Path) -> None:
    assert parse_job({"prompt": "x"}, CTX, inputs).sampling == Sampling(0.7, 0.8, 20, 0.0, 1.5, 1.0)
    # And any of them may still be set.
    assert parse_job({"prompt": "x", "temperature": 0.2, "topK": 5}, CTX, inputs).sampling == Sampling(
        0.2, 0.8, 5, 0.0, 1.5, 1.0
    )


def test_max_tokens_is_capped_by_the_loaded_context(inputs: Path) -> None:
    assert parse_job({"prompt": "x", "maxTokens": 4096}, 4096, inputs).max_tokens == 4096
    with pytest.raises(JobError, match="maxTokens"):
        parse_job({"prompt": "x", "maxTokens": 4097}, 4096, inputs)


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"prompt": "x", "temperature": "hot"}, "temperature must be a number"),
        ({"prompt": "x", "temperature": 3}, "temperature must be between"),
        ({"prompt": "x", "thinking": "yes"}, "thinking must be true or false"),
        ({"prompt": "x", "messages": "hi"}, "messages must be a list"),
        ({"prompt": "x", "messages": [{"role": "tool", "content": "?"}]}, "role must be one of"),
        ({"prompt": "x\x00"}, "null byte"),
        ({"prompt": 5}, "prompt must be a string"),
    ],
)
def test_bad_values_are_named(inputs: Path, body: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job(body, CTX, inputs)


def test_the_request_the_child_sees(inputs: Path) -> None:
    job = parse_job({"prompt": "x", "reasoningBudget": 100, "seed": 7}, CTX, inputs)
    request = _request(job)
    assert request["stream"] is True
    assert request["timings_per_token"] is True
    assert request["chat_template_kwargs"] == {"enable_thinking": False}
    assert request["reasoning_budget"] == 100
    assert request["seed"] == 7
    assert request["temperature"] == 0.7

    # Unrestricted thinking is the child's default and is left unsaid.
    assert "reasoning_budget" not in _request(parse_job({"prompt": "x"}, CTX, inputs))
