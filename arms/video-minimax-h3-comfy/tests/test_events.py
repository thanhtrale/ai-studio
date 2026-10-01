"""The event socket, and the phases it turns ComfyUI's node ids into.

Two things are worth pinning here. The frame reader, because a websocket frame
is a bit layout and an off-by-one silently desynchronises the stream rather
than raising. And the phase bookkeeping, because it is what decides where a
load and a sampler step are filed -- and getting that wrong produces a
timeline that looks plausible and is wrong.
"""

from __future__ import annotations

import json
import socket
import struct
import threading
import time
from pathlib import Path

import pytest

from arm_h3 import wsevents
from arm_h3.graph import PHASES, SAMPLER
from arm_h3.progress import JobProgress
from arm_h3.runtime import ComfyServer, LoadConfig


def text_frame(payload: dict) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    if len(body) < 126:
        return bytes([0x81, len(body)]) + body
    return bytes([0x81, 126]) + struct.pack(">H", len(body)) + body


def serve_frames(frames: list[bytes]) -> tuple[int, threading.Thread]:
    """A socket that answers the handshake and then writes `frames`."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = int(listener.getsockname()[1])

    def run() -> None:
        conn, _ = listener.accept()
        with conn:
            header = b""
            while not header.endswith(b"\r\n\r\n"):
                chunk = conn.recv(1)
                if not chunk:
                    return
                header += chunk
            conn.sendall(
                b"HTTP/1.1 101 Switching Protocols\r\n"
                b"Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
            )
            for frame in frames:
                conn.sendall(frame)
            conn.sendall(bytes([0x88, 0]))
        listener.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return port, thread


def test_the_reader_yields_whole_json_messages() -> None:
    small = {"type": "executing", "data": {"node": "cond"}}
    # Past 125 bytes the length moves into its own two-byte field, which is
    # the boundary a hand-rolled frame reader gets wrong.
    large = {"type": "executing", "data": {"node": "sampler", "pad": "x" * 400}}
    port, _ = serve_frames([text_frame(small), text_frame(large)])

    seen = list(wsevents.events("127.0.0.1", port, "client-1"))

    assert [message["data"]["node"] for message in seen] == ["cond", "sampler"]


def test_a_binary_frame_is_skipped_without_losing_the_next_one() -> None:
    # ComfyUI's latent previews are binary. Skipping the opcode but not the
    # payload would leave the reader parsing pixels as a frame header.
    preview = bytes([0x82, 8]) + b"\x00" * 8
    port, _ = serve_frames([preview, text_frame({"type": "executing", "data": {"node": "save"}})])

    seen = list(wsevents.events("127.0.0.1", port, "client-1"))

    assert [message["data"]["node"] for message in seen] == ["save"]


def config_for(tmp_path: Path) -> LoadConfig:
    models = tmp_path / "models"
    models.mkdir(exist_ok=True)
    return LoadConfig(
        comfy_dir=tmp_path,
        diffusion_model=models / "dit.safetensors",
        text_encoder=models / "te.safetensors",
        video_vae=models / "vvae.safetensors",
        audio_vae=models / "avae.safetensors",
        turbo_lora=models / "lora.safetensors",
        custom_nodes_dir=tmp_path / "custom_nodes",
        input_dir=tmp_path / "inputs",
        scratch_dir=tmp_path / "scratch",
    )


@pytest.fixture
def server(tmp_path: Path) -> ComfyServer:
    progress = JobProgress()
    progress.begin("job-1")
    instance = ComfyServer(config_for(tmp_path), progress)
    instance.progress.start("generate", "Generate")
    instance.begin_scan(6, phases=PHASES, sampler_node=SAMPLER)
    return instance


def executing(node: str | None) -> dict:
    return {"type": "executing", "data": {"node": node}}


def steps_of(progress: JobProgress, key: str) -> list[dict]:
    for step in progress.snapshot()["steps"]:
        if step["key"] == key:
            return step.get("children", [])
    return []


def test_a_named_node_opens_a_phase_under_the_generation(server: ComfyServer) -> None:
    server._absorb_event(executing("cond"))

    children = steps_of(server.progress, "generate")
    assert [(child["label"], child["state"]) for child in children] == [("Encode prompt", "running")]


def test_the_next_node_closes_the_phase_before_it(server: ComfyServer) -> None:
    server._absorb_event(executing("cond"))
    server._absorb_event(executing("sampler"))

    children = steps_of(server.progress, "generate")
    assert [(child["label"], child["state"]) for child in children] == [
        ("Encode prompt", "done"),
        ("Denoise", "running"),
    ]


def test_an_unnamed_node_still_ends_the_phase_before_it(server: ComfyServer) -> None:
    # A loader has no line of its own, but it is proof that whatever was
    # running has finished -- otherwise the phase stays open all graph.
    server._absorb_event(executing("cond"))
    server._absorb_event(executing("unet"))

    children = steps_of(server.progress, "generate")
    assert [(child["label"], child["state"]) for child in children] == [("Encode prompt", "done")]


def test_a_load_is_filed_under_the_phase_that_asked_for_the_weights(server: ComfyServer) -> None:
    server._absorb_event(executing("sampler"))
    server._absorb("[INFO] Requested to load MiniMaxH3")

    denoise = next(
        child for child in steps_of(server.progress, "generate") if child["label"] == "Denoise"
    )
    assert [grandchild["label"] for grandchild in denoise["children"]] == [
        "step 1 of 6",
        "Load transformer",
    ]


def test_a_phase_claims_the_load_that_beat_its_own_event(server: ComfyServer) -> None:
    # ComfyUI announces a node before running it, but that announcement goes
    # the long way round while the log goes straight down a pipe -- so a VAE,
    # which loads in the node's first instruction, arrives first.
    server._absorb_event(executing("sampler"))
    server._absorb("[INFO] Requested to load MiniMaxH3AudioVAE")
    server._absorb_event(executing("decode_audio"))

    phases = {child["label"]: child for child in steps_of(server.progress, "generate")}
    assert [g["label"] for g in phases["Decode audio"]["children"]] == ["Load audio VAE"]
    assert "Load audio VAE" not in [g["label"] for g in phases["Denoise"]["children"]]


def test_two_decoders_in_a_row_each_keep_their_own_load(server: ComfyServer) -> None:
    # Both VAEs land a breath early, one after the other. A phase that could
    # still reach a load the phase before it already claimed would walk it
    # forward a node at a time and leave the first decoder empty.
    server._absorb_event(executing("sampler"))
    server._absorb("[INFO] Requested to load MiniMaxH3AudioVAE")
    server._absorb_event(executing("decode_audio"))
    server._absorb("[INFO] Requested to load MiniMaxH3VideoVAE")
    server._absorb_event(executing("decode_video"))

    phases = {child["label"]: child for child in steps_of(server.progress, "generate")}
    assert [g["label"] for g in phases["Decode audio"]["children"]] == ["Load audio VAE"]
    assert [g["label"] for g in phases["Decode video"]["children"]] == ["Load video VAE"]


def test_a_phase_does_not_steal_a_load_from_the_middle_of_the_last_one(
    server: ComfyServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    server._absorb_event(executing("sampler"))
    server._absorb("[INFO] Requested to load MiniMaxH3")

    # The transformer loads well into sampling, so the next phase has no claim
    # on it however late its own event arrives.
    real = time.perf_counter
    monkeypatch.setattr(time, "perf_counter", lambda: real() + 30.0)
    server._absorb_event(executing("decode_video"))

    phases = {child["label"]: child for child in steps_of(server.progress, "generate")}
    assert "Load transformer" in [g["label"] for g in phases["Denoise"]["children"]]
    assert phases["Decode video"].get("children") is None


def test_the_sampler_bar_becomes_one_step_at_a_time(server: ComfyServer) -> None:
    server._absorb_event(executing("sampler"))
    server._absorb(" 17%|#7        | 1/6 [00:30<02:34, 30.96s/it]")
    server._absorb(" 33%|###3      | 2/6 [01:01<02:03, 30.90s/it]")

    denoise = next(
        child for child in steps_of(server.progress, "generate") if child["label"] == "Denoise"
    )
    assert [(g["label"], g["state"]) for g in denoise["children"]] == [
        ("step 1 of 6", "done"),
        ("step 2 of 6", "done"),
        ("step 3 of 6", "running"),
    ]


def test_the_last_step_of_the_bar_opens_nothing_after_it(server: ComfyServer) -> None:
    server._absorb_event(executing("sampler"))
    for done in range(1, 7):
        server._absorb(f" | {done}/6 [00:30<00:00, 30.96s/it]")

    denoise = next(
        child for child in steps_of(server.progress, "generate") if child["label"] == "Denoise"
    )
    assert len(denoise["children"]) == 6
    assert all(g["state"] == "done" for g in denoise["children"])


def test_ending_the_scan_closes_the_phase_left_open(server: ComfyServer) -> None:
    # The last node has no `executing` event after it; the prompt just ends.
    server._absorb_event(executing("save"))
    server.end_scan()

    children = steps_of(server.progress, "generate")
    assert [(child["label"], child["state"]) for child in children] == [("Write the file", "done")]


def test_events_outside_a_job_are_ignored(server: ComfyServer) -> None:
    server.end_scan()
    server._absorb_event(executing("cond"))

    assert steps_of(server.progress, "generate") == []
