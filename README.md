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

The browser never talks to an arm directly. Every request is relayed by the web app's server side, which is where the supervisor credential lives and where a job's paths are confined -- neither belongs in a page.

## Prerequisites

- **Node 24.20.0** (`.nvmrc`), **npm 11** (ships with it)
- An NVIDIA driver new enough for the CUDA runtime your arms bundle. Arms ship their own CUDA libraries, so only the driver is shared.

```powershell
nvm use            # or install 24.20.0
npm install
Copy-Item .env.example .env
```

Then put a token in `.env`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Running

```powershell
npm run dev             # supervisor + web, interleaved output, Ctrl+C stops both
npm run dev:web         # web only
npm run dev:supervisor  # supervisor only
```

The console is at <http://127.0.0.1:3000>. Plain http, bound to loopback: nothing here leaves the machine, and a self-signed certificate only cost a browser warning per profile.

### Two processes, on purpose

The supervisor is deliberately **not** part of Nuxt. Nuxt reloads its server on every edit, and a reload would orphan any arm it had spawned — leaving several gigabytes of VRAM held by a process nothing can reach. Keeping them separate also means restarting the web app never interrupts a running generation.

If you start only `npm run dev:web`, the console loads and reports *Supervisor unavailable* rather than pretending every arm is stopped.

## Arms

Each directory under `arms/` with an `arm.yaml` is an arm:

```
arms/
  text-qwen36-a3b-llamacpp/  arm.yaml  params.schema.json  bin/  .venv/  <- you place binaries here
  text-gemma4-26b-a4b-llamacpp/ arm.yaml params.schema.json bin/ .venv/
  image-qwen-edit-sdcpp/     arm.yaml  params.schema.json  bin/  .venv/
  video-ltx25-diffusers/     arm.yaml  params.schema.json  .venv/        <- its own interpreter
  text-llamacpp-cu124/       arm.yaml  params.schema.json               <- a scaffold; see below
```

`bin/`, `build/` and `.venv/` are git-ignored. Each arm's README says which release to download. Two arms may wrap the same runtime at different versions built against different CUDA toolkits — they resolve their libraries from their own directory and do not interfere.

The manifest declares two things that matter most:

| field | values | meaning |
| --- | --- | --- |
| `protocol` | `openai`, `comfy`, `cli`, `native` | who speaks the studio's job contract. The first three need no code in the arm |
| `lifecycle` | `resident`, `oneshot` | a long-running server, or a process per unit of work that exits and returns its VRAM |

Adding an ollama arm is a manifest and nothing else — in principle. In practice
only `native` is implemented today: the supervisor posts a job to an arm's
`/generate` and polls its `/progress`, and an `openai` or `comfy` arm has
neither. `text-llamacpp-cu124` is the scaffold that declared `openai`;
`text-qwen36-a3b-llamacpp` is the text arm that actually runs, and it wraps
`llama-server` in a native process for the same reason the image arm wraps
`sd-server` — the timeline.

Model weights and generated output live under `storage/`, which is git-ignored apart from its directory skeleton.

## The console

Every view has a URL and every page is rendered on the server first — there is no client-only shell.

| route | what it is |
| --- | --- |
| `/` | what the studio can do, one card per function. A card says *no arm discovered* or *no console yet* rather than pretending |
| `/generate/image` | the Qwen-Image-Edit console. Same two parameters, and a batch: one request, several files, each filed on its own |
| `/generate/video` | the LTX-2.5 console. `?from=<media id>` reloads a previous run's settings, `?reference=<media id>` starts from an image |
| `/analyze/block` | a Figma frame and a Jira ticket, read separately and then compared. See below |
| `/library` | everything in storage. `?folder=` and `?item=` are the selection, so a particular clip is a link |

Arms are a drawer rather than a route, and it is there for inspection rather than operation: **nobody starts an arm by hand**. See the broker below.

The console's right-hand column is what makes a minutes-long run bearable. It carries two things:

