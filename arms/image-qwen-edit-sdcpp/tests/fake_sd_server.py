"""A stand-in for sd-server: the same API, the same log, no model.

The arm's real work is translation -- studio job in, child job out, images and a
timeline back -- and none of that needs twelve gigabytes of weights to be wrong.
This speaks the half of stable-diffusion.cpp's server the arm actually uses, and
prints the log lines the arm parses, so the translation can be tested on a
machine with no GPU at all.

Run as: python fake_sd_server.py --listen-port N [every flag the arm passes]
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer


# A 1x1 white PNG, built rather than embedded so the bytes are checkable.
def one_pixel_png() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return len(payload).to_bytes(4, "big") + body + zlib.crc32(body).to_bytes(4, "big")

    header = (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
    pixels = zlib.compress(b"\x00\xff\xff\xff")
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")


PNG = one_pixel_png()

state: dict[str, object] = {"job": None}
lock = threading.Lock()


def log(line: str) -> None:
    print(line, flush=True)


def bar(done: int, total: int) -> None:
    # The real one redraws in place with a carriage return and no newline.
    sys.stdout.write(f"\r  |{'=' * done}{' ' * (total - done)}| {done}/{total} - 1.23s/it")
    sys.stdout.flush()


def run_job(job_id: str, request: dict) -> None:
    batch = int(request.get("batch_count", 1))
    steps = int(request.get("sample_params", {}).get("sample_steps", 4))
    seed = int(request.get("seed", -1))

    log("[INFO ] stable-diffusion.cpp:1104 - apply_loras completed, taking 0.00s")
    log("[INFO ] stable-diffusion.cpp:1490 - get_learned_condition completed, taking 1.42s")

    for index in range(batch):
        chosen = (seed if seed >= 0 else 1000) + index
        log(f"[INFO ] stable-diffusion.cpp:1701 - generating image: {index + 1}/{batch} - seed {chosen}")
        for step in range(1, steps + 1):
            bar(step, steps)
            time.sleep(0.01)
        sys.stdout.write("\n")
        log("[INFO ] stable-diffusion.cpp:1760 - sampling completed, taking 3.20s")

    log("[INFO ] stable-diffusion.cpp:1812 - decode_first_stage completed, taking 0.80s")

    with lock:
        job = state["job"]
        assert isinstance(job, dict)
        job["status"] = "completed"
        job["result"] = {
            "output_format": "png",
            "images": [
                {"index": index, "b64_json": base64.b64encode(PNG).decode("ascii")}
                for index in range(batch)
            ],
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
        if self.path == "/sdcpp/v1/capabilities":
            self._send(200, {"modes": ["img_gen"], "samplers": ["euler", "euler_a"]})
            return
        if self.path.startswith("/sdcpp/v1/jobs/"):
            with lock:
                job = state["job"]
            if not isinstance(job, dict) or job["id"] != self.path.rsplit("/", 1)[-1]:
                self._send(404, {"error": "no such job"})
                return
            self._send(200, job)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/sdcpp/v1/img_gen":
            self._send(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        request = json.loads(self.rfile.read(length) or b"{}")

        # A rejection the arm can actually reach: everything the arm validates
        # itself is refused before the child ever sees it, so the only way to
        # exercise "the child said no" is a field the arm passes straight
        # through.
        if str(request.get("prompt", "")).startswith("reject:"):
            self._send(400, {"error": "the stand-in was asked to refuse this"})
            return

        job_id = "job_fake_1"
        with lock:
            state["job"] = {"id": job_id, "kind": "img_gen", "status": "generating", "result": None}
        threading.Thread(target=run_job, args=(job_id, request), daemon=True).start()
        self._send(202, {"id": job_id, "status": "queued", "poll_url": f"/sdcpp/v1/jobs/{job_id}"})

    def log_message(self, *_: object) -> None:
        """Silence the access log; the generation log is the point."""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen-ip", default="127.0.0.1")
    parser.add_argument("--listen-port", type=int, required=True)
    parser.add_argument("--diffusion-model", default="")
    parser.add_argument("--vae", default="")
    parser.add_argument("--llm", default="")
    parser.add_argument("--llm_vision", default="")
    parser.add_argument("--threads", default="")
    parser.add_argument("--model-args", default="")
    parser.add_argument("--offload-to-cpu", action="store_true")
    parser.add_argument("--diffusion-fa", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    log(f"[INFO ] model.cpp:120 - loading model from '{args.diffusion_model}'")
    time.sleep(0.05)
    log("[INFO ] model.cpp:400 - loading model from cache completed, taking 0.05s")

    HTTPServer((args.listen_ip, args.listen_port), Handler).serve_forever()


if __name__ == "__main__":
    main()
