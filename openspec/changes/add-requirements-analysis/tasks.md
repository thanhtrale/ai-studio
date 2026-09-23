## 1. Contract and arm discovery

- [x] 1.1 Add `text.generate` to `ARM_CAPABILITIES` in `packages/arm-contract/src/manifest.ts`; verify `manifest.test.ts` passes and add a case asserting a `modality: video` arm declaring `text.generate` is rejected
- [x] 1.2 Declare `capabilities: [text.generate]` in `arms/text-qwen36-a3b-llamacpp/arm.yaml` and verify the supervisor's inventory reports it via `GET /api/arms`
- [x] 1.3 Add the Analyze card to `apps/web/app/pages/index.vue` keyed on the `text.generate` capability, and verify the text card stops reading "no console yet"

## 2. Analysis contract and storage

- [x] 2.1 Define the shared analysis vocabulary in `apps/web/shared/analysis.ts` — request, normalised design, normalised ticket with passages, element inventory, ticket claim, requirement with evidence, gap, and the analysis record — and verify `npm run typecheck` passes
- [x] 2.2 Implement `storage/analyses/<id>/` read and write helpers with the layout in design.md, and verify a unit test round-trips a record and refuses an id that is not a plain identifier
- [x] 2.3 Verify the library scanner ignores `storage/analyses/` — add a test asserting an analysis directory produces no `MediaItem`

## 3. Job registry and progress

- [x] 3.1 Implement the in-memory analysis registry emitting the `JobProgress` shape, with step transitions and elapsed seconds, and verify unit tests cover pending → running → done and a failure leaving later steps pending
- [x] 3.2 Graft a pass's supervisor job progress in as that step's children, and verify a test with a stubbed supervisor shows arm steps nested under the pass
- [x] 3.3 Add `GET /api/analyze/[id]` returning progress, and verify it answers for an analysis registered but not yet started
- [x] 3.4 Report an on-disk analysis with no registry entry and no terminal state as failed, and verify a test simulating a restart does not report it as running

## 4. Design source

- [x] 4.1 Implement Figma link parsing — file key and `node-id` in both `123-456` and `123:456` forms — and verify unit tests cover a design link, a link with no node, and a non-Figma URL
- [x] 4.2 Add `@modelcontextprotocol/sdk` to `apps/web` and implement the MCP client against `http://127.0.0.1:3845/mcp` with a per-call timeout, and verify a test against a stub MCP server completes a `get_metadata` call
- [x] 4.3 Implement the `DesignSource` interface and its Figma MCP adapter calling `get_metadata`, `get_design_context`, `get_variable_defs` and conditionally `get_screenshot`, and verify a test asserts the render is not requested when the arm accepts no images
- [x] 4.4 Distinguish the three unreachable causes — nothing listening, node refused, call timed out — and verify each produces its own message in a test
- [x] 4.5 Implement the digest: indented text, node ids preserved, invisible and decorative nodes dropped with a count, depth truncation at the budget; verify unit tests cover the drop count, determinism across two runs on one fixture, and a truncation note
- [x] 4.6 Capture the digest's node id set for evidence checking, and verify a test asserts every id in the digest text is in the set

## 5. Ticket source

- [x] 5.1 Implement content sniffing for XML, HTML, PDF and text, and verify tests cover a Jira XML export, a `.doc` containing HTML, a PDF, and a file that is none of them
- [x] 5.2 Implement the Jira XML parser — key, summary, status, type, description, comments, custom fields, attachment names — and verify it against a real exported fixture
- [x] 5.3 Implement the HTML parser preserving headings, lists and tables into Markdown, and verify a test asserts an acceptance-criteria list survives as a list
- [x] 5.4 Add a PDF text extractor for the Print path and verify a test extracts text from a fixture, with absent fields absent rather than guessed
- [x] 5.5 Divide the normalised ticket into addressable passages and verify a test asserts each passage id resolves in the stored ticket
- [x] 5.6 Add `POST /api/analyze/ticket` accepting an upload or pasted text, and verify it refuses an empty ticket and an unreadable format with the detected type named

