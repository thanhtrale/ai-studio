"""The whole arm against a stand-in child.

Everything but the model: the child is started and waited for, its log is read
and turned into a timeline, the graph is built and queued, the files ComfyUI
saved are moved into the library's tree.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from arm_h3.generation import JobError
from arm_h3.runtime import ChildFailed, ComfyServer, LoadConfig
from arm_h3.server import ArmState

FAKE = Path(__file__).parent / "fake_comfy.py"


@dataclass
class FakeConfig(LoadConfig):
    """The real config, pointed at a stand-in instead of ComfyUI's main.py."""

    @property
    def main(self) -> Path:
        return FAKE

    def argv(self, host: str, port: int, model_paths: Path) -> list[str]:
        real = super().argv(host, port, model_paths)
        # Same flags, same order, different program: the arm's own argument
        # building is what is under test, so only the script name is replaced.
        return [sys.executable, str(FAKE), *real[2:]]


def config_for(tmp_path: Path) -> FakeConfig:
    models = tmp_path / "models"
    models.mkdir(exist_ok=True)
    nodes = tmp_path / "custom_nodes" / "minimax_h3_turbo"
    nodes.mkdir(parents=True, exist_ok=True)
    (nodes / "__init__.py").write_text("", encoding="utf-8")
    return FakeConfig(
        comfy_dir=tmp_path,
        diffusion_model=models / "minimax_h3_fl2va_int8_convrot.safetensors",
        text_encoder=models / "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
        video_vae=models / "minimax_h3_video_vae_fp16.safetensors",
        audio_vae=models / "minimax_h3_audio_vae_fp32.safetensors",
        turbo_lora=models / "minimax_h3_turbo_v4_step600_ema.safetensors",
        custom_nodes_dir=tmp_path / "custom_nodes",
        input_dir=tmp_path / "inputs",
        scratch_dir=tmp_path / "scratch",
    )


@pytest.fixture
def arm(tmp_path: Path):
    out_dir = tmp_path / "outputs"
    in_dir = tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    state = ArmState(config_for(tmp_path), out_dir, in_dir)
    try:
        yield state
    finally:
        state.shutdown()


