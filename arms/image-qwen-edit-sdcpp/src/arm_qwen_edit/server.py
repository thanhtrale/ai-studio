"""Loopback HTTP server for the Qwen-Image-Edit arm.

The contract is the studio's, not stable-diffusion.cpp's: `/healthz`,
`/generate`, `/progress`, `/stats`. Translating between the two is the whole
job of this arm, and keeping the translation here means the supervisor stays
ignorant of what a sampler is -- which is what lets the next arm be something
else entirely.

The child is started on the first job rather than at startup, for the same
reason the video arm defers loading weights: a health check gated on twelve
gigabytes coming off NVMe would time out, and a started arm is meant to be
reachable, not warm.
"""

from __future__ import annotations

import json
import threading
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import __version__, vram
from .generation import JobError, generate, parse_job
from .progress import JobProgress
from .runtime import ChildFailed, LoadConfig, SdServer

ARM_ID = "image-qwen-edit-sdcpp"
# Reference images arrive as paths, not bytes, so a job body stays small.
MAX_BODY_BYTES = 256 * 1024


class Busy(RuntimeError):
    pass


class ArmState:
    """Owns the child process and serialises access to the GPU."""

    def __init__(self, config: LoadConfig, out_dir: Path, in_dir: Path) -> None:
        self.config = config
        self.out_dir = out_dir
        self.in_dir = in_dir
        # One timeline per arm, reset per job: the log reader writes to it from
        # its own thread for as long as the child lives.
        self.progress = JobProgress(vram_gib=self.vram_gib)
        # Decided once, when there is a child to ask about. Until then there is
        # nothing to measure and no way to know what kind of answer exists.
        self.vram_scope: vram.Scope | None = None
        self.server = SdServer(config, self.progress)
        # One generation at a time. The child would queue a second job itself,
        # but then two jobs would share one timeline and neither would read right.
        self._gpu = threading.Lock()

    def vram_gib(self) -> float | None:
        """One reading, of whatever this machine is able to report.

        A GeForce card under Windows will not attribute memory to a process, so
        on this machine the honest answer is a whole-card figure -- and the
        scope travels with every number so nothing reads it as this arm's own
        share. See `vram.py`.
        """
        pid = self.server.pid
        if pid is None:
            return None

        if self.vram_scope is None:
            self.vram_scope = vram.probe(pid)

        if self.vram_scope == "process":
            return vram.used_gib({pid})
        if self.vram_scope == "card":
            return vram.card_gib()
        return None

    @property
    def loaded(self) -> bool:
        return self.server.running

    def run(self, body: dict[str, Any]) -> dict[str, Any]:
        job = parse_job(body, self.out_dir, self.in_dir)
        raw_id = body.get("jobId")
        job_id = raw_id if isinstance(raw_id, str) and raw_id else None

        if not self._gpu.acquire(blocking=False):
            # Before `begin`, so a rejected job cannot wipe the timeline of the
            # one that is actually running.
            raise Busy("a generation is already running")

        try:
            self.progress.begin(job_id)
            if not self.server.running:
                with self.progress.step("start", "Start sd-server", str(self.config.diffusion_model.name)):
                    self.server.start()
                print(f"[{ARM_ID}] sd-server up on port {self.server.port}", flush=True)
                # One reading straight away, so the first job's chart starts at
                # the load rather than at the sampler thread's next tick.
                self.progress.sample_vram()

            report = generate(self.server, job, self.progress)
            # After the job, not before: the scope is discovered by taking a
            # reading, and the first reading happens once the child is up.
            report.vram_scope = self.vram_scope or "unavailable"
            self.progress.finish()
        except Exception as error:
            self.progress.fail(f"{type(error).__name__}: {error}")
            raise
        finally:
            self._gpu.release()

        print(
            f"[{ARM_ID}] wrote {len(report.images)} image(s) in {report.seconds_total:.1f}s "
            f"(peak vram {report.peak_vram_gib:.2f} GiB, scope {report.vram_scope})",
            flush=True,
        )
        return asdict(report)

    def shutdown(self) -> None:
        self.server.stop()


def build_handler(state: ArmState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            path = self.path.split("?")[0]

            if path == "/healthz":
                self._respond(
                    200,
                    {
                        "status": "ok",
                        "arm": ARM_ID,
                        "version": __version__,
                        "loaded": state.loaded,
                        "model": state.config.diffusion_model.name,
                    },
                )
                return

            if path == "/progress":
                self._respond(200, state.progress.snapshot())
                return

            if path == "/stats":
                pid = state.server.pid
                self._respond(
                    200,
                    {
                        "loaded": state.loaded,
                        "pid": pid,
                        "port": state.server.port,
                        "vramGib": state.vram_gib(),
                        "vramScope": state.vram_scope,
                        "tail": state.server.tail().splitlines()[-10:],
                    },
                )
                return

            self._error(404, "not_found", "unknown path")

        def do_POST(self) -> None:
            if self.path != "/generate":
                self._error(404, "not_found", "unknown path")
                return

            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                self._error(413, "invalid_request", "request body too large")
                return

            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError as error:
                self._error(400, "invalid_request", f"malformed JSON: {error}")
                return
            if not isinstance(body, dict):
                self._error(400, "invalid_request", "body must be a JSON object")
                return

            try:
                self._respond(200, state.run(body))
            except JobError as error:
                self._error(400, "invalid_params", str(error))
            except Busy as error:
                self._error(409, "arm_busy", str(error))
            except ChildFailed as error:
                self._error(500, "arm_error", str(error))
            except Exception as error:  # noqa: BLE001 - the arm must not die on one bad job
                self._error(500, "arm_error", f"{type(error).__name__}: {error}")

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            print(f"[{ARM_ID}] {format % args}", flush=True)

        def _error(self, status: int, code: str, message: str) -> None:
            self._respond(status, {"error": {"code": code, "message": message}})

        def _respond(self, status: int, body: dict[str, Any]) -> None:
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


def serve(host: str, port: int, state: ArmState) -> None:
    server = ThreadingHTTPServer((host, port), build_handler(state))
    print(f"[{ARM_ID}] listening on http://{host}:{port}", flush=True)
    print(
        f"[{ARM_ID}] model={state.config.diffusion_model} out={state.out_dir} in={state.in_dir}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        # The child holds the card. Leaving it behind would strand the GPU
        # against an arm the supervisor has already stopped.
        state.shutdown()
