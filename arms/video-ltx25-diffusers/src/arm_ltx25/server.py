"""Loopback HTTP server for the LTX-2.5 arm.

Weights are loaded on the first job, not at startup. Reading 66 GiB and pinning
it takes long enough that a health check gated on it would time out, and the
supervisor's contract is that a started arm is reachable -- not that it is warm.
"""

from __future__ import annotations

import json
import threading
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import __version__
from .generation import JobError, generate, parse_job
from .loading import LoadConfig, host_rss_gib, load_pipeline, vram_snapshot
from .progress import JobProgress

ARM_ID = "video-ltx25-diffusers"
MAX_BODY_BYTES = 64 * 1024


class ArmState:
    """Owns the pipeline and serialises access to the GPU."""

    def __init__(self, config: LoadConfig, out_dir: Any, in_dir: Any) -> None:
        self.config = config
        self.out_dir = out_dir
        self.in_dir = in_dir
        self._pipe: Any | None = None
        self._load_report: Any | None = None
        # One job at a time on the card, so one timeline is enough. A caller
        # polls it by job id and is told nothing if the arm has moved on.
        self.progress = JobProgress()
        # One generation at a time. A second concurrent run would double peak
        # VRAM on a card that is already oversubscribed.
        self._gpu = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._pipe is not None

    @property
    def load_report(self) -> dict[str, Any] | None:
        return asdict(self._load_report) if self._load_report is not None else None

    def run(self, body: dict[str, Any]) -> dict[str, Any]:
        job = parse_job(body, self.out_dir, self.in_dir)
        raw_id = body.get("jobId")
        job_id = raw_id if isinstance(raw_id, str) and raw_id else None

        if not self._gpu.acquire(blocking=False):
            # Deliberately before `begin`: a rejected job must not wipe the
            # timeline of the one that is actually running.
            raise Busy("a generation is already running")
        try:
            self.progress.begin(job_id)
            if self._pipe is None:
                print(f"[{ARM_ID}] loading {self.config.model_dir} ({self.config.precision})", flush=True)
                # 66 GiB across PCIe, and the single longest step of a first job.
                # Reported as its own step so it is never mistaken for a hang.
                with self.progress.step(
                    "load", "Load model", f"{self.config.precision} · offload {self.config.offload}"
                ) as reported:
                    self._pipe, self._load_report = load_pipeline(self.config, self.progress)
                    # Split, because the two halves have different cures: the
                    # imports are a fixed process cost, the weights are bytes
                    # off NVMe at the drive's own rate.
                    reported.detail(
                        f"{type(self._pipe).__name__} · imports "
                        f"{self._load_report.import_seconds:.1f}s · weights "
                        f"{self._load_report.seconds:.1f}s · {self.config.precision}"
                        f" · offload {self.config.offload}"
                    )
                print(f"[{ARM_ID}] loaded in {self._load_report.seconds:.1f}s", flush=True)

            report = generate(self._pipe, job, self.config.model_dir, self.progress)
            self.progress.finish()
        except Exception as error:
            self.progress.fail(f"{type(error).__name__}: {error}")
            raise
        finally:
            self._gpu.release()

        print(
            f"[{ARM_ID}] generated {report.out_path} in {report.seconds_total:.1f}s "
            f"(peak vram {report.peak_vram_reserved_gib:.2f} GiB)",
            flush=True,
        )
        return asdict(report)


class Busy(RuntimeError):
    pass


def build_handler(state: ArmState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
            if self.path == "/healthz":
                self._respond(
                    200,
                    {
                        "status": "ok",
                        "arm": ARM_ID,
                        "version": __version__,
                        "loaded": state.loaded,
                        "precision": state.config.precision,
                        "offload": state.config.offload,
                    },
                )
                return

            if self.path.split("?")[0] == "/progress":
                self._respond(200, state.progress.snapshot())
                return

            if self.path == "/stats":
                self._respond(
                    200,
                    {
                        "loaded": state.loaded,
                        "load": state.load_report,
                        "vram": vram_snapshot(),
                        "host_rss_gib": host_rss_gib(),
                    },
                )
                return

            self._error(404, "not_found", "unknown path")

        def do_POST(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
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
            except FileNotFoundError as error:
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
    print(f"[{ARM_ID}] model={state.config.model_dir} out={state.out_dir} in={state.in_dir}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
