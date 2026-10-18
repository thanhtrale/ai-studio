"""Loopback HTTP server for the character rig arm and its CPU tools.

The contract is the studio's: `/healthz`, `/generate`, `/progress`, `/stats`.
One package serves two manifests -- `rig-mia-skintokens` (`--role rig`, holds
the card) and `mesh-char3d-tools` (`--role tools`, declares no GPU) -- because
both run the same vendored scripts on the same interpreter, and the only thing
that differs is whether the supervisor has to clear the card first.

Nothing is loaded at start. Each job is a script run in a process of its own
(see `runner.py`), so the arm is reachable as soon as it listens and holds no
memory between jobs: what a rig costs the card is returned when it ends.
"""

from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import __version__, vram
from .progress import JobProgress
from .runner import ScriptFailed, ScriptRunner
from .tasks import ROLE_TASKS, JobError, Roots, parse_job

ARM_IDS = {"rig": "rig-mia-skintokens", "tools": "mesh-char3d-tools"}
MAX_BODY_BYTES = 256 * 1024


class Busy(RuntimeError):
    pass


@dataclass
class Report:
    task: str
    seconds_total: float
    peak_vram_gib: float
    vram_scope: str
    stages: list[dict[str, Any]]
    #: The script's own `done` event: absolute paths under `outputDir`, and
    #: whatever it measured (clips, stretch, handInBody, the cross-check).
    result: dict[str, Any]


class ArmState:
    """Owns the script runner and serialises jobs."""

    def __init__(
        self, role: str, roots: Roots, runner_env: dict[str, str], scripts_dir: Path, python: Path
    ) -> None:
        if role not in ROLE_TASKS:
            raise ValueError(f"role must be one of {', '.join(ROLE_TASKS)}")
        self.role = role
        self.arm_id = ARM_IDS[role]
        self.roots = roots
        self.progress = JobProgress(vram_gib=self.vram_gib)
        self.runner = ScriptRunner(scripts_dir, python, runner_env, self.progress)
        self.vram_scope: vram.Scope | None = None
        self._lock = threading.Lock()

    def vram_gib(self) -> float | None:
        """What the running script holds, or the whole card where that is all there is.

        SkinTokens runs as a grandchild of the rig script, so a per-process
        figure would miss it; on GeForce under Windows the honest answer is the
        card's anyway, and the scope travels with the number.
        """
        pid = self.runner.pid
        if pid is None:
            return None
        if self.vram_scope is None:
            self.vram_scope = vram.probe(pid)
        if self.vram_scope == "process":
            return vram.used_gib({pid})
        if self.vram_scope == "card":
            return vram.card_gib()
        return None

    def run(self, body: dict[str, Any]) -> dict[str, Any]:
        job = parse_job(body, self.role, self.roots)
        raw_id = body.get("jobId")
        job_id = raw_id if isinstance(raw_id, str) and raw_id else None

        if not self._lock.acquire(blocking=False):
            raise Busy("a job is already running")
        try:
            self.progress.begin(job_id)
            result = self.runner.run(job)
            self.progress.finish()
        except Exception as error:
            self.progress.fail(f"{type(error).__name__}: {error}")
            raise
        finally:
            self._lock.release()

        report = Report(
            task=result.task,
            seconds_total=result.seconds,
            peak_vram_gib=self.progress.peak_gib,
            vram_scope=self.vram_scope or "unavailable",
            stages=result.stages,
            result=result.result,
        )
        print(f"[{self.arm_id}] {result.task} done in {result.seconds:.1f}s", flush=True)
        return asdict(report)

    def shutdown(self) -> None:
        self.runner.stop()


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
                        "arm": state.arm_id,
                        "version": __version__,
                        "role": state.role,
                        "tasks": list(ROLE_TASKS[state.role]),
                        # A script per job: nothing is ever resident.
                        "loaded": False,
                    },
                )
                return
            if path == "/progress":
                self._respond(200, state.progress.snapshot())
                return
            if path == "/stats":
                self._respond(
                    200,
                    {"pid": state.runner.pid, "vramGib": state.vram_gib(), "vramScope": state.vram_scope},
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
            except ScriptFailed as error:
                self._error(500, "arm_error", str(error))
            except Exception as error:  # noqa: BLE001 - the arm must not die on one bad job
                self._error(500, "arm_error", f"{type(error).__name__}: {error}")

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            print(f"[{state.arm_id}] {format % args}", flush=True)

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
    print(f"[{state.arm_id}] listening on http://{host}:{port} (role {state.role})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        state.shutdown()
