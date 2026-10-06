"""Reading ComfyUI's log, because its HTTP API will not say what it is doing.

ComfyUI answers `/history` with nothing at all until a prompt is finished, and
a prompt here spends much of its time reading seven gigabytes of weights off
NVMe. Between "accepted" and "done" the API is silent, which for a job that
takes two minutes is indistinguishable from a hang.

The one place that detail exists is the child's own console output, so this
turns those lines into events the timeline can show. Deliberately forgiving:
the log is a human-facing side effect of another project rather than an
interface it promises to keep, so an unrecognised line is surfaced as the
running step's detail and a renamed phase costs a label rather than a job.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

EventKind = Literal["phase", "loaded", "staged", "progress", "executed", "error", "info"]


@dataclass(frozen=True)
class LogEvent:
    kind: EventKind
    text: str = ""
    name: str = ""
    seconds: float | None = None
    index: int | None = None
    total: int | None = None
    rate: str = ""


# ComfyUI colours its own log. The escapes are invisible in a terminal and
# very much not invisible to a regular expression anchored at the start of a
# line, which is how every pattern below is written.
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
# "[INFO] Requested to load ..." -- its logger prefixes the level, and the
# message this module cares about begins after it.
_TAGGED = re.compile(r"^\[(?P<level>[A-Z]+)\]\s*(?P<message>.*)$")
_LOUD = {"ERROR", "CRITICAL", "FATAL"}

# "Requested to load Hunyuan3Dv2_1" -- model_management.py, once per model
# per prompt, and the only announcement that a load has started.
_REQUESTED = re.compile(r"^Requested to load\s+(?P<name>\S+)")
# "loaded completely; ... 9123.45 MB loaded, full load: True"
# "loaded partially; ... 8000.00 MB loaded, 3000.00 MB offloaded, ..."
_LOADED = re.compile(r"^loaded (?P<how>completely|partially);.*?(?P<mb>[\d.]+)\s*MB loaded", re.IGNORECASE)
# What this build actually prints, because DynamicVRAM is on by default:
# "Model Hunyuan3Dv2_1 prepared for dynamic VRAM loading. 9123MB Staged. 0 patches
# attached." It never reaches the line above, and unlike that line it names the
# model -- which is what lets a completion be matched to its own request rather
# than to whichever one is next in the queue.
_STAGED = re.compile(r"^Model (?P<name>\S+) prepared for dynamic VRAM loading\.\s*(?P<mb>\d+)\s*MB Staged")
# "Prompt executed in 42.37 seconds"
_EXECUTED = re.compile(r"^Prompt executed in\s+(?P<seconds>[\d.]+)\s*seconds")
# tqdm's sampler bar: " 45%|####5     | 18/40 [00:12<00:14,  1.52it/s]". The
# percentage and the bar glyphs vary with terminal width and encoding, so the
# "18/40 [" and the rate are what this matches on.
_PROGRESS = re.compile(r"(?P<done>\d+)\s*/\s*(?P<total>\d+)\s*\[[^\]]*?(?P<rate>[\d.]+\s*(?:s/it|it/s))")
# ComfyUI's own marker around a node that raised, and Python's around anything.
_FAILURE = re.compile(r"!!! Exception during processing|^Traceback \(most recent call last\)")

#: How a loaded model's class name is said in the timeline. Matched as a
#: substring because the class names carry suffixes ComfyUI generates.
MODEL_LABELS: tuple[tuple[str, str], ...] = (
    ("BiRefNet", "Load background remover"),
    ("BackgroundRemoval", "Load background remover"),
    ("CLIPVision", "Load image encoder"),
    ("Dino", "Load image encoder"),
    ("ShapeVAE", "Load shape VAE"),
    ("VAE", "Load shape VAE"),
)
DEFAULT_MODEL_LABEL = "Load shape model"


def model_label(name: str) -> str:
    """How `Requested to load <name>` is shown."""
    for needle, label in MODEL_LABELS:
        if needle.lower() in name.lower():
            return label
    return DEFAULT_MODEL_LABEL


def parse_line(raw: str) -> LogEvent | None:
    """One log line as an event, or None when there is nothing in it.

    The progress bar is matched before anything else: it carries neither colour
    nor a level tag of its own, and its "18/40" would be read as a fragment of
    whatever pattern happened to be tried first.
    """
    line = _ANSI.sub("", raw).strip().strip("\x00")
    if not line:
        return None

    progress = _PROGRESS.search(line)
    if progress:
        return LogEvent(
            kind="progress",
            text=line,
            index=int(progress.group("done")),
            total=int(progress.group("total")),
            rate=progress.group("rate").replace(" ", ""),
        )

    tagged = _TAGGED.match(line)
    level = tagged.group("level") if tagged else ""
    message = tagged.group("message").strip() if tagged else line
    if not message:
        return None

    if level in _LOUD:
        return LogEvent(kind="error", text=message)

    executed = _EXECUTED.match(message)
    if executed:
        return LogEvent(kind="executed", text=message, seconds=float(executed.group("seconds")))

    requested = _REQUESTED.match(message)
    if requested:
        name = requested.group("name")
        return LogEvent(kind="phase", text=message, name=name)

    loaded = _LOADED.match(message)
    if loaded:
        return LogEvent(
            kind="loaded",
            text=message,
            name=loaded.group("how"),
            # Megabytes as reported; the caller turns it into a GiB detail.
            total=int(float(loaded.group("mb"))),
        )

    staged = _STAGED.match(message)
    if staged:
        return LogEvent(
            kind="staged",
            text=message,
            name=staged.group("name"),
            total=int(staged.group("mb")),
        )

    if _FAILURE.search(message):
        return LogEvent(kind="error", text=message)

    return LogEvent(kind="info", text=message)


def split_stream(buffer: str) -> tuple[list[str], str]:
    """Whole lines out of a chunk, and whatever is left mid-line.

    tqdm redraws its bar with a carriage return rather than a newline, so a
    reader that only split on `\\n` would see one enormous line once sampling
    finished -- which is exactly when it stops being useful.
    """
    parts = re.split(r"[\r\n]", buffer)
    return parts[:-1], parts[-1]
