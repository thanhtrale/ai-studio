"""Download what the rig arm reads into the studio's models directory.

    python scripts/fetch.py            # every file in weights.json
    python scripts/fetch.py --check    # report what is there, download nothing
    python scripts/fetch.py --anims    # also the Mixamo dataset's animation/ folder (784 MiB, 1000 files)

Reads `weights.json`; nothing is listed here. A file counts as present only at
its exact byte count, which was read from the Hugging Face API rather than from
a size label (labels mix GiB and decimal GB).

`jasongzy/Mixamo` is gated ("auto"): accept it on its Hugging Face page with
the account whose token is in HF_HOME first. Do not fetch it from a mirror.

A file with `link` is not downloaded when the linked file is already there at
the same size: it is hard-linked, so the same 625 MiB ShapeVAE is not kept twice.

Run with any Python that has `huggingface_hub`; the arm's own venv does.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001, S110
        pass

ARM = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = os.environ.get("AISTUDIO_MODELS_DIR") or str(ARM.parents[1] / "storage" / "models")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="only report what is on disk")
    parser.add_argument("--anims", action="store_true", help="also fetch the Mixamo dataset's animation/ folder")
    parser.add_argument("--dest", default=DEFAULT_ROOT, help="the studio's models directory")
    args = parser.parse_args()

    manifest = json.loads((ARM / "weights.json").read_text(encoding="utf-8"))
    root = Path(args.dest)
    print(f"arm   {ARM.name}\nroot  {root}\n")

    missing = []
    for entry in manifest["files"]:
        target = root / entry["dest"]
        have = target.stat().st_size if target.exists() else 0
        ok = have == int(entry["bytes"])
        mark = "ok " if ok else ("bad" if have else "  -")
        gated = "  (gated)" if entry.get("gated") else ""
        print(f"  [{mark}] {int(entry['bytes']) / 2**20:8.1f} MiB  {entry['role']:<24} {entry['dest']}{gated}")
        if not ok:
            missing.append(entry)
    if args.check:
        return 1 if missing else 0

    from huggingface_hub import hf_hub_download, snapshot_download

    for entry in missing:
        target = root / entry["dest"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if entry.get("link"):
            source = root / entry["link"]
            if source.is_file() and source.stat().st_size == int(entry["bytes"]):
                if target.exists():
                    target.unlink()
                os.link(source, target)
                print(f"link  {source} -> {target}")
                continue
        print(f"get   {entry['repo']}  {entry['file']}")
        got = Path(
            hf_hub_download(
                entry["repo"],
                entry["file"],
                revision=entry["revision"],
                repo_type=entry.get("repoType", "model"),
                local_dir=str(root / "_hf" / entry["repo"].replace("/", "__")),
            )
        )
        if got.resolve() != target.resolve():
            os.replace(got, target)
        print(f"  -> {target}  ({target.stat().st_size} B)")

    if args.anims:
        dataset = manifest["animations"]
        print(f"\nget   {dataset['repo']}  {dataset['folder']}/** -> {dataset['dest']}")
        snapshot_download(
            dataset["repo"],
            repo_type="dataset",
            revision=dataset["revision"],
            allow_patterns=[f"{dataset['folder']}/*"],
            local_dir=str(root / dataset["dest"]),
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
