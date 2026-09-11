"""The `sd-server` child: starting it, watching it, and shutting it down.

Why a child at all, rather than driving `sd-cli` once per job: the CLI exits
after every image, so every job would re-read twelve gigabytes of weights. The
supervisor's whole broker design is built on an arm that stays warm -- reuse is
measured at 0.0 s against a cold load -- and only the server build of
stable-diffusion.cpp can keep the model resident between jobs.

The child is started on the first job, not at arm start. Reading the weights
takes longer than any sensible health-check timeout, and the supervisor's
contract is that a started arm is reachable, not that it is warm.
"""

from __future__ import annotations

import json
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .logscan import parse_line, phase_label, split_stream
from .progress import JobProgress

READY_POLL_SECONDS = 0.5
# Keep the last few lines so a child that dies during start can say why.
TAIL_LINES = 40


@dataclass
class LoadConfig:
    """Everything that decides how the weights are read.

    All of it is start-time: changing any of it means a different child
    process, which is exactly what the supervisor's broker restarts an arm for.
    """

    server_binary: Path
    diffusion_model: Path
    vae: Path
    llm: Path
    llm_vision: Path | None = None
    offload_to_cpu: bool = True
    flash_attention: bool = True
    threads: int = -1
    model_args: str = ""
    # A 20B transformer off NVMe is minutes, not seconds, and a first run on a
    # cold file cache is the slow case this has to survive.
    ready_timeout_seconds: float = 900.0
    verbose: bool = True

    def argv(self, host: str, port: int) -> list[str]:
        args = [
            str(self.server_binary),
            "--diffusion-model",
            str(self.diffusion_model),
            "--vae",
            str(self.vae),
            "--llm",
            str(self.llm),
            "--listen-ip",
            host,
            "--listen-port",
            str(port),
        ]
        # Only a GGUF text encoder needs its vision tower supplied separately;
        # the safetensors encoder carries its own. The parameter always has a
        # value -- a launch placeholder cannot be omitted conditionally -- so
        # what decides is whether the file is actually there.
        if self.llm_vision is not None and self.llm_vision.is_file():
            # Spelled with an underscore upstream, unlike every neighbouring flag.
            args += ["--llm_vision", str(self.llm_vision)]
        if self.offload_to_cpu:
            args.append("--offload-to-cpu")
        if self.flash_attention:
            args.append("--diffusion-fa")
        if self.threads > 0:
            args += ["--threads", str(self.threads)]
        if self.model_args:
            args += ["--model-args", self.model_args]
        if self.verbose:
            # Without this the child says nothing between accepting a job and
            # finishing it, and the timeline has nothing to show.
            args.append("-v")
        return args


class ChildFailed(RuntimeError):
    """The child would not start, or died while it was meant to be serving."""


