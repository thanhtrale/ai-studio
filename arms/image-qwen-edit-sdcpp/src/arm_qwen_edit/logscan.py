"""Reading the child's log, because its API will not say what it is doing.

`sd-server` accepts a job and reports `queued`, `generating`, `completed` -- and
nothing in between. For a run that spends thirty seconds reading weights and
another thirty denoising, that is indistinguishable from a hang. The one place
that detail exists is the child's own log, so this turns those lines into
events the timeline can show.

Deliberately forgiving. The log is a human-facing side effect of another
project, not an interface it promises to keep, so every pattern here is
optional: an unrecognised line is still surfaced as the running step's detail,
and a version that renames a phase loses a label rather than breaking a job.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

EventKind = Literal["phase", "done", "image", "progress", "error", "info"]


@dataclass(frozen=True)
class LogEvent:
    kind: EventKind
    text: str = ""
    name: str = ""
    seconds: float | None = None
    index: int | None = None
    total: int | None = None
    seed: int | None = None
    rate: str = ""


# "[INFO ] stable-diffusion.cpp:1234 - <message>"
_TAGGED = re.compile(r"^\[(?P<level>\w+)\s*\]\s*(?:[\w.\-]+:\d+\s*-\s*)?(?P<message>.*)$")
# "loading model from '...'", "load ... using ... backend"
_LOADING = re.compile(r"^(?:loading|load)\b.*?\bmodel\b", re.IGNORECASE)
# "<phase> completed, taking 1.23s" -- sd.cpp's one consistent phrasing.
_COMPLETED = re.compile(r"^(?P<name>.+?)\s+completed,\s+taking\s+(?P<seconds>[\d.]+)s", re.IGNORECASE)
_COMPLETED_IN = re.compile(r"^(?P<name>.+?)\s+completed\s+in\s+(?P<seconds>[\d.]+)s", re.IGNORECASE)
# "generating image: 2/4 - seed 12345"
_IMAGE = re.compile(
    r"generating\s+image:?\s*(?P<index>\d+)\s*/\s*(?P<total>\d+)(?:\s*-\s*seed\s*(?P<seed>-?\d+))?",
    re.IGNORECASE,
)
# The sampler's progress bar: "|=====>   | 3/8 - 1.23s/it". Also matches the
# bare "3/8 - 1.23it/s" some builds print without the bar.
_PROGRESS = re.compile(r"(?P<done>\d+)\s*/\s*(?P<total>\d+)\s*-\s*(?P<rate>[\d.]+\s*(?:s/it|it/s))")

# The phases worth a line of their own, mapped to how the timeline says them.
PHASE_LABELS: dict[str, str] = {
    "get_learned_condition": "Encode prompt",
    "condition": "Encode prompt",
    "apply_loras": "Apply LoRAs",
    "sampling": "Sample",
    "generating latent image": "Sample",
    "decode_first_stage": "Decode",
    "vae decode": "Decode",
    "img_gen": "Generate",
    "txt2img": "Generate",
    "img2img": "Generate",
}


def phase_label(name: str) -> str | None:
    """How a `<name> completed, taking Xs` phase is shown, if it is shown."""
    cleaned = name.strip().lower()
    for key, label in PHASE_LABELS.items():
        if cleaned.endswith(key) or cleaned.startswith(key):
            return label
    return None


def parse_line(raw: str) -> LogEvent | None:
    """One log line as an event, or None when there is nothing in it.

    The progress bar is checked before the message is untagged, because the bar
    carries no `[INFO ]` prefix -- and checked after `generating image`, whose
    "2/4" would otherwise be read as a step count.
    """
    line = raw.strip().strip("\x00")
    if not line:
        return None

    tagged = _TAGGED.match(line)
    level = (tagged.group("level") if tagged else "").upper()
    message = tagged.group("message").strip() if tagged else line

    if level in {"ERROR", "FATAL"}:
        return LogEvent(kind="error", text=message)

    image = _IMAGE.search(message)
    if image:
        seed = image.group("seed")
        return LogEvent(
            kind="image",
            text=message,
            index=int(image.group("index")),
            total=int(image.group("total")),
            seed=int(seed) if seed is not None else None,
        )

    progress = _PROGRESS.search(message)
    if progress:
        return LogEvent(
            kind="progress",
            text=message,
            index=int(progress.group("done")),
            total=int(progress.group("total")),
            rate=progress.group("rate").replace(" ", ""),
        )

    completed = _COMPLETED.match(message) or _COMPLETED_IN.match(message)
    if completed:
        return LogEvent(
            kind="done",
            text=message,
            name=completed.group("name").strip(),
            seconds=float(completed.group("seconds")),
        )

    if _LOADING.match(message):
        return LogEvent(kind="phase", text=message, name="load")

    return LogEvent(kind="info", text=message) if message else None


def split_stream(buffer: str) -> tuple[list[str], str]:
    """Whole lines out of a chunk, and whatever is left mid-line.

    The progress bar redraws itself with a carriage return rather than a
    newline, so a reader that only split on `\\n` would see one enormous line
    once the run finished -- which is exactly when it stops being useful.
    """
    parts = re.split(r"[\r\n]", buffer)
    return parts[:-1], parts[-1]
