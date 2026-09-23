"""The log parser, line by line, against lines a real b10919 wrote."""

from __future__ import annotations

from arm_gemma_text.logscan import Buffer, Error, Fit, KvBuffer, Offload, PromptProgress, parse_line, placement


def test_offload_line() -> None:
    assert parse_line("0.05.384.105 I load_tensors: offloaded 41/41 layers to GPU") == Offload(41, 41)


def test_model_buffers_name_their_device() -> None:
    assert parse_line("0.05.384.108 I load_tensors:   CPU_Mapped model buffer size = 20797.72 MiB") == Buffer(
        "CPU_Mapped", 20797.72
    )
    assert parse_line("0.05.384.110 I load_tensors:        CUDA0 model buffer size = 12167.74 MiB") == Buffer(
        "CUDA0", 12167.74
    )


def test_kv_buffer() -> None:
    assert parse_line("0.22.451.473 I llama_kv_cache:      CUDA0 KV buffer size =  1280.00 MiB") == KvBuffer(
        1280.0
    )


def test_prompt_progress_derives_the_total_and_keeps_the_rate() -> None:
    event = parse_line(
        "1.08.595.063 I slot print_timing: id  0 | task 0 | prompt processing, n_tokens =   2048, "
        "progress = 0.29, t =  30.36 s / 67.47 tokens per second"
    )
    assert event == PromptProgress(2048, 7062, "67 tok/s")


def test_prompt_progress_at_the_end_never_exceeds_done() -> None:
    event = parse_line(
        "2.02.313.635 I slot print_timing: id  0 | task 0 | prompt processing, n_tokens =   7029, "
        "progress = 1.00, t =  84.07 s / 83.60 tokens per second"
    )
    assert event == PromptProgress(7029, 7029, "84 tok/s")


def test_fit_and_error_levels() -> None:
    assert parse_line("0.00.482.031 I common_params_fit_impl: projected to use 22305 MiB") == Fit(
        "projected to use 22305 MiB"
    )
    assert parse_line("0.01.000.000 E srv load_model: failed to load model") == Error(
        "srv load_model: failed to load model"
    )
    # Warnings are not errors, and neither is an info line that says "error".
    assert parse_line("0.04.944.056 W llama_model_loader: tensor overrides to CPU are used with mmap") is None
    assert parse_line("0.13.517.677 I srv  llama_server: model loaded") is None


def test_unrecognised_lines_are_ignored() -> None:
    assert parse_line("") is None
    assert parse_line("0.13.750.219 I slot launch_slot_: id  0 | task 78 | processing task") is None


def test_placement_reads_as_one_line() -> None:
    assert placement([Buffer("CPU_Mapped", 20797.72), Buffer("CUDA0", 12167.74)], Offload(41, 41)) == (
        "41/41 layers on GPU · CPU 20.3 GiB · CUDA0 11.9 GiB"
    )
    assert placement([], None) == ""
