"""Loopback HTTP server for the Make-It-Animatable rig arm.

The studio's contract: `/healthz` (which also lists the clips the arm can put
on a rig), `/generate`, `/progress`, `/stats`. The three networks are loaded
on the first job and stay; Blender runs per job in a process of its own.
"""

from __future__ import annotations

import gc
import json
import os
import threading
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import __version__
from .builtin_clips import BUILTIN
from .engine import Engine
from .generation import BlenderFailed, JobError, available_clips, generate, parse_job
from .progress import JobProgress

ARM_ID = "rig-make-it-animatable"
MAX_BODY_BYTES = 64 * 1024


class Busy(RuntimeError):
    pass


class ArmState:
    def __init__(
        self, engine: Engine, out_dir: Path, in_dir: Path, clip_dir: Path, template: Path, scratch: Path
    ) -> None:
        self.engine = engine
        self.out_dir = out_dir
        self.in_dir = in_dir
        self.clip_dir = clip_dir
        self.template = template
        self.scratch = scratch
        self.progress = JobProgress(vram_gib=self.vram_gib)
        self._gpu = threading.Lock()

    def clips(self) -> list[str]:
        return sorted(BUILTIN) + [name for name in available_clips(self.clip_dir) if name not in BUILTIN]

    def vram_gib(self) -> float | None:
        try:
            import torch

            if not torch.cuda.is_available():
                return None
            return torch.cuda.memory_reserved() / 2**30
        except Exception:  # noqa: BLE001 - a meter must never fail a job
            return None

    @property
    def loaded(self) -> bool:
        return self.engine.loaded

    def run(self, body: dict[str, Any]) -> dict[str, Any]:
        job = parse_job(body, self.out_dir, self.in_dir, self.clip_dir)
        raw_id = body.get("jobId")
        job_id = raw_id if isinstance(raw_id, str) and raw_id else None
        if not self._gpu.acquire(blocking=False):
            raise Busy("a rig is already running")
        try:
            self.progress.begin(job_id)
            if not self.engine.loaded:
                with self.progress.step(
                    "load", "Load rig models", "joints, weights, pose · Hunyuan3D 2.1 VAE"
                ):
                    self.engine.load()
            self.progress.sample_vram()
            report = generate(self.engine, job, self.progress, self.scratch, self.template)
            self.progress.finish()
        except Exception as error:
            self.progress.fail(f"{type(error).__name__}: {error}")
            raise
        finally:
            gc.collect()
            self._gpu.release()
        print(
            f"[{ARM_ID}] rigged {job.mesh_path.name} in {report.seconds_total:.1f}s: {report.clips}",
            flush=True,
        )
        return asdict(report)

    def shutdown(self) -> None:
        pass


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
                        "model": "make-it-animatable-v2",
                        "clips": state.clips(),
                    },
                )
                return

            if path == "/progress":
                self._respond(200, state.progress.snapshot())
                return

            if path == "/stats":
                self._respond(
                    200,
                    {
                        "loaded": state.loaded,
                        "pid": os.getpid(),
                        "vramGib": state.vram_gib(),
                        "vramScope": "process",
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
            except BlenderFailed as error:
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
    print(f"[{ARM_ID}] out={state.out_dir} in={state.in_dir}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        state.shutdown()
