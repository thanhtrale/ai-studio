"""A stand-in for `llama-server`, close enough to exercise the arm without a GPU.

What it imitates is the surface the arm depends on, taken from a real b10919
run rather than from documentation: `/health` answering 503 until the model is
"loaded" and 200 after; the trace-level load log with its prefixed lines; a
streamed `/v1/chat/completions` that sends `reasoning_content` chunks before
`content` chunks, each carrying `timings`; and the `prompt processing` progress
lines a long prompt writes to the log.

The model is a rule: it "thinks" for a few tokens, then answers with the words
of the last user message reversed. That is enough to check the text comes back
intact and that thinking can be turned off, and nothing about it needs
twenty gigabytes.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

LOAD_SECONDS = 0.3
TOKEN_SECONDS = 0.005

LOAD_LOG = """0.00.090.545 I cmn  common_param: common_params_print_info: build 10919 (d3146f2b5)
0.00.143.669 I srv    load_model: loading model '{model}'
0.03.579.298 I print_info: model type            = 35B.A3B
0.03.579.338 I load_tensors: loading model tensors, this can take a while... (load_mode = none)
0.05.384.100 I load_tensors: offloading output layer to GPU
0.05.384.104 I load_tensors: offloading 39 repeating layers to GPU
0.05.384.105 I load_tensors: offloaded 41/41 layers to GPU
0.05.384.108 I load_tensors:          CPU model buffer size = 10821.13 MiB
0.05.384.110 I load_tensors:        CUDA0 model buffer size = 10492.40 MiB
0.22.449.105 I llama_context: n_ctx                 = {ctx}
0.22.451.473 I llama_kv_cache:      CUDA0 KV buffer size =  1280.00 MiB
0.23.290.627 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = {ctx}, kv_unified = 'false'
0.23.517.677 I srv  llama_server: model loaded
0.23.517.683 I srv  llama_server: listening on http://{host}:{port}
"""


def log(line: str) -> None:
    print(line, flush=True)


class State:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.loaded = False
        self.requests = 0
        self.lock = threading.Lock()

    def load(self) -> None:
        for line in LOAD_LOG.format(
            model=self.args.model, ctx=self.args.ctx_size, host=self.args.host, port=self.args.port
        ).splitlines():
            log(line)
            time.sleep(LOAD_SECONDS / 16)
        self.loaded = True


def build_handler(state: State) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            if self.path == "/health":
                if state.loaded:
                    self._json(200, {"status": "ok"})
                else:
                    self._json(
                        503, {"error": {"code": 503, "message": "Loading model", "type": "unavailable_error"}}
                    )
                return
            self._json(404, {"error": {"message": "not found"}})

        def do_POST(self) -> None:
            if self.path != "/v1/chat/completions":
                self._json(404, {"error": {"message": "not found"}})
                return

            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            with state.lock:
                state.requests += 1
                task = state.requests

            messages = body.get("messages", [])
            last_user = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
            thinking = body.get("chat_template_kwargs", {}).get("enable_thinking", True)
            max_tokens = int(body.get("max_tokens", 64))
            if body.get("temperature", 1.0) > 5.0:
                self._json(
                    400,
                    {
                        "error": {
                            "code": 400,
                            "message": "temperature out of range",
                            "type": "invalid_request_error",
                        }
                    },
                )
                return

            prompt_n = sum(len(m.get("content", "").split()) for m in messages) + 8
            log(f"0.11.285.246 I slot launch_slot_: id  0 | task {task} | processing task, is_child = 0")
            # A long prompt reports its progress in batches, as the real child
            # does; a short one says nothing before its first token.
            if prompt_n > 2048:
                done = 0
                while done < prompt_n:
                    done = min(done + 2048, prompt_n)
                    log(
                        f"1.08.595.063 I slot print_timing: id  0 | task {task} | prompt processing, "
                        f"n_tokens = {done:6d}, progress = {done / prompt_n:.2f}, t = {done / 1200:6.2f} s / "
                        f"{1200.0:.2f} tokens per second"
                    )
                    time.sleep(0.01)

            thought = ["Let", " me", " think", "."] if thinking else []
            answer = [f" {word}" if index else word for index, word in enumerate(reversed(last_user.split()))]
            if not answer:
                answer = ["(nothing)"]
            tokens = [("reasoning_content", t) for t in thought] + [("content", t) for t in answer]
            finish = "stop"
            if len(tokens) > max_tokens:
                tokens = tokens[:max_tokens]
                finish = "length"

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            prompt_ms = prompt_n * 0.8
            started = time.perf_counter()

            def chunk(delta: dict[str, Any], finish_reason: str | None, predicted: int) -> None:
                elapsed_ms = (time.perf_counter() - started) * 1000.0
                payload = {
                    "choices": [{"finish_reason": finish_reason, "index": 0, "delta": delta}],
                    "created": int(time.time()),
                    "id": f"chatcmpl-fake{task}",
                    "model": state.args.model,
                    "object": "chat.completion.chunk",
                    "timings": {
                        "cache_n": 0,
                        "prompt_n": prompt_n,
                        "prompt_ms": prompt_ms,
                        "prompt_per_second": prompt_n / (prompt_ms / 1000.0),
                        "predicted_n": predicted,
                        "predicted_ms": elapsed_ms,
                        "predicted_per_second": predicted / (elapsed_ms / 1000.0) if elapsed_ms else 0.0,
                    },
                }
                self._event(json.dumps(payload))

            chunk({"role": "assistant", "content": None}, None, 0)
            for index, (kind, text) in enumerate(tokens, start=1):
                time.sleep(TOKEN_SECONDS)
                chunk({kind: text}, None, index)
            chunk({}, finish, len(tokens))
            self._event("[DONE]")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

            log(
                f"2.02.620.986 I slot print_timing: id  0 | task {task} | prompt eval time = {prompt_ms:.2f} ms / "  # noqa: E501 - verbatim log line
                f"{prompt_n} tokens"
            )
            log(
                f"2.02.621.129 I slot      release: id  0 | task {task} | stop processing: n_tokens = {prompt_n + len(tokens)}, truncated = 0"  # noqa: E501 - verbatim log line
            )

        def _event(self, data: str) -> None:
            frame = f"data: {data}\n\n".encode()
            self.wfile.write(f"{len(frame):x}\r\n".encode() + frame + b"\r\n")
            self.wfile.flush()

        def _json(self, status: int, body: dict[str, Any]) -> None:
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--ctx-size", type=int, default=4096)
    # Everything else the arm passes is accepted and ignored, the way the real
    # child accepts flags this stand-in has no use for.
    args, _rest = parser.parse_known_args()

    state = State(args)
    server = ThreadingHTTPServer((args.host, args.port), build_handler(state))
    # Bind first, load second: the real child answers 503 on the port while
    # it reads the weights, and the arm's readiness check depends on that.
    threading.Thread(target=state.load, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
