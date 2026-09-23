"""The flags this arm must and must not pass to its child.

One of these is not a style preference. `--swa-full` turns off the reduced
sliding-window KV cache, and for this model that is the difference between
fitting on the card and not: 25 of its 30 layers are sliding attention with a
1024-token window, and full-size caches for all of them at the trained context
is 25.6 GiB. llama.cpp defaults it to false, so the correct action is to never
pass it -- which is exactly the kind of requirement that is invisible in a diff
and survives only as a test.
"""

from __future__ import annotations

from pathlib import Path

from arm_gemma_text.runtime import LoadConfig


def config() -> LoadConfig:
    return LoadConfig(
        server_binary=Path("llama-server.exe"),
        model=Path("model.gguf"),
        mmproj=Path("mmproj.gguf"),
    )


def test_swa_full_is_never_passed() -> None:
    argv = config().argv("127.0.0.1", 8080)
    assert "--swa-full" not in argv
    assert not any(arg.startswith("--swa") for arg in argv)


def test_the_placement_flags_are_pinned() -> None:
    argv = config().argv("127.0.0.1", 8080)
    # The child's own placement fills the card to the edge, which under WDDM is
    # where the driver starts paging VRAM in silence.
    assert argv[argv.index("--fit") + 1] == "off"
    # With experts in RAM the mapped variant halves prompt speed; the child
    # warns about it itself.
    assert argv[argv.index("--load-mode") + 1] == "none"


def test_the_kv_cache_type_reaches_both_halves() -> None:
    argv = config().argv("127.0.0.1", 8080)
    assert argv[argv.index("--cache-type-k") + 1] == "q8_0"
    assert argv[argv.index("--cache-type-v") + 1] == "q8_0"
