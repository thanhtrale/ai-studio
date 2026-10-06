"""The PyTorch rasterizer against the CUDA kernel's own loop, written out in Python."""

from __future__ import annotations

import math

import pytest

torch = pytest.importorskip("torch")

from arm_hy3dpaint import raster  # noqa: E402


def reference(V, F, width, height):
    """`rasterizeImagecoordsKernelGPU` then `barycentricFromImgcoordGPU`, one pixel at a time."""
    V = V.tolist()
    F = F.tolist()

    def screen(v):
        return [
            (v[0] / v[3] * 0.5 + 0.5) * (width - 1) + 0.5,
            (0.5 + 0.5 * v[1] / v[3]) * (height - 1) + 0.5,
            v[2] / v[3] * 0.49999 + 0.5,
        ]

    def bary(a, b, c, p):
        def area(p0, p1, p2):
            return (p2[0] - p0[0]) * (p1[1] - p0[1]) - (p1[0] - p0[0]) * (p2[1] - p0[1])

        total = area(a, b, c)
        if total == 0:
            return [-1.0, -1.0, -1.0]
        beta = area(a, p, c) / total
        gamma = area(a, b, p) / total
        return [1.0 - beta - gamma, beta, gamma]

    zbuf = [raster.EMPTY] * (width * height)
    for idx, face in enumerate(F):
        t = [screen(V[i]) for i in face]
        x_min, x_max = min(p[0] for p in t), max(p[0] for p in t)
        y_min, y_max = min(p[1] for p in t), max(p[1] for p in t)
        for px in range(int(x_min), math.floor(x_max + 1) + 1):
            if px < 0 or px >= width or not px < x_max + 1:
                continue
            for py in range(int(y_min), math.floor(y_max + 1) + 1):
                if py < 0 or py >= height or not py < y_max + 1:
                    continue
                b = bary(t[0], t[1], t[2], [px + 0.5, py + 0.5])
                if all(0.0 <= value <= 1.0 for value in b):
                    depth = b[0] * t[0][2] + b[1] * t[1][2] + b[2] * t[2][2]
                    token = int(depth * raster.DEPTH_QUANT) * raster.MAXINT + idx + 1
                    pixel = py * width + px
                    zbuf[pixel] = min(zbuf[pixel], token)

    findices = [0] * (width * height)
    for pixel, token in enumerate(zbuf):
        if token != raster.EMPTY:
            findices[pixel] = token % raster.MAXINT
    return findices


def scene(seed: int = 0, faces: int = 40):
    generator = torch.Generator().manual_seed(seed)
    xyz = torch.rand((faces * 3, 3), generator=generator) * 1.8 - 0.9
    w = torch.rand((faces * 3, 1), generator=generator) * 0.5 + 0.75
    V = torch.cat([xyz * w, w], dim=1)
    F = torch.arange(faces * 3, dtype=torch.int32).view(faces, 3)
    return V, F


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_matches_the_kernel_loop(seed: int) -> None:
    V, F = scene(seed)
    findices, _ = raster.rasterize_image(V, F, None, 37, 29)
    expected = reference(V, F, 37, 29)
    assert findices.view(-1).tolist() == expected


def test_barycentrics_reconstruct_screen_position() -> None:
    V, F = scene(3, faces=12)
    width = height = 48
    findices, bary = raster.rasterize_image(V, F, None, width, height)
    drawn = torch.nonzero(findices.view(-1)).squeeze(1)
    assert drawn.numel() > 0
    assert torch.allclose(bary.view(-1, 3)[drawn].sum(1), torch.ones(drawn.numel()), atol=1e-5)
    # Perspective-correct weights interpolate clip coordinates linearly, so
    # x/w of the interpolated clip position is the pixel's own NDC x.
    faces = F.long()[findices.view(-1)[drawn].long() - 1]
    clip = (bary.view(-1, 3)[drawn].unsqueeze(-1) * V[faces]).sum(1)
    ndc_x = clip[:, 0] / clip[:, 3]
    px = (drawn % width).float() + 0.5
    expected = ((px - 0.5) / (width - 1) - 0.5) * 2
    assert torch.allclose(ndc_x, expected, atol=1e-3)


def test_chunking_does_not_change_the_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    V, F = scene(4, faces=60)
    whole, bary_whole = raster.rasterize_image(V, F, None, 64, 64)
    monkeypatch.setattr(raster, "PAIRS_PER_CHUNK", 50)
    chunked, bary_chunked = raster.rasterize_image(V, F, None, 64, 64)
    assert torch.equal(whole, chunked)
    assert torch.equal(bary_whole, bary_chunked)


def test_empty_and_offscreen() -> None:
    V = torch.tensor([[5.0, 5.0, 0.0, 1.0], [6.0, 5.0, 0.0, 1.0], [5.0, 6.0, 0.0, 1.0]])
    F = torch.tensor([[0, 1, 2]], dtype=torch.int32)
    findices, bary = raster.rasterize_image(V, F, None, 16, 16)
    assert int(findices.sum()) == 0
    assert float(bary.abs().sum()) == 0.0
    findices, _ = raster.rasterize_image(V, F[:0], None, 16, 16)
    assert int(findices.sum()) == 0


def test_rasterize_takes_height_width() -> None:
    V, F = scene(5, faces=8)
    findices, bary = raster.rasterize(V[None], F, (20, 30))
    assert findices.shape == (20, 30)
    assert bary.shape == (20, 30, 3)
