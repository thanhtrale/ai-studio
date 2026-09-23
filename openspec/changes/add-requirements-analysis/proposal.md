## Why

The studio generates media. On an AEM Edge Delivery Services project the work that actually costs time sits upstream of any generation: reading a Figma frame and a Jira ticket, and working out what the block has to do, what the ticket forgot to say, and where the two disagree. That reading is done by hand, once per block, and its output — a consolidated requirement and a Universal Editor content model — is what the implementation is then written from. It is a reading-and-reconciling task, which is the shape of work a local model is actually good at.

The machine already has the arm to run one. `text-qwen36-a3b-llamacpp` loads, answers at 60 tok/s, and has no console — the home page says so. This change is that console, made purposeful rather than a chat box, and the first feature in the studio whose logic lives in the web application rather than in an arm.

## What Changes

- **A new studio function, `/analyze/block`**: a form taking a Figma node link and a Jira ticket (imported file or pasted text), an **Analyze** button, and the existing job timeline reporting each step as it happens.

- **The pipeline is orchestrated by the web application, not by an arm.** The arm is a text endpoint and nothing more: it receives messages and returns text. Every instruction, every pass, every schema and every rule about what counts as a gap lives in `apps/web`. An arm is swapped by changing which one the request names.

- **A job registry in the web application.** Progress today is the supervisor's, assembled from steps an arm reports. An analysis has steps no arm can see — fetching Figma, parsing a ticket, five model passes — so the web app keeps its own registry and reports it in the same `JobProgress` shape, which is what lets the existing `JobTimeline.vue` render it unchanged. Each model pass is a supervisor job whose own steps nest under the pass that made it.

- **Figma through the Dev Mode MCP server** (`http://127.0.0.1:3845/mcp`, Figma desktop running), behind a `DesignSource` interface so a REST/PAT adapter can be added later without touching the pipeline. The adapter calls `get_metadata` for the node tree, `get_design_context` for the frames that matter, `get_variable_defs` for tokens and `get_screenshot` for the picture.

- **Jira by file import and paste**, because the issue view exports Word, XML and Print rather than JSON. XML is parsed first — it carries description, custom fields, comments and attachments in one file — with Word (HTML in a `.doc`), PDF and plain paste behind it.

- **Every requirement carries the node id it came from.** "Design is the source of truth" is only checkable if a reader can follow a statement back to the layer that produced it; a requirement with no evidence is reported as inferred, not asserted.

- **Three artefacts per analysis**: the consolidated requirement, the gap list (missing, contradicted, ambiguous — with the design's reading winning every contradiction), and a proposed `_<block>.json` carrying the `definitions`, `models` and `filters` arrays that `aem-boilerplate-xwalk` merges into the Universal Editor's configuration.

- **A new arm, `text-gemma4-26b-a4b-llamacpp`**, wrapping `google/gemma-4-26B-A4B-it` on llama.cpp in the same shape as the existing text arm.

- **`text.generate` joins `ARM_CAPABILITIES`**, so the console can find an arm that speaks chat rather than guessing from modality. The analysis runs on any arm declaring it, which is what makes Gemma and Qwen comparable on the same input.

- **Analyses are stored under `storage/analyses/<id>/`** with their inputs, so a run can be re-read and re-run. They are not media and do not enter the media library.

### Non-Goals

Deliberately deferred, to keep this change reviewable:

- Generating the block's `*.js` and `*.css`. The model proposes the content model; a developer writes the block against it.
- Writing anything back to Figma or Jira. Both are read-only.
- Diffing Figma tokens against a project's existing CSS variables.
- A Figma REST/PAT adapter, and a Jira cookie-session adapter. The interfaces accommodate both; neither is built here.
- Any change to how the supervisor brokers the GPU. An analysis is several jobs on one arm, which the broker already handles by reusing a loaded arm at 0.0 s.

## Capabilities

### New Capabilities

- `requirements-analysis`: The feature. What an analysis is, the passes it runs, how progress is reported, what a gap is, how design wins a contradiction, how evidence is attached, and how the result is stored.
- `design-source`: Reading a design. The adapter contract, the Figma Dev Mode MCP implementation, node-link parsing, and the distillation that turns a node tree into something a context window holds.
- `ticket-source`: Reading a ticket. The import formats accepted, how each is parsed into one normalised ticket, and what happens to an attachment or a format that cannot be read.

### Modified Capabilities

None. `openspec/specs/` is empty — the initial change has not been archived — so the addition of `text.generate` to the manifest's capability enum is recorded under Impact rather than as a delta against a spec that does not yet exist.

## Impact

- **`packages/arm-contract`**: `ARM_CAPABILITIES` gains `text.generate`. The enum is validated against an arm's modality, so a `text.generate` capability is only accepted on a `modality: text` arm — no code change is needed for that check, it already exists.

- **`apps/web`**: a new page, a new server route group under `server/api/analyze/`, a job registry in server memory, an MCP client, and parsers. New dependencies: `@modelcontextprotocol/sdk` for the Figma server, and a PDF text extractor for the Print export path. XML and Word are parsed without a dependency.

- **New long-running state in Nitro.** An analysis outlives the request that started it, so the registry holds jobs in module state. That state dies with a Nuxt reload — which in development is every edit — so a job's inputs are written to `storage/analyses/<id>/` before the first pass rather than kept only in memory.

- **A new external dependency at runtime: the Figma desktop app.** The MCP server is local, but it is Figma's process, not the studio's. It is unreachable when the app is closed, when the user has no Dev seat, or when the local server is not enabled in preferences — three different failures, and the console must say which rather than reporting "Figma unavailable".

- **`arms/text-gemma4-26b-a4b-llamacpp`**: a new arm. `google/gemma-4-26B-A4B-it` has no GGUF in Google's own repository, so the manifest names a path under `storage/models/` and the arm's README says which conversion was installed. Its placement numbers (`cpuMoe`, `contextSize`, `kvCacheType`) are left unmeasured until it runs on this card; the existing text arm's README is the pattern for recording them.

- **Not affected**: the supervisor, the media library, the image and video consoles, and GPU arbitration. This change adds a caller, not a mechanism.
