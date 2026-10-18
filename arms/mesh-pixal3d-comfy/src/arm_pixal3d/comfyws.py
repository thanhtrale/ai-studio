"""ComfyUI's websocket, read with the standard library.

The console log says when a model loads and draws tqdm bars, and that is all.
It never says which node is running, so a graph with four samplers shows one
bar filling four times and a remesh, an unwrap and three bakes as nothing at
all. The websocket says exactly that: `executing` names each node as it
starts, `progress` counts any node's own steps, `execution_cached` lists what
was skipped, and nodes like DecimateMesh send a line of text about themselves.

A minimal RFC 6455 client rather than a dependency: the arm has none of its
own, and reading text and binary frames from a loopback socket is a page of
code. Only what ComfyUI sends is handled -- unfragmented or continued text and
binary frames, ping, close -- and nothing is sent but pongs and the close.

The log is still read: it is the only place loads are described, and the
websocket is the thing that can drop. When it does, the arm reconnects, and
completion is still decided by `/history`, never by this.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

OP_CONTINUATION = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA
#: ComfyUI's binary event for a node's progress text (`BinaryEventTypes.TEXT`).
BINARY_TEXT = 3


class Closed(ConnectionError):
    pass


@dataclass(frozen=True)
class Event:
    kind: str
    data: dict[str, Any]


def _recv_exact(sock: socket.socket, count: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < count:
        chunk = sock.recv(count - len(chunks))
        if not chunk:
            raise Closed("websocket closed")
        chunks += chunk
    return bytes(chunks)


def _send_frame(sock: socket.socket, opcode: int, payload: bytes) -> None:
    """A client frame, which the protocol requires to be masked."""
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(0x80 | length)
    elif length < 1 << 16:
        header += bytes([0x80 | 126]) + struct.pack(">H", length)
    else:
        header += bytes([0x80 | 127]) + struct.pack(">Q", length)
    mask = os.urandom(4)
    sock.sendall(bytes(header) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))


def connect(host: str, port: int, client_id: str, timeout: float = 5.0) -> socket.socket:
    sock = socket.create_connection((host, port), timeout=timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET /ws?clientId={client_id} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(request.encode())

    response = bytearray()
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(1024)
        if not chunk:
            raise Closed("websocket handshake closed")
        response += chunk
        if len(response) > 16384:
            raise Closed("websocket handshake too long")
    head, _, rest = bytes(response).partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0]
    if b" 101 " not in status:
        sock.close()
        raise Closed(f"websocket refused: {status.decode(errors='replace')}")
    if rest:
        # A server is allowed to start sending right after the handshake; the
        # bytes that came with it are pushed back in front of the stream.
        sock = _Prefixed(sock, rest)  # type: ignore[assignment]
    # Blocking from here on: a quiet socket between jobs is not an error.
    sock.settimeout(None)
    return sock


class _Prefixed:
    """A socket with some bytes already read off it, served first."""

    def __init__(self, sock: socket.socket, prefix: bytes) -> None:
        self._sock = sock
        self._prefix = prefix

    def recv(self, count: int) -> bytes:
        if self._prefix:
            out, self._prefix = self._prefix[:count], self._prefix[count:]
            return out
        return self._sock.recv(count)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._sock, name)


def frames(sock: socket.socket) -> Iterator[tuple[int, bytes]]:
    """Whole messages as (opcode, payload), answering pings along the way."""
    message_op: int | None = None
    buffer = bytearray()
    while True:
        first, second = _recv_exact(sock, 2)
        fin, opcode = first & 0x80, first & 0x0F
        length = second & 0x7F
        if length == 126:
            length = struct.unpack(">H", _recv_exact(sock, 2))[0]
        elif length == 127:
            length = struct.unpack(">Q", _recv_exact(sock, 8))[0]
        mask = _recv_exact(sock, 4) if second & 0x80 else b""
        payload = _recv_exact(sock, length)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

        if opcode == OP_PING:
            _send_frame(sock, OP_PONG, payload)
            continue
        if opcode == OP_PONG:
            continue
        if opcode == OP_CLOSE:
            try:
                _send_frame(sock, OP_CLOSE, payload[:2])
            except OSError:
                pass
            raise Closed("websocket closed by ComfyUI")

        if opcode != OP_CONTINUATION:
            message_op = opcode
            buffer = bytearray()
        buffer += payload
        if fin and message_op is not None:
            yield message_op, bytes(buffer)
            message_op = None


def decode(opcode: int, payload: bytes) -> Event | None:
    """One ComfyUI message as an event, or None for what the arm ignores."""
    if opcode == OP_TEXT:
        try:
            message = json.loads(payload)
        except ValueError:
            return None
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            return None
        data = message.get("data")
        return Event(message["type"], data if isinstance(data, dict) else {})

    if opcode == OP_BINARY and len(payload) >= 8:
        event_type = struct.unpack(">I", payload[:4])[0]
        if event_type != BINARY_TEXT:
            return None  # previews: this arm runs with them off anyway
        body = payload[4:]
        node_length = struct.unpack(">I", body[:4])[0]
        node = body[4 : 4 + node_length].decode("utf-8", errors="replace")
        text = body[4 + node_length :].decode("utf-8", errors="replace")
        return Event("progress_text", {"node": node, "text": text})
    return None


def listen(
    host: str,
    port: int,
    client_id: str,
    on_event: Callable[[Event], None],
    on_open: Callable[[], None] | None = None,
) -> None:
    """Connect and deliver events until the socket closes. Raises on any failure."""
    sock = connect(host, port, client_id)
    if on_open is not None:
        on_open()
    try:
        for opcode, payload in frames(sock):
            event = decode(opcode, payload)
            if event is not None:
                on_event(event)
    finally:
        try:
            sock.close()
        except OSError:
            pass
