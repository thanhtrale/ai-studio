"""Re-encode a GLB's textures as WebP, in place.

ComfyUI's `SaveGLB` embeds every map as PNG, and on a TRELLIS.2 mesh the maps
are most of the file: 2048² base colour, ORM and normal maps come to about
9 MB of a 13 MB GLB. WebP is smaller at any quality, lossless included, and three.js
reads it natively through `EXT_texture_webp`, so a page needs no decoder of
its own -- unlike KTX2, which would also need a transcoder shipped with it.

Pillow is not this arm's dependency: it comes with ComfyUI in the shared venv
the arm runs on, and it is imported here lazily so the rest of the arm, and
its tests, do not need it.

The rewrite keeps every buffer view in its original order and rewrites only
the bytes of those that hold images, so accessors -- which point at views by
index -- are untouched.
"""

from __future__ import annotations

import io
import json
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
EXTENSION = "EXT_texture_webp"
#: The quality scale the studio exposes, 1 to 100. 100 is lossless: every
#: pixel as baked, about a quarter smaller than PNG. Below it is lossy WebP at
#: that quality -- on the test chair's 2048 maps, 90 is a sixth of the PNGs and
#: 75 a fourteenth.
LOSSLESS = 100
DEFAULT_QUALITY = LOSSLESS
#: A normal map's error shows up as lighting rather than colour, so in lossy
#: mode it is given this many more points than the rest.
NORMAL_BOOST = 5


@dataclass
class CompressionReport:
    images: int
    bytes_before: int
    bytes_after: int


def _pad(data: bytes, filler: bytes = b"\x00") -> bytes:
    return data + filler * (-len(data) % 4)


def _read(path: Path) -> tuple[dict[str, Any], bytes]:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError(f"{path} is not a GLB")
    offset = 12
    document: dict[str, Any] | None = None
    binary = b""
    while offset + 8 <= len(data):
        length, kind = struct.unpack("<II", data[offset : offset + 8])
        chunk = data[offset + 8 : offset + 8 + length]
        if kind == JSON_CHUNK:
            document = json.loads(chunk)
        elif kind == BIN_CHUNK:
            binary = chunk
        offset += 8 + length
    if document is None:
        raise ValueError(f"{path} has no JSON chunk")
    return document, binary


def _write(path: Path, document: dict[str, Any], binary: bytes) -> None:
    payload = _pad(json.dumps(document, separators=(",", ":")).encode("utf-8"), b" ")
    binary = _pad(binary)
    chunks = struct.pack("<II", len(payload), JSON_CHUNK) + payload
    if binary:
        chunks += struct.pack("<II", len(binary), BIN_CHUNK) + binary
    header = b"glTF" + struct.pack("<II", 2, 12 + len(chunks))
    path.write_bytes(header + chunks)


def _normal_images(document: dict[str, Any]) -> set[int]:
    """Which images are normal maps, by following materials to textures."""
    textures = document.get("textures") or []
    found: set[int] = set()
    for material in document.get("materials") or []:
        reference = material.get("normalTexture")
        if isinstance(reference, dict) and isinstance(reference.get("index"), int):
            texture = textures[reference["index"]] if reference["index"] < len(textures) else {}
            source = texture.get("source")
            if isinstance(source, int):
                found.add(source)
    return found


def _normal_quality(quality: int) -> int:
    """The quality a normal map gets: the same when lossless, a little more when not."""
    return quality if quality >= LOSSLESS else min(LOSSLESS - 1, quality + NORMAL_BOOST)


def _encode(raw: bytes, quality: int) -> bytes:
    # Pillow comes with ComfyUI, not with this arm.
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        mode = "RGBA" if image.mode in ("RGBA", "LA", "P") and "A" in image.getbands() else "RGB"
        out = io.BytesIO()
        if quality >= LOSSLESS:
            # `quality` is effort in lossless mode; 4 is within a few percent
            # of 6 at half the time on a 2048 map.
            image.convert(mode).save(out, format="WEBP", lossless=True, quality=100, method=4)
        else:
            image.convert(mode).save(out, format="WEBP", quality=quality, method=6)
        return out.getvalue()


def compress_textures(path: Path, quality: int = DEFAULT_QUALITY) -> CompressionReport:
    """Rewrite `path` with every embedded PNG/JPEG image as WebP at `quality` (1-100).

    A GLB with no images, or whose images are already WebP, is left as it is.
    The extension is declared required: a loader that cannot read WebP would
    otherwise draw the mesh untextured without saying why.
    """
    document, binary = _read(path)
    images = document.get("images") or []
    views = document.get("bufferViews") or []

    targets: dict[int, int] = {}
    for index, image in enumerate(images):
        view = image.get("bufferView")
        if isinstance(view, int) and image.get("mimeType") in ("image/png", "image/jpeg"):
            targets[view] = index
    if not targets:
        return CompressionReport(images=0, bytes_before=0, bytes_after=0)

    normals = _normal_images(document)
    before = after = 0
    converted: set[int] = set()
    rebuilt = bytearray()
    for view_index, view in enumerate(views):
        start = view.get("byteOffset", 0)
        data = binary[start : start + view["byteLength"]]
        image_index = targets.get(view_index)
        if image_index is not None:
            encoded = _encode(data, _normal_quality(quality) if image_index in normals else quality)
            before += len(data)
            # A flat or tiny map can come out larger as WebP than as PNG; it
            # stays PNG, which every loader reads anyway.
            if len(encoded) < len(data):
                data = encoded
                images[image_index]["mimeType"] = "image/webp"
                converted.add(image_index)
            after += len(data)
        # Every view starts on a four-byte boundary, which accessors require.
        rebuilt += b"\x00" * (-len(rebuilt) % 4)
        view["byteOffset"] = len(rebuilt)
        view["byteLength"] = len(data)
        rebuilt += data

    if document.get("buffers"):
        document["buffers"][0]["byteLength"] = len(rebuilt)

    for texture in document.get("textures") or []:
        source = texture.get("source")
        if isinstance(source, int) and source in converted:
            texture.setdefault("extensions", {})[EXTENSION] = {"source": source}
            # The core `source` must name a PNG or JPEG; with the extension
            # required there is none to fall back to, so it goes.
            del texture["source"]

    if converted:
        for key in ("extensionsUsed", "extensionsRequired"):
            names = document.setdefault(key, [])
            if EXTENSION not in names:
                names.append(EXTENSION)

    _write(path, document, bytes(rebuilt))
    return CompressionReport(images=len(converted), bytes_before=before, bytes_after=after)
