"""Splice ai-studio's rules into the rulesets already live on the Firebase project.

Firebase has no notion of partial rules: a deploy replaces the whole file, and
this project's database and bucket are shared with other apps. So the live
ruleset is fetched first, this app's block is swapped in between markers, and
everything else is carried through untouched.

    python3 scripts/sync-rules.py            # fetch + write .rules-backup/*
    python3 scripts/sync-rules.py --diff     # and show what would change

Deploy the result with:

    npx firebase-tools deploy --only firestore:rules,storage \\
      --project <id> --config firebase.rules.json
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

PROJECT = "forward-camera-345608"
ROOT = Path(__file__).resolve().parent.parent
BACKUP = ROOT / ".rules-backup"
FRAGMENTS = ROOT / "rules"

BEGIN = "    // >>> ai-studio — managed by frontend/scripts/sync-rules.py"
END = "    // <<< ai-studio"

# The block this app used to have before it was split into fragments. Removed on
# the first run so the open rule does not sit alongside the scoped one.
LEGACY = re.compile(
    r"[ \t]*match /ai-studio/\{document=\*\*\} \{\s*allow read, write: if true;\s*\}\n",
)

TARGETS = {
    "firestore": {
        "release": "cloud.firestore",
        "fragment": FRAGMENTS / "firestore.ai-studio.rules",
        # Our block goes directly after this line in the live ruleset.
        "anchor": re.compile(r"^\s*match /databases/\{database\}/documents \{\s*$", re.MULTILINE),
    },
    "storage": {
        "release": f"{PROJECT}.appspot.com",
        "fragment": FRAGMENTS / "storage.ai-studio.rules",
        "anchor": re.compile(r"^\s*match /b/\{bucket\}/o \{\s*$", re.MULTILINE),
    },
}


def token() -> str:
    return subprocess.run(
        ["gcloud", "auth", "print-access-token"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def api(path: str, bearer: str) -> dict:
    # curl rather than urllib: the python.org build on macOS ships without a CA
    # bundle, so every TLS handshake from urllib fails here.
    result = subprocess.run(
        [
            "curl",
            "-sS",
            "-H",
            f"Authorization: Bearer {bearer}",
            "-H",
            f"x-goog-user-project: {PROJECT}",
            f"https://firebaserules.googleapis.com/v1/{path}",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    if "error" in payload:
        raise SystemExit(f"API lỗi: {payload['error'].get('message')}")
    return payload


def live_ruleset(release_id: str, bearer: str) -> str:
    releases = api(f"projects/{PROJECT}/releases", bearer).get("releases", [])
    match = next((r for r in releases if r["name"].split("/")[-1] == release_id), None)
    if match is None:
        raise SystemExit(f"Không tìm thấy release {release_id}")

    ruleset = api(f"projects/{PROJECT}/rulesets/{match['rulesetName'].split('/')[-1]}", bearer)
    return ruleset["source"]["files"][0]["content"]


def strip_comment_header(fragment: str) -> str:
    lines = fragment.splitlines(keepends=True)
    body = [line for line in lines if not line.startswith("//")]
    return "".join(body).strip("\n")


def splice(live: str, fragment: str, anchor: re.Pattern[str]) -> str:
    block = f"{BEGIN}\n{strip_comment_header(fragment)}\n{END}\n"

    existing = re.compile(
        rf"{re.escape(BEGIN)}.*?{re.escape(END)}\n",
        re.DOTALL,
    )
    if existing.search(live):
        return existing.sub(block, live)

    cleaned = LEGACY.sub("", live)
    anchored = anchor.search(cleaned)
    if anchored is None:
        raise SystemExit("Không tìm thấy chỗ neo để chèn khối rules")

    cut = anchored.end() + 1
    return cleaned[:cut] + block + cleaned[cut:]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--diff", action="store_true", help="in diff so với bản đang chạy")
    args = parser.parse_args()

    BACKUP.mkdir(exist_ok=True)
    bearer = token()

    for name, target in TARGETS.items():
        live = live_ruleset(str(target["release"]), bearer)

        fragment = Path(target["fragment"]).read_text(encoding="utf-8")
        merged = splice(live, fragment, target["anchor"])  # type: ignore[arg-type]

        (BACKUP / f"{name}.live.rules").write_text(live, encoding="utf-8")
        (BACKUP / f"{name}.merged.rules").write_text(merged, encoding="utf-8")
        print(f"{name}: {len(live.splitlines())} dòng live → {len(merged.splitlines())} dòng ghép")

        if args.diff:
            delta = difflib.unified_diff(
                live.splitlines(keepends=True),
                merged.splitlines(keepends=True),
                fromfile=f"{name}.live",
                tofile=f"{name}.merged",
            )
            sys.stdout.writelines(delta)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
