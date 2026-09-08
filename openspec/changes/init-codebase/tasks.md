## 1. Repository and tooling foundation

- [ ] 1.1 Add root `package.json` and `pnpm-workspace.yaml` declaring `apps/*`, `packages/*` as workspaces, and verify `pnpm install` completes and `pnpm -r list` shows the expected packages
- [ ] 1.2 Add shared TypeScript configuration and a base ESLint config consumed by every workspace package, and verify `pnpm -r typecheck` and `pnpm -r lint` run clean on empty packages
- [ ] 1.3 Add Vitest at the root with a workspace-aware config, and verify `pnpm test` runs and reports zero tests without erroring
- [ ] 1.4 Create `storage/` with `models/`, `outputs/`, `cache/` and a tracked `.gitkeep`, and verify `git status` reports no untracked files inside `storage/` other than the placeholder
- [ ] 1.5 Add `.env.example` documenting the supervisor port and shared credential variables, and verify `.env` itself is ignored by `git check-ignore .env`

## 2. Arm contract package

- [ ] 2.1 Create `packages/arm-contract` exporting a Zod schema for the arm manifest covering `id`, `modality`, `protocol`, `lifecycle`, `resources`, `launch`, `health`, `params`, and verify unit tests accept the two example manifests from design.md
- [ ] 2.2 Add schema rules that reject unsupported `protocol` values and require a health declaration and a port placeholder for `resident` arms while allowing their absence for `oneshot`, and verify unit tests cover both directions (spec: arm-package - Arms declare a lifecycle mode, Arms declare a wire protocol)
- [ ] 2.3 Export inferred TypeScript types plus the control-API request and response types shared by supervisor and web, and verify both packages compile against them
- [ ] 2.4 Implement a placeholder-substitution helper that validates values against the arm's parameter schema, substitutes only into individual argv elements, and rejects path values resolving outside `storage/`, and verify unit tests cover traversal attempts and shell-metacharacter values (spec: arm-supervisor - Launch commands cannot be supplied by callers)

## 3. Arm package scaffolds

- [ ] 3.1 Create `arms/text-llamacpp-cu124/` with `arm.yaml` (resident, `openai`) and `params.schema.json`, plus a README stating which binary release to place in `bin/`, and verify the manifest passes contract validation
- [ ] 3.2 Create `arms/image-sdcpp-v03-cu121/` with `arm.yaml` (oneshot, `cli`) and `params.schema.json`, and verify the manifest passes contract validation
- [ ] 3.3 Create `arms/image-diffusers/` with `arm.yaml` (resident, `native`), `params.schema.json`, `pyproject.toml`, and a `src/` entry point stub that only serves a health endpoint, and verify the manifest passes contract validation
- [ ] 3.4 Confirm `arms/*/bin/`, `arms/*/build/`, and `arms/*/.venv/` are excluded from version control, and verify with `git check-ignore` against a path in each (spec: arm-package - Arm environments are mutually isolated)

## 4. Supervisor: discovery and control interface

- [ ] 4.1 Create `apps/supervisor` as a Node service that starts, binds to loopback only, and exposes a health endpoint, and verify a request from loopback succeeds while the process is not listening on any external address (spec: arm-supervisor - The control interface is restricted to the local machine)
- [ ] 4.2 Implement bearer-credential enforcement on every control route, and verify a request without the credential is rejected and starts nothing
- [ ] 4.3 Implement arm discovery that scans `arms/`, validates each manifest, and builds an inventory retaining invalid arms with their validation errors, and verify tests cover a valid arm, a directory with no manifest, an invalid manifest, and duplicate identifiers (spec: arm-package - Arms are declared by a manifest, Manifests are validated before use)
- [ ] 4.4 Expose an inventory endpoint returning each arm's identifier, modality, parameter schema, state, and validation error where applicable, while omitting allocated ports, and verify a test asserts no port or arm address appears in the payload (spec: arm-supervisor - Arms are not exposed to the browser)

## 5. Supervisor: process lifecycle

