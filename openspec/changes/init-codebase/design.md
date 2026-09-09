## Context

See proposal.md - Why. The constraints that shape this design:

- Arms need mutually incompatible native dependencies (two sd.cpp builds against different CUDA minor versions must coexist).
- A single consumer GPU means arms compete for VRAM; switching modality generally requires evicting the incumbent.
- Backends are not uniform: `llama-server` and `ollama` are long-running HTTP servers, ComfyUI is a long-running server with a graph API, `sd.cpp` is a one-shot CLI with no server at all, and `diffusers` is a Python library with no process of its own.
- The development server runs over HTTPS, so a page at `https://localhost:3000` cannot call an arm at `http://127.0.0.1:*` directly - browsers block that as mixed content. All arm traffic must be proxied server-side.
- Nuxt's dev server reloads on every server-side edit.

## Goals / Non-Goals

**Goals:**

- Adding a new arm that reuses an existing wire protocol requires writing a manifest file and no application code.
- An arm's native dependencies are invisible to every other arm.
- Stopping an arm reliably returns its VRAM.
- A running arm and an in-flight job survive a web-app restart.

**Non-Goals:**

- Multi-GPU scheduling. One GPU is assumed; the manifest reserves a device field but the scheduler ignores it.
- Remote or multi-machine arms. Everything is loopback-local.
- Sandboxing arms from each other or from the filesystem. Arms are trusted local code.

## Decisions

### 1. The supervisor is a separate daemon, not part of Nitro

```
   Browser (https)
      |
   +--------------------+
   |  apps/web (Nuxt)   |   UI + server-side proxy only
   +---------+----------+
             | HTTP over 127.0.0.1 + bearer token
   +---------v----------+
   | apps/supervisor    |   registry, lifecycle, scheduler, PID ownership
   +--+-------------+---+
      | spawn       | spawn
   +--v----+     +--v-----+
   | arm A |     | arm B  |
   +-------+     +--------+
```

Alternative considered: keep the supervisor inside Nitro and spawn arms from Nuxt server routes. Rejected because Nuxt HMR restarts the Nitro process on every server-side edit. A child process spawned before the reload keeps running but loses its parent's handle, leaving an orphaned arm holding several gigabytes of VRAM that only Task Manager can clear. Rebuilding state from a PID table after each reload is possible but is a workaround for a self-inflicted problem. Splitting the daemon out also means restarting the web app never interrupts a long-running generation.

Cost accepted: two processes to run in development, and an RPC hop. Mitigated by a single `pnpm dev` script that starts both.

Transport is plain HTTP on loopback with a bearer token from `.env`, chosen over Unix domain sockets (unavailable on Windows) and named pipes (platform-specific, poor tooling). The token exists so that other local processes on the machine cannot drive the supervisor.

### 2. Isolation by directory and virtualenv, not containers

Each arm package owns its binaries and its interpreter environment:

```
arms/image-sdcpp-v03-cu121/bin/{sd.exe, cudart64_12.dll, cublas64_12.dll, ...}
arms/image-sdcpp-v05-cu124/bin/{sd.exe, cudart64_12.dll, cublas64_12.dll, ...}
arms/image-diffusers/.venv/  (torch built for its own CUDA)
```

Alternative considered: one container per arm. Rejected for now because it is not necessary. Prebuilt llama.cpp and sd.cpp releases ship their CUDA runtime DLLs next to the executable, and Windows resolves DLLs from the executable's directory first; PyTorch wheels likewise vendor their CUDA libraries. Only the host NVIDIA driver is shared, and a modern driver supports every CUDA 12.x runtime. Containers would add a WSL2 and nvidia-container-toolkit dependency to buy isolation the filesystem already provides. The manifest's `launch.env` allows per-arm environment overrides for the cases where directory order is not enough.

### 3. An arm is a manifest, not an interface implementation

`arm.yaml` is the only thing the supervisor understands about an arm. Two fields carry most of the design:

**`protocol`** decides who speaks the studio's job contract:

| value | meaning | code required in the arm |
|---|---|---|
| `openai` | OpenAI-compatible HTTP; supervisor adapts | none - manifest only |
| `comfy` | ComfyUI graph API; supervisor adapts | none - manifest only |
| `cli` | supervisor runs the binary once per job | none - manifest only |
| `native` | the arm implements the studio contract itself | a server, any language |

Alternative considered: require every arm to implement the studio contract, with a per-arm sidecar. Rejected because it makes the common cases expensive - `ollama` and `llama-server` already expose a perfectly good OpenAI-compatible API, and wrapping them adds a process and a translation layer per arm for no gain. Centralising the adapters means a new ollama arm is a five-line YAML file. `native` remains the escape hatch for anything unusual, which preserves the "any language" requirement.

**`lifecycle`** distinguishes two genuinely different process shapes:

```
  resident            spawn -> [running: many jobs] -> stop
                      holds VRAM until stopped; needs health probe + port

  oneshot             per job: spawn -> run -> exit
                      VRAM returned on exit; no port, no health probe
```

`sd.cpp` has no server mode, so without `oneshot` it could not be an arm at all. The side benefit is that one-shot arms are exempt from eviction: they never hold VRAM between jobs.

Example manifests:

