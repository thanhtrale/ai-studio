"""The ComfyUI child: starting it, watching it, and shutting it down.

Why a child at all rather than importing ComfyUI into this process: ComfyUI
owns a global torch device, a node registry and an asyncio server, and it
expects to be the program. Hosting it in-process would make this arm's HTTP
contract a hostage to its event loop, and a wedged sampler would take the
arm's `/progress` endpoint down with it -- which is exactly the endpoint you
need when a sampler wedges.

The child is started by the first job, not at arm start. Importing torch and
reading a seven gigabyte checkpoint takes longer than any sensible health-check
timeout, and
the supervisor's contract is that a started arm is reachable, not that it is
warm.
"""

from __future__ import annotations

import json
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import comfyws
from .jobobject import KillOnClose
from .logscan import model_label, parse_line, split_stream
from .progress import JobProgress

READY_POLL_SECONDS = 0.5
#: Between websocket reconnects. The socket only carries detail; losing it for
#: a second costs a line of the timeline, never the job.
WS_RETRY_SECONDS = 1.0
# ComfyUI imports torch and scans every node module before it binds. Cold, on
# this machine, that is tens of seconds; the ceiling is generous because the
# failure it guards against is a child that never binds at all.
READY_TIMEOUT_SECONDS = 300.0
# Enough to show why a child died during start, and not so much that a job's
# worth of progress bars pushes the reason out of the window.
TAIL_LINES = 80

VRAM_MODE_FLAGS: dict[str, list[str]] = {
    "dynamic": [],
    "highvram": ["--highvram"],
    "lowvram": ["--lowvram"],
    "novram": ["--novram"],
}

ATTENTION_FLAGS: dict[str, list[str]] = {
    "pytorch": ["--use-pytorch-cross-attention"],
    "sage": ["--use-sage-attention"],
    "flash": ["--use-flash-attention"],
    "split": ["--use-split-cross-attention"],
    "quad": ["--use-quad-cross-attention"],
}

CACHE_MODE_FLAGS: dict[str, list[str]] = {
    "ram": [],
    "classic": ["--cache-classic"],
    # Ten node results: the loaders, the encodes and a sampler, which is what a
    # batch needs kept so its second image does not re-encode the prompt.
    "lru": ["--cache-lru", "10"],
    "none": ["--cache-none"],
}


class ChildFailed(RuntimeError):
    """ComfyUI would not start, or died while it was meant to be serving."""