- **Two VRAM meters on one axis.** The machine line is `nvidia-smi` for the whole card, sampled once a second by the supervisor whether or not a job is running. The arm line is what the arm itself holds — torch's reserved figure where there is a torch, and `nvidia-smi`'s per-process figure for an arm whose model runs in a child process. They are different measurements — the first includes the desktop, the browser's compositor, and the driver — so the chart draws both and claims nothing about the gap between them. Measured on one run: 10.00 GiB machine against 9.73 GiB arm.
- **The job's own timeline**, step by step as it happens: freeing the card, loading the model, then whatever that arm's work actually is — the enhancer's rewrite in full, encoding, each denoising step with its time, the upsampling rounds, decode and mux for a clip; encode, sample and decode per image for a batch. Almost all of a run is one of load, enhance or denoise, and a spinner cannot tell those apart — nor any of them from a hang.

  The steps are the arm's to name. The supervisor contributes only the ones it owns, and an arm that is not written in Python at all still reports a timeline: `image-qwen-edit-sdcpp` builds one by reading its child process's log.

Shared UI lives in `apps/web/app/components/ui/` — button, field, input, select, checkbox, card, badge, alert, modal, drawer. Pages compose those rather than restyling controls, which is what keeps one form looking like the next.

## Requirements analysis

The first feature here whose logic is **not** in an arm. `/analyze/block` takes a Figma frame and a Jira ticket and produces a consolidated requirement, the disagreements between the two, and a proposed Universal Editor content model for an AEM Edge Delivery block. The arm is a text endpoint and nothing else: every instruction, schema and rule lives in `apps/web/server/analysis/`, so swapping `text-qwen36-a3b-llamacpp` for `text-gemma4-26b-a4b-llamacpp` is a dropdown rather than a change.

**The design is the source of truth.** Where the two sources disagree, the design's reading becomes the requirement and the ticket's becomes a gap. That only means anything if it is checkable, so every statement carries the node id or ticket passage it came from — and those ids are checked against what the sources actually contained. A statement citing an id that is not there is demoted to an inference, not reported as a requirement. That check is code, not prompt wording.

**Four passes, and the first two read one source each.** Pass 1 sees the design with the ticket unseen; pass 2 sees the ticket with the design unseen; pass 3 diffs the two structured lists they produced; pass 4 models. The isolation is the whole design: a model handed both at once writes one fluent description in which every disagreement has quietly been resolved by assumption, and the disagreements are the product. There is no pass that writes prose — `requirements.md` is rendered from pass 3's JSON, because a model asked to prettify its own output is one more place for a sentence to appear that is not in the data.

```
storage/analyses/<id>/
  analysis.json      state, arm, timings
  design.json        the digest, its node ids, what the reduction dropped
  ticket.json        the normalised ticket, cut into citable passages
  passes/p1.json …   each pass's raw reply and parsed value
  requirements.md    the readable consolidation
  gaps.json          gaps and inferences
  _<block>.json      definitions / models / filters, ready for blocks/<name>/
```

Sources are written **before** the first pass, not after the last: the run registry is module state and a Nuxt reload empties it, so an analysis interrupted at pass 3 still leaves its digest and its ticket readable. A record still saying *running* with nothing running it is reported as failed rather than as a spinner that never stops.

**Figma is reached over its Dev Mode MCP server** at `http://127.0.0.1:3845/mcp`, which lives inside the Figma desktop application — so that application must be running, with the local MCP server enabled in its preferences and the file open. Three separate failures are reported separately, because each needs something different: nothing listening, the server refusing the node, and a call that hung. `node scripts/figma-stub.mjs` serves a fixed frame on the same port, which is how the console is worked on without Figma at all.

**Jira is imported rather than called.** Its issue view exports Word, XML and Print — not JSON — so the entry point is a file, and the file's name lies: the "Word" export is HTML in a `.doc`. The format is sniffed from the content. XML is the one to prefer and the one the parser is best at; it is the only path carrying comments, which matter more than they look, because a requirement agreed in a thread and never written back into the description exists only there.

## The library

`storage/` **is** the index. A file's path relative to it is its identity, and a JSON sidecar under `storage/library/` mirrors that path with what the studio knows about it:

```
storage/
  inputs/   frame.png                          <- uploads; the only place an arm may read a job input from
  outputs/  2026-09-11/123857-0ce45c0d.mp4     <- generations, filed by the day they were made
            bench/bench-bf16-group-stream-0.mp4   <- whatever a script wrote, in its own folder
  library/  outputs/2026-09-11/123857-0ce45c0d.mp4.json
  analyses/ analysis-20260922-a1b2c3d4/         <- requirements analyses; not media, and not scanned
```

