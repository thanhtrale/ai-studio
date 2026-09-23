## Context

See proposal.md — Why. What shapes the approach here is three properties of the existing studio and two of the inputs.

The studio's job contract is arm-shaped: the browser posts to `/api/arms/<id>/generate`, the web app relays to the supervisor, the supervisor brokers the card and posts one job to one arm, and the timeline the console renders is assembled from steps *the arm* reported. `JobTimeline.vue` reads a `JobProgress` and knows nothing about where it came from. The supervisor reuses a loaded arm at 0.0 s when a second job arrives with the same start parameters, which is what makes a several-pass pipeline on one arm affordable.

`ARM_CAPABILITIES` today lists only `image.generate` and `video.generate`. The text arm declares nothing and the home page therefore shows it as "no console yet" — correct, and the reason a text console has no way to find an arm to run on.

The two inputs are awkward in opposite directions. A Figma node tree is enormous and highly structured; a Jira ticket is small and barely structured at all. The failure mode of feeding both to one model in one prompt is not that it runs out of context — it is that the model *harmonises* them: asked to describe a block given a design and a ticket, it writes one coherent description in which the disagreements have quietly disappeared. Those disagreements are the product.

## Goals / Non-Goals

**Goals:**

- Every instruction, schema and rule lives in `apps/web`. An arm receives messages and returns text.
- The pipeline is arm-agnostic: naming a different `text.generate` arm is the whole of switching models, so Gemma and Qwen can be compared on one input.
- Disagreement between the sources survives to the output instead of being smoothed away.
- A statement can be followed back to the node or the passage that produced it, mechanically rather than on trust.
- The existing timeline component renders an analysis unchanged.

**Non-Goals:**

- Streaming tokens to the browser. A pass is the unit of progress; within a pass the arm's own steps already give a meter.
- Cancelling a running analysis. A pass is short enough to wait out, and the broker already serialises work on the card.
- Concurrency. One analysis at a time per process, because the card runs one arm at a time anyway.

## Decisions

### The pipeline runs in the web application, with its own job registry

A Nitro module holds analyses in memory and reports them in the `JobProgress` shape from `@ai-studio/arm-contract`. `/api/analyze/<id>` returns that shape, `JobTimeline.vue` renders it, and the console polls it on the same 700 ms cadence `useJobTelemetry` already uses.

Reusing the shape rather than inventing one is the decision worth naming. The alternative — a bespoke progress type for analyses — would have meant a second timeline component with the same states, the same nesting and the same duration formatting. `JobStep` is already generic: its comment says the labels are the producer's, not cases handled by the contract. An analysis is simply a producer that is not an arm.

Each model pass is a real supervisor job with its own id, `<analysisId>-p<n>`. While a pass runs, its supervisor progress is fetched and grafted in as the children of that pass's step, so the timeline shows **Pass 3 · Reconcile** with the arm's **Prompt processing** and **Answer** beneath it. That is why an analysis id is constrained to the same character set as a job id: the per-pass ids derive from it.

*Alternative rejected:* putting the pipeline in a new arm. It would have inherited progress reporting and process isolation for free, but it puts the prompts, the schemas and the gap rules — the entire substance of the feature — inside a package the README defines as trusted-but-external code, and makes changing a prompt a restart of a 16 GiB process.

### Passes 1 and 2 read one source each, in isolation

| pass | input | output | why it is separate |
| --- | --- | --- | --- |
| 1 · Design inventory | design digest (+ render) | elements: `{nodeId, role, kind, sample, repeated, variant}` | Enumerated with the ticket unseen, so nothing in it can be suggested by the ticket |
| 2 · Ticket claims | normalised ticket | claims: `{id, passageId, statement, kind}` | Extracted with the design unseen, so nothing is quietly dropped for not matching a layer |
| 3 · Reconcile | pass 1 + pass 2 output | requirements with evidence, and gaps | The only pass that sees both — and it sees two short structured lists, not the raw sources |
| 4 · Content model | pass 1 + pass 3 output | `definitions` / `models` / `filters` | Modelling is a different skill from reconciling, and its output is validated differently |

The isolation of 1 and 2 is the core of the design. A model given both sources at once produces a fluent synthesis in which every gap has been resolved by assumption; a model given one source at a time produces two inventories that a third pass can *diff*. The diff is what the user asked for.

It also fixes the context problem as a side effect. Pass 3 — the pass that needs to reason hardest — receives two lists of a few hundred tokens each rather than a node tree and a ticket, so it has room to think.

There is no pass 5. The readable requirement document is rendered from pass 3's JSON in code, because a model asked to prettify its own structured output is an opportunity to introduce a statement that is in the prose and not in the data.

