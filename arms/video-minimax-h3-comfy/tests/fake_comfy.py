"""A stand-in for ComfyUI: the same API, the same log, no model.

The arm's real work is translation -- studio job in, node graph out, files and
a timeline back -- and none of that needs thirty-four gigabytes of weights to
be wrong. This speaks the endpoints the arm uses, answers the graph it builds,
and prints the log lines it parses, so the translation can be tested on a
machine with no GPU at all.

Run as: python fake_comfy.py --port N --output-directory DIR [every other flag]
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

#: Not a playable clip: the arm moves the file and measures it, and never
#: opens it. The ftyp box is here so a reader of the fixture can tell what it
#: is standing in for.
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 64

history: dict[str, dict] = {}
lock = threading.Lock()
output_dir = Path()
#: Every graph the fake was asked to run, so a test can assert on what the arm
#: built rather than only on what came back.
submitted: list[dict] = []


def log(line: str) -> None:
    print(line, flush=True)


def bar(done: int, total: int) -> None:
    percent = int(done * 100 / total)
    filled, blank = "#" * done, " " * (total - done)
    sys.stdout.write(f"\r{percent:3d}%|{filled}{blank}| {done}/{total} [00:17<00:51, 17.20s/it]")
    sys.stdout.flush()


def run_clip(prompt_id: str, graph: dict) -> None:
    steps = int(graph["sigmas"]["inputs"]["steps"])

    log("\x1b[32m[INFO]\x1b[0m Requested to load MiniMaxH3TEModel_")
    log(
        "\x1b[32m[INFO]\x1b[0m Model MiniMaxH3TEModel_ prepared for dynamic VRAM loading. "
        "17000MB Staged. 0 patches attached."
    )
    log("\x1b[32m[INFO]\x1b[0m Requested to load MiniMaxH3")
    log(
        "\x1b[32m[INFO]\x1b[0m Model MiniMaxH3 prepared for dynamic VRAM loading. "
        "15000MB Staged. 0 patches attached."
    )

    for step in range(1, steps + 1):
        bar(step, steps)
        time.sleep(0.01)
    sys.stdout.write("\n")

    log("\x1b[32m[INFO]\x1b[0m Prompt executed in 91.40 seconds")

    prefix = graph["save"]["inputs"]["filename_prefix"]
    subfolder, _, stem = str(prefix).rpartition("/")
    target = output_dir / subfolder if subfolder else output_dir
    target.mkdir(parents=True, exist_ok=True)
    filename = f"{stem}_00001_.mp4"
    (target / filename).write_bytes(MP4)

    with lock:
        history[prompt_id] = {
            "outputs": {
                "save": {
                    "images": [{"filename": filename, "subfolder": subfolder, "type": "output"}]
                }
            },
            "status": {"status_str": "success", "completed": True, "messages": []},
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/system_stats":
            self._send(200, {"system": {"comfyui_version": "fake"}, "devices": []})
            return
        if self.path.startswith("/history/"):
            prompt_id = self.path.rsplit("/", 1)[-1]
            with lock:
                entry = history.get(prompt_id)
            self._send(200, {prompt_id: entry} if entry else {})
            return
        if self.path == "/aistudio-test/submitted":
            with lock:
                self._send(200, {"graphs": list(submitted)})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/prompt":
            self._send(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        graph = body.get("prompt") or {}
        prompt_id = body.get("prompt_id") or "fake"

        # A rejection the arm can actually reach: everything the arm validates
        # itself is refused before the child sees it, so the only way to
        # exercise "ComfyUI said no" is a field passed straight through.
        text = graph.get("cond", {}).get("inputs", {}).get("prompt", "")
        if str(text).startswith("reject:"):
            self._send(
                400, {"error": {"type": "prompt_outputs_failed_validation"}, "node_errors": {}}
            )
            return

        with lock:
            submitted.append(graph)

        threading.Thread(target=run_clip, args=(prompt_id, graph), daemon=True).start()
        self._send(200, {"prompt_id": prompt_id, "number": len(submitted), "node_errors": {}})

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


def main() -> None:
    global output_dir  # one process, one output directory

    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--output-directory", required=True)
    args, _ = parser.parse_known_args()

    output_dir = Path(args.output_directory)
    output_dir.mkdir(parents=True, exist_ok=True)

    log("Total VRAM 16376 MB, total RAM 65437 MB")
    log("Starting server")
    HTTPServer((args.listen, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
