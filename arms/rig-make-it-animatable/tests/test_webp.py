"""WebP maps out to PNG for trimesh, and back in again after Blender."""

from __future__ import annotations

import io
import json
import random
import struct
from pathlib import Path

import pytest

Image = pytest.importorskip("PIL.Image")

from arm_mia.webp import EXTENSION, _read, compress_textures, decompress_textures  # noqa: E402


def glb(path: Path) -> None:
    rng = random.Random(1)  # noqa: S311 - test pixels, not secrets
    out = io.BytesIO()
    Image.frombytes("RGB", (64, 64), rng.randbytes(64 * 64 * 3)).save(out, format="PNG")
    png = out.getvalue()
    positions = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    blob = positions + png + b"\x00" * (-len(png) % 4)
    doc = {
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 36},
            {"buffer": 0, "byteOffset": 36, "byteLength": len(png)},
        ],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"}],
        "images": [{"bufferView": 1, "mimeType": "image/png"}],
        "textures": [{"source": 0}],
        "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
    }
    js = json.dumps(doc).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(blob), 0x004E4942) + blob
    path.write_bytes(b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body)


def test_round_trip(tmp_path: Path) -> None:
    original = tmp_path / "a.glb"
    glb(original)
    compress_textures(original, 100)
    doc, _ = _read(original)
    assert doc["images"][0]["mimeType"] == "image/webp" and EXTENSION in doc["extensionsRequired"]

    back = tmp_path / "b.glb"
    assert decompress_textures(original, back) == 1
    doc, binary = _read(back)
    assert doc["images"][0]["mimeType"] == "image/png"
    assert doc["textures"][0] == {"source": 0}
    assert "extensionsRequired" not in doc and "extensionsUsed" not in doc
    view = doc["bufferViews"][doc["images"][0]["bufferView"]]
    image = Image.open(io.BytesIO(binary[view["byteOffset"] : view["byteOffset"] + view["byteLength"]]))
    assert image.size == (64, 64)
    # Positions untouched.
    assert binary[:36] == struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