### Evidence is enforced, not requested

Passes 1, 3 and 4 return node ids. Every returned node id is checked against the set of ids the digest actually contains. An id that is not in that set did not come from the design, whatever the model believes. Such a statement is demoted to an inference and reported under inferences, never among the requirements.

This is the anti-fabrication mechanism, and it is deterministic code rather than prompt wording. It is also why the digest must preserve ids through the reduction: the set of ids *is* the ground truth the output is checked against. The same check runs on ticket passage ids against the passages the parser produced.

**Ids are normalised before they are checked, and the reason is a lesson learned twice from real runs.** The design outline writes a node as `#1:3`; the ticket labels a section `[passage acceptancecriteria]`. Both sigils exist so a person can find an id in a wall of text, and both prompts ask for the id "verbatim" — so the model returned `#1:3` and `[passage acceptancecriteria]`, which is exactly what it was told to do. A plain set lookup called both fabrications: the first real run produced nine perfectly correct elements and discarded all nine, and the second discarded every ticket claim the same way.

So: **any sigil added for readability becomes part of what the model copies.** Asking more firmly is not the fix — accepting the decoration is, because the decoration is ours. The normalisation strips a surrounding `[...]`, a leading label word, and a leading `#`; none of those characters occurs in a Figma node id or a passage id, so nothing is being guessed at. The prompts were also made to spell out the stripped form, but the normalisation is what makes it not matter.

**And ids a model must copy exactly have to be short enough to copy exactly.** The third run surfaced the same lesson from the other end. Passage ids were slugs of the source's own anchors, so a Confluence section called *Scenarios - Site Visitor (Guest User Experience)* became `scenariossitevisitor-guestuserexperience`. Of 61 claims extracted, 28 were discarded: some cited `sitevisitor-guestuserexperience`, dropping a prefix from forty characters of run-together lowercase, and some cited `Introduction` — the heading — for the passage named `intro`.

Nothing was wrong with the model's reading of the ticket; the ids were simply not transcribable. They are now ordinals — `p1`…`pn`, and `c1`…`cn` for comments — with the anchor and the heading kept beside them for display. `p3` cannot be mistyped, and the rendered document maps ids back to headings so a reader still sees *Acceptance Criteria* rather than `p5`.

The general form of both findings: **an identifier that crosses a model boundary is an interface, and should be designed like one** — short, unambiguous, and forgiving of the decoration its own presentation adds.

### The design digest is built from `get_metadata`, deepened selectively

Figma's local MCP server at `http://127.0.0.1:3845/mcp` exposes `get_metadata`, which returns a sparse XML outline — layer id, name, type, position, size — for exactly the reason we need it: navigating a large file without spending the context on it. That removes most of the distillation work a REST adapter would have had to do against `/v1/files`.

The adapter then reads in four calls:

1. `get_metadata` on the referenced node — the skeleton, and the id set.
2. `get_design_context` on the block frame — styling and text, as React + Tailwind.
3. `get_variable_defs` — the tokens used, so a requirement can say `--color-brand-primary` rather than `#1473E6`.
4. `get_screenshot` — only when the selected arm accepts images.

`get_design_context` returns an *interpretation*: Figma's own design-to-code guess, in a framework nobody here is using. It is treated as evidence about styling and hierarchy, never as the structure — the structure is `get_metadata`'s, whose ids are real. The digest labels it as such so pass 1 does not mistake a Tailwind class for a design decision.

The digest is emitted as indented text rather than JSON. Braces, quotes and repeated keys are perhaps a third of a JSON tree's tokens and carry nothing a model needs, and the same budget buys correspondingly more of the design.

*Alternative rejected for now:* REST with a PAT, which is headless and does not need the desktop app. The interface accommodates it; MCP is first because it is what the user works in, and because `get_variable_defs` and `get_code_connect_map` have no REST equivalent outside Enterprise.

### The ticket parser detects format from content

Jira Cloud's issue view offers Word, XML and Print — not JSON — so the entry point is a file, and the file's name lies. Jira's "Word" export is HTML in a `.doc`. Detection is by sniffing, in this order:

| detected | parsed as | carries |
| --- | --- | --- |
| `%PDF` magic | PDF text extraction | the text of the page, and little structure |
| first tag `<rss>` or `<channel>`, and an `<item>` | Jira XML export | key, summary, status, type, description, comments, custom fields, attachment names |
| an HTML root tag | HTML | summary, description, whatever the print stylesheet kept |
| anything else textual | plain text / Markdown | one description |

