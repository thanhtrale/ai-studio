"""LTX-2.5 distilled video arm, hosting Hugging Face Diffusers in-process.

`diffusers` is a library rather than a server, so unlike the llama.cpp and sd.cpp
arms this one contains code. What it adds beyond calling the pipeline is the part
that is specific to this machine: a precision and offload policy for a 22B model
on a 16 GiB card. See `docs/stack-selection.md`.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
