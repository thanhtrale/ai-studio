"""Running one script, and turning what it prints into the studio's timeline.

The scripts speak companion-web's arm protocol: one JSON object per line on
stdout, with `event` set to `stage` (a phase has begun), `step` (`i` of `of`
within a stage), `done` (the result) or `error` (`message`). Their log goes to
stderr, and only its tail is kept, to say why a run died.

Each `stage` becomes a child step under the task's own step, closed when the
next one opens, so the timeline shows where the time went -- the prep remesh,
MIA, SkinTokens, the Blender bind -- rather than one bar for a minute.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .jobobject import KillOnClose
from .progress import JobProgress
from .tasks import TASK_LABELS, ScriptJob

TAIL_LINES = 60
#: A rig is about a minute and a turntable a few seconds on the measured card;
#: a script still going after this is wedged, not slow.
SCRIPT_TIMEOUT_SECONDS = 1800.0


class ScriptFailed(RuntimeError):
    """The script said `error`, died, or never said `done`."""


@dataclass
class ScriptResult:
    task: str
    seconds: float
    #: The script's own `done` event, minus the protocol fields.
    result: dict[str, Any]
    #: Seconds per stage, in the order they ran.
    stages: list[dict[str, Any]]


class ScriptRunner:
    """Starts a script per job and follows it. One at a time; the server holds the lock."""

    def __init__(self, scripts_dir: Path, python: Path, env: dict[str, str], progress: JobProgress) -> None:
        self.scripts_dir = scripts_dir
        self.python = python
        self.env = env
        self.progress = progress
        self._process: subprocess.Popen[bytes] | None = None
        self._job = KillOnClose()

    @property
    def pid(self) -> int | None:
        process = self._process
        return process.pid if process is not None and process.poll() is None else None

    def stop(self) -> None:
        process = self._process
        if process is not None and process.poll() is None:
            process.kill()

    def run(self, job: ScriptJob) -> ScriptResult:
        script = self.scripts_dir / job.script
        if not script.is_file():
            raise ScriptFailed(f"{script} is not there")
        job.out_dir.mkdir(parents=True, exist_ok=True)

        started = time.perf_counter()
        parent = f"task:{job.task}"
        self.progress.start(parent, TASK_LABELS[job.task], job.detail)

        env = {**os.environ, **self.env, **job.env, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        argv = [str(self.python), str(script)]
        print(f"[arm] {' '.join(argv)}", flush=True)
        try:
            self._process = subprocess.Popen(  # noqa: S603 - argv built here, not from the job
                argv,
                cwd=str(self.scripts_dir),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
        except OSError as error:
            self.progress.finish_step(parent, detail=f"could not start: {error}")
            raise ScriptFailed(f"could not start {script.name}: {error}") from error
        try:
            self._job.adopt(self._process)
        except OSError as error:
            print(f"[arm] warning: could not put the script in a job object ({error})", flush=True)

        process = self._process
        tail: deque[str] = deque(maxlen=TAIL_LINES)
        reader = threading.Thread(target=self._drain, args=(process, tail), daemon=True)
        reader.start()

        if process.stdin is None or process.stdout is None:
            raise ScriptFailed(f"{script.name} started without pipes")
        process.stdin.write(json.dumps(job.payload).encode("utf-8"))
        process.stdin.close()

        stages: list[dict[str, Any]] = []
        current: dict[str, Any] = {}
        done: dict[str, Any] | None = None
        failure: str | None = None
        meters: set[str] = set()

        def close_stage() -> None:
            if current:
                seconds = time.perf_counter() - current["t"]
                self.progress.finish_step(current["key"], seconds=seconds)
                stages.append({"name": current["name"], "seconds": round(seconds, 2)})
                current.clear()

        deadline = time.monotonic() + SCRIPT_TIMEOUT_SECONDS
        for raw in process.stdout:
            if time.monotonic() > deadline:
                process.kill()
                failure = f"{job.script} did not finish within {SCRIPT_TIMEOUT_SECONDS:.0f}s"
                break
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = event.get("event")
            if kind == "stage":
                close_stage()
                name = str(event.get("stage") or "stage")
                key = f"{parent}:{len(stages)}:{name}"
                self.progress.start(key, name, None, parent=parent)
                current.update(key=key, name=name, t=time.perf_counter())
            elif kind == "step":
                total, value = event.get("of"), event.get("i")
                if isinstance(total, int) and isinstance(value, int) and total > 0:
                    stage = str(event.get("stage") or job.task)
                    meter = f"{job.task}:{stage}"
                    if meter not in meters:
                        self.progress.meter(meter, stage, total)
                        meters.add(meter)
                    self.progress.advance(meter, value, total)
            elif kind == "done":
                done = {k: v for k, v in event.items() if k not in ("event", "ms")}
            elif kind == "error":
                failure = str(event.get("message") or "the script reported an error")

        code = process.wait()
        reader.join(timeout=5)
        seconds = time.perf_counter() - started

        if failure is None and done is None:
            failure = f"{job.script} exited with code {code} and no result"
        if failure is not None or done is None:
            failure = failure or f"{job.script} gave no result"
            # The task and the stage it died in stay running, so the server's
            # `fail` marks both: the timeline then shows where it stopped.
            last = "\n".join(list(tail)[-15:])
            raise ScriptFailed(f"{failure}\n{last}" if last else failure)

        close_stage()
        self.progress.finish_step(parent, detail=f"{job.detail} · {seconds:.1f}s", seconds=seconds)
        return ScriptResult(task=job.task, seconds=round(seconds, 2), result=done, stages=stages)

    @staticmethod
    def _drain(process: subprocess.Popen[bytes], tail: deque[str]) -> None:
        """Keep stderr moving, echo it, and keep its tail for a failure message."""
        if process.stderr is None:
            return
        for raw in process.stderr:
            line = raw.decode("utf-8", errors="replace").rstrip()
            tail.append(line)
            sys.stdout.write(f"  {line}\n")
            sys.stdout.flush()
