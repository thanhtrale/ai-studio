"""Measure what a configuration of this arm actually costs.

Produces the numbers that `docs/stack-selection.md` predicts, so the predictions
can be replaced by measurements. Run it from this directory with the arm's venv:

    .venv/Scripts/python.exe bench.py --model ../../storage/models/ltx-2.5-distilled

Add `--config fp8:group-stream --config bf16:group-stream` to compare; each
configuration is loaded from cold in its own subprocess, because a pipeline that
has already been through CUDA once does not load like one that has not.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

DEFAULT_PROMPT = (
    "A woman with long dark hair stands at a rain-streaked window in a dim apartment, "
    "city lights blurred behind the glass. She turns her head slowly toward the camera "
    "and exhales. The lighting is cool and low-key, coming mostly from the window, and "
    "raindrops cast moving shadows across her face. Handheld camera, shallow depth of "
    "field, the scene appears to be real-life footage."
)


class MemorySampler:
    """Samples system-wide memory, which is what pinned offload buffers move."""

    def __init__(self, interval: float = 0.25) -> None:
        import psutil

        self._psutil = psutil
        self._interval = interval
        self._stop = threading.Event()
        self.peak_used_gib = 0.0
        self.peak_proc_rss_gib = 0.0
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        process = self._psutil.Process()
        gib = 1024**3
        while not self._stop.is_set():
            self.peak_used_gib = max(self.peak_used_gib, self._psutil.virtual_memory().used / gib)
            self.peak_proc_rss_gib = max(self.peak_proc_rss_gib, process.memory_info().rss / gib)
            self._stop.wait(self._interval)

    def __enter__(self) -> MemorySampler:
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join(timeout=2)


def directory_bytes(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def run_one(args: argparse.Namespace, precision: str, offload: str) -> dict[str, object]:
    """Load, generate twice, and report. Called in a fresh subprocess."""
    import torch

    from arm_ltx25.generation import Job, generate
    from arm_ltx25.loading import LoadConfig, load_pipeline, vram_snapshot

    model_dir = Path(args.model).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    config = LoadConfig(
        model_dir=model_dir,
        precision=precision,
        offload=offload,
        blocks_per_group=args.blocks_per_group,
        disk_offload_dir=Path(args.offload_dir).resolve(),
        transformer_gguf=Path(args.transformer_gguf).resolve() if args.transformer_gguf else None,
        text_encoder_dir=Path(args.text_encoder_dir).resolve() if args.text_encoder_dir else None,
    )

    with MemorySampler() as sampler:
        pipe, load_report = load_pipeline(config)
        after_load = vram_snapshot()

        runs = []
        for index in range(args.runs):
            job = Job(
                prompt=args.prompt,
                out_path=out_dir / f"bench-{precision}-{offload}-{index}.mp4",
                width=args.width,
                height=args.height,
                num_frames=args.num_frames,
                seed=args.seed,
            )
            report = generate(pipe, job, model_dir)
            runs.append(
                {
                    "seconds_total": report.seconds_total,
                    "seconds_prologue": report.seconds_encode_prompt,
                    "seconds_per_step": report.seconds_per_step,
                    "peak_vram_allocated_gib": report.peak_vram_allocated_gib,
                    "peak_vram_reserved_gib": report.peak_vram_reserved_gib,
                    "out_bytes": report.out_bytes,
                }
            )

    steps = [s for run in runs[1:] or runs for s in run["seconds_per_step"]]
    return {
        "precision": precision,
        "offload": offload,
        "blocks_per_group": args.blocks_per_group,
        "resolution": f"{args.width}x{args.height}x{args.num_frames}",
        "model_disk_gib": directory_bytes(model_dir) / 1024**3,
        "load_seconds": load_report.seconds,
        "pinned": load_report.pinned,
        "vram_after_load_gib": after_load["reserved_gib"],
        "vram_free_after_load_gib": after_load["free_gib"],
        "peak_vram_reserved_gib": max(r["peak_vram_reserved_gib"] for r in runs),
        "peak_system_ram_gib": sampler.peak_used_gib,
        "peak_process_rss_gib": sampler.peak_proc_rss_gib,
        "median_step_seconds": sorted(steps)[len(steps) // 2] if steps else None,
        "runs": runs,
        "torch": torch.__version__,
    }


def parse_configs(values: list[str]) -> list[tuple[str, str]]:
    configs = []
    for value in values:
        precision, _, offload = value.partition(":")
        configs.append((precision, offload or "group-stream"))
    return configs


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bench.py", description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--out-dir", default="../../storage/outputs/bench")
    parser.add_argument("--offload-dir", default="../../storage/cache/ltx25-offload")
    parser.add_argument("--transformer-gguf", default=None, help="pre-quantized transformer, e.g. a Q6_K GGUF")
    parser.add_argument("--text-encoder-dir", default=None, help="pre-quantized text encoder directory")
    parser.add_argument("--report", default="../../storage/outputs/bench/report.json")
    parser.add_argument(
        "--config",
        action="append",
        default=[],
        metavar="PRECISION:OFFLOAD",
        help="repeatable, e.g. fp8:group-stream (default: fp8:group-stream, bf16:group-stream)",
    )
    parser.add_argument("--runs", type=int, default=2, help="generations per config; the first is discarded as warm-up")
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=544)
    parser.add_argument("--num-frames", type=int, default=121)
    parser.add_argument("--blocks-per-group", type=int, default=2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    # Set when this process is the child running a single configuration.
    parser.add_argument("--single", metavar="PRECISION:OFFLOAD", help=argparse.SUPPRESS)
    return parser


def main() -> None:
    args = build_parser().parse_args()

    if args.single:
        precision, offload = parse_configs([args.single])[0]
        print(json.dumps({"__result__": run_one(args, precision, offload)}), flush=True)
        return

    configs = parse_configs(args.config) if args.config else [("fp8", "group-stream"), ("bf16", "group-stream")]
    results = []

    for precision, offload in configs:
        print(f"=== {precision} / {offload} ===", flush=True)
        # Built from parsed values rather than by filtering sys.argv, so a value
        # that happens to look like a flag cannot change the child's behaviour.
        child = [
            sys.executable,
            __file__,
            "--single", f"{precision}:{offload}",
            "--model", args.model,
            "--out-dir", args.out_dir,
            "--offload-dir", args.offload_dir,
            *(["--transformer-gguf", args.transformer_gguf] if args.transformer_gguf else []),
            *(["--text-encoder-dir", args.text_encoder_dir] if args.text_encoder_dir else []),
            "--runs", str(args.runs),
            "--width", str(args.width),
            "--height", str(args.height),
            "--num-frames", str(args.num_frames),
            "--blocks-per-group", str(args.blocks_per_group),
            "--seed", str(args.seed),
            "--prompt", args.prompt,
        ]
        started = time.perf_counter()
        completed = subprocess.run(child, capture_output=True, text=True, env=os.environ.copy())
        print(completed.stdout[-4000:], flush=True)
        if completed.returncode != 0:
            print(completed.stderr[-4000:], file=sys.stderr, flush=True)
            results.append({"precision": precision, "offload": offload, "error": completed.stderr[-2000:]})
            continue

        payload = next(
            (json.loads(line)["__result__"] for line in completed.stdout.splitlines() if '"__result__"' in line),
            None,
        )
        if payload is None:
            results.append({"precision": precision, "offload": offload, "error": "no result line in child output"})
            continue
        payload["wall_seconds"] = time.perf_counter() - started
        results.append(payload)

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(results, indent=2), encoding="utf-8")

    print(f"\nwrote {report_path}\n")
    header = f"{'config':<22}{'load s':>9}{'step s':>9}{'clip s':>9}{'peak VRAM':>11}{'peak RAM':>10}"
    print(header)
    print("-" * len(header))
    for row in results:
        name = f"{row['precision']}/{row['offload']}"
        if "error" in row:
            print(f"{name:<22}{'FAILED':>9}")
            continue
        clip = row["runs"][-1]["seconds_total"]
        print(
            f"{name:<22}{row['load_seconds']:>9.1f}{row['median_step_seconds']:>9.2f}{clip:>9.1f}"
            f"{row['peak_vram_reserved_gib']:>10.2f}G{row['peak_system_ram_gib']:>9.1f}G"
        )


if __name__ == "__main__":
    main()