@dataclass
class LoadConfig:
    """Everything that decides how ComfyUI reads its weights.

    All of it is start-time: changing any of it means a different child
    process, which is exactly what the supervisor's broker restarts an arm for.
    """

    comfy_dir: Path
    #: The Hunyuan3D checkpoint: DiT, DINOv2 image encoder and shape VAE in one
    #: file, which is why there is one path here rather than three.
    checkpoint: Path
    #: BiRefNet, for cutting the object out of its photograph.
    bg_model: Path
    input_dir: Path
    scratch_dir: Path
    vram_mode: str = "dynamic"
    attention: str = "pytorch"
    reserve_vram: float = 0.8
    cache_mode: str = "ram"
    extra_args: str = ""

    @property
    def main(self) -> Path:
        return self.comfy_dir / "main.py"

    def model_search_paths(self) -> dict[str, str]:
        """Which directory ComfyUI searches for each kind of weight.

        Derived from the two files rather than configured separately: the
        supervisor has already proven each path is inside managed storage, and
        a setting naming a directory would be one more thing that can disagree
        with the files.
        """
        return {
            "checkpoints": str(self.checkpoint.parent),
            "background_removal": str(self.bg_model.parent),
        }

    def write_model_paths(self) -> Path:
        """`extra_model_paths.yaml`, written fresh on every start.

        Hand-rolled rather than via PyYAML, which is a dependency of the child
        and not of this arm. The values are absolute paths the supervisor
        produced, and they are quoted, so a directory with a colon or a space
        in it stays one scalar.
        """
        target = self.scratch_dir / "extra_model_paths.yaml"
        lines = ["# Written by the arm on every start. Edits here are overwritten.", "aistudio:"]
        for key, value in self.model_search_paths().items():
            escaped = value.replace("\\", "/").replace('"', '\\"')
            lines.append(f'  {key}: "{escaped}"')
        target.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return target

    def argv(self, host: str, port: int, model_paths: Path) -> list[str]:
        output_dir = self.scratch_dir / "output"
        temp_dir = self.scratch_dir / "temp"
        user_dir = self.scratch_dir / "user"

        args = [
            sys.executable,
            str(self.main),
            "--listen",
            host,
            "--port",
            str(port),
            "--disable-auto-launch",
            # Nothing in this arm reaches the network, and a node that did
            # would do it with the studio's card and none of its consent.
            "--disable-api-nodes",
            # The graph is built here, from ComfyUI's own blueprint. A custom
            # node folder left behind by a previous experiment would change
            # what a job means without changing anything the studio records.
            "--disable-all-custom-nodes",
            "--disable-manager-ui",
            # Previews would decode a latent every few steps to produce an
            # image nobody is watching: this arm reports numbers, not frames.
            "--preview-method",
            "none",
            "--extra-model-paths-config",
            str(model_paths),
            "--input-directory",
            str(self.input_dir),
            "--output-directory",
            str(output_dir),
            "--temp-directory",
            str(temp_dir),
            "--user-directory",
            str(user_dir),
            "--log-stdout",
        ]
        args += VRAM_MODE_FLAGS.get(self.vram_mode, [])
        args += ATTENTION_FLAGS.get(self.attention, [])
        args += CACHE_MODE_FLAGS.get(self.cache_mode, [])
        if self.reserve_vram > 0:
            args += ["--reserve-vram", f"{self.reserve_vram:g}"]
        if self.extra_args:
            args += shlex.split(self.extra_args)
        return args


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
    """What the log said about the prompt currently running."""

    steps_total: int = 0
    steps_done: int = 0
    rate: str = ""
    last_error: str | None = None
    #: Set while a job is running, so load phases are attributed to that job's
    #: timeline instead of appearing under whatever ran last.
    active: bool = False
    #: The prompt this scan is for, so a websocket event for another is ignored.
    prompt_id: str | None = None
    #: Graph node id -> what the timeline calls it. Nodes not named here --
    #: loaders, model patches -- run without a line of their own.
    labels: dict[str, str] = field(default_factory=dict)
    #: The node the websocket last said was running, as a timeline key.
    current: str | None = None
    #: Named nodes finished or served from cache, for the node meter.
    finished: set[str] = field(default_factory=set)
    #: Per node: (time, value) of the previous progress tick, for a rate.
    ticks: dict[str, tuple[float, int]] = field(default_factory=dict)


