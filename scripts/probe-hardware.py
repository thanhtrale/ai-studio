"""Hardware probe for ai-studio: the numbers that decide an arm's runtime stack.

Measures the four ceilings that bound a large-model arm on this machine:
  compute   - bf16/fp16 tensor-core throughput
  vram      - how much of the card is actually allocatable
  pcie      - host->device bandwidth, which sets the cost of weight offloading
  storage   - NVMe read throughput, which sets cold-start weight load time
"""

from __future__ import annotations

import json
import os
import platform
import statistics
import sys
import tempfile
import time

import torch


def gib(n: int | float) -> float:
    return n / (1024**3)


def sync() -> None:
    torch.cuda.synchronize()


def bench_matmul(dtype: torch.dtype, n: int = 8192, iters: int = 30) -> float:
    """Return TFLOP/s for an n x n square matmul."""
    a = torch.randn(n, n, device="cuda", dtype=dtype)
    b = torch.randn(n, n, device="cuda", dtype=dtype)
    for _ in range(5):
        a @ b
    sync()
    t0 = time.perf_counter()
    for _ in range(iters):
        a @ b
    sync()
    dt = (time.perf_counter() - t0) / iters
    del a, b
    torch.cuda.empty_cache()
    return (2 * n**3) / dt / 1e12


def bench_pcie(size_mb: int = 512, iters: int = 12) -> dict[str, float]:
    """H2D and D2H bandwidth for pinned and pageable host memory, in GiB/s."""
    n = size_mb * 1024 * 1024 // 2  # bfloat16 elements
    out: dict[str, float] = {}

    for label, pin in (("pinned", True), ("pageable", False)):
        host = torch.empty(n, dtype=torch.bfloat16, pin_memory=pin)
        dev = torch.empty(n, dtype=torch.bfloat16, device="cuda")

        for _ in range(3):
            dev.copy_(host, non_blocking=pin)
        sync()
        t0 = time.perf_counter()
        for _ in range(iters):
            dev.copy_(host, non_blocking=pin)
        sync()
        out[f"h2d_{label}_gibs"] = gib(size_mb * 1024 * 1024 * iters) / (time.perf_counter() - t0)

        for _ in range(3):
            host.copy_(dev, non_blocking=pin)
        sync()
        t0 = time.perf_counter()
        for _ in range(iters):
            host.copy_(dev, non_blocking=pin)
        sync()
        out[f"d2h_{label}_gibs"] = gib(size_mb * 1024 * 1024 * iters) / (time.perf_counter() - t0)

        del host, dev
        torch.cuda.empty_cache()

    return out


def bench_vram_ceiling(step_mb: int = 256) -> dict[str, float]:
    """Allocate in steps until CUDA refuses, to find the practical ceiling."""
    blocks = []
    try:
        while True:
            blocks.append(torch.empty(step_mb * 1024 * 1024, dtype=torch.uint8, device="cuda"))
    except torch.OutOfMemoryError:
        pass
    peak = len(blocks) * step_mb
    del blocks
    torch.cuda.empty_cache()
    free, total = torch.cuda.mem_get_info()
    return {
        "allocatable_gib": peak / 1024,
        "reported_free_gib": gib(free),
        "reported_total_gib": gib(total),
    }


def bench_disk(path: str, size_mb: int | None = None) -> dict[str, float]:
    """Sequential write then genuinely cold read, in GiB/s.

    The probe file must be larger than free RAM. An earlier version used a fixed
    4 GiB and reported 6.57 GiB/s cold against 6.62 GiB/s warm; those agreed
    because the file never left the page cache, so neither number touched the
    device. Sized above free RAM the same drive sustains 1.74 GiB/s -- and every
    cold-start estimate downstream depends on which figure is used.
    """
    if size_mb is None:
        # psutil is not a hard dependency of this script; without it, fall back to
        # a size that is above free RAM on any machine this repo targets.
        try:
            import psutil

            free_mb = psutil.virtual_memory().available / (1024 * 1024)
        except ImportError:
            free_mb = 48 * 1024
        size_mb = int(max(4096, free_mb * 1.5)) // 64 * 64
    chunk = os.urandom(64 * 1024 * 1024)
    chunks = size_mb // 64
    fname = os.path.join(path, "aistudio_probe.bin")

    t0 = time.perf_counter()
    with open(fname, "wb", buffering=0) as f:
        for _ in range(chunks):
            f.write(chunk)
        f.flush()
        os.fsync(f.fileno())
    write_gibs = gib(size_mb * 1024 * 1024) / (time.perf_counter() - t0)

    buf = bytearray(64 * 1024 * 1024)
    t0 = time.perf_counter()
    with open(fname, "rb", buffering=0) as f:
        while f.readinto(buf):
            pass
    read_gibs = gib(size_mb * 1024 * 1024) / (time.perf_counter() - t0)

    # Warm read: the page cache is what a second load actually hits. With the
    # file sized above RAM this can no longer be fully cached either, so the
    # two numbers should now differ; if they still match, the probe is too small.
    t0 = time.perf_counter()
    with open(fname, "rb", buffering=0) as f:
        while f.readinto(buf):
            pass
    warm_gibs = gib(size_mb * 1024 * 1024) / (time.perf_counter() - t0)

    os.remove(fname)
    return {
        "probe_mb": size_mb,
        "write_gibs": write_gibs,
        "read_cold_gibs": read_gibs,
        "read_warm_gibs": warm_gibs,
    }


def bench_host_memcpy(size_mb: int = 2048, iters: int = 5) -> float:
    """Host-to-host copy bandwidth, the floor for any CPU-side offload shuffle."""
    n = size_mb * 1024 * 1024
    src = bytearray(os.urandom(1024 * 1024)) * (size_mb)
    dst = bytearray(n)
    mv_s, mv_d = memoryview(src), memoryview(dst)
    times = []
    for _ in range(iters):
        t0 = time.perf_counter()
        mv_d[:] = mv_s
        times.append(time.perf_counter() - t0)
    return gib(n) / statistics.median(times)


def main() -> None:
    scratch = sys.argv[1] if len(sys.argv) > 1 else tempfile.gettempdir()

    if not torch.cuda.is_available():
        print("CUDA unavailable", file=sys.stderr)
        raise SystemExit(1)

    props = torch.cuda.get_device_properties(0)
    report: dict[str, object] = {
        "host": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "cpu": platform.processor(),
            "cpu_count": os.cpu_count(),
        },
        "torch": {
            "version": torch.__version__,
            "cuda": torch.version.cuda,
            "cudnn": torch.backends.cudnn.version(),
        },
        "gpu": {
            "name": props.name,
            "total_gib": gib(props.total_memory),
            "sm_count": props.multi_processor_count,
            "capability": f"{props.major}.{props.minor}",
        },
    }

    print("probing compute ...", flush=True)
    report["compute_tflops"] = {
        "bf16_8192": bench_matmul(torch.bfloat16),
        "fp16_8192": bench_matmul(torch.float16),
        "fp32_4096": bench_matmul(torch.float32, n=4096, iters=10),
    }

    print("probing pcie ...", flush=True)
    report["pcie"] = bench_pcie()

    print("probing vram ceiling ...", flush=True)
    report["vram"] = bench_vram_ceiling()

    print("probing host memcpy ...", flush=True)
    report["host_memcpy_gibs"] = bench_host_memcpy()

    print("probing storage ...", flush=True)
    report["storage"] = bench_disk(scratch)

    print(json.dumps(report, indent=2))
    with open(os.path.join(scratch, "probe-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)


if __name__ == "__main__":
    main()