def free_port(host: str) -> int:
    """A loopback port nothing holds right now.

    Racy in principle -- something could take it between the close and the
    child's bind -- but the alternative is parsing the port back out of the
    child's log, and this window is microseconds on an interface only this
    machine can reach.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        return int(probe.getsockname()[1])


@dataclass
class JobScan:
    """What the log said about the job currently running."""

    seeds: list[int] = field(default_factory=list)
    steps_total: int = 0
    images_total: int = 0
    last_error: str | None = None


class SdServer:
    """One `sd-server` process, its log, and the timeline it feeds."""

    def __init__(self, config: LoadConfig, progress: JobProgress, host: str = "127.0.0.1") -> None:
        self.config = config
        self.progress = progress
        self.host = host
        self.port: int | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._reader: threading.Thread | None = None
        self._tail: list[str] = []
        self._lock = threading.Lock()
        self.scan = JobScan()

    # --- lifecycle -----------------------------------------------------------

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    @property
    def pid(self) -> int | None:
        return self._process.pid if self._process is not None else None

    def start(self) -> None:
        """Spawn the child and wait until it answers. Idempotent."""
        if self.running:
            return

        if not self.config.server_binary.is_file():
            raise ChildFailed(
                f"{self.config.server_binary} is not there -- unpack a stable-diffusion.cpp "
                "release into the arm's bin/ directory (see the arm README)"
            )

        self.port = free_port(self.host)
        argv = self.config.argv(self.host, self.port)
        print(f"[arm] starting {' '.join(argv)}", flush=True)

        try:
            self._process = subprocess.Popen(  # noqa: S603 - argv built from validated config
                argv,
                cwd=str(self.config.server_binary.parent),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
        except OSError as error:
            raise ChildFailed(f"could not start {self.config.server_binary}: {error}") from error

        self._reader = threading.Thread(target=self._read_log, daemon=True)
        self._reader.start()
        self._await_ready()

    def stop(self, timeout: float = 20.0) -> None:
        process = self._process
        self._process = None
        self.port = None
        if process is None or process.poll() is not None:
            return

        process.terminate()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=timeout)

    def _await_ready(self) -> None:
        deadline = time.monotonic() + self.config.ready_timeout_seconds
        while time.monotonic() < deadline:
            process = self._process
            if process is None or process.poll() is not None:
                code = process.returncode if process else "unknown"
                raise ChildFailed(f"sd-server exited with code {code}:\n{self.tail()}")
            if self._answers():
                return
            time.sleep(READY_POLL_SECONDS)

        self.stop()
        raise ChildFailed(
            f"sd-server did not answer within {self.config.ready_timeout_seconds:.0f}s:\n{self.tail()}"
        )

    def _answers(self) -> bool:
        try:
            self.get("/sdcpp/v1/capabilities", timeout=2.0)
        except (urllib.error.URLError, OSError, ValueError):
            return False
        return True

    # --- http ----------------------------------------------------------------

    def url(self, path: str) -> str:
        if self.port is None:
            raise ChildFailed("sd-server is not running")
        return f"http://{self.host}:{self.port}{path}"

    def get(self, path: str, timeout: float = 30.0) -> Any:
        request = urllib.request.Request(self.url(path), method="GET")  # noqa: S310 - loopback only
        with urllib.request.urlopen(request, timeout=timeout) as answer:  # noqa: S310
            return json.loads(answer.read() or b"{}")

    def post(self, path: str, body: dict[str, Any], timeout: float = 120.0) -> Any:
        payload = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(  # noqa: S310 - loopback only
            self.url(path),
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=timeout) as answer:  # noqa: S310
            return json.loads(answer.read() or b"{}")

    # --- the log -------------------------------------------------------------

    def tail(self) -> str:
        with self._lock:
            return "\n".join(self._tail[-TAIL_LINES:])

    def reset_scan(self) -> JobScan:
        with self._lock:
            self.scan = JobScan()
            return self.scan

    def _read_log(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return

        buffer = ""
        while True:
            chunk = process.stdout.read(1)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="replace")
            lines, buffer = split_stream(buffer)
            for line in lines:
                self._absorb(line)

        if buffer.strip():
            self._absorb(buffer)

    def _absorb(self, line: str) -> None:
        text = line.strip()
        if not text:
            return
        with self._lock:
            self._tail.append(text)
            del self._tail[:-TAIL_LINES]

        event = parse_line(text)
        if event is None:
            return

        # Everything below writes to the timeline, which is safe from any
        # thread, and to the scan, which is not -- hence the lock on the scan.
        if event.kind == "error":
            with self._lock:
                self.scan.last_error = event.text
            self.progress.describe("generate", event.text[:200])
            return

        if event.kind == "phase" and event.name == "load":
            self.progress.start("load", "Load model", event.text[:120], parent="generate")
            return

        if event.kind == "done":
            seconds = event.seconds
            label = phase_label(event.name)
            if event.name.strip().lower().startswith(("load", "loading")):
                self.progress.finish_step("load", seconds=seconds)
                return
            if label is None:
                return
            key = f"phase-{label.lower().replace(' ', '-')}"
            self.progress.start(key, label, parent="generate")
            self.progress.finish_step(key, seconds=seconds)
            return

        if event.kind == "image":
            with self._lock:
                if event.seed is not None:
                    self.scan.seeds.append(event.seed)
                if event.total:
                    self.scan.images_total = event.total
            if event.total and event.total > 1 and event.index is not None:
                self.progress.meter("batch", "Images", event.total)
                self.progress.advance("batch", event.index - 1, event.total)
            # The load is over the moment the first image starts, whether or not
            # the line announcing that was one this parser recognised.
            self.progress.finish_step("load")
            return

        if event.kind == "progress" and event.index is not None and event.total:
            with self._lock:
                self.scan.steps_total = event.total
            self.progress.meter("steps", "Denoise", event.total, event.rate or None)
            self.progress.advance("steps", event.index, event.total)
            return

        if event.kind == "info" and self.progress.running("generate"):
            self.progress.describe("generate", event.text[:200])
