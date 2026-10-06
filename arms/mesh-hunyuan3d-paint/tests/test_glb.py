"""The GLB writer: a file three.js would load, with maps in the channels glTF names."""

from __future__ import annotations

import io
import json
import struct
from pathlib import Path

import numpy as np
import pytest

Image = pytest.importorskip("PIL.Image")

from arm_hy3dpaint.glb import TexturedMesh, write_glb  # noqa: E402


def read(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    magic, version, total = struct.unpack("<4sII", data[:12])
    assert (magic, version, total) == (b"glTF", 2, len(data))
    json_len, json_kind = struct.unpack("<II", data[12:20])
    assert json_kind == 0x4E4F534A and json_len % 4 == 0
    document = json.loads(data[20 : 20 + json_len])
    bin_len, bin_kind = struct.unpack("<II", data[20 + json_len : 28 + json_len])
    assert bin_kind == 0x004E4942
    return document, data[28 + json_len : 28 + json_len + bin_len]


def view(document: dict, blob: bytes, index: int) -> bytes:
    entry = document["bufferViews"][index]
    assert entry["byteOffset"] % 4 == 0
    return blob[entry["byteOffset"] : entry["byteOffset"] + entry["byteLength"]]


def triangle(**maps: np.ndarray) -> TexturedMesh:
    return TexturedMesh(
        positions=np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32),
        normals=np.array([[0, 0, 1]] * 3, np.float32),
        uvs=np.array([[0, 0], [1, 0], [0, 1]], np.float32),
        faces=np.array([[0, 1, 2]], np.uint32),
        **maps,
    )


def test_textured_round_trip(tmp_path: Path) -> None:
    colour = np.zeros((8, 8, 3), np.uint8)
    colour[..., 0] = 200
    metallic = np.full((8, 8), 30, np.uint8)
    roughness = np.full((8, 8), 180, np.uint8)
    path = tmp_path / "out.glb"
    write_glb(triangle(base_color=colour, metallic=metallic, roughness=roughness), path)

    document, blob = read(path)
    primitive = document["meshes"][0]["primitives"][0]
    assert set(primitive["attributes"]) == {"POSITION", "NORMAL", "TEXCOORD_0"}
    position = document["accessors"][primitive["attributes"]["POSITION"]]
    assert position["min"] == [0.0, 0.0, 0.0] and position["max"] == [1.0, 1.0, 0.0]
    indices = np.frombuffer(
        view(document, blob, document["accessors"][primitive["indices"]]["bufferView"]), "<u4"
    )
    assert indices.tolist() == [0, 1, 2]

    # V is flipped on the way out: glTF's V runs down the image.
    uv_view = document["accessors"][primitive["attributes"]["TEXCOORD_0"]]["bufferView"]
    uvs = np.frombuffer(view(document, blob, uv_view), "<f4").reshape(-1, 2)
    assert uvs.tolist() == [[0, 1], [1, 1], [0, 0]]

    pbr = document["materials"][0]["pbrMetallicRoughness"]
    base = document["textures"][pbr["baseColorTexture"]["index"]]["source"]
    mr = document["textures"][pbr["metallicRoughnessTexture"]["index"]]["source"]
    base_pixels = np.asarray(
        Image.open(io.BytesIO(view(document, blob, document["images"][base]["bufferView"])))
    )
    mr_pixels = np.asarray(Image.open(io.BytesIO(view(document, blob, document["images"][mr]["bufferView"]))))
    assert base_pixels[0, 0].tolist() == [200, 0, 0]
    # Roughness in G, metallic in B.
    assert mr_pixels[0, 0].tolist() == [255, 180, 30]
    assert pbr["metallicFactor"] == 1.0 and pbr["roughnessFactor"] == 1.0


def test_untextured(tmp_path: Path) -> None:
    path = tmp_path / "plain.glb"
    write_glb(triangle(), path)
    document, _ = read(path)
    assert "images" not in document and "textures" not in document
    assert document["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] == [0.8, 0.8, 0.8, 1.0]
