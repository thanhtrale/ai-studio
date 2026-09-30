"""The whole arm against a stand-in child.

Everything but the model: the child is started and waited for, its log is read
and turned into a timeline, both graphs are built and queued, the files
ComfyUI saved are moved into the library's tree.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from arm_qwen21.generation import JobError
from arm_qwen21.runtime import ChildFailed, ComfyServer, LoadConfig
from arm_qwen21.server import ArmState

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
    nodes = tmp_path / "custom_nodes" / "viggle_turbo"
    nodes.mkdir(parents=True, exist_ok=True)
    (nodes / "__init__.py").write_text("", encoding="utf-8")
    return FakeConfig(
        comfy_dir=tmp_path,
        diffusion_model=models / "qwen_image_2.1_bf16.safetensors",
        text_encoder=models / "qwen3vl_8b.safetensors",
        vae=models / "qwen_image_2.1_vae_bf16.safetensors",
        turbo_lora=models / "viggle-turbo-r256.safetensors",
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


def test_a_single_image_run(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run(
        {"jobId": "job-1", "prompt": "a paper crane", "outPath": "2026-09-30/a.png", "seed": 42}
    )

    written = tmp_path / "outputs" / "2026-09-30" / "a.png"
    assert written.is_file()
    assert written.read_bytes().startswith(b"\x89PNG")

    assert report["batch"] == 1
    assert report["images"][0]["out_path"] == str(written)
    assert report["images"][0]["seed"] == 42
    # Six steps is the schedule, not a suggestion: it is what the LoRA was
    # distilled for and what the arm defaults to.
    assert report["steps"] == 6
    assert report["prompt_used"] is None
    assert report["vram_scope"] in {"process", "card", "unavailable"}


def test_the_image_is_moved_out_of_comfy_s_own_output_tree(arm: ArmState, tmp_path: Path) -> None:
    arm.run({"jobId": "job-2", "prompt": "a paper crane", "outPath": "a.png"})

    assert list((tmp_path / "scratch" / "output").rglob("*.png")) == []


def test_a_batch_writes_one_file_per_image_with_its_own_seed(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run(
        {"jobId": "job-3", "prompt": "a crane", "outPath": "b.png", "batch": 3, "seed": 100, "steps": 4}
    )

    folder = tmp_path / "outputs"
    assert sorted(path.name for path in folder.iterdir()) == ["b-2.png", "b-3.png", "b.png"]
    assert [image["seed"] for image in report["images"]] == [100, 101, 102]

    meters = {meter["key"]: meter for meter in arm.progress.snapshot()["meters"]}
    assert (meters["batch"]["done"], meters["batch"]["total"]) == (3, 3)


def test_the_timeline_carries_the_child_log(arm: ArmState) -> None:
    arm.run({"jobId": "job-4", "prompt": "a crane", "outPath": "c.png", "steps": 6})

    snapshot = arm.progress.snapshot()
    steps = {step["key"]: step for step in snapshot["steps"]}
    assert steps["start"]["state"] == "done"
    assert steps["generate"]["state"] == "done"

    children = steps["generate"].get("children", [])
    assert {child["label"] for child in children} >= {"Load transformer"}
    assert all(child["state"] == "done" for child in children)

    meters = {meter["key"]: meter for meter in snapshot["meters"]}
    assert (meters["steps"]["done"], meters["steps"]["total"]) == (6, 6)


def test_the_enhancer_rewrites_the_prompt_once_for_the_whole_batch(arm: ArmState) -> None:
    report = arm.run(
        {
            "jobId": "job-5",
            "prompt": "a paper crane",
            "outPath": "d.png",
            "batch": 2,
            "enhancePrompt": True,
            "steps": 4,
        }
    )

    assert report["prompt_used"] == "rewritten: a paper crane"

    # The rewriter draws its own progress bar as it generates tokens. Counting
    # those as sampler steps is how a six-step job reports 146 of 1024.
    meters = {meter["key"]: meter["label"] for meter in arm.progress.snapshot()["meters"]}
    assert meters.get("rewrite") == "Rewriter tokens"
    assert meters.get("steps") == "Sampler steps"

    graphs = arm.server.get("/aistudio-test/submitted")["graphs"]
    # One rewrite, then one prompt per image: the rewrite does not depend on
    # the seed, so paying for it twice would be paying for nothing.
    assert sum(1 for graph in graphs if "rewrite_generate" in graph) == 1
    images = [graph for graph in graphs if "encode" in graph]
    assert len(images) == 2
    assert all(graph["encode"]["inputs"]["prompt"] == "rewritten: a paper crane" for graph in images)


def test_without_the_enhancer_only_the_image_graph_runs(arm: ArmState) -> None:
    arm.run({"jobId": "job-6", "prompt": "a paper crane", "outPath": "e.png", "steps": 4})

    graphs = arm.server.get("/aistudio-test/submitted")["graphs"]
    assert not any("rewrite_generate" in graph for graph in graphs)


def test_references_reach_the_graph(arm: ArmState, tmp_path: Path) -> None:
    (tmp_path / "inputs" / "ref.png").write_bytes(b"\x89PNG\r\n\x1a\nreference")

    arm.run(
        {
            "jobId": "job-7",
            "prompt": "make it snow",
            "outPath": "f.png",
            "refImages": ["ref.png"],
            "steps": 4,
        }
    )

    graphs = arm.server.get("/aistudio-test/submitted")["graphs"]
    assert graphs[-1]["ref0"]["inputs"]["image"] == "ref.png"
    assert graphs[-1]["encode"]["inputs"]["images.image_1"] == ["ref0", 0]


def test_a_job_the_arm_rejects_never_opens_a_timeline(arm: ArmState) -> None:
    with pytest.raises(JobError, match="multiple of 32"):
        arm.run({"jobId": "job-8", "prompt": "a", "outPath": "g.png", "width": 1000})

    assert arm.progress.snapshot() == {"jobId": None, "steps": [], "meters": [], "vram": []}


def test_a_graph_comfy_refuses_fails_the_timeline(arm: ArmState) -> None:
    with pytest.raises(ChildFailed, match="ComfyUI refused the prompt"):
        arm.run({"jobId": "job-9", "prompt": "reject: this one", "outPath": "g.png"})

    snapshot = arm.progress.snapshot()
    assert "generate" in {step["key"] for step in snapshot["steps"] if step["state"] == "failed"}


def test_a_missing_viggle_node_says_what_to_do(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    (config.custom_nodes_dir / "viggle_turbo" / "__init__.py").unlink()
    server = ComfyServer(config, ArmState(config, tmp_path, tmp_path).progress)

    with pytest.raises(ChildFailed, match="viggle_turbo"):
        server.start()


def test_the_search_paths_include_the_lora_and_the_node(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    config.scratch_dir.mkdir(parents=True, exist_ok=True)

    written = config.write_model_paths().read_text(encoding="utf-8")

    models = str(tmp_path / "models").replace("\\", "/")
    nodes = str(tmp_path / "custom_nodes").replace("\\", "/")
    assert f'loras: "{models}"' in written
    # The Viggle nodes belong to this arm, not to the vendored ComfyUI, which
    # is why they arrive as a search path rather than as files copied into it.
    assert f'custom_nodes: "{nodes}"' in written
