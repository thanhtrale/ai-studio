# ai-studio

A local studio for running generation models. Two moving parts:

- **arms** — self-contained packages that each wrap one runtime (llama.cpp, stable-diffusion.cpp, diffusers, ollama, ComfyUI). An arm is described by a manifest; most need no code at all.
- **the studio** — a supervisor daemon that owns arm processes and arbitrates the GPU, plus a Nuxt web console that talks to it.

```
  Browser (https)
       |
  +----------------+        +------------------+       +-------+
  | apps/web       |------->| apps/supervisor  |--...->| arms/ |
  | UI + relay     |  http  | lifecycle, GPU   | spawn |       |
  +----------------+  loop  +------------------+       +-------+
```

The browser never talks to an arm directly. It cannot: the dev server is HTTPS and arms are plain HTTP on loopback, so every request is relayed by the web app's server side.

## Prerequisites

- **Node 24.20.0** (`.nvmrc`), **pnpm 12**
- An NVIDIA driver new enough for the CUDA runtime your arms bundle. Arms ship their own CUDA libraries, so only the driver is shared.

```powershell
nvm use            # or install 24.20.0
npm install -g pnpm
pnpm install
Copy-Item .env.example .env
```

Then put a token in `.env`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Running

```powershell
pnpm dev             # supervisor + web, interleaved output, Ctrl+C stops both
pnpm dev:web         # web only
pnpm dev:supervisor  # supervisor only
```

The console is at <https://127.0.0.1:3000>. The certificate is self-signed and generated on the fly, so the browser will warn once; nothing needs to be installed.

### Two processes, on purpose

The supervisor is deliberately **not** part of Nuxt. Nuxt reloads its server on every edit, and a reload would orphan any arm it had spawned — leaving several gigabytes of VRAM held by a process nothing can reach. Keeping them separate also means restarting the web app never interrupts a running generation.

If you start only `pnpm dev:web`, the console loads and reports *Supervisor unavailable* rather than pretending every arm is stopped.

## Arms

Each directory under `arms/` with an `arm.yaml` is an arm:

```
arms/
  text-llamacpp-cu124/     arm.yaml  params.schema.json  bin/     <- you place binaries here
  image-sdcpp-v03-cu121/   arm.yaml  params.schema.json  bin/
  image-diffusers/         arm.yaml  params.schema.json  .venv/   <- its own interpreter
  video-ltx25-diffusers/   arm.yaml  params.schema.json  .venv/
```

`bin/`, `build/` and `.venv/` are git-ignored. Each arm's README says which release to download. Two arms may wrap the same runtime at different versions built against different CUDA toolkits — they resolve their libraries from their own directory and do not interfere.

The manifest declares two things that matter most:

| field | values | meaning |
| --- | --- | --- |
| `protocol` | `openai`, `comfy`, `cli`, `native` | who speaks the studio's job contract. The first three need no code in the arm |
| `lifecycle` | `resident`, `oneshot` | a long-running server, or a process per unit of work that exits and returns its VRAM |

Adding an ollama arm is a manifest and nothing else.

Model weights and generated output live under `storage/`, which is git-ignored apart from its directory skeleton.

## GPU arbitration

One arm holds the GPU at a time. Starting a second exclusive arm stops the first and waits for it to actually exit before launching. Stopping kills the whole process tree — a Python arm's workers would otherwise keep the allocation alive.

The policy is one function (`plan()` in the supervisor). A VRAM-budget policy that lets several small arms coexist replaces it without touching any caller.

## Security

**`arms/` is trusted code.** A manifest is an instruction to execute a binary, so anyone who can write to `arms/` can run code as you — treat it like any other dependency you install.

The boundaries that are enforced:

- Launch commands come only from manifests on disk. No API accepts a command, argument, working directory, or environment.
- Processes are spawned with an argv array and no shell, so a parameter containing shell metacharacters is just a string.
- Parameters are validated against the arm's JSON Schema, and path parameters must resolve inside `storage/`.
- The supervisor binds loopback only and requires a bearer credential. Arm ports are never sent to the browser.

## Docs

- [docs/hardware-baseline.md](docs/hardware-baseline.md) — measured ceilings of this machine: compute, PCIe, VRAM, storage.
- [docs/stack-selection.md](docs/stack-selection.md) — how those numbers pick a runtime and precision for an arm, worked through for LTX-2.5.

`scripts/probe-hardware.py` produces the baseline. Re-run it when the machine changes.

## Checks

```powershell
pnpm test        # unit + integration
pnpm lint
pnpm -r typecheck
```

Integration tests spawn real processes and real listeners, so they take longer than the rest.
