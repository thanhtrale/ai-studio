"""What is on the card, and an honest answer about whose it is.

The video arm asks torch for `memory_reserved` and gets "what this process
holds". There is no torch here -- the model runs in a child written in C++ --
so the equivalent is nvidia-smi's per-process accounting.

On this machine that accounting does not exist. A GeForce card under Windows
runs in WDDM mode, where the display driver owns the allocations and
`--query-compute-apps=used_memory` answers `[N/A]` for every process. Only TCC
mode, which consumer cards cannot enter, reports per-process figures.

So the scope is measured rather than assumed, and every figure this module
returns says which one it is. Reporting a whole-card reading as "what this arm
holds" would be the kind of quiet wrongness that a chart makes look like fact.
"""

from __future__ import annotations

import shutil
import subprocess
from typing import Literal

MIB_PER_GIB = 1024.0
# Long enough for a loaded driver, short enough that a wedged nvidia-smi cannot
# stall the sampler thread it runs on.
TIMEOUT_SECONDS = 5.0

Scope = Literal["process", "card", "unavailable"]

#: What a reading covers.
#:
#: ``process`` -- this arm's child only, the same thing the video arm reports.
#: ``card``    -- everything on the GPU, because the driver will not attribute.
#: ``unavailable`` -- no nvidia-smi at all.
SCOPE_LABELS: dict[Scope, str] = {
    "process": "this arm's child process",
    "card": "the whole card (this driver will not attribute per process)",
    "unavailable": "nothing -- nvidia-smi did not answer",
}


def _run(args: list[str]) -> str | None:
    try:
        # S603/S607: a constant argv with no shell, and nvidia-smi found on PATH
        # because there is no fixed location for it across driver versions.
        finished = subprocess.run(  # noqa: S603
            ["nvidia-smi", *args],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return finished.stdout if finished.returncode == 0 else None


def available() -> bool:
    return shutil.which("nvidia-smi") is not None


def _compute_apps() -> list[tuple[int, float | None]]:
    """Every process on the card, with its memory or None where unattributed."""
    out = _run(["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"])
    if out is None:
        return []

    rows: list[tuple[int, float | None]] = []
    for line in out.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 2:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        try:
            rows.append((pid, float(parts[1])))
        except ValueError:
            # "[N/A]" -- the process is on the card, the driver will not say
            # how much of it it holds.
            rows.append((pid, None))
    return rows


def probe(pid: int) -> Scope:
    """What kind of reading this machine can give about `pid`.

    Asked once the child exists, because the answer depends on the driver mode
    rather than on anything this arm chose.
    """
    if not available():
        return "unavailable"

    for entry_pid, mib in _compute_apps():
        if entry_pid == pid:
            return "process" if mib is not None else "card"

    # The child is on the card but not listed yet, or holds nothing yet. The
    # card reading is still a true statement about the card.
    return "card" if card_gib() is not None else "unavailable"


def used_gib(pids: set[int]) -> float | None:
    """GiB held by the given processes, or None when the driver will not say."""
    if not pids:
        return None

    rows = _compute_apps()
    if not rows:
        return None

    mine = [mib for pid, mib in rows if pid in pids]
    if not mine or any(mib is None for mib in mine):
        return None
    return sum(mib for mib in mine if mib is not None) / MIB_PER_GIB


def card_gib() -> float | None:
    """GiB in use on the whole card, by everything."""
    out = _run(["--query-gpu=memory.used", "--format=csv,noheader,nounits"])
    if out is None:
        return None
    for line in out.splitlines():
        try:
            return float(line.strip()) / MIB_PER_GIB
        except ValueError:
            continue
    return None