XML is the format to push users towards and the one the parser is best at; the others degrade in what they can populate, and absent fields stay absent rather than being guessed. Only the PDF path needs a dependency.

**Three things a real export settled, against what was assumed here first.**

*There is no XML declaration.* The export opens with an HTML comment naming the Jira build that wrote it, and its root is `<rss version="0.92">` — the issue is at `channel > item`. A rule keyed on `<?xml ?>` would have matched no real export at all. So the sniffer skips comments, processing instructions and doctypes to find the first real tag, and keys on that.

*The description is escaped HTML inside the XML.* One document, two levels of markup: the tokeniser resolves entities building the XML tree, and what comes out of `<description>` is HTML that is parsed again. That is why there is one tolerant tokeniser rather than an XML parser and an HTML parser.

*A table can have more cells than its header has columns.* In the export tested, the row specifying the CTA divider reads `…hides the visual divider line (` | `) when 1 or no CTAs are defined.` — five cells against a four-column header, because the author typed a literal `|` and Confluence's wiki renderer read it as a cell boundary. A parser that truncates to the header width silently loses half a requirement. Overflow cells are rejoined with `|`, which is the exact inverse of the split rather than a repair that invents anything.

**Comments are parsed, not dropped.** In the same export the description's field table specifies *"1 to 3 high-resolution photo assets"* while the only comment says *"video autoplay is technically supported"*. A requirement agreed in a thread and never written back into the description exists only there, and it is precisely the kind of disagreement this feature is built to surface — so a ticket source that read descriptions alone would hide its most valuable finding.

### Structured output is validated and repaired in the web app

Each pass declares a JSON schema. The arm returns text; the web app parses it, validates it, and on failure sends one repair turn quoting the validator's complaint. A second failure fails the pass with the raw output kept on disk.

**A truncated reply is not a malformed one, and must not be repaired as if it were.** The first real run of pass 2 against a ticket with a Given/When/Then table and a twelve-row field specification produced 14 467 characters of perfectly good claims and stopped mid-object at the token cap. Telling a model that hit its limit to "only fix the shape" guarantees it truncates again at exactly the same place. The child reports `finish_reason`, so the runner distinguishes the two: a truncation gets a repair turn asking for the same content said shorter, and a second truncation fails naming the cap rather than reporting a JSON syntax error. The caps themselves were raised — pass 2 is the largest output of the four, and 4 096 was not close.

llama.cpp can constrain generation with a GBNF grammar, which would make malformed JSON impossible. Exposing that would mean adding a grammar field to the arm's job contract — putting a fragment of this feature's schema inside an arm, which is the one thing the user's constraint rules out. The repair turn costs a few seconds on the rare failure; the coupling would cost the arm-agnosticism that makes Gemma and Qwen swappable. If the failure rate turns out to be high on a small model, the honest fix is a `responseFormat: json` flag on the contract — a capability of *any* text arm, not a schema belonging to this feature.

### `text.generate` joins the capability enum

`ARM_CAPABILITIES` gains `text.generate`, the existing text arm declares it, and the analysis console offers the arms that declare it. The manifest already validates that a capability's first segment matches the arm's modality, so nothing new is needed to stop a video arm claiming it.

### Storage is a directory per analysis, outside the media library

```
storage/analyses/<id>/
  analysis.json      state, arm, timings, adapter versions
  design.json        digest, tokens, id set, what was dropped
  design.png         the render, when one was taken
  ticket.json        normalised ticket with addressable passages
  passes/1-inventory.json … 4-model.json     raw text and parsed output per pass
  requirements.md    rendered in code from pass 3
  gaps.json
  _<block>.json      the proposed content model
```

`design.json` and `ticket.json` are written before pass 1 runs. The registry is module state and dies with a Nuxt reload — every edit in development — so the durable record has to exist before the long part starts. On startup, an analysis on disk with no registry entry and no terminal state is reported as failed rather than as running.

The media library is not extended. Its identity model is "a file's path under `storage/` is its id", its kinds are image and video, and its thumbnails, range requests and lightbox all assume media. An analysis is a directory of JSON, and forcing it through that model would change the library's meaning to gain a list view.

### The Gemma arm is the existing text arm's shape

`google/gemma-4-26B-A4B-it` is a mixture of experts of the same family of shapes as the installed `Qwen3.6-35B-A3B` — a large parameter count with a small active one — so `text-qwen36-a3b-llamacpp` is the right template: a small Python process that starts `llama-server.exe` as a child, keeps it resident, translates the job into a chat completion, and turns the stream into a timeline. The `cpuMoe` lever that made the Qwen arm fast is the same lever here.

