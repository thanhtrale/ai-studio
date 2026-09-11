"""What the current job is doing, readable while it is doing it.

A generation here is minutes long and almost all of that is one of three things:
weights crossing PCIe, the enhancer writing, or the denoising loop. A caller that
only gets a report at the end cannot tell those apart -- and cannot tell any of
them from a hang. So the arm keeps a running record and serves it.

The shape is the studio's `JobProgress`, so the supervisor can hand it to the
browser without knowing what a sigma is.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import torch

GIB = 1024**3
# One reading a second, matching the machine-wide meter the supervisor samples.
VRAM_INTERVAL_SECONDS = 1.0
# Twenty minutes. A job longer than that has other problems.
MAX_VRAM_SAMPLES = 1200


def _now_ms() -> float:
    return time.time() * 1000.0


class _Step:
    __slots__ = ("key", "label", "detail", "parent", "state", "started", "seconds", "note", "replaces")

    def __init__(self, key: str, label: str, detail: str | None, parent: str | None) -> None:
        self.key = key
        self.label = label
        self.detail = detail
        self.parent = parent
        self.state = "running"
        self.started = time.perf_counter()
        self.seconds: float | None = None
        self.note: str | None = None
        self.replaces: str | None = None

    def elapsed(self) -> float:
        return self.seconds if self.seconds is not None else time.perf_counter() - self.started


class _Meter:
    __slots__ = ("key", "label", "detail", "done", "total")

    def __init__(self, key: str, label: str, total: int, detail: str | None) -> None:
        self.key = key
        self.label = label
        self.detail = detail
        self.done = 0
        self.total = total


class JobProgress:
    """The current job's timeline. One per arm process, reset per job.

    Every method is safe to call from the generation thread while the HTTP
    thread is reading, which is the whole point: the reader is a different
    request than the one doing the work.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._job_id: str | None = None
        self._steps: list[_Step] = []
        self._meters: list[_Meter] = []
        self._vram: list[dict[str, float]] = []
        self._sampling: threading.Event | None = None
        self._sampler: threading.Thread | None = None

    # --- lifecycle -----------------------------------------------------------

    def begin(self, job_id: str | None) -> None:
        """Start a new job, discarding the previous one.

        The previous job's timeline is dropped rather than kept: the supervisor
        already took a final snapshot when that job returned, and keeping two
        would only invite showing the wrong one.
        """
        with self._lock:
            self._job_id = job_id
            self._steps = []
            self._meters = []
            self._vram = []
        self._start_sampling()

    def finish(self) -> None:
        self._stop_sampling()
        with self._lock:
            for step in self._steps:
                if step.state == "running":
                    step.state = "done"
                    step.seconds = step.elapsed()

    def fail(self, detail: str) -> None:
        self._stop_sampling()
        with self._lock:
            for step in self._steps:
                if step.state == "running":
                    step.state = "failed"
                    step.seconds = step.elapsed()
                    step.detail = detail if step.detail is None else f"{step.detail} — {detail}"

    # --- steps ---------------------------------------------------------------

    def start(self, key: str, label: str, detail: str | None = None, parent: str | None = None) -> None:
        with self._lock:
            self._steps.append(_Step(key, label, detail, parent))

    def finish_step(self, key: str, detail: str | None = None, seconds: float | None = None) -> None:
        with self._lock:
            step = self._find(key)
            if step is None:
                return
            step.state = "done"
            step.seconds = seconds if seconds is not None else step.elapsed()
            if detail is not None:
                step.detail = detail

    def describe(self, key: str, detail: str) -> None:
        with self._lock:
            step = self._find(key)
            if step is not None:
                step.detail = detail

    def annotate(self, key: str, note: str, replaces: str | None = None) -> None:
        """Attach text worth reading in full, such as what the enhancer wrote."""
        with self._lock:
            step = self._find(key)
            if step is not None:
                step.note = note
                step.replaces = replaces

    def _find(self, key: str) -> _Step | None:
        for step in self._steps:
            if step.key == key:
                return step
        return None

    class _Scope:
        def __init__(self, progress: JobProgress, key: str) -> None:
            self._progress = progress
            self._key = key

        def __enter__(self) -> JobProgress._Scope:
            return self

        def __exit__(self, exc_type: object, *_: object) -> None:
            if exc_type is None:
                self._progress.finish_step(self._key)

        def detail(self, text: str) -> None:
            self._progress.describe(self._key, text)

        def note(self, text: str, replaces: str | None = None) -> None:
            self._progress.annotate(self._key, text, replaces)

    def step(
        self, key: str, label: str, detail: str | None = None, parent: str | None = None
    ) -> JobProgress._Scope:
        """`with progress.step(...)`: opens on entry, closes on a clean exit.

        A raised exception deliberately leaves the step open, so `fail` can mark
        the step that was actually running when it went wrong.
        """
        self.start(key, label, detail, parent)
        return JobProgress._Scope(self, key)

    # --- counted work --------------------------------------------------------

    def meter(self, key: str, label: str, total: int, detail: str | None = None) -> None:
        with self._lock:
            self._meters = [entry for entry in self._meters if entry.key != key]
            self._meters.append(_Meter(key, label, total, detail))

    def advance(self, key: str, done: int) -> None:
        with self._lock:
            for entry in self._meters:
                if entry.key == key:
                    entry.done = done

    # --- vram ----------------------------------------------------------------

    def sample_vram(self) -> None:
        """One reading of what this process has reserved on the card.

        `memory_reserved` rather than `memory_allocated`: reserved is what the
        caching allocator is actually holding against the card, which is the
        figure that has to fit alongside everything else on the machine.
        """
        if not torch.cuda.is_available():
            return
        with self._lock:
            self._vram.append({"at": _now_ms(), "gib": torch.cuda.memory_reserved() / GIB})
            if len(self._vram) > MAX_VRAM_SAMPLES:
                del self._vram[: len(self._vram) - MAX_VRAM_SAMPLES]

    def _start_sampling(self) -> None:
        self._stop_sampling()
        stop = threading.Event()

        def run() -> None:
            while not stop.wait(VRAM_INTERVAL_SECONDS):
                self.sample_vram()

        self._sampling = stop
        self._sampler = threading.Thread(target=run, daemon=True)
        self._sampler.start()
        self.sample_vram()

    def _stop_sampling(self) -> None:
        if self._sampling is not None:
            self._sampling.set()
        self._sampling = None
        self._sampler = None

    # --- reading -------------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            by_parent: dict[str, list[dict[str, Any]]] = {}
            for step in self._steps:
                if step.parent is not None:
                    by_parent.setdefault(step.parent, []).append(self._render(step))

            steps = [self._render(step, by_parent.get(step.key)) for step in self._steps if step.parent is None]

            return {
                "jobId": self._job_id,
                "steps": steps,
                "meters": [
                    {
                        "key": entry.key,
                        "label": entry.label,
                        **({"detail": entry.detail} if entry.detail else {}),
                        "done": entry.done,
                        "total": entry.total,
                    }
                    for entry in self._meters
                ],
                "vram": list(self._vram),
            }

    @staticmethod
    def _render(step: _Step, children: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        rendered: dict[str, Any] = {
            "key": step.key,
            "label": step.label,
            "state": step.state,
            "seconds": round(step.elapsed(), 3),
        }
        if step.detail:
            rendered["detail"] = step.detail
        if step.note:
            rendered["note"] = step.note
        if step.replaces:
            rendered["noteReplaces"] = step.replaces
        if children:
            rendered["children"] = children
        return rendered
