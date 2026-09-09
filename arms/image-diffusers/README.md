# image-diffusers

Resident image arm that hosts Hugging Face Diffusers inside its own Python
interpreter. Unlike the llama.cpp and sd.cpp arms this one contains code,
because `diffusers` is a library rather than a server.

At this stage only the health endpoint is implemented — enough for the
supervisor to start, health-check, stop, and force-kill it.

## Setting up the environment

From this directory:

```powershell
uv venv                      # creates .venv/ (git-ignored)
uv pip install -e .
# Pick the CUDA build that suits the installed driver:
uv pip install torch --index-url https://download.pytorch.org/whl/cu124
uv pip install -e ".[runtime]"
```

The manifest launches `./.venv/Scripts/python.exe` directly, so whatever CUDA
build lands in this venv is used by this arm and no other.

## Why `PYTHONPATH` is set in the manifest

`launch.env` puts `./src` on the path so the arm starts even before
`uv pip install -e .` has been run. After an editable install it is redundant
but harmless.