def test_a_single_clip_run(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run(
        {
            "jobId": "job-1",
            "prompt": "a lone crane over a misty gorge",
            "outPath": "2026-09-30/a.mp4",
            "seed": 42,
            "steps": 4,
        }
    )

    written = tmp_path / "outputs" / "2026-09-30" / "a.mp4"
    assert written.is_file()

    assert report["batch"] == 1
    assert report["videos"][0]["out_path"] == str(written)
    assert report["videos"][0]["seed"] == 42
    assert (report["num_frames"], report["frame_rate"]) == (124, 24)
    assert report["vram_scope"] in {"process", "card", "unavailable"}


def test_the_clip_is_moved_out_of_comfy_s_own_output_tree(arm: ArmState, tmp_path: Path) -> None:
    arm.run({"jobId": "job-2", "prompt": "a crane", "outPath": "a.mp4", "steps": 4})

    assert list((tmp_path / "scratch" / "output").rglob("*.mp4")) == []


def test_a_batch_writes_one_file_per_clip_with_its_own_seed(
    arm: ArmState, tmp_path: Path
) -> None:
    report = arm.run(
        {
            "jobId": "job-3",
            "prompt": "a crane",
            "outPath": "b.mp4",
            "batch": 3,
            "seed": 100,
            "steps": 4,
        }
    )

    folder = tmp_path / "outputs"
    assert sorted(path.name for path in folder.iterdir()) == ["b-2.mp4", "b-3.mp4", "b.mp4"]
    assert [clip["seed"] for clip in report["videos"]] == [100, 101, 102]

    meters = {meter["key"]: meter for meter in arm.progress.snapshot()["meters"]}
    assert (meters["batch"]["done"], meters["batch"]["total"]) == (3, 3)


def test_the_timeline_carries_the_child_log(arm: ArmState) -> None:
    arm.run({"jobId": "job-4", "prompt": "a crane", "outPath": "c.mp4", "steps": 6})

    snapshot = arm.progress.snapshot()
    steps = {step["key"]: step for step in snapshot["steps"]}
    assert steps["start"]["state"] == "done"
    assert steps["generate"]["state"] == "done"

    children = steps["generate"].get("children", [])
    assert {child["label"] for child in children} >= {"Load transformer", "Load text encoder"}
    assert all(child["state"] == "done" for child in children)

    meters = {meter["key"]: meter for meter in snapshot["meters"]}
    assert (meters["steps"]["done"], meters["steps"]["total"]) == (6, 6)


def test_keyframes_reach_the_graph(arm: ArmState, tmp_path: Path) -> None:
    (tmp_path / "inputs" / "first.png").write_bytes(b"\x89PNG\r\n\x1a\nreference")

    arm.run(
        {
            "jobId": "job-5",
            "prompt": "it starts to snow",
            "outPath": "d.mp4",
            "refImages": ["first.png"],
            "steps": 4,
        }
    )

    graphs = arm.server.get("/aistudio-test/submitted")["graphs"]
    assert graphs[-1]["keyframe0"]["inputs"]["image"] == "first.png"
    assert graphs[-1]["cond"]["inputs"]["first_frame"] == ["keyframe0", 0]


def test_a_job_the_arm_rejects_never_opens_a_timeline(arm: ArmState) -> None:
    with pytest.raises(JobError, match="multiple of 32"):
        arm.run({"jobId": "job-6", "prompt": "a", "outPath": "e.mp4", "width": 1000})

    assert arm.progress.snapshot() == {"jobId": None, "steps": [], "meters": [], "vram": []}


def test_a_graph_comfy_refuses_fails_the_timeline(arm: ArmState) -> None:
    with pytest.raises(ChildFailed, match="ComfyUI refused the prompt"):
        arm.run({"jobId": "job-7", "prompt": "reject: this one", "outPath": "f.mp4"})

    snapshot = arm.progress.snapshot()
    assert "generate" in {step["key"] for step in snapshot["steps"] if step["state"] == "failed"}


def test_a_missing_turbo_node_says_what_to_do(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    (config.custom_nodes_dir / "minimax_h3_turbo" / "__init__.py").unlink()
    server = ComfyServer(config, ArmState(config, tmp_path, tmp_path).progress)

    with pytest.raises(ChildFailed, match="minimax_h3_turbo"):
        server.start()


def test_the_search_paths_cover_both_vaes_and_the_node(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    config.scratch_dir.mkdir(parents=True, exist_ok=True)

    written = config.write_model_paths().read_text(encoding="utf-8")

    models = str(tmp_path / "models").replace("\\", "/")
    nodes = str(tmp_path / "custom_nodes").replace("\\", "/")
    # ComfyUI's VAELoader has one search path, so the video and audio VAEs are
    # expected to sit together -- the arm says so rather than quietly loading
    # whichever of the two it can find.
    assert f'vae: "{models}"' in written
    assert f'loras: "{models}"' in written
    assert f'custom_nodes: "{nodes}"' in written


def test_ref2v_reaches_the_graph_on_its_own_checkpoint(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    config.ref2va_model = tmp_path / "models" / "minimax_h3_ref2va_int8_convrot.safetensors"
    config.ref2va_model.write_bytes(b"weights")
    out_dir, in_dir = tmp_path / "outputs", tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    (in_dir / "hero.png").write_bytes(b"png")
    (in_dir / "room.png").write_bytes(b"png")
    state = ArmState(config, out_dir, in_dir)
    try:
        report = state.run(
            {
                "jobId": "job-ref",
                "prompt": "<Picture 1> walks into <Picture 2>",
                "outPath": "r.mp4",
                "mode": "ref2v",
                "refImages": ["hero.png", "room.png"],
            }
        )
        graph = state.server.get("/aistudio-test/submitted")["graphs"][-1]
    finally:
        state.shutdown()

    assert report["mode"] == "ref2v"
    assert graph["unet"]["inputs"]["unet_name"] == "minimax_h3_ref2va_int8_convrot.safetensors"
    assert graph["cond"]["class_type"] == "MiniMaxH3ReferenceToVideo"
    assert graph["reference1"]["inputs"]["image"] == "room.png"


def test_ref2v_without_the_checkpoint_never_starts_comfy(arm: ArmState, tmp_path: Path) -> None:
    (tmp_path / "inputs" / "hero.png").write_bytes(b"png")

    with pytest.raises(ChildFailed, match="ref2va"):
        arm.run(
            {
                "jobId": "job-ref-missing",
                "prompt": "<Picture 1> waves",
                "outPath": "m.mp4",
                "mode": "ref2v",
                "refImages": ["hero.png"],
            }
        )
    assert arm.server.pid is None


def test_a_ref2va_checkpoint_elsewhere_is_a_second_search_path(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    config.ref2va_model = tmp_path / "elsewhere" / "minimax_h3_ref2va_int8_convrot.safetensors"
    config.scratch_dir.mkdir(parents=True, exist_ok=True)

    written = config.write_model_paths().read_text(encoding="utf-8")

    models = str(tmp_path / "models").replace("\\", "/")
    elsewhere = str(tmp_path / "elsewhere").replace("\\", "/")
    # One key, two lines once YAML has read the escape: ComfyUI splits a search
    # path on newlines.
    assert f'diffusion_models: "{models}\\n{elsewhere}"' in written
