"""A stand-in for ComfyUI: the same API, the same log, no model.

The arm's real work is translation -- studio job in, node graph out, files and
a timeline back -- and none of that needs seven gigabytes of weights to be
wrong. This speaks the four endpoints the arm actually uses and prints the log
lines the arm parses, so the translation can be tested on a machine with no GPU
at all.

Run as: python fake_comfy.py --port N --output-directory DIR [every other flag]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def tiny_glb(vertices: int = 3, faces: int = 1) -> bytes:
    """A GLB whose JSON chunk names one primitive, padded the way the spec asks.

    No buffer data: the arm reads counts from the accessors and nothing else,
    so the bytes behind them would be decoration.
    """
    document = {
        "asset": {"version": "2.0"},
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "accessors": [
            {"count": vertices, "componentType": 5126, "type": "VEC3"},
            {"count": faces * 3, "componentType": 5125, "type": "SCALAR"},
        ],
    }
    payload = json.dumps(document).encode("utf-8")
    payload += b" " * (-len(payload) % 4)
    chunk = len(payload).to_bytes(4, "little") + b"JSON" + payload
    total = 12 + len(chunk)
    return b"glTF" + (2).to_bytes(4, "little") + total.to_bytes(4, "little") + chunk


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


#: client id -> open websocket connections, as ComfyUI addresses its events.
sockets: dict[str, list] = {}
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _ws_frame(opcode: int, payload: bytes) -> bytes:
    # Server frames are unmasked.
    length = len(payload)
    if length < 126:
        header = bytes([0x80 | opcode, length])
    elif length < 1 << 16:
        header = bytes([0x80 | opcode, 126]) + struct.pack(">H", length)
    else:
        header = bytes([0x80 | opcode, 127]) + struct.pack(">Q", length)
    return header + payload


def ws_send(client_id: str | None, kind: str, data: dict) -> None:
    frame = _ws_frame(0x1, json.dumps({"type": kind, "data": data}).encode())
    for connection in list(sockets.get(client_id or "", [])):
        try:
            connection.sendall(frame)
        except OSError:
            pass


def ws_text(client_id: str | None, node: str, text: str) -> None:
    node_bytes = node.encode()
    payload = struct.pack(">I", 3) + struct.pack(">I", len(node_bytes)) + node_bytes + text.encode()
    frame = _ws_frame(0x2, payload)
    for connection in list(sockets.get(client_id or "", [])):
        try:
            connection.sendall(frame)
        except OSError:
            pass


def run_prompt(prompt_id: str, graph: dict, client_id: str | None = None) -> None:
    sampler = graph.get("sampler", {}).get("inputs", {})
    steps = int(sampler.get("steps", 4))
    seed = int(sampler.get("seed", 0))

    log("\x1b[32m[INFO]\x1b[0m Requested to load CLIPVisionModelProjection")
    log(
        "\x1b[32m[INFO]\x1b[0m Model CLIPVisionModelProjection prepared for dynamic VRAM loading. "
        "580MB Staged. 0 patches attached."
    )
    log("\x1b[32m[INFO]\x1b[0m Requested to load Hunyuan3Dv2_1")
    log(
        "\x1b[32m[INFO]\x1b[0m Model Hunyuan3Dv2_1 prepared for dynamic VRAM loading. "
        "6200MB Staged. 0 patches attached."
    )

    for step in range(1, steps + 1):
        bar(step, steps)
        time.sleep(0.01)
    sys.stdout.write("\n")

    # What the real one sends: each node as it starts, a sampler's own steps,
    # a decimator's line of text, then a null node for the end of the prompt.
    ws_send(client_id, "execution_start", {"prompt_id": prompt_id})
    for node, spec in graph.items():
        ws_send(client_id, "executing", {"node": node, "display_node": node, "prompt_id": prompt_id})
        if spec.get("class_type") == "KSampler":
            total = int(spec.get("inputs", {}).get("steps", 1))
            for value in range(1, total + 1):
                ws_send(
                    client_id,
                    "progress",
                    {"value": value, "max": total, "node": node, "prompt_id": prompt_id},
                )
                time.sleep(0.002)
        if spec.get("class_type") == "DecimateMesh":
            ws_text(client_id, node, "faces: 1.2M → 50K  (-96%)")
    ws_send(client_id, "executing", {"node": None, "prompt_id": prompt_id})
    ws_send(client_id, "execution_success", {"prompt_id": prompt_id})

    log("\x1b[32m[INFO]\x1b[0m Prompt executed in 3.21 seconds")

    prefix = graph.get("save", {}).get("inputs", {}).get("filename_prefix", "ComfyUI")
    subfolder, _, stem = str(prefix).rpartition("/")
    target = output_dir / subfolder if subfolder else output_dir
    target.mkdir(parents=True, exist_ok=True)
    filename = f"{stem}_00001_.glb"
    faces = int(graph.get("decimate", {}).get("inputs", {}).get("target_face_count", 0)) or 250_000
    (target / filename).write_bytes(tiny_glb(vertices=faces // 2 + 2, faces=faces))

    # SaveGLB's own shape: an empty mesh is skipped and reported as nothing.
    saved = (
        []
        if "noobject" in str(graph.get("ref", {}).get("inputs", {}).get("image", ""))
        else [{"filename": filename, "subfolder": subfolder, "type": "output"}]
    )

    with lock:
        history[prompt_id] = {
            "prompt": [0, prompt_id, graph, {}, []],
            "outputs": {"save": {"3d": saved}},
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
        if self.path.startswith("/ws"):
            self._websocket()
            return
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

    def _websocket(self) -> None:
        client_id = self.path.partition("clientId=")[2] or "anonymous"
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()  # noqa: S324
        self.wfile.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode()
        )
        self.wfile.flush()
        connection = self.connection
        with lock:
            sockets.setdefault(client_id, []).append(connection)
        connection.sendall(
            _ws_frame(0x1, json.dumps({"type": "status", "data": {"sid": client_id}}).encode())
        )
        try:
            while connection.recv(1024):
                pass
        except OSError:
            pass
        finally:
            with lock:
                sockets.get(client_id, []).remove(connection)
            self.close_connection = True

    def do_POST(self) -> None:
        if self.path != "/prompt":
            self._send(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        graph = body.get("prompt") or {}
        prompt_id = body.get("prompt_id") or "fake"

        prompt_text = graph.get("ref", {}).get("inputs", {}).get("image", "")
        # A rejection the arm can actually reach: everything the arm validates
        # itself is refused before the child ever sees it, so the only way to
        # exercise "ComfyUI said no" is a field the arm passes straight through.
        if "reject" in str(prompt_text):
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

        client_id = body.get("client_id")
        threading.Thread(target=run_prompt, args=(prompt_id, graph, client_id), daemon=True).start()
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
    ThreadingHTTPServer((args.listen, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
