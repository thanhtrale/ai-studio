"""Reading ComfyUI's console output.

The lines here are the real thing, copied from the sources that print them:
`comfy/model_management.py`, `comfy/model_patcher.py`, `main.py` and tqdm.
"""

from __future__ import annotations

from arm_trellis2.logscan import model_label, parse_line, split_stream


def test_a_load_request_names_the_model() -> None:
    event = parse_line("Requested to load QwenImageTEModel_")

    assert event is not None
    assert (event.kind, event.name) == ("phase", "QwenImageTEModel_")


def test_comfy_s_own_colour_and_level_tag_are_stripped() -> None:
    # What ComfyUI actually prints: a green "[INFO]" wrapped in ANSI escapes.
    # Every pattern in this module is anchored at the start of the message, so
    # leaving the prefix on means matching nothing at all.
    event = parse_line("\x1b[32m[INFO]\x1b[0m Requested to load QwenImage")

    assert event is not None
    assert (event.kind, event.name) == ("phase", "QwenImage")


def test_a_tagged_error_is_an_error() -> None:
    event = parse_line("\x1b[31m[ERROR]\x1b[0m Allocation on device")

    assert event is not None
    assert (event.kind, event.text) == ("error", "Allocation on device")


def test_a_model_class_becomes_a_label() -> None:
    assert model_label("DINOv3ViTModel") == "Load image encoder"
    assert model_label("BiRefNet") == "Load background remover"
    assert model_label("TextureVae") == "Load texture VAE"
    assert model_label("ShapeVae") == "Load shape VAE"
    # Anything unrecognised is the transformer: it is the one model every job
    # loads, and a wrong label is cheaper than no step at all.
    assert model_label("Trellis2") == "Load transformer"


def test_a_full_load_reports_how_much_landed() -> None:
    event = parse_line("loaded completely; 9001.00 MB loaded, full load: True")

    assert event is not None
    assert (event.kind, event.name, event.total) == ("loaded", "completely", 9001)


def test_a_partial_load_is_told_apart_from_a_full_one() -> None:
    line = (
        "loaded partially; 8000.00 MB loaded, 3000.00 MB offloaded, "
        "0.00 MB buffer reserved, lowvram patches: 0"
    )
    event = parse_line(line)

    assert event is not None
    assert (event.kind, event.name, event.total) == ("loaded", "partially", 8000)


def test_a_dynamic_vram_load_names_the_model_it_finished() -> None:
    # What this build actually prints: DynamicVRAM is on by default and never
    # reaches the "loaded completely" line. Unlike that line it names the
    # model, which is what lets a completion close its own step rather than
    # whichever one happens to be next in the queue.
    event = parse_line(
        "[INFO] Model QwenImage prepared for dynamic VRAM loading. "
        "9123MB Staged. 0 patches attached. Force pre-loaded 60 weights: 61 KB."
    )

    assert event is not None
    assert (event.kind, event.name, event.total) == ("staged", "QwenImage", 9123)


def test_the_sampler_bar_carries_the_count_and_the_rate() -> None:
    event = parse_line(" 45%|####5     | 18/40 [00:12<00:14,  1.52it/s]")

    assert event is not None
    assert (event.kind, event.index, event.total, event.rate) == ("progress", 18, 40, "1.52it/s")


def test_a_bar_with_a_postfix_still_reads() -> None:
    # ComfyUI hangs a status message off the bar while weights are moving.
    event = parse_line("25%|##5       | 1/4 [00:01<00:03,  1.15s/it,  Model Initialization complete!  ]")

    assert event is not None
    assert (event.index, event.total, event.rate) == (1, 4, "1.15s/it")


def test_a_bar_with_no_rate_yet_is_not_progress() -> None:
    # The first redraw has "?it/s" and no elapsed time to report.
    assert parse_line("0%|          | 0/4 [00:00<?, ?it/s]").kind != "progress"


def test_a_slow_bar_reports_seconds_per_step() -> None:
    event = parse_line("100%|##########| 40/40 [01:20<00:00,  2.01s/it]")

    assert event is not None
    assert (event.index, event.total, event.rate) == (40, 40, "2.01s/it")


def test_a_finished_prompt_carries_its_own_total() -> None:
    event = parse_line("Prompt executed in 42.37 seconds")

    assert event is not None
    assert (event.kind, event.seconds) == ("executed", 42.37)


def test_a_traceback_is_an_error() -> None:
    assert parse_line("!!! Exception during processing !!! out of memory").kind == "error"
    assert parse_line("Traceback (most recent call last):").kind == "error"


def test_anything_else_survives_as_detail() -> None:
    event = parse_line("Using pytorch attention")

    assert event is not None
    assert (event.kind, event.text) == ("info", "Using pytorch attention")


def test_an_empty_line_is_nothing() -> None:
    assert parse_line("   ") is None


def test_the_bar_is_split_on_its_carriage_returns() -> None:
    # tqdm redraws in place, so a reader that only split on newlines would see
    # one enormous line the moment sampling finished.
    lines, rest = split_stream("\r 1/4 [a]\r 2/4 [b]\r 3/4 [c")

    assert lines == ["", " 1/4 [a]", " 2/4 [b]"]
    assert rest == " 3/4 [c"
