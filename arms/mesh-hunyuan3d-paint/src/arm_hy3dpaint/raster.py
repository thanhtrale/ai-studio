"""`custom_rasterizer`, in PyTorch.

Hunyuan3D's paint stage rasterizes through a CUDA extension of its own, which
has to be compiled against the installed torch with nvcc and MSVC -- neither of
which this machine has, and neither of which an arm should need. The kernel is
small: a z-buffer filled by `atomicMin` on a 64-bit token that packs quantised
depth above the face index, then a perspective-corrected barycentric per pixel
for whichever face won. Both halves are expressed here as tensor ops, and the
module stands in for the extension under its own name (see `vendor.py`).

Matched to `rasterizer_gpu.cu` rather than to "a rasterizer":

- screen space is `(ndc * 0.5 + 0.5) * (size - 1) + 0.5`, pixel centres at `+0.5`
- depth is `ndc_z * 0.49999 + 0.5`, quantised as `int(depth * 2**18)`
- a pixel is covered when all three barycentrics are in [0, 1], edges included
- ties in quantised depth go to the lower face index, as `atomicMin` does
- `findices` is the face index plus one, zero where nothing was drawn

The z-buffer is a `scatter_reduce(amin)` over every (face, pixel) pair in each
face's bounding box. Faces are taken in chunks so that the pair count, not the
face count, bounds memory: one triangle filling the frame is one chunk.
"""

from __future__ import annotations

import torch

#: `MAXINT` in rasterizer.h. The token is `depth_q * MAXINT + face + 1`.
MAXINT = 2147483647
#: `2 << 17` in the kernel.
DEPTH_QUANT = 2 << 17
#: What an empty pixel's token starts as, as in `rasterize_image_gpu`.
EMPTY = MAXINT * MAXINT + (MAXINT - 1)
#: (face, pixel) pairs evaluated at once. About 0.6 GB of temporaries.
PAIRS_PER_CHUNK = 8_000_000


def _screen(V: torch.Tensor, width: int, height: int) -> torch.Tensor:
    w = V[:, 3:4]
    x = (V[:, 0:1] / w * 0.5 + 0.5) * (width - 1) + 0.5
    y = (0.5 + 0.5 * V[:, 1:2] / w) * (height - 1) + 0.5
    z = V[:, 2:3] / w * 0.49999 + 0.5
    return torch.cat([x, y, z], dim=1)


