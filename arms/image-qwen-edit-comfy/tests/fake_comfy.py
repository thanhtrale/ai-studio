"""A stand-in for ComfyUI: the same API, the same log, no model.

The arm's real work is translation -- studio job in, node graph out, files and
a timeline back -- and none of that needs nineteen gigabytes of weights to be
wrong. This speaks the four endpoints the arm actually uses and prints the log
lines the arm parses, so the translation can be tested on a machine with no GPU
at all.

Run as: python fake_comfy.py --port N --output-directory DIR [every other flag]
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


# A 1x1 white PNG, built rather than embedded so the bytes are checkable.
def one_pixel_png() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return len(payload).to_bytes(4, "big") + body + zlib.crc32(body).to_bytes(4, "big")

    header = (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
    pixels = zlib.compress(b"\x00\xff\xff\xff")
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")


PNG = one_pixel_png()

history: dict[str, dict] = {}
lock = threading.Lock()
output_dir = Path()
#: Every graph the fake was asked to run, so a test can assert on what the arm
#: built rather than only on what came back.
submitted: list[dict] = []


def log(line: str) -> None:
    print(line, flush=True)


def bar(done: int, total: int) -> None:
    # The real one is tqdm, redrawing in place with a carriage return.
    percent = int(done * 100 / total)
    filled, blank = "#" * done, " " * (total - done)
    sys.stdout.write(f"\r{percent:3d}%|{filled}{blank}| {done}/{total} [00:01<00:02,  1.23it/s]")
    sys.stdout.flush()


def run_prompt(prompt_id: str, graph: dict) -> None:
    sampler = graph.get("sampler", {}).get("inputs", {})
    steps = int(sampler.get("steps", 4))
    seed = int(sampler.get("seed", 0))

    log("\x1b[32m[INFO]\x1b[0m Requested to load QwenImageTEModel_")
    log(
        "\x1b[32m[INFO]\x1b[0m Model QwenImageTEModel_ prepared for dynamic VRAM loading. "
        "9001MB Staged. 0 patches attached."
    )
    log("\x1b[32m[INFO]\x1b[0m Requested to load QwenImage")
    log(
        "\x1b[32m[INFO]\x1b[0m Model QwenImage prepared for dynamic VRAM loading. "
        "8000MB Staged. 0 patches attached."
    )

    for step in range(1, steps + 1):
        bar(step, steps)
        time.sleep(0.01)
    sys.stdout.write("\n")

    log("\x1b[32m[INFO]\x1b[0m Prompt executed in 3.21 seconds")

    prefix = graph.get("save", {}).get("inputs", {}).get("filename_prefix", "ComfyUI")
    subfolder, _, stem = str(prefix).rpartition("/")
    target = output_dir / subfolder if subfolder else output_dir
    target.mkdir(parents=True, exist_ok=True)
    filename = f"{stem}_00001_.png"
    (target / filename).write_bytes(PNG)

    with lock:
        history[prompt_id] = {
            "prompt": [0, prompt_id, graph, {}, []],
            "outputs": {
                "save": {
                    "images": [{"filename": filename, "subfolder": subfolder, "type": "output"}]
                }
            },
            "status": {"status_str": "success", "completed": True, "messages": []},
            # Echoed so a test can read the seed the graph actually carried.
            "meta": {"seed": seed},
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

        prompt_text = graph.get("positive", {}).get("inputs", {}).get("prompt", "")
        # A rejection the arm can actually reach: everything the arm validates
        # itself is refused before the child ever sees it, so the only way to
        # exercise "ComfyUI said no" is a field the arm passes straight through.
        if str(prompt_text).startswith("reject:"):
            self._send(
                400,
                {
                    "error": {"type": "prompt_outputs_failed_validation", "message": "refused"},
                    "node_errors": {},
                },
            )
            return

        with lock:
            submitted.append(graph)

        threading.Thread(target=run_prompt, args=(prompt_id, graph), daemon=True).start()
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
