"""The child must not be able to outlive the arm.

This is not hypothetical. A real run of the image arm left `sd-server.exe`
holding 444 MiB of a 16 GiB card after its parent was terminated: `atexit` does not run when Windows
kills a process with `TerminateProcess`, which is what `taskkill /F` does and
therefore what the supervisor does to an arm it has to stop hard.

So the guarantee is moved into the kernel, and this checks the kernel keeps it.
"""

from __future__ import annotations

import subprocess
import sys
import time

import pytest

from arm_gemma_text.jobobject import KillOnClose

WINDOWS_ONLY = pytest.mark.skipif(sys.platform != "win32", reason="job objects are a Win32 mechanism")


def _sleeper() -> subprocess.Popen[bytes]:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])


@WINDOWS_ONLY
def test_closing_the_job_kills_what_is_in_it() -> None:
    job = KillOnClose()
    assert job.active

    child = _sleeper()
    try:
        job.adopt(child)
        assert child.poll() is None

        # Exactly what happens when this arm is terminated: no unwinding, no
        # atexit, just the last handle to the job going away.
        job.close()

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and child.poll() is None:
            time.sleep(0.05)
        assert child.poll() is not None, "the child outlived the job object"
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)


@WINDOWS_ONLY
def test_a_child_in_the_job_still_runs_normally() -> None:
    """The job must not disturb a child that is behaving."""
    job = KillOnClose()
    child = subprocess.Popen([sys.executable, "-c", "print('alive')"], stdout=subprocess.PIPE)
    try:
        job.adopt(child)
        out, _ = child.communicate(timeout=30)
        assert out.strip() == b"alive"
        assert child.returncode == 0
    finally:
        job.close()


def test_it_is_a_no_op_off_windows() -> None:
    job = KillOnClose()
    # Constructing and closing must be safe everywhere; only Win32 has anything
    # to enforce, and the tests above are skipped elsewhere.
    assert job.active == (sys.platform == "win32")
    job.close()
    assert not job.active
