# text-llamacpp-cu124

Resident text arm. Wraps `llama-server` from llama.cpp and speaks the
OpenAI-compatible protocol, so this package contains no code — only the
manifest and the parameter schema.

## Installing the runtime

Download a **CUDA 12.4** prebuilt release of llama.cpp for Windows from
<https://github.com/ggml-org/llama.cpp/releases> and unpack it into `bin/` so
that the layout is:

```
arms/text-llamacpp-cu124/
  arm.yaml
  params.schema.json
  bin/
    llama-server.exe
    ggml-cuda.dll
    cudart64_12.dll        <- shipped with the release, not the system copy
    cublas64_12.dll
    ...
```

`bin/` is git-ignored. Nothing here is downloaded automatically.

## Why the CUDA version is in the arm id

The CUDA runtime DLLs live next to `llama-server.exe`, and the manifest sets
`launch.cwd` to `bin/`. Windows resolves DLLs from the executable's directory
first, so a second arm built against a different CUDA minor version can be
installed alongside this one without either interfering with the other. Only
the host NVIDIA driver is shared.

## Models

Place GGUF weights under the managed storage directory, for example
`storage/models/llama-3.1-8b-instruct-q4_k_m.gguf`, and pass the path relative
to `storage/` as the `model` parameter. Paths that resolve outside `storage/`
are rejected before the process is launched.
