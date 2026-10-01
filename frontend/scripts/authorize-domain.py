"""Thêm domain vào danh sách Authorized domains của Firebase Auth.

    python3 scripts/authorize-domain.py ai-studio-client.web.app

Đọc danh sách hiện có rồi ghi lại cả danh sách kèm domain mới — API này thay cả
trường, nên không đọc trước là xoá mất domain của app khác.
"""

from __future__ import annotations

import json
import subprocess
import sys

PROJECT = "forward-camera-345608"
BASE = f"https://identitytoolkit.googleapis.com/admin/v2/projects/{PROJECT}/config"


def token() -> str:
    return subprocess.run(
        ["gcloud", "auth", "print-access-token"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def call(method: str, url: str, bearer: str, body: dict | None = None) -> dict:
    command = [
        "curl",
        "-sS",
        "-X",
        method,
        "-H",
        f"Authorization: Bearer {bearer}",
        "-H",
        f"x-goog-user-project: {PROJECT}",
        "-H",
        "Content-Type: application/json",
        url,
    ]
    if body is not None:
        command += ["-d", json.dumps(body)]

    result = subprocess.run(command, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    if "error" in payload:
        raise SystemExit(f"API lỗi: {payload['error'].get('message')}")
    return payload


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1

    domain = sys.argv[1]
    bearer = token()

    current = call("GET", BASE, bearer).get("authorizedDomains", [])
    print("đang có:", ", ".join(current))

    if domain in current:
        print(f"{domain} đã có sẵn, không đổi gì")
        return 0

    updated = [*current, domain]
    call("PATCH", f"{BASE}?updateMask=authorizedDomains", bearer, {"authorizedDomains": updated})
    print("sau khi thêm:", ", ".join(call("GET", BASE, bearer).get("authorizedDomains", [])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