## 6. Pipeline

- [x] 6.1 Implement the pass runner: build messages, submit a supervisor job as `<analysisId>-p<n>`, parse, validate against the pass schema, one repair turn on failure, fail with the raw output kept on a second; verify unit tests cover a clean parse, a repaired parse and a hard failure
- [x] 6.2 Write pass 1 (design inventory) with its schema and prompt, and verify a test with a recorded arm response yields elements carrying node ids
- [x] 6.3 Write pass 2 (ticket claims) with its schema and prompt, and verify a test asserts the prompt contains no design content
- [x] 6.4 Write pass 3 (reconcile) with its schema and prompt, and verify tests cover the three gap kinds and that a design/ticket contradiction yields the design's reading as the requirement
- [x] 6.5 Write pass 4 (content model) with its schema and prompt, and verify tests cover a simple block, a container with a repeating item plus its filter, and a variant field in the classes group
- [x] 6.6 Implement evidence checking against the digest id set and the ticket passage ids, demoting unmatched statements to inferences, and verify a test asserts a fabricated node id never reaches the requirements
- [x] 6.7 Validate the pass 4 output carries `definitions`, `models` and `filters`, and verify a test asserts a malformed document fails the step rather than being returned
- [x] 6.8 Render `requirements.md` from pass 3's JSON in code, and verify a snapshot test covers requirements, inferences and gaps
- [x] 6.9 Wire the whole pipeline behind `POST /api/analyze`, persisting sources before pass 1, and verify an integration test runs end to end against a stubbed supervisor and a stub MCP server

## 7. Console

- [x] 7.1 Build `/analyze/block` — block name, Figma node link, ticket import or paste, arm select filtered to `text.generate` — and verify the Analyze button is disabled until both sources are present
- [x] 7.2 Render progress with the existing `JobTimeline.vue` against `/api/analyze/[id]`, and verify a run shows each pass and the arm's steps nested beneath the running one
- [x] 7.3 Show the three artefacts — the requirement document, the gap list, the proposed `_<block>.json` with a copy action — and verify each is reachable for a completed analysis
- [x] 7.4 Surface the design-source failures distinctly in the UI, and verify a closed Figma desktop app produces the "not running or not enabled" message rather than a generic error

## 8. The Gemma arm

- [x] 8.1 Scaffold `arms/text-gemma4-26b-a4b-llamacpp` from `text-qwen36-a3b-llamacpp` — manifest, `params.schema.json`, wrapper package, `.venv` — and verify `pytest` passes against its stub llama-server
- [x] 8.2 Download `unsloth/gemma-4-26B-A4B-it-qat-GGUF` → `gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf` (13.27 GiB) and `mmproj-F16.gguf` into `storage/models/gemma-4-26b-a4b/`, record the choice in the arm's README, and verify the arm starts and answers its health check
- [x] 8.3 Assert `--swa-full` is never passed and add a test on the launch args proving it; verify the child's log reports the sliding layers at a 1024-token window rather than at full context
- [x] 8.4 Measure placement on this card — `cpuMoe`, `contextSize`, `kvCacheType`, load time, prompt and generation rates, whole-card peak, and whether the full 262144 context fits — and set the manifest defaults from the measurement; verify the README's table is written from that run and carries no unmeasured number
- [x] 8.5 Declare `capabilities: [text.generate]` and verify the arm appears in the console's arm select

## 9. End to end

- [x] 9.1 Run one real analysis — a real Figma frame, a real exported ticket — on the Gemma arm and again on the Qwen arm, and verify both complete with no pipeline change and each result records its arm
- [x] 9.2 Verify `npm test`, `npm run lint` and `npm run typecheck` all pass
- [x] 9.3 Add the feature to the root `README.md` — the console table, the storage layout, and what the Figma desktop dependency means — and verify the routes described match the ones that exist
