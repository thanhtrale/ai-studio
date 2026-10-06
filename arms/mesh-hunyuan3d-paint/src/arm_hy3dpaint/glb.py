"""A textured mesh as one GLB, written directly.

Hunyuan3D's own exporter writes an OBJ with its maps beside it and then opens
Blender (`bpy`) to turn that into a GLB. A GLB is a JSON header and one binary
buffer, so this writes it in place of both.

What goes in is what the paint stage produces and three.js reads:

- positions, normals, one UV set, 32-bit indices
- base colour as an sRGB PNG
- metallic and roughness packed the glTF way -- roughness in G, metallic in B,
  R left white for an occlusion the paint stage does not make
- `doubleSided` off: the surface is closed, and back faces of a closed surface
  are never seen

UVs are written with V flipped. The paint stage's texture rows run from V = 1
at the top, the OpenGL way; glTF puts V = 0 at the top of the image.
"""

from __future__ import annotations

import io
import json
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
FLOAT = 5126
UINT32 = 5125
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
LINEAR = 9729
LINEAR_MIPMAP_LINEAR = 9987
REPEAT = 10497


@dataclass
class TexturedMesh:
    positions: np.ndarray  # [N, 3] float32
    normals: np.ndarray  # [N, 3] float32
    uvs: np.ndarray  # [N, 2] float32, OpenGL convention (V up)
    faces: np.ndarray  # [M, 3] uint32
    #: [H, W, 3] uint8, sRGB.
    base_color: np.ndarray | None = None
    #: [H, W] each, uint8, linear.
    metallic: np.ndarray | None = None
    roughness: np.ndarray | None = None


def _png(pixels: np.ndarray) -> bytes:
    out = io.BytesIO()
    Image.fromarray(pixels).save(out, format="PNG", compress_level=6)
    return out.getvalue()


def _pad(data: bytes, filler: bytes = b"\x00") -> bytes:
    return data + filler * (-len(data) % 4)


def write_glb(mesh: TexturedMesh, path: Path) -> None:
    positions = np.ascontiguousarray(mesh.positions, dtype=np.float32)
    normals = np.ascontiguousarray(mesh.normals, dtype=np.float32)
    uvs = np.ascontiguousarray(mesh.uvs, dtype=np.float32).copy()
    uvs[:, 1] = 1.0 - uvs[:, 1]
    faces = np.ascontiguousarray(mesh.faces, dtype=np.uint32).reshape(-1)

    blob = bytearray()
    views: list[dict] = []
    accessors: list[dict] = []

    def add_view(data: bytes, target: int | None = None) -> int:
        offset = len(blob)
        blob.extend(_pad(data))
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        views.append(view)
        return len(views) - 1

    def add_accessor(array: np.ndarray, kind: str, component: int, target: int, bounds: bool = False) -> int:
        view = add_view(array.tobytes(), target)
        accessor = {
            "bufferView": view,
            "componentType": component,
            "count": int(array.shape[0]),
            "type": kind,
        }
        if bounds:
            accessor["min"] = [float(v) for v in array.min(axis=0)]
            accessor["max"] = [float(v) for v in array.max(axis=0)]
        accessors.append(accessor)
        return len(accessors) - 1

    position = add_accessor(positions, "VEC3", FLOAT, ARRAY_BUFFER, bounds=True)
    normal = add_accessor(normals, "VEC3", FLOAT, ARRAY_BUFFER)
    texcoord = add_accessor(uvs, "VEC2", FLOAT, ARRAY_BUFFER)
    indices = add_accessor(faces, "SCALAR", UINT32, ELEMENT_ARRAY_BUFFER)

    images: list[dict] = []
    textures: list[dict] = []

    def add_texture(pixels: np.ndarray) -> int:
        view = add_view(_png(pixels))
        images.append({"bufferView": view, "mimeType": "image/png"})
        textures.append({"source": len(images) - 1, "sampler": 0})
        return len(textures) - 1

    pbr: dict = {"metallicFactor": 0.0, "roughnessFactor": 1.0}
    if mesh.base_color is not None:
        pbr["baseColorTexture"] = {"index": add_texture(mesh.base_color)}
    if mesh.metallic is not None and mesh.roughness is not None:
        packed = np.stack([np.full_like(mesh.roughness, 255), mesh.roughness, mesh.metallic], axis=-1).astype(
            np.uint8
        )
        pbr["metallicRoughnessTexture"] = {"index": add_texture(packed)}
        pbr["metallicFactor"] = 1.0
    if mesh.base_color is None:
        pbr["baseColorFactor"] = [0.8, 0.8, 0.8, 1.0]

    document: dict = {
        "asset": {"version": "2.0", "generator": "ai-studio mesh-hunyuan3d-paint"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": position, "NORMAL": normal, "TEXCOORD_0": texcoord},
                        "indices": indices,
                        "material": 0,
                    }
                ]
            }
        ],
        "materials": [{"pbrMetallicRoughness": pbr, "doubleSided": False}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    if textures:
        document["samplers"] = [
            {"magFilter": LINEAR, "minFilter": LINEAR_MIPMAP_LINEAR, "wrapS": REPEAT, "wrapT": REPEAT}
        ]
        document["images"] = images
        document["textures"] = textures

    header = _pad(json.dumps(document, separators=(",", ":")).encode("utf-8"), b" ")
    body = bytes(blob)
    total = 12 + 8 + len(header) + 8 + len(body)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(struct.pack("<4sII", b"glTF", 2, total))
        handle.write(struct.pack("<II", len(header), JSON_CHUNK))
        handle.write(header)
        handle.write(struct.pack("<II", len(body), BIN_CHUNK))
        handle.write(body)