class ComfyServer:
    """One ComfyUI process, its log, and the timeline it feeds."""

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
        # "Requested to load X" and its completion are separate lines, and only
        # one of the two completion forms ComfyUI has names the model. So steps
        # are keyed by model name, for the form that can be matched exactly,
        # and also queued, for the form that cannot: ComfyUI announces a group
        # of models before loading any of them, but in the order it loads them.
        self._loading: deque[str] = deque()
        # Kills the child if this process is terminated without unwinding,
        # which is exactly how the supervisor stops an arm it has to stop hard.
        self._job = KillOnClose()
        # ComfyUI addresses websocket events to the client that queued the
        # prompt, so every prompt carries this id and the socket subscribes as it.
        self.client_id = uuid.uuid4().hex
        self._ws: threading.Thread | None = None
        #: True while the socket is up. The log's sampler bar is ignored then:
        #: the socket says the same thing, per node rather than all in one bar.
        self.ws_live = False

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

        if not self.config.main.is_file():
            raise ChildFailed(
                f"{self.config.main} is not there -- this arm runs on the image-qwen-edit-comfy "
                "arm's ComfyUI checkout, so install that arm first (see both READMEs)"
            )

        for directory in ("output", "temp", "user"):
            (self.config.scratch_dir / directory).mkdir(parents=True, exist_ok=True)
        model_paths = self.config.write_model_paths()

        self.port = free_port(self.host)
        argv = self.config.argv(self.host, self.port, model_paths)
        print(f"[arm] starting {' '.join(argv)}", flush=True)

        try:
            self._process = subprocess.Popen(  # noqa: S603 - argv built from validated config
                argv,
                cwd=str(self.config.comfy_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
        except OSError as error:
            raise ChildFailed(f"could not start {self.config.main}: {error}") from error

        try:
            self._job.adopt(self._process)
        except OSError as error:
            # Worth saying out loud rather than swallowing: without the job
            # object, a hard kill of this arm leaves ComfyUI on the card.
            print(f"[arm] warning: could not put the child in a job object ({error})", flush=True)

        self._reader = threading.Thread(target=self._read_log, daemon=True)
        self._reader.start()
        self._await_ready()

        self._ws = threading.Thread(target=self._follow_socket, args=(self._process,), daemon=True)
        self._ws.start()

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
        deadline = time.monotonic() + READY_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            process = self._process
            if process is None or process.poll() is not None:
                code = process.returncode if process else "unknown"
                raise ChildFailed(f"ComfyUI exited with code {code}:\n{self.tail()}")
            if self._answers():
                return
            time.sleep(READY_POLL_SECONDS)

        self.stop()
        raise ChildFailed(f"ComfyUI did not answer within {READY_TIMEOUT_SECONDS:.0f}s:\n{self.tail()}")

    def _answers(self) -> bool:
        try:
            self.get("/system_stats", timeout=2.0)
        except (urllib.error.URLError, OSError, ValueError):
            return False
        return True

    # --- http ----------------------------------------------------------------

    def url(self, path: str) -> str:
        if self.port is None:
            raise ChildFailed("ComfyUI is not running")
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
        try:
            with urllib.request.urlopen(request, timeout=timeout) as answer:  # noqa: S310
                return json.loads(answer.read() or b"{}")
        except urllib.error.HTTPError as error:
            # ComfyUI answers a graph it will not run with 400 and a body
            # naming the node and the input. That body is the whole diagnosis,
            # and urllib would otherwise throw it away.
            detail = error.read().decode("utf-8", errors="replace")
            raise ChildFailed(f"ComfyUI refused the prompt ({error.code}): {detail}") from error

    # --- the log -------------------------------------------------------------

    def tail(self) -> str:
        with self._lock:
            return "\n".join(self._tail[-TAIL_LINES:])

    def begin_scan(
        self, steps_total: int, prompt_id: str | None = None, labels: dict[str, str] | None = None
    ) -> JobScan:
        with self._lock:
            self.scan = JobScan(
                steps_total=steps_total, active=True, prompt_id=prompt_id, labels=dict(labels or {})
            )
            # A load left open by the previous prompt must not swallow this
            # one's first "loaded" line and report someone else's duration.
            self._loading.clear()
            return self.scan

    def end_scan(self) -> None:
        with self._lock:
            current = self.scan.current
            self.scan.current = None
            self.scan.active = False
        # A node still open here is one the socket never saw end -- the prompt
        # failed in it, or the socket dropped. Either way it stops counting.
        if current is not None:
            self.progress.finish_step(current)

    # --- the websocket -------------------------------------------------------

    def _follow_socket(self, process: subprocess.Popen[bytes]) -> None:
        """Read ComfyUI's events for as long as this child lives, reconnecting."""
        while self._process is process and process.poll() is None:
            port = self.port
            if port is None:
                return
            try:
                comfyws.listen(self.host, port, self.client_id, self._on_socket, on_open=self._socket_open)
            except (OSError, comfyws.Closed, ValueError):
                pass
            finally:
                self.ws_live = False
            time.sleep(WS_RETRY_SECONDS)

    def _socket_open(self) -> None:
        self.ws_live = True

    def _named(self, data: dict[str, Any]) -> tuple[str, str] | None:
        """The (node, label) an event is about, if it is this job's and named."""
        node = data.get("node")
        with self._lock:
            scan = self.scan
            if not scan.active or not isinstance(node, str):
                return None
            prompt = data.get("prompt_id")
            if prompt is not None and scan.prompt_id is not None and prompt != scan.prompt_id:
                return None
            label = scan.labels.get(node)
        return (node, label) if label is not None else None

    def _node_meter(self) -> None:
        with self._lock:
            total, done = len(self.scan.labels), len(self.scan.finished)
        if total:
            self.progress.meter("nodes", "Nodes", total)
            self.progress.advance("nodes", done, total)

    def _close_current(self) -> None:
        with self._lock:
            current = self.scan.current
            self.scan.current = None
            if current is not None:
                self.scan.finished.add(current.removeprefix("node:"))
        if current is not None:
            self.progress.finish_step(current)
        self._node_meter()

    def _on_socket(self, event: comfyws.Event) -> None:
        kind, data = event.kind, event.data

        if kind == "executing":
            prompt = data.get("prompt_id")
            with self._lock:
                ours = self.scan.active and (prompt is None or prompt == self.scan.prompt_id)
            if not ours:
                return
            # A new node starting is the previous one finishing: ComfyUI runs
            # them one at a time and says nothing else when one ends.
            self._close_current()
            named = self._named(data)
            if named is not None:
                node, label = named
                key = f"node:{node}"
                self.progress.start(key, label, parent="generate")
                with self._lock:
                    self.scan.current = key
            return

        if kind == "execution_cached":
            nodes = data.get("nodes") or []
            with self._lock:
                if not self.scan.active or data.get("prompt_id") not in (None, self.scan.prompt_id):
                    return
                cached = [node for node in nodes if node in self.scan.labels]
                self.scan.finished.update(cached)
            for node in cached:
                key = f"node:{node}"
                self.progress.start(key, self.scan.labels[node], "cached", parent="generate")
                self.progress.finish_step(key, detail="cached", seconds=0.0)
            self._node_meter()
            return

        if kind == "progress":
            named = self._named(data)
            value, total = data.get("value"), data.get("max")
            if named is None or not isinstance(value, int) or not isinstance(total, int) or total <= 0:
                return
            node, label = named
            now = time.monotonic()
            with self._lock:
                previous = self.scan.ticks.get(node)
                self.scan.ticks[node] = (now, value)
            rate = ""
            if previous is not None and value > previous[1]:
                per = (now - previous[0]) / (value - previous[1])
                rate = f"{per:.2f}s/it" if per >= 1 else f"{1 / per:.2f}it/s"
            if total <= 1:
                # A node that reports a single tick has nothing to count; its
                # own progress text, if it sends one, says more.
                return
            # One meter per node, so four samplers are four bars rather than
            # one bar that fills four times.
            self.progress.meter(f"progress:{node}", label, total, detail=rate or None)
            self.progress.advance(f"progress:{node}", value, total)
            self.progress.describe(f"node:{node}", f"{value}/{total}" + (f" · {rate}" if rate else ""))
            return

        if kind == "progress_text":
            named = self._named(data)
            text = str(data.get("text") or "").strip()
            if named is not None and text:
                self.progress.describe(f"node:{named[0]}", text[:160])
            return

        if kind in ("execution_success", "execution_error", "execution_interrupted"):
            with self._lock:
                ours = self.scan.active and data.get("prompt_id") in (None, self.scan.prompt_id)
            if ours:
                self._close_current()

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

        with self._lock:
            active = self.scan.active

        if event.kind == "error":
            with self._lock:
                self.scan.last_error = event.text
            return

        # Load phases and the sampler bar only mean something while a job owns
        # the timeline. Outside one they are the child talking to itself.
        if not active:
            return

        if event.kind == "phase":
            key = f"load:{event.name}"
            with self._lock:
                if key not in self._loading:
                    self._loading.append(key)
            self.progress.start(key, model_label(event.name), event.name, parent="generate")
            return

        if event.kind == "staged":
            self._finish_load(f"load:{event.name}", event.total or 0, "staged")
            return

        if event.kind == "loaded":
            with self._lock:
                key = self._loading[0] if self._loading else None
            if key is not None:
                self._finish_load(key, event.total or 0, event.name)
            return

        if event.kind == "progress" and event.index is not None and event.total is not None:
            if self.ws_live:
                # The socket is counting the same steps per node; one bar fed
                # by every sampler in turn is exactly what it replaces.
                return
            with self._lock:
                self.scan.steps_done = event.index
                self.scan.steps_total = event.total
                self.scan.rate = event.rate
            self.progress.meter("steps", "Sampler steps", event.total, detail=event.rate)
            self.progress.advance("steps", event.index, event.total)

    def _finish_load(self, key: str, megabytes: int, how: str) -> None:
        """Close a load step, if it is one this job opened.

        Silent about a key it does not know: ComfyUI reports on a model it had
        already staged without announcing a request for it, and inventing a
        step for that would show a load that did not happen.
        """
        with self._lock:
            if key not in self._loading:
                return
            self._loading.remove(key)
        self.progress.finish_step(key, detail=f"{how} · {megabytes / 1024.0:.2f} GiB")