def _barycentric(
    a: torch.Tensor, b: torch.Tensor, c: torch.Tensor, px: torch.Tensor, py: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    """(alpha, beta, gamma, valid) for points against triangles, as the header computes them."""

    def area2(p0x, p0y, p1x, p1y, p2x, p2y):
        return (p2x - p0x) * (p1y - p0y) - (p1x - p0x) * (p2y - p0y)

    area = area2(a[:, 0], a[:, 1], b[:, 0], b[:, 1], c[:, 0], c[:, 1])
    valid = area != 0
    inv = torch.where(valid, 1.0 / torch.where(valid, area, torch.ones_like(area)), torch.zeros_like(area))
    beta = area2(a[:, 0], a[:, 1], px, py, c[:, 0], c[:, 1]) * inv
    gamma = area2(a[:, 0], a[:, 1], b[:, 0], b[:, 1], px, py) * inv
    alpha = 1.0 - beta - gamma
    return alpha, beta, gamma, valid


def _inside(alpha: torch.Tensor, beta: torch.Tensor, gamma: torch.Tensor) -> torch.Tensor:
    return (alpha >= 0) & (alpha <= 1) & (beta >= 0) & (beta <= 1) & (gamma >= 0) & (gamma <= 1)


def rasterize_image(
    V: torch.Tensor,
    F: torch.Tensor,
    D: torch.Tensor | None,
    width: int,
    height: int,
    occlusion_truncation: float = 1e-6,
    use_depth_prior: int = 0,
) -> list[torch.Tensor]:
    """`custom_rasterizer_kernel.rasterize_image`: (findices [H, W] int32, barycentric [H, W, 3])."""
    if use_depth_prior:
        # Nothing in the paint pipeline asks for it; a silent wrong answer
        # would be worse than saying so.
        raise NotImplementedError("use_depth_prior is not implemented")

    device = V.device
    V = V.float()
    F = F.long()
    screen = _screen(V, width, height)
    zbuffer = torch.full((height * width,), EMPTY, dtype=torch.int64, device=device)

    if F.shape[0]:
        t0, t1, t2 = screen[F[:, 0]], screen[F[:, 1]], screen[F[:, 2]]
        xs = torch.stack([t0[:, 0], t1[:, 0], t2[:, 0]], dim=1)
        ys = torch.stack([t0[:, 1], t1[:, 1], t2[:, 1]], dim=1)
        # Pixel px is a candidate when its centre px + 0.5 is inside the box.
        x0 = torch.ceil(xs.min(1).values - 0.5).clamp(min=0)
        x1 = torch.floor(xs.max(1).values - 0.5).clamp(max=width - 1)
        y0 = torch.ceil(ys.min(1).values - 0.5).clamp(min=0)
        y1 = torch.floor(ys.max(1).values - 0.5).clamp(max=height - 1)
        bw = (x1 - x0 + 1).clamp(min=0)
        bh = (y1 - y0 + 1).clamp(min=0)
        # NaN boxes (w == 0) fail every comparison and come out as zero here.
        bw = torch.nan_to_num(bw, nan=0.0).long()
        bh = torch.nan_to_num(bh, nan=0.0).long()
        pairs = bw * bh

        live = torch.nonzero(pairs > 0).squeeze(1)
        if live.numel():
            counts = pairs[live]
            ends = torch.cumsum(counts, 0)
            # Chunk boundaries on the cumulative pair count, on the host: a
            # handful of numbers, not a per-face loop.
            ends_host = ends.cpu()
            start = 0
            total = int(ends_host[-1])
            done = 0
            while start < live.numel():
                limit = done + PAIRS_PER_CHUNK
                stop = int(torch.searchsorted(ends_host, limit, right=True))
                stop = max(stop, start + 1)
                _fill(
                    zbuffer, live[start:stop], counts[start:stop], screen, F,
                    x0, y0, bw, width,
                )  # fmt: skip
                done = int(ends_host[stop - 1])
                start = stop
            if done != total:
                raise RuntimeError(f"rasterized {done} of {total} pixel pairs")

    face = zbuffer % MAXINT
    drawn = zbuffer != EMPTY
    findices = torch.where(drawn, face, torch.zeros_like(face)).to(torch.int32)

    barycentric = torch.zeros((height * width, 3), dtype=torch.float32, device=device)
    pixels = torch.nonzero(drawn).squeeze(1)
    if pixels.numel():
        f = face[pixels] - 1
        px = (pixels % width).float() + 0.5
        py = torch.div(pixels, width, rounding_mode="floor").float() + 0.5
        tri = F[f]
        a, b, c = screen[tri[:, 0]], screen[tri[:, 1]], screen[tri[:, 2]]
        alpha, beta, gamma, _ = _barycentric(a, b, c, px, py)
        # Perspective correction by each vertex's clip w.
        alpha = alpha / V[tri[:, 0], 3]
        beta = beta / V[tri[:, 1], 3]
        gamma = gamma / V[tri[:, 2], 3]
        norm = 1.0 / (alpha + beta + gamma)
        barycentric[pixels] = torch.stack([alpha * norm, beta * norm, gamma * norm], dim=1)

    return [findices.view(height, width), barycentric.view(height, width, 3)]


def _fill(
    zbuffer: torch.Tensor,
    faces: torch.Tensor,
    counts: torch.Tensor,
    screen: torch.Tensor,
    F: torch.Tensor,
    x0: torch.Tensor,
    y0: torch.Tensor,
    bw: torch.Tensor,
    width: int,
) -> None:
    device = zbuffer.device
    total = int(counts.sum())
    owner = torch.repeat_interleave(torch.arange(faces.numel(), device=device), counts)
    offsets = torch.cumsum(counts, 0) - counts
    local = torch.arange(total, device=device) - offsets[owner]
    f = faces[owner]
    w = bw[f]
    px = x0[f].long() + local % w
    py = y0[f].long() + torch.div(local, w, rounding_mode="floor")

    tri = F[f]
    a, b, c = screen[tri[:, 0]], screen[tri[:, 1]], screen[tri[:, 2]]
    alpha, beta, gamma, valid = _barycentric(a, b, c, px.float() + 0.5, py.float() + 0.5)
    keep = valid & _inside(alpha, beta, gamma)
    depth = alpha * a[:, 2] + beta * b[:, 2] + gamma * c[:, 2]
    # The kernel's token is unsigned: a negative depth wraps to a huge value
    # and never wins. Dropping it is the same outcome.
    keep &= depth >= 0
    if not bool(keep.any()):
        return
    quant = (depth[keep] * DEPTH_QUANT).long()
    token = quant * MAXINT + (f[keep] + 1)
    pixel = py[keep] * width + px[keep]
    zbuffer.scatter_reduce_(0, pixel, token, reduce="amin")


def rasterize(
    pos: torch.Tensor,
    tri: torch.Tensor,
    resolution: tuple[int, int] | list[int],
    clamp_depth: torch.Tensor | None = None,
    use_depth_prior: int = 0,
) -> tuple[torch.Tensor, torch.Tensor]:
    """`custom_rasterizer.rasterize`: resolution is (height, width), pos is [1, N, 4]."""
    findices, barycentric = rasterize_image(
        pos[0], tri, clamp_depth, int(resolution[1]), int(resolution[0]), 1e-6, use_depth_prior
    )
    return findices, barycentric


def interpolate(
    col: torch.Tensor, findices: torch.Tensor, barycentric: torch.Tensor, tri: torch.Tensor
) -> torch.Tensor:
    """`custom_rasterizer.interpolate`, verbatim: attributes blended by the winning face."""
    f = findices - 1 + (findices == 0)
    vcol = col[0, tri.long()[f.long()]]
    result = barycentric.view(*barycentric.shape, 1) * vcol
    result = torch.sum(result, axis=-2)
    return result.view(1, *result.shape)
