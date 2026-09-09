## Why

The repository is empty. Before any generation feature can be built, the project needs a skeleton that reflects its defining constraint: arms are heterogeneous runtimes (llama.cpp, sd.cpp, diffusers, ollama, ComfyUI) that may require **incompatible CUDA versions and incompatible library versions on the same machine**, and they compete for a single GPU's VRAM. That constraint dictates package isolation, process-level lifecycle control, and a declarative contract between the web app and the arms. Getting this foundation wrong is expensive to undo, so it is settled first.

## What Changes

- Establish a pnpm monorepo: `apps/web` (Nuxt + Tailwind), `apps/supervisor` (Node daemon), `packages/arm-contract` (shared schemas), `arms/*` (one package per arm), `storage/` (runtime data, untracked).
- Define the **arm package contract**: every arm is a self-contained, independently versioned package described by an `arm.yaml` manifest. The manifest declares how to launch the runtime, which wire protocol it speaks, whether it is resident or one-shot, and what parameters it accepts. Arms may be written in any language, or contain no code at all.
- Introduce the **supervisor daemon** as a process separate from the web server. It owns arm discovery, process spawn/stop/force-kill, port allocation, health probing, and GPU exclusivity. It is separate from Nitro so that Nuxt HMR reloads cannot orphan a running arm holding VRAM.
- Introduce the **web console** shell: Nuxt app with Tailwind, HTTPS dev server, and a server-side proxy to the supervisor. Ships an arm inventory view that can start and stop arms.
- Scaffold arm packages as folder structure plus manifests only: a resident text arm (llama.cpp), a one-shot image arm (sd.cpp), and a Python-hosted image arm (diffusers) with its own isolated virtualenv. No runtime integration yet.

### Non-Goals

Deliberately deferred to later changes, to keep this one reviewable:

- Job orchestration (submission, queueing, progress, cancellation, token streaming).
- The media library (generated assets plus prompt/settings metadata).
- Protocol adapters that translate between the studio contract and OpenAI-compatible / ComfyUI APIs.
- Downloading or vendoring any model weights or runtime binaries.
- Containerisation. Per-arm directory and virtualenv isolation is sufficient because prebuilt llama.cpp/sd.cpp binaries ship their own CUDA runtime DLLs alongside the executable, and PyTorch wheels bundle theirs; only the host driver must be new enough.

## Capabilities

### New Capabilities

- `arm-package`: What an arm is. Package layout, the `arm.yaml` manifest schema, environment isolation guarantees, discovery, and manifest validation.
- `arm-supervisor`: The daemon that owns arm processes. Lifecycle transitions, port allocation, health probing, forced VRAM reclamation, GPU exclusivity policy, and the control API it exposes.
- `web-console`: The Nuxt application. HTTPS development server, proxying to the supervisor, and the arm inventory and control surface.

### Modified Capabilities

None. This is the first change in the repository.

## Impact

- **New tooling**: pnpm workspaces, TypeScript project references, Vitest, ESLint. Node 24.20.0, pnpm 12.
- **New runtime dependency**: the supervisor is a second long-running process during development; `pnpm dev` must start both it and Nuxt.
- **Security surface introduced**: the web app can cause arbitrary local processes to be spawned. Launch commands are read only from `arm.yaml` files on disk, are never constructed from user input, and are executed without a shell. Arms bind to loopback only.
- **Platform**: primary development target is Windows with NVIDIA GPUs; process termination must kill the whole process tree or VRAM is not reclaimed.
- **Not affected**: nothing. The repository has no existing code.
