"""The `llama-server` child: starting it, watching it, and shutting it down.

Unlike `sd-server`, which answers its API before it has read a byte of weights,
`llama-server` reads the whole model before it will answer `/health` with 200.
So "start the child" and "load the model" are one step here, and it is a step
of tens of seconds for a 21 GiB file -- which is why it happens on the first
job rather than at arm start, where the supervisor's health timeout would be
waiting on it.

The child is started on the first job and kept between jobs. The supervisor's
broker is built on that: a job whose start parameters match the loaded arm is
reused at 0.0 s, and only a resident child can honour it.
"""

from __future__ import annotations

import json
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .jobobject import KillOnClose
from .logscan import Buffer, Error, Fit, KvBuffer, Offload, PromptProgress, parse_line, placement
from .progress import JobProgress

READY_POLL_SECONDS = 0.5
# Keep the last few lines so a child that dies during start can say why.
TAIL_LINES = 60


@dataclass
class LoadConfig:
    """Everything that decides how the weights are placed.

    All of it is start-time: changing any of it means a different child
    process, which is exactly what the supervisor's broker restarts an arm for.
    """

    server_binary: Path
    model: Path
    # The vision projector. Loading it costs VRAM a text job never uses, so it
    # is only passed when `vision` says so -- the placeholder always has a
    # value because a launch argument cannot be omitted conditionally.
    mmproj: Path | None = None
    vision: bool = False
    context_size: int = 65536
    gpu_layers: int = 999
    # Experts of the first N layers stay in host RAM; attention and the rest
    # of every layer go to the card. The Q4_K_XL file is 21 GiB against 16 GiB
    # of VRAM, so some experts have to live in RAM, and this number is the
    # arm's whole performance lever. 22 measured at 14.7 GiB on the card,
    # 1351 tok/s prompt and 63 tok/s generation; see the README for 20 and 24.
    cpu_moe: int = 22
    flash_attention: str = "auto"
    threads: int = -1
    # KV cache type for K and V. f16 is the child's default; q8_0 halves it,
    # which matters at the long contexts this model was trained for.
    kv_cache_type: str = "f16"
    # A 21 GiB file off NVMe. Measured at 11-13 s with the file cached; the
    # first read after a reboot is the case this has to survive.
    ready_timeout_seconds: float = 900.0

    def argv(self, host: str, port: int) -> list[str]:
        args = [
            str(self.server_binary),
            "--model",
            str(self.model),
            "--host",
            host,
            "--port",
            str(port),
            "--ctx-size",
            str(self.context_size),
            "--gpu-layers",
            str(self.gpu_layers),
            "--n-cpu-moe",
            str(self.cpu_moe),
            # The child's own placement is off, and not casually: with it on,
            # the same model on the same card ran at 96 tok/s prompt and 24
            # tok/s generation against 1351 and 63 with the placement pinned
            # above. It also filled the card to 15.9 of 16.4 GiB, which under
            # WDDM is where the driver starts paging VRAM to RAM in silence.
            "--fit",
            "off",
            # Read the file rather than map it. With experts in RAM, the mapped
            # variant measured at half the prompt speed and three quarters of
            # the generation speed -- the child's own log says as much.
            "--load-mode",
            "none",
            "--flash-attn",
            self.flash_attention,
            "--cache-type-k",
            self.kv_cache_type,
            "--cache-type-v",
            self.kv_cache_type,
            # One slot: the arm runs one job at a time, and a second slot would
            # only split the KV budget.
            "--parallel",
            "1",
            # Thoughts arrive as `reasoning_content`, separate from the answer,
            # which is what lets the timeline show "Think" and "Answer" as two
            # steps and the report keep them apart.
            "--reasoning-format",
            "deepseek",
            # Nothing here reads it, and the port is the supervisor's secret.
            "--no-webui",
            "--metrics",
            # The log is read by a pipe; colour codes would only be noise in it.
            "--log-colors",
            "off",
            # Trace. The default level hides everything libllama says about
            # loading, and where the weights landed is the one thing the
            # timeline cannot learn from the API.
            "--verbosity",
            "4",
        ]
        if self.threads > 0:
            args += ["--threads", str(self.threads)]
        if self.vision and self.mmproj is not None and self.mmproj.is_file():
            args += ["--mmproj", str(self.mmproj)]
        else:
            # Otherwise the child looks for a projector beside the model and
            # loads it if it finds one, which is exactly the VRAM `vision`
            # exists to decline.
            args.append("--no-mmproj")
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
class Placement:
    """What the log said about where the weights went. Filled once, at load."""

    offload: Offload | None = None
    buffers: list[Buffer] = field(default_factory=list)
    kv_mib: float = 0.0
    fit: list[str] = field(default_factory=list)
    last_error: str | None = None

    def summary(self) -> str:
        return placement(self.buffers, self.offload)


