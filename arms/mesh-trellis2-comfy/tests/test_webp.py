"""WebP re-encoding of a GLB's maps, on a GLB built here with real PNGs."""

from __future__ import annotations

import io
import json
import struct
from pathlib import Path

import pytest

from arm_trellis2.webp import EXTENSION, compress_textures

Image = pytest.importorskip("PIL.Image")


def png(seed: int, size: int = 256) -> bytes:
    """A photographic-ish map: noise, which PNG stores badly and WebP well."""
    out = io.BytesIO()
    random = __import__("random").Random(seed)
    Image.frombytes("RGB", (size, size), random.randbytes(size * size * 3)).save(out, format="PNG")
    return out.getvalue()


def flat_png() -> bytes:
    """A regular pattern PNG compresses to a few hundred bytes and WebP cannot match."""
    out = io.BytesIO()
    image = Image.new("RGB", (64, 64))
    image.putdata(
        [((x * 7 + y * 13) % 256, (x * 3) % 256, (y * 5) % 256) for y in range(64) for x in range(64)]
    )
    image.save(out, format="PNG")
    return out.getvalue()


def build_glb(path: Path, normal: bytes | None = None) -> bytes:
    """Positions, then two images, then indices -- so views after an image move."""
    positions = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    colour = png(1)
    normal = normal if normal is not None else png(2)
    indices = struct.pack("<3I", 0, 1, 2)

    blob = bytearray()
    views = []
    for data in (positions, colour, normal, indices):
        blob += b"\x00" * (-len(blob) % 4)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        blob += data

    document = {
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
            {"bufferView": 3, "componentType": 5125, "count": 3, "type": "SCALAR"},
        ],
        "images": [{"bufferView": 1, "mimeType": "image/png"}, {"bufferView": 2, "mimeType": "image/png"}],
        "textures": [{"source": 0}, {"source": 1}],
        "materials": [
            {"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}, "normalTexture": {"index": 1}}
        ],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
    }
    payload = json.dumps(document).encode()
    payload += b" " * (-len(payload) % 4)
    blob += b"\x00" * (-len(blob) % 4)
    chunks = struct.pack("<II", len(payload), 0x4E4F534A) + payload
    chunks += struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    path.write_bytes(b"glTF" + struct.pack("<II", 2, 12 + len(chunks)) + chunks)
    return positions + indices


def read(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    length = struct.unpack("<I", data[12:16])[0]
    document = json.loads(data[20 : 20 + length])
    binary = data[20 + length + 8 :]
    return document, binary


def test_maps_become_webp_and_geometry_survives(tmp_path: Path) -> None:
    path = tmp_path / "m.glb"
    build_glb(path)
    size_before = path.stat().st_size

    report = compress_textures(path)

    assert report.images == 2
    assert report.bytes_after < report.bytes_before
    assert path.stat().st_size < size_before

    document, binary = read(path)
    assert [image["mimeType"] for image in document["images"]] == ["image/webp", "image/webp"]
    assert EXTENSION in document["extensionsUsed"] and EXTENSION in document["extensionsRequired"]
    assert document["textures"][0] == {"extensions": {EXTENSION: {"source": 0}}}

    # Every view aligned, and the bytes accessors point at unchanged.
    views = document["bufferViews"]
    assert all(view["byteOffset"] % 4 == 0 for view in views)
    position = views[0]
    assert struct.unpack("<9f", binary[position["byteOffset"] : position["byteOffset"] + 36])[3] == 1.0
    index = views[3]
    assert struct.unpack("<3I", binary[index["byteOffset"] : index["byteOffset"] + 12]) == (0, 1, 2)
    for view in views[1:3]:
        chunk = binary[view["byteOffset"] : view["byteOffset"] + view["byteLength"]]
        assert chunk[:4] == b"RIFF" and chunk[8:12] == b"WEBP"


def test_a_glb_without_images_is_left_alone(tmp_path: Path) -> None:
    path = tmp_path / "m.glb"
    from .fake_comfy import tiny_glb

    path.write_bytes(tiny_glb())
    before = path.read_bytes()
    assert compress_textures(path).images == 0
    assert path.read_bytes() == before


def test_a_map_webp_would_grow_stays_png(tmp_path: Path) -> None:
    path = tmp_path / "m.glb"
    build_glb(path, normal=flat_png())

    # Lossy: lossless WebP beats PNG even on this pattern.
    report = compress_textures(path, 90)

    document, _ = read(path)
    assert report.images == 1
    assert [image["mimeType"] for image in document["images"]] == ["image/webp", "image/png"]
    assert document["textures"][1] == {"source": 1}


def test_full_quality_is_lossless(tmp_path: Path) -> None:
    path = tmp_path / "m.glb"
    build_glb(path)
    original = Image.open(io.BytesIO(png(1))).convert("RGB")

    compress_textures(path, 100)

    document, binary = read(path)
    view = document["bufferViews"][document["images"][0]["bufferView"]]
    chunk = binary[view["byteOffset"] : view["byteOffset"] + view["byteLength"]]
    assert Image.open(io.BytesIO(chunk)).convert("RGB").tobytes() == original.tobytes()


def test_lower_quality_is_smaller(tmp_path: Path) -> None:
    sizes = []
    for quality in (100, 90, 50):
        path = tmp_path / f"m{quality}.glb"
        build_glb(path)
        sizes.append(compress_textures(path, quality).bytes_after)
    assert sizes[0] > sizes[1] > sizes[2]
