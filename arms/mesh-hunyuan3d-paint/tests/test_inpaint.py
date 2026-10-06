"""Vertex inpainting: colour reaches unseen vertices along the mesh, not across the image."""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("scipy")

from arm_hy3dpaint.inpaint import meshVerticeInpaint


def strip(count: int = 6):
    """A strip of quads along x, each vertex with its own texel far from the others."""
    top = [(float(i), 1.0, 0.0) for i in range(count)]
    bottom = [(float(i), 0.0, 0.0) for i in range(count)]
    positions = np.array(top + bottom, dtype=np.float32)
    faces = []
    for i in range(count - 1):
        a, b, c, d = i, i + 1, count + i, count + i + 1
        faces += [(a, c, b), (b, c, d)]
    faces = np.array(faces, dtype=np.int32)
    # UVs on a diagonal of a 64² texture, so no two vertices share a texel.
    uvs = np.array([((k + 0.5) / (2 * count), (k + 0.5) / (2 * count)) for k in range(2 * count)], np.float32)
    return positions, faces, uvs


def texel(uv: np.ndarray, size: int) -> tuple[int, int]:
    return round((1 - float(uv[1])) * (size - 1)), round(float(uv[0]) * (size - 1))


def test_colour_spreads_from_seen_vertices() -> None:
    positions, faces, uvs = strip()
    size = 64
    texture = np.zeros((size, size, 3), np.float32)
    mask = np.zeros((size, size), np.uint8)
    # Only the two leftmost vertices were seen, and they are red.
    for vertex in (0, 6):
        row, col = texel(uvs[vertex], size)
        texture[row, col] = (1.0, 0.0, 0.0)
        mask[row, col] = 255

    out, out_mask = meshVerticeInpaint(texture, mask, positions, uvs, faces, faces)

    for vertex in range(12):
        row, col = texel(uvs[vertex], size)
        assert out_mask[row, col] == 255, vertex
        assert np.allclose(out[row, col], (1.0, 0.0, 0.0)), vertex


def test_weights_follow_distance() -> None:
    positions, faces, uvs = strip(3)
    size = 64
    texture = np.zeros((size, size, 3), np.float32)
    mask = np.zeros((size, size), np.uint8)
    seen = {0: (1.0, 0.0, 0.0), 2: (0.0, 0.0, 1.0), 3: (1.0, 0.0, 0.0), 5: (0.0, 0.0, 1.0)}
    for vertex, colour in seen.items():
        row, col = texel(uvs[vertex], size)
        texture[row, col] = colour
        mask[row, col] = 255

    out, _ = meshVerticeInpaint(texture, mask, positions, uvs, faces, faces)

    # The middle vertices sit between red and blue, so they end up a mix.
    for vertex in (1, 4):
        row, col = texel(uvs[vertex], size)
        red, _, blue = out[row, col]
        assert 0.1 < red < 0.9 and 0.1 < blue < 0.9
        assert red + blue == pytest.approx(1.0, abs=1e-5)


def test_untouched_texels_are_left_alone() -> None:
    positions, faces, uvs = strip()
    size = 64
    texture = np.random.default_rng(0).random((size, size, 3)).astype(np.float32)
    mask = np.zeros((size, size), np.uint8)
    mask[0, 0] = 255
    out, out_mask = meshVerticeInpaint(texture, mask, positions, uvs, faces, faces)
    assert np.array_equal(out[0, 0], texture[0, 0])
    assert out_mask[0, 0] == 255
    # Nothing was seen on the mesh, so nothing on it could be coloured.
    assert int((out_mask > 0).sum()) == 1
