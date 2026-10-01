"""Reading ComfyUI's event socket, because the log does not say which node runs.

The log gives loads and the sampler's own bar; it says nothing about the
boundary between encoding a prompt, denoising, decoding the two streams and
muxing the file. Those boundaries are only on ComfyUI's `/ws`, as `executing`
events naming the node id -- and the graph this arm builds uses its own stable
ids, so the mapping from event to phase is exact rather than guessed.

A websocket client rather than a dependency: this arm has none by design, and
what is needed here is one read-only text channel on loopback. No extensions,
no continuation frames worth reassembling (ComfyUI sends whole JSON messages),
and the only frame this end ever writes is a pong.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import socket
import struct
from collections.abc import Iterator
from typing import Any

#: Long enough to outlive a load that stalls the event loop, short enough that
#: a dead child does not hold the reader thread open forever.
READ_TIMEOUT_SECONDS = 120.0
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONTINUATION = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class SocketClosed(RuntimeError):
    """The peer hung up, or sent something this reader will not follow."""


def _read_exactly(sock: socket.socket, count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = count
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            raise SocketClosed("the websocket closed mid-frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _handshake(sock: socket.socket, host: str, port: int, path: str) -> None:
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock.sendall(request.encode("ascii"))

    # Headers only, byte at a time: whatever follows the blank line is the
    # first frame, and over-reading here would eat it.
    header = b""
    while not header.endswith(b"\r\n\r\n"):
        byte = sock.recv(1)
        if not byte:
            raise SocketClosed("the server closed during the handshake")
        header += byte
        if len(header) > 8192:
            raise SocketClosed("the server answered the handshake with a flood")

    status = header.split(b"\r\n", 1)[0]
    if b"101" not in status:
        raise SocketClosed(f"the server refused the upgrade: {status!r}")


def _send_pong(sock: socket.socket, payload: bytes) -> None:
    """Answer a ping, masked, because a client's frames always are."""
    mask = secrets.token_bytes(4)
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    header = bytes([0x80 | OP_PONG, 0x80 | len(payload)])
    sock.sendall(header + mask + masked)


def _read_frame(sock: socket.socket) -> tuple[int, bytes]:
    first, second = _read_exactly(sock, 2)
    opcode = first & 0x0F
    length = second & 0x7F

    if length == 126:
        (length,) = struct.unpack(">H", _read_exactly(sock, 2))
    elif length == 127:
        (length,) = struct.unpack(">Q", _read_exactly(sock, 8))

    # A server never masks, but a masked frame would desynchronise the stream
    # silently, so the key is consumed rather than assumed absent.
    mask = _read_exactly(sock, 4) if second & 0x80 else b""
    payload = _read_exactly(sock, length)
    if mask:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


def events(host: str, port: int, client_id: str) -> Iterator[dict[str, Any]]:
    """Every JSON message ComfyUI addresses to `client_id`, until it closes.

    Binary frames are ComfyUI's latent previews, which this arm turns off and
    would not look at anyway; they are read and dropped so the stream stays in
    step rather than skipped, which would leave the parser mid-frame.
    """
    sock = socket.create_connection((host, port), timeout=READ_TIMEOUT_SECONDS)
    try:
        sock.settimeout(READ_TIMEOUT_SECONDS)
        _handshake(sock, host, port, f"/ws?clientId={client_id}")

        while True:
            opcode, payload = _read_frame(sock)
            if opcode == OP_CLOSE:
                return
            if opcode == OP_PING:
                _send_pong(sock, payload)
                continue
            if opcode in (OP_BINARY, OP_PONG, OP_CONTINUATION):
                continue
            if opcode != OP_TEXT:
                continue
            try:
                message = json.loads(payload.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            if isinstance(message, dict):
                yield message
    finally:
        sock.close()
