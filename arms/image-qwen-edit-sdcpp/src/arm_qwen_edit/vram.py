"""What this arm holds on the card, without torch to ask.

The weights live in a child process written in C++, so there is no allocator in
this interpreter to interrogate. nvidia-smi keeps per-process accounting, and
asking it for one pid is the closest equivalent to `torch.memory_reserved`: what
this arm put on the card, as opposed to what the whole card holds -- which the
supervisor already samples separately.

One `nvidia-smi` per reading rather than a long-lived `--loop`: the compute-apps
query prints a variable number of rows per iteration with nothing between them,
so a streamed reader cannot tell where one iteration ends. A spawn a second, and
only while a job runs, is the cheaper mistake.
"""

from __future__ import annotations

import shutil
import subprocess

MIB_PER_GIB = 1024.0
QUERY = ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]
# Long enough for a loaded driver, short enough that a wedged nvidia-smi cannot
# stall the sampler thread it runs on.
TIMEOUT_SECONDS = 5.0


def available() -> bool:
    return shutil.which("nvidia-smi") is not None


def _rows() -> list[tuple[int, float]]:
    try:
        # S603/S607: a constant argv with no shell, and nvidia-smi found on PATH
        # because there is no fixed location for it across driver versions.
        finished = subprocess.run(  # noqa: S603
            ["nvidia-smi", *QUERY],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []

    if finished.returncode != 0:
        return []

    rows: list[tuple[int, float]] = []
    for line in finished.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 2:
            continue
        try:
            rows.append((int(parts[0]), float(parts[1])))
        except ValueError:
            # "[N/A]" for a process the driver will not name, and the header row
            # on driver versions that print one despite --noheader.
            continue
    return rows


def used_gib(pids: set[int]) -> float | None:
    """GiB held by the given processes, or None when nothing can be read.

    None rather than 0.0 on failure, because "nvidia-smi did not answer" and
    "the child holds nothing" are different facts and only one of them is worth
    plotting.
    """
    if not pids:
        return None

    rows = _rows()
    if not rows:
        return None

    total = sum(mib for pid, mib in rows if pid in pids)
    return total / MIB_PER_GIB
