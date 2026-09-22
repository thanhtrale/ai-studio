"""Job validation: what a caller may ask for, and what it gets by default."""

from __future__ import annotations

import pytest

from arm_qwen_text.generation import JobError, Sampling, _request, parse_job

CTX = 65536


def test_a_prompt_becomes_the_last_user_message() -> None:
    job = parse_job({"prompt": "  hello  "}, CTX)
    assert job.messages == [{"role": "user", "content": "hello"}]
    assert job.prompt == "hello"
    assert job.thinking is True
    assert job.max_tokens == 8192
    assert job.seed == -1


def test_system_and_history_come_before_the_prompt() -> None:
    job = parse_job(
        {
            "system": "Be brief.",
            "messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
            "prompt": "how are you",
        },
        CTX,
    )
    assert [turn["role"] for turn in job.messages] == ["system", "user", "assistant", "user"]
    assert job.messages[-1]["content"] == "how are you"


def test_history_alone_is_enough_when_it_ends_with_the_user() -> None:
    job = parse_job({"messages": [{"role": "user", "content": "hi"}]}, CTX)
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
def test_a_job_with_nothing_to_answer_is_refused(body: dict) -> None:
    with pytest.raises(JobError, match=r"prompt is required|last message"):
        parse_job(body, CTX)


def test_sampling_defaults_follow_the_thinking_switch() -> None:
    # The model card gives one set of numbers for thinking and another for
    # instruct mode; silence picks the right set rather than one for both.
    assert parse_job({"prompt": "x"}, CTX).sampling == Sampling(1.0, 0.95, 20, 0.0, 1.5, 1.0)
    assert parse_job({"prompt": "x", "thinking": False}, CTX).sampling == Sampling(
        0.7, 0.8, 20, 0.0, 1.5, 1.0
    )
    # And any of them may still be set.
    assert parse_job({"prompt": "x", "temperature": 0.2, "topK": 5}, CTX).sampling == Sampling(
        0.2, 0.95, 5, 0.0, 1.5, 1.0
    )


def test_max_tokens_is_capped_by_the_loaded_context() -> None:
    assert parse_job({"prompt": "x", "maxTokens": 4096}, 4096).max_tokens == 4096
    with pytest.raises(JobError, match="maxTokens"):
        parse_job({"prompt": "x", "maxTokens": 4097}, 4096)


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
def test_bad_values_are_named(body: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job(body, CTX)


def test_the_request_the_child_sees() -> None:
    job = parse_job({"prompt": "x", "thinking": False, "reasoningBudget": 100, "seed": 7}, CTX)
    request = _request(job)
    assert request["stream"] is True
    assert request["timings_per_token"] is True
    assert request["chat_template_kwargs"] == {"enable_thinking": False}
    assert request["reasoning_budget"] == 100
    assert request["seed"] == 7
    assert request["temperature"] == 0.7

    # Unrestricted thinking is the child's default and is left unsaid.
    assert "reasoning_budget" not in _request(parse_job({"prompt": "x"}, CTX))