- [ ] 5.1 Implement a loopback port allocator that reserves an unused port per resident arm and releases it on exit, and verify a test starting and stopping an arm twice does not leak the port
- [ ] 5.2 Implement process launch using an argv array with `shell: false`, injecting the allocated port and schema-validated parameters, capturing stdout and stderr into a ring buffer, and verify a test asserts no command string is ever passed to an interpreter
- [ ] 5.3 Implement the arm state machine (stopped, starting, running, stopping, failed) with health polling and the manifest's timeout, and verify tests cover healthy startup, health timeout, and process exit during startup (spec: arm-supervisor - Starting a resident arm)
- [ ] 5.4 Make a start request for an already running arm a no-op that succeeds without launching a second process, and verify the test asserts a single process
- [ ] 5.5 Implement graceful stop with a grace period followed by forced termination, and verify tests cover an arm that exits promptly and one that ignores the graceful signal (spec: arm-supervisor - Stopping an arm reclaims its resources)
- [ ] 5.6 Implement process-tree termination behind a single platform-dispatched function using a Windows Job Object with `taskkill /T /F` as fallback, and verify a test spawns a process that itself spawns a child and asserts no descendant survives the stop
- [ ] 5.7 Implement one-shot execution that launches per unit of work and resolves on exit, surfacing exit code and captured output, and verify a test using a trivial binary asserts the process is gone afterwards

## 6. Supervisor: GPU arbitration and reconciliation

- [ ] 6.1 Implement the scheduler as a replaceable `plan(request, running[]) -> { evict[], start }` function with a single-exclusive-slot policy, and verify unit tests cover no incumbent, a different incumbent, the same arm already running, and a one-shot arm requiring no eviction (spec: arm-supervisor - GPU access is arbitrated)
- [ ] 6.2 Wire the scheduler into the start path so an incumbent is confirmed exited before the requested arm launches, and verify a test asserts ordering and that only the requested arm runs afterwards
- [ ] 6.3 Make a failed eviction abort the start with a reason naming the incumbent, and verify the test asserts the requested arm was never launched
- [ ] 6.4 Persist a launch registry recording PID, arm identifier, start token, and start time, and verify the file is written on launch and cleared on clean exit
- [ ] 6.5 Implement startup reconciliation that adopts recognisable processes and discards unrecognisable records without terminating foreign processes, refusing control requests until reconciliation completes, and verify tests cover adoption, a stale record for a dead PID, and a recycled PID belonging to an unrelated process (spec: arm-supervisor - The supervisor reconciles orphaned processes on startup)

## 7. Web console

- [ ] 7.1 Create `apps/web` as a Nuxt application with Tailwind configured and the dev server set to self-signed HTTPS, and verify `pnpm dev:web` serves an `https://` origin from a clean checkout with no certificate files present (spec: web-console - The development server is served over HTTPS)
- [ ] 7.2 Implement a server-side supervisor client that reads the supervisor address and credential from the environment, and verify the credential is never included in any payload reaching the browser
- [ ] 7.3 Implement server routes relaying inventory, start, and stop to the supervisor, mapping failures so that "arm not running", "arm error", and "supervisor unreachable" are distinguishable, and verify tests assert each mapping (spec: web-console - All arm traffic is relayed by the application server)
- [ ] 7.4 Build the arm inventory view listing identifier, modality, and state, rendering invalid arms with their error and no start control, and verify it renders against a stubbed inventory covering valid, running, failed, and invalid arms (spec: web-console - The application presents the arm inventory)
- [ ] 7.5 Add state polling or streaming so transitions update in place, and verify a test asserts the view reflects a stopped-to-running transition without a page reload
- [ ] 7.6 Add start and stop controls with transitional states, disabled conflicting actions, and a confirmation naming the arm that will be evicted, and verify tests cover a successful start, a failed start restoring the control, and an eviction confirmation (spec: web-console - Arms can be started and stopped from the application)
- [ ] 7.7 Present supervisor unavailability as a distinct state that recovers automatically once the supervisor returns, and verify a test asserts arms are not shown as stopped while the supervisor is unreachable (spec: web-console - Loss of the supervisor is surfaced explicitly)

## 8. Integration and developer experience

- [ ] 8.1 Add a root `pnpm dev` script that starts the supervisor and the web application together with interleaved labelled output, and verify a single command brings both up and Ctrl+C stops both
- [ ] 8.2 Add a repository README covering prerequisites, the two-process dev model, where to place arm binaries, and the statement that `arms/` is trusted code, and verify a reader can start the stack from a clean checkout following it alone
- [ ] 8.3 Verify end to end with the scaffolded arms that starting a resident arm evicts a running exclusive arm, that stopping leaves no descendant process, and that restarting the web application leaves the running arm untouched (spec: arm-supervisor - The supervisor runs independently of the web application)
- [ ] 8.4 Run `openspec validate init-codebase --strict` and confirm it reports no issues
