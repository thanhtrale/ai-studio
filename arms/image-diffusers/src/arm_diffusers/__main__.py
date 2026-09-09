"""Minimal loopback HTTP server exposing only the arm health endpoint."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if self.path != "/healthz":
            self._respond(404, {"error": {"code": "not_found", "message": "unknown path"}})
            return
        self._respond(200, {"status": "ok", "arm": "image-diffusers", "version": __version__})

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        # stdout is captured by the supervisor; keep it to one line per request.
        print(f"[image-diffusers] {format % args}", flush=True)

    def _respond(self, status: int, body: dict[str, object]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_diffusers")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    if args.host not in {"127.0.0.1", "::1", "localhost"}:
        parser.error("this arm binds loopback only")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[image-diffusers] listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