That choice is what lets the library show files it never created: a clip written by `bench.py` appears with no registration step, and lists with what the filesystem knows. A record adds the rest — job id, arm, prompt, the prompt the enhancer actually sent, the reference image, the settings, and the run's own report — which is what makes *use these settings* reproduce a run rather than approximate it.

Sidebar folders are directories, not a separate concept: date folders for generations and whatever name a script chose for a batch are the same mechanism.

Video thumbnails are the `<video>` element with a `#t=` fragment, so the browser decodes the frame and the studio needs no ffmpeg and no second copy on disk. The media route answers range requests, which is what makes that work — and what lets a clip be scrubbed.

## GPU arbitration and the broker

One arm holds the GPU at a time. Starting a second exclusive arm stops the first and waits for it to actually exit before launching. Stopping kills the whole process tree — a Python arm's workers would otherwise keep the allocation alive.

The policy is one function (`plan()` in the supervisor). A VRAM-budget policy that lets several small arms coexist replaces it without touching any caller.

**The user never starts an arm.** A job says which arm it needs and in which configuration, and the supervisor gets the card into that state before relaying it (`acquire()` in `arm-manager.ts`, planned by `brokerPlan()`):

| what is on the card | what happens |
| --- | --- |
| the arm the job needs, same start parameters | reused — reloading 36 GiB of weights to run a second clip would be absurd |
| the arm the job needs, *different* start parameters | unloaded and reloaded: placement is decided when the weights are read, so it cannot be changed in place |
| a different exclusive arm | stopped first, and the memory has to actually come back before the replacement claims it |
| an arm adopted after a supervisor restart | reloaded, because nothing recorded how it was started and the broker will not assume |

Every step it takes is reported into the job's timeline as it takes it, so "Queued for the card" is a row with a reason and children, not a spinner. Measured end to end: a cold start added 3.6 s before the model load; a second job with the same parameters was reused at 0.0 s; changing `offload` unloaded in 10.5 s and restarted in 3.5 s.

Brokering runs on the same queue as start and stop, so a second job arriving mid-eviction waits rather than racing onto the card.

## Security

**`arms/` is trusted code.** A manifest is an instruction to execute a binary, so anyone who can write to `arms/` can run code as you — treat it like any other dependency you install.

The boundaries that are enforced:

- Launch commands come only from manifests on disk. No API accepts a command, argument, working directory, or environment.
- Processes are spawned with an argv array and no shell, so a parameter containing shell metacharacters is just a string.
- Parameters are validated against the arm's JSON Schema, and path parameters must resolve inside `storage/`.
- The supervisor binds loopback only and requires a bearer credential. Arm ports are never sent to the browser.
- Media ids are whitelisted, not merely checked for `..`: one of two known roots, plain path segments, a known media extension, and no Win32 device name. Uploaded filenames are reduced to one sanitised segment and never overwrite an existing file, because records already point at it.

## Docs

- [docs/hardware-baseline.md](docs/hardware-baseline.md) — measured ceilings of this machine: compute, PCIe, VRAM, storage.
- [docs/stack-selection.md](docs/stack-selection.md) — how those numbers pick a runtime and precision for an arm, worked through for LTX-2.5.

`scripts/probe-hardware.py` produces the baseline. Re-run it when the machine changes.

## Checks

```powershell
npm test           # unit + integration
npm run lint
npm run typecheck  # every workspace, web included
```

Integration tests spawn real processes and real listeners, so they take longer than the rest. `apps/web/server/analysis/design/mcp.integration.test.ts` runs a real MCP server over real HTTP in the test process, and declares `// @vitest-environment node` to do it: the web project's default environment is happy-dom, whose `fetch` is a browser's and refuses a cross-origin request to a loopback port — which is what the server side of this application does all day.

The Python arms have their own suites, which `npm test` does not run:

```powershell
cd arms/text-qwen36-a3b-llamacpp;    .\.venv\Scripts\python.exe -m pytest -q
cd arms/text-gemma4-26b-a4b-llamacpp; .\.venv\Scripts\python.exe -m pytest -q
```
