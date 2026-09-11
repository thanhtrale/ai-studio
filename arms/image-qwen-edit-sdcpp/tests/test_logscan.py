"""The log parser, against lines stable-diffusion.cpp actually prints.

Worth testing precisely because the input is not an interface anyone promised:
if a build renames a phase the timeline should lose a label, never a job. Every
case here also asserts what happens to a line the parser does not recognise.
"""

from __future__ import annotations

from arm_qwen_edit.logscan import parse_line, phase_label, split_stream


def test_tagged_info_line_keeps_only_the_message() -> None:
    event = parse_line("[INFO ] stable-diffusion.cpp:1842 - running in Flow matching mode")
    assert event is not None
    assert event.kind == "info"
    assert event.text == "running in Flow matching mode"


def test_completed_line_carries_the_phase_and_its_seconds() -> None:
    event = parse_line("[INFO ] stable-diffusion.cpp:1490 - get_learned_condition completed, taking 1234 ms")
    assert event is not None
    # Milliseconds are not the phrasing this matches; it stays an info line
    # rather than being read as a phase with a wrong duration.
    assert event.kind == "info"

    event = parse_line("[INFO ] stable-diffusion.cpp:1490 - get_learned_condition completed, taking 1.23s")
    assert event is not None
    assert event.kind == "done"
    assert event.name == "get_learned_condition"
    assert event.seconds == 1.23
    assert phase_label(event.name) == "Encode prompt"


def test_generating_image_is_read_before_the_progress_bar_pattern() -> None:
    # "2/4" here is an image index, not a step count. Read as a step count it
    # would drive the denoise meter backwards on every image of a batch.
    event = parse_line("[INFO ] stable-diffusion.cpp:1701 - generating image: 2/4 - seed 1118877715456453")
    assert event is not None
    assert event.kind == "image"
    assert (event.index, event.total) == (2, 4)
    assert event.seed == 1118877715456453


def test_generating_image_without_a_seed() -> None:
    event = parse_line("[INFO ] stable-diffusion.cpp:1701 - generating image: 1/1")
    assert event is not None
    assert event.kind == "image"
    assert event.seed is None


def test_progress_bar_gives_step_and_rate() -> None:
    event = parse_line("  |==============>                   | 3/8 - 1.23s/it")
    assert event is not None
    assert event.kind == "progress"
    assert (event.index, event.total) == (3, 8)
    assert event.rate == "1.23s/it"


def test_progress_bar_in_iterations_per_second() -> None:
    event = parse_line("|====| 8/8 - 2.50it/s")
    assert event is not None
    assert event.kind == "progress"
    assert event.rate == "2.50it/s"


def test_error_lines_are_separated_from_everything_else() -> None:
    event = parse_line("[ERROR] model.cpp:900 - failed to load model from 'nope.gguf'")
    assert event is not None
    assert event.kind == "error"
    assert "failed to load model" in event.text


def test_loading_line_opens_the_load_phase() -> None:
    event = parse_line("[INFO ] model.cpp:120 - loading model from 'qwen-image-edit-2511-Q4_K_M.gguf'")
    assert event is not None
    assert event.kind == "phase"
    assert event.name == "load"


def test_blank_and_padding_lines_produce_nothing() -> None:
    assert parse_line("") is None
    assert parse_line("   \x00 ") is None


def test_unknown_phase_has_no_label_rather_than_a_wrong_one() -> None:
    assert phase_label("some_future_stage") is None


def test_split_stream_breaks_on_carriage_returns_too() -> None:
    # The progress bar redraws with \r. A reader splitting only on \n would see
    # one line the length of the whole run, arriving when the run ended.
    lines, rest = split_stream("a\rb\nc")
    assert lines == ["a", "b"]
    assert rest == "c"


def test_split_stream_keeps_a_partial_line_for_the_next_chunk() -> None:
    lines, rest = split_stream("|==> | 1/8 -")
    assert lines == []
    assert rest == "|==> | 1/8 -"