class LlamaServer:
    """One `llama-server` process, its log, and the timeline it feeds."""

    def __init__(self, config: LoadConfig, progress: JobProgress, host: str = "127.0.0.1") -> None:
        self.config = config
        self.progress = progress
        self.host = host
        self.port: int | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._reader: threading.Thread | None = None
        self._tail: list[str] = []
        self._lock = threading.Lock()
        self.placement = Placement()
        # Kills the child if this process is terminated without unwinding,
        # which is exactly how the supervisor stops an arm it has to stop hard.
        self._job = KillOnClose()

    # --- lifecycle -----------------------------------------------------------

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    @property
    def pid(self) -> int | None:
        return self._process.pid if self._process is not None else None

    def start(self) -> None:
        """Spawn the child and wait until the model is loaded. Idempotent."""
        if self.running:
            return

        if not self.config.server_binary.is_file():
            raise ChildFailed(
                f"{self.config.server_binary} is not there -- unpack a llama.cpp release into the "
                "arm's bin/ directory (see the arm README)"
            )
        if not self.config.model.is_file():
            raise ChildFailed(f"{self.config.model} is not there -- fetch the weights (see the arm README)")

        self.port = free_port(self.host)
        argv = self.config.argv(self.host, self.port)
        print(f"[arm] starting {' '.join(argv)}", flush=True)

        self.placement = Placement()
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

        try:
            self._job.adopt(self._process)
        except OSError as error:
            # Worth saying out loud rather than swallowing: without the job
            # object, a hard kill of this arm leaves the child on the card.
            print(f"[arm] warning: could not put the child in a job object ({error})", flush=True)

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
                raise ChildFailed(f"llama-server exited with code {code}:\n{self.tail()}")
            if self._answers():
                return
            time.sleep(READY_POLL_SECONDS)

        self.stop()
        raise ChildFailed(
            f"llama-server did not answer within {self.config.ready_timeout_seconds:.0f}s:\n{self.tail()}"
        )

    def _answers(self) -> bool:
        # 503 with "Loading model" until the weights are in; 200 after. Only the
        # 200 counts, so a started child that is still reading is "not yet".
        try:
            self.get("/health", timeout=2.0)
        except (urllib.error.URLError, OSError, ValueError):
            return False
        return True

    # --- http ----------------------------------------------------------------

    def url(self, path: str) -> str:
        if self.port is None:
            raise ChildFailed("llama-server is not running")
        return f"http://{self.host}:{self.port}{path}"

    def get(self, path: str, timeout: float = 30.0) -> Any:
        request = urllib.request.Request(self.url(path), method="GET")  # noqa: S310 - loopback only
        with urllib.request.urlopen(request, timeout=timeout) as answer:  # noqa: S310
            return json.loads(answer.read() or b"{}")

    def stream(self, path: str, body: dict[str, Any], timeout: float) -> Iterator[dict[str, Any]]:
        """POST and yield each server-sent event's JSON as it arrives.

        `timeout` is per read, not for the whole completion: a token that takes
        that long to arrive means the child has stopped, and a job that is
        still producing is never cut off by it.
        """
        payload = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(  # noqa: S310 - loopback only
            self.url(path),
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        )
        try:
            answer = urllib.request.urlopen(request, timeout=timeout)  # noqa: S310
        except urllib.error.HTTPError as error:
            raise ChildFailed(self._explain(error)) from error

        with answer:
            for raw in answer:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if data == "[DONE]":
                    return
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    if "error" in event:
                        raise ChildFailed(str(event["error"].get("message", event["error"])))
                    yield event

    @staticmethod
    def _explain(error: urllib.error.HTTPError) -> str:
        try:
            body = json.loads(error.read() or b"{}")
            message = body.get("error", {}).get("message") if isinstance(body, dict) else None
        except (json.JSONDecodeError, OSError):
            message = None
        return f"llama-server answered {error.code}: {message or error.reason}"

    # --- the log -------------------------------------------------------------

    def tail(self) -> str:
        with self._lock:
            return "\n".join(self._tail[-TAIL_LINES:])

    def _read_log(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return

        for raw in process.stdout:
            self._absorb(raw.decode("utf-8", errors="replace"))

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
        # thread, and to the placement, which is not -- hence the lock.
        match event:
            case Offload():
                with self._lock:
                    self.placement.offload = event
                self.progress.annotate("load", self.placement.summary())
            case Buffer():
                with self._lock:
                    self.placement.buffers.append(event)
                self.progress.annotate("load", self.placement.summary())
            case KvBuffer():
                with self._lock:
                    self.placement.kv_mib += event.mib
            case Fit():
                with self._lock:
                    self.placement.fit.append(event.text)
                self.progress.describe("load", event.text[:200])
            case PromptProgress():
                self.progress.meter("prompt", "Prompt tokens", event.total, event.rate)
                self.progress.advance("prompt", event.done, event.total)
            case Error():
                with self._lock:
                    self.placement.last_error = event.text
