# image-sdcpp-v03-cu121

One-shot image arm. Wraps the `sd.exe` CLI from stable-diffusion.cpp, which has
no server mode — the supervisor runs it once per job and the process exits,
returning its VRAM without an explicit stop.

## Installing the runtime

Download the **v0.3.x, CUDA 12.1** Windows release from
<https://github.com/leejet/stable-diffusion.cpp/releases> and unpack it into
`bin/`:

```
arms/image-sdcpp-v03-cu121/
  arm.yaml
  params.schema.json
  bin/
    sd.exe
    cudart64_12.dll        <- shipped with the release
    ...
```

`bin/` is git-ignored.

## Running a second version side by side

Copy this directory, change `id`, and unpack a different release into its
`bin/`. Because `launch.cwd` points at the arm's own `bin/`, the two builds
load their own CUDA runtimes and never see each other's.
