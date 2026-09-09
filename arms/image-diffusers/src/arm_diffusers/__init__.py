"""Scaffold for the Diffusers image arm.

Only the health endpoint is implemented. Generation is intentionally absent:
this package exists so the supervisor has a real `native` arm to start, stop,
and force-kill while the job contract is designed in a later change.
"""

__all__ = ["__version__"]

__version__ = "0.0.0"
