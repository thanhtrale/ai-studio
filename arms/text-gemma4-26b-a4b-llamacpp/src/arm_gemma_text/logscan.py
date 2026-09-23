"""Reading `llama-server`'s log, for the two things its API will not say.

The API is complete about a completion -- token counts, timings, the finish
reason -- so unlike the image arm, this arm does not need the log to report a
job. What the log alone knows is *where the weights went* and *how far a long
prompt has got*:

- `load_tensors: offloaded 40/41 layers to GPU` and the per-device buffer sizes
  that follow are the only record of what `--fit` decided. On a 16 GiB card
  holding a 21 GiB model that decision is the arm's whole performance story.
- `prompt processing, n_tokens = 2048, progress = 0.29, t = 30.36 s / 67.47
  tokens per second` is the only progress signal a 7 000-token prompt gives
  before its first output token, which was 84 s away in one measured run.

Both only appear at `-lv 4`: the default verbosity hides everything libllama
says about loading, which is why the arm asks for trace.

Every line carries a prefix -- `0.05.384.105 I load_tensors: ...` is a
timestamp, a level and the source -- so the patterns search rather than anchor.

This is a log, not an interface anyone promised to keep. Every pattern is
optional: an unrecognised line is ignored, and a build that rewords a line
loses a note rather than failing a job. `tests/test_logscan.py` pins the shapes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# `load_tensors: offloaded 40/41 layers to GPU`
OFFLOADED = re.compile(r"offloaded\s+(\d+)/(\d+)\s+layers? to GPU")
# `load_tensors:        CUDA0 model buffer size = 12167.74 MiB`
# `load_tensors:   CPU_Mapped model buffer size = 20797.72 MiB`
MODEL_BUFFER = re.compile(r"load_tensors:\s+(\S+) model buffer size\s*=\s*([\d.]+)\s*MiB")
# `llama_kv_cache:      CUDA0 KV buffer size =   640.00 MiB`
KV_BUFFER = re.compile(r"KV buffer size\s*=\s*([\d.]+)\s*MiB")
# `slot print_timing: id  0 | task 0 | prompt processing, n_tokens =   2048, progress = 0.29, t =  30.36 s / 67.47 tokens per second`  # noqa: E501 - verbatim log line
PROMPT_PROGRESS = re.compile(
    r"prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+)(?:, t =\s*([\d.]+) s / ([\d.]+) tokens per second)?"  # noqa: E501 - verbatim log line
)
# `common_params_fit_impl: ...` -- what --fit decided, in its own words. Off by
# default in this arm, but the line is kept for anyone who turns it on.
FIT = re.compile(r"common_params_fit_impl:\s*(.*)$")
# The level is the second field of every line: `0.05.384.105 E ...`.
ERROR = re.compile(r"^\S+ E\s+(.*)$")


@dataclass(frozen=True)
class Offload:
    """Layers on the card, out of the layers there are."""

    on_gpu: int
    total: int


@dataclass(frozen=True)
class Buffer:
    """A device's share of the weights, in MiB."""

    device: str
    mib: float


@dataclass(frozen=True)
class KvBuffer:
    mib: float


@dataclass(frozen=True)
class PromptProgress:
    """How far a prompt has been processed; `total` is derived, not stated."""

    done: int
    total: int
    rate: str | None


@dataclass(frozen=True)
class Fit:
    text: str


@dataclass(frozen=True)
class Error:
    text: str


Event = Offload | Buffer | KvBuffer | PromptProgress | Fit | Error


def parse_line(line: str) -> Event | None:
    text = line.strip()
    if not text:
        return None

    if (match := OFFLOADED.search(text)) is not None:
        return Offload(int(match.group(1)), int(match.group(2)))

    if (match := MODEL_BUFFER.search(text)) is not None:
        return Buffer(match.group(1), float(match.group(2)))

    if (match := KV_BUFFER.search(text)) is not None:
        return KvBuffer(float(match.group(1)))

    if (match := PROMPT_PROGRESS.search(text)) is not None:
        done = int(match.group(1))
        fraction = float(match.group(2))
        # The line gives a count and a fraction, never the total. Derived here
        # so the meter can show "2048 of 7062" rather than "29%"; the exact
        # count arrives with the first streamed token and replaces it.
        total = round(done / fraction) if fraction > 0 else done
        rate = f"{float(match.group(4)):.0f} tok/s" if match.group(4) else None
        return PromptProgress(done, max(total, done), rate)

    if (match := FIT.search(text)) is not None:
        return Fit(match.group(1))

    if (match := ERROR.match(text)) is not None:
        return Error(match.group(1))

    return None


def placement(buffers: list[Buffer], offload: Offload | None) -> str:
    """One line for the timeline: `40/41 layers on GPU · CUDA0 12.1 GiB · CPU 8.6 GiB`."""
    parts: list[str] = []
    if offload is not None:
        parts.append(f"{offload.on_gpu}/{offload.total} layers on GPU")
    for entry in buffers:
        parts.append(f"{entry.device.replace('_Mapped', '')} {entry.mib / 1024:.1f} GiB")
    return " · ".join(parts)