```yaml
id: text-llamacpp-cu124
modality: text
protocol: openai
lifecycle: resident
resources: { gpu: exclusive, vramEstimateMb: 8000 }
launch:
  cwd: ./bin
  command: ./llama-server.exe
  args: ["-m", "{{model}}", "--host", "127.0.0.1", "--port", "{{port}}"]
health: { type: http, path: /health, timeoutMs: 120000 }
params: ./params.schema.json
```

```yaml
id: image-sdcpp-v03-cu121
modality: image
protocol: cli
lifecycle: oneshot
resources: { gpu: exclusive, vramEstimateMb: 6000 }
launch:
  cwd: ./bin
  command: ./sd.exe
  args: ["-m", "{{model}}", "-p", "{{prompt}}", "-o", "{{outPath}}"]
health: { type: none }
params: ./params.schema.json
```

Manifests are parsed and validated by a Zod schema in `packages/arm-contract`, shared by the supervisor and the web app so the UI can render controls from the same types.

### 4. GPU arbitration: one exclusive slot, behind an evictor interface

For this change the policy is the simplest one that matches the intended behaviour: at most one arm with `resources.gpu: exclusive` may be running. Starting another evicts the incumbent first.

```
  request arm B  -->  B running?  --yes--> dispatch
                          |no
                          v
                  incumbent holding the slot?  --yes--> stop it, await exit
                          |no                                 |
                          +<----------------------------------+
                          v
                  spawn B -> await health -> dispatch
```

Alternative considered: a VRAM budget allowing several small arms to coexist. Deferred, not rejected. The scheduler is therefore written as `plan(request, running[]) -> { evict[], start }` so the policy is one replaceable function. Hard-coding `if (running) kill(running)` at the call site would make the budget policy a rewrite.

`vramEstimateMb` is recorded in the manifest now, unused by the current policy, so that manifests do not need revisiting when the policy changes.

### 5. Spawning is a security boundary

The web app can cause processes to start, so the rules are structural rather than advisory:

- Launch commands come only from `arm.yaml` files discovered under `arms/`. There is no API that accepts a command, and manifests are not writable through the web app.
- Processes are spawned with an argv array and `shell: false`. No string is ever handed to a shell.
- `{{...}}` placeholders are substituted only with values that passed the arm's `params.schema.json`, and only into individual argv elements - never concatenated into one.
- Placeholders resolving to paths (`{{model}}`, `{{outPath}}`) are resolved and asserted to remain inside `storage/`, rejecting traversal.
- Arms bind `127.0.0.1` on a supervisor-allocated ephemeral port. The port is never sent to the browser; the browser only ever talks to Nuxt.

### 6. Process termination kills the tree

Stopping an arm means `SIGTERM` (or the Windows equivalent), then a forced kill after a grace period. The forced path must terminate the whole process tree - a Python arm's dataloader workers or a ComfyUI subprocess will otherwise survive and keep the VRAM allocation alive, which defeats the entire point of the stop operation. On Windows this uses a Job Object with kill-on-close, falling back to `taskkill /T /F`.

### 7. Pinned toolchain

Node 24.20.0 (the version installed on the development machine), pnpm 12, Nuxt 4, Tailwind 4. Pinned via `engines`, `packageManager`, and `.nvmrc` so that a second machine cannot silently resolve something else.

Tailwind 4 is wired through `@tailwindcss/vite` with `@import "tailwindcss"` in a CSS entry point, not through the `@nuxtjs/tailwindcss` module and with no `tailwind.config.js`. Tailwind 4 moved configuration into CSS and dropped the JS config file; the Nuxt module targets the v3 shape, so using it would reintroduce the very file v4 removed. Recording this because scaffolding tools still default to the v3 arrangement.

## Risks / Trade-offs

- **Thrashing when alternating between chat and image generation.** Every switch pays a full model load. → Accepted for this change; the evictor interface from decision 4 is the seam where an idle TTL, a pinned arm, or a VRAM budget can be added without touching callers.
- **Supervisor crash orphans arms.** → The supervisor persists a PID and start-token registry; on startup it reconciles, adopting processes it recognises and killing the rest before accepting requests.
- **`arm.yaml` is effectively an instruction to execute a binary.** Anyone who can write to `arms/` can run code as the user. → This is inherent to the product and is not a privilege escalation, since the same user already runs the studio. Documented as a trust boundary: `arms/` is trusted code, treated like any dependency.
- **Self-signed HTTPS produces a browser warning.** → Accepted for development. `mkcert` is documented as an opt-in for anyone who wants a clean padlock; `.gitignore` already excludes certificate material.
- **Windows-first assumptions** (`.exe` in manifests, Job Objects, DLL search order). → The manifest keeps `command` opaque so per-platform manifests are possible; the process-tree kill lives behind one platform-dispatched function.
- **Two dev processes can drift out of sync** if someone starts only Nuxt. → The web app surfaces supervisor reachability as an explicit state in the UI rather than failing requests obscurely.

## Open Questions

- Whether `packages/arm-contract` should also generate JSON Schema for consumption by non-TypeScript `native` arms. Only matters once such an arm exists.
- Whether arm binaries should be fetched by a repo-level script or documented as manual setup. Does not affect the contract, the specs, or the task breakdown.