llama.cpp reads GGUF only — safetensors would have to go through `convert_hf_to_gguf.py` — but conversion is unnecessary here: Google, `ggml-org` and Unsloth all publish GGUF for this model. The arm installs **`unsloth/gemma-4-26B-A4B-it-qat-GGUF` → `gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf`, 13.27 GiB**. It is quantisation-aware trained, so its 4-bit quality is far closer to bf16 than a post-training quant of the same size, and the QAT build is 2.6 GiB *smaller* than the non-QAT `UD-Q4_K_XL` (15.84 GiB) — there is no trade to make. It is also the same publisher and the same dynamic-quant scheme as the installed Qwen model, so the `cpuMoe` intuition transfers. `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` (13.45 GiB) is the first-party runner-up.

**Why this model suits a long-context feature.** Of its 30 layers only 5 are full attention; the other 25 are sliding attention with a 1024-token window, and `attention_k_eq_v` means K and V share one tensor. So the KV cache that grows with context is `5 × 2 heads × 512 dim = 5120` values per token — 10 KiB at f16, about 5 KiB at q8_0 — while the 25 sliding layers cost a fixed ~105 MiB whatever the context. At the trained maximum of 262 144 tokens that is roughly **1.4 GiB of KV at q8_0**, against 5 120 MiB for the same context on the installed Qwen arm. The full context is reachable on this card.

**`--swa-full` must stay off.** llama.cpp defaults it to false, which is what keeps the sliding layers at their window. Turning it on would allocate full context for all 25 of them — `25 × 8 × 256 × 262144 × 2 B` is 25.6 GiB of KV — and the arm would simply not fit. The manifest does not expose it and the README says why.

**The placement defaults still ship unmeasured.** The arithmetic puts `cpuMoe` near 9 or 10 of 30 layers at full context, against the 26 of 40 the Qwen arm needs — but the existing arm's README is entirely measured numbers, and inventing a `cpuMoe` for a model nobody has run on this card would be the one kind of lie that repository does not tell. Tasks include the measurement run, and the README section is written from its output.

## Risks / Trade-offs

**A closed Figma desktop app stops the feature dead.** → Three distinguishable failures rather than one: nothing listening on 3845, the server answering but refusing the node, and a call that hangs. Each names what to do. The `DesignSource` interface is the real mitigation: the REST adapter is a day's work behind it whenever the dependency becomes intolerable.

**`get_design_context` is Figma's interpretation, not the design.** → It is admitted into the digest labelled as an interpretation, and never as the id-bearing structure. Requirements are anchored to `get_metadata` ids, which are checkable.

**A 26B model may not hold a four-pass structured-output pipeline reliably.** → The passes are deliberately small and each has a narrow schema; the repair turn catches malformed JSON; and because the pipeline is arm-agnostic, the fallback is a dropdown rather than a rewrite. This is also the argument for building `text.generate` as a capability rather than hard-coding the arm id.

**Unmeasured placement numbers for the new arm.** → Shipped as explicitly provisional, with the measurement as a task. The risk is a slow first run, not a wrong one.

**The registry dies on every Nuxt reload in development.** → Sources are persisted before the first pass, and a non-terminal analysis with no registry entry reports as failed. An analysis interrupted at pass 3 still leaves its digest, its ticket and passes 1–2 readable, so the rerun is cheap.

**Evidence checking demotes correct statements.** A true observation the model attributes to the wrong node id is demoted to an inference. → Accepted deliberately. An unverifiable requirement presented as verified is the more expensive error in a workflow whose premise is that the design is the source of truth.

**Four passes is four model runs per analysis.** → They land on one resident arm, which the broker reuses at 0.0 s after the first. The cost is generation time, not reloads.

## Migration Plan

Additive throughout: a new page, a new route group, a new arm, one value appended to an enum. Nothing existing changes behaviour. The text arm gaining `text.generate` changes the home page's text card from "no console yet" to a link, which is the intended effect.

Rollback is deleting the change: no schema migration, no stored format anything else reads, and `storage/analyses/` is ignored by the library scanner rather than filtered out of it.

## Open Questions

- What `cpuMoe`, `contextSize` and `kvCacheType` the chosen GGUF actually wants on a 16 GiB card. Deferred safely: the manifest exposes all three as start parameters, so the answer changes defaults in one file and no caller. The conversion itself is no longer open — see the arm decision above.
- Whether the published MTP draft model (0.23 GiB) is worth wiring for speculative decoding. Deferred: it is a speed lever on a running arm, not a change to anything this feature depends on.
- Whether pass 4 should be given the project's existing `blocks/` directory as context, so proposed models reuse established field names. Deferred: it is an additional input to one pass, not a change to the pipeline's shape.
