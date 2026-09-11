"""Tie the child's life to this process's, at the level Windows enforces.

`atexit` does not run when a process is killed with `TerminateProcess`, which is
what `taskkill /F` does and therefore what happens to this arm every time the
supervisor stops it hard. A child started normally then survives, and this
child holds thirteen gigabytes of a sixteen gigabyte card -- an orphan nobody is
looking for and nothing will reclaim.

Observed, not theorised: a real run left `sd-server.exe` alive holding 444 MiB
after its parent was terminated.

A job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` moves the guarantee into
the kernel. When this process dies -- cleanly, by signal, or by
`TerminateProcess` -- its last handle to the job closes and Windows kills
everything in it. No cooperation from the child required.

A no-op on any other platform, where the supervisor's process group already
covers this.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from typing import Any

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimits),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class KillOnClose:
    """A job object holding one child, which dies when this object is dropped.

    The handle has to outlive the child, so a caller keeps the instance for as
    long as the child runs. Dropping it is what kills the child, which is the
    behaviour being bought.
    """

    def __init__(self) -> None:
        self._handle: int | None = None
        if sys.platform != "win32":
            return

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObject failed")

        limits = _ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(
            wintypes.HANDLE(handle),
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        )
        if not ok:
            error = ctypes.get_last_error()
            kernel32.CloseHandle(wintypes.HANDLE(handle))
            raise OSError(error, "SetInformationJobObject failed")

        self._kernel32 = kernel32
        self._handle = handle

    @property
    def active(self) -> bool:
        return self._handle is not None

    def adopt(self, process: Any) -> None:
        """Put an already-started `subprocess.Popen` into the job.

        `_handle` is private, but it is the only place the standard library
        keeps the Win32 process handle, and reopening it by pid would race a
        pid that has already been reused.
        """
        if self._handle is None:
            return
        handle = getattr(process, "_handle", None)
        if handle is None:
            return
        if not self._kernel32.AssignProcessToJobObject(
            wintypes.HANDLE(self._handle), wintypes.HANDLE(int(handle))
        ):
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")

    def close(self) -> None:
        if self._handle is None:
            return
        # Closing the last handle is what kills the child; that is the point.
        self._kernel32.CloseHandle(wintypes.HANDLE(self._handle))
        self._handle = None

    def __del__(self) -> None:
        # S110: during interpreter teardown there is nowhere to log to -- the
        # streams may already be closed -- and raising from __del__ only prints
        # a warning nobody acts on. Closing the handle is the whole job.
        try:
            self.close()
        except Exception:  # noqa: BLE001, S110 - nothing useful can happen during teardown
            pass
