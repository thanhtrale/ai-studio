import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  resolveArgs,
  validateParams,
  type ArmSummary,
  type ControlErrorCode,
  type InventoryResponse,
  type LaunchValue,
} from '@ai-studio/arm-contract';

import type { SupervisorConfig } from './config.js';
import { discoverArms, type DiscoveredArm, type InvalidArm } from './discovery.js';
import { launch as defaultLaunch, type ExitInfo, type LaunchedProcess } from './launcher.js';
import { PortAllocator } from './ports.js';
import { systemProcessInspector, type ProcessInspector } from './process-inspector.js';
import { processExists as defaultProcessExists, terminateTree as defaultTerminateTree } from './process-tree.js';
import { buildCommandLine, LaunchRegistry } from './registry.js';
import { reconcile } from './reconcile.js';
import { plan, singleExclusiveSlot, type EvictionPolicy, type SchedulableArm } from './scheduler.js';

export class ArmControlError extends Error {
  readonly code: ControlErrorCode;

  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = 'ArmControlError';
    this.code = code;
  }
}

type RuntimeState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

interface ArmRuntime {
  arm: DiscoveredArm;
  state: RuntimeState;
  detail: string | null;
  port: number | null;
  pid: number | null;
  process: LaunchedProcess | null;
  updatedAt: number;
}

export interface ArmManagerDeps {
  launch?: typeof defaultLaunch;
  terminateTree?: typeof defaultTerminateTree;
  processExists?: (pid: number) => boolean;
  inspector?: ProcessInspector;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  policy?: EvictionPolicy;
  healthIntervalMs?: number;
}

const HEALTH_REQUEST_TIMEOUT_MS = 2000;

export class ArmManager {
  readonly #config: SupervisorConfig;
  readonly #deps: Required<Omit<ArmManagerDeps, 'policy'>> & { policy: EvictionPolicy };
  readonly #ports: PortAllocator;
  readonly #registry: LaunchRegistry;

  #runtimes = new Map<string, ArmRuntime>();
  #invalid: InvalidArm[] = [];
  #ready = false;
  /** Serialises start/stop so two requests cannot both evict the same incumbent. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(config: SupervisorConfig, deps: ArmManagerDeps = {}) {
    this.#config = config;
    this.#deps = {
      launch: deps.launch ?? defaultLaunch,
      terminateTree: deps.terminateTree ?? defaultTerminateTree,
      processExists: deps.processExists ?? defaultProcessExists,
      inspector: deps.inspector ?? systemProcessInspector,
      fetch: deps.fetch ?? globalThis.fetch,
      now: deps.now ?? Date.now,
      healthIntervalMs: deps.healthIntervalMs ?? 250,
      policy: deps.policy ?? singleExclusiveSlot,
    };
    this.#ports = new PortAllocator(config.host);
    this.#registry = new LaunchRegistry(config.stateDir);
  }

  get ready(): boolean {
    return this.#ready;
  }

  async init(): Promise<void> {
    await this.#refreshInventory();
    await this.#reconcileOrphans();
    this.#ready = true;
  }

  async #refreshInventory(): Promise<void> {
    const result = await discoverArms(this.#config.armsDir);
    const next = new Map<string, ArmRuntime>();

    for (const arm of result.arms) {
      const existing = this.#runtimes.get(arm.id);
      next.set(arm.id, existing ? { ...existing, arm } : this.#freshRuntime(arm));
    }

    this.#runtimes = next;
    this.#invalid = result.invalid;
  }

  #freshRuntime(arm: DiscoveredArm): ArmRuntime {
    return {
      arm,
      state: 'stopped',
      detail: null,
      port: null,
      pid: null,
      process: null,
      updatedAt: this.#deps.now(),
    };
  }

  async #reconcileOrphans(): Promise<void> {
    const records = await this.#registry.load();
    if (records.length === 0) return;

    const decisions = await reconcile({
      records,
      inspector: this.#deps.inspector,
      knownArmIds: new Set(this.#runtimes.keys()),
    });

    const kept: typeof records = [];
    for (const decision of decisions) {
      if (decision.action === 'adopt') {
        const runtime = this.#runtimes.get(decision.record.armId);
        if (runtime) {
          runtime.state = 'running';
          runtime.pid = decision.record.pid;
          runtime.port = decision.record.port;
          runtime.detail = 'adopted after supervisor restart';
          runtime.updatedAt = this.#deps.now();
          if (decision.record.port !== null) this.#ports.reserve(decision.record.port);
        }
        kept.push(decision.record);
        continue;
      }

      if (decision.action === 'terminate') {
        await this.#deps.terminateTree(decision.record.pid, 'force').catch(() => undefined);
      }
      // 'discard' deliberately does nothing: the pid is not ours to kill.
    }

    await this.#registry.replaceAll(kept);
  }

  /**
   * Base URL of a running arm's own HTTP server.
   *
   * Arms bind loopback only, so the supervisor is the one process that can reach
   * them. Job requests are relayed rather than validated here: the schema for a
   * job belongs to the arm, and the supervisor deliberately knows nothing about
   * modality-specific payloads.
   */
  endpoint(id: string): string {
    const runtime = this.#runtimes.get(id);
    if (!runtime) throw new ArmControlError('not_found', `unknown arm "${id}"`);
    if (runtime.state !== 'running' || runtime.port === null) {
      throw new ArmControlError('arm_not_running', `arm "${id}" is not running`);
    }
    return `http://${this.#config.host}:${runtime.port}`;
  }

  inventory(): InventoryResponse {
    const arms: ArmSummary[] = [];

    for (const runtime of this.#runtimes.values()) {
      arms.push({
        id: runtime.arm.id,
        name: runtime.arm.manifest.name ?? runtime.arm.id,
        modality: runtime.arm.manifest.modality,
        protocol: runtime.arm.manifest.protocol,
        lifecycle: runtime.arm.manifest.lifecycle,
        gpu: runtime.arm.manifest.resources.gpu,
        vramEstimateMb: runtime.arm.manifest.resources.vramEstimateMb ?? null,
        state: runtime.state,
        detail: runtime.detail,
        paramsSchema: runtime.arm.paramsSchema,
        updatedAt: new Date(runtime.updatedAt).toISOString(),
      });
    }

    for (const entry of this.#invalid) {
      arms.push({
        id: entry.id,
        name: entry.id,
        modality: null,
        protocol: null,
        lifecycle: null,
        gpu: null,
        vramEstimateMb: null,
        state: 'invalid',
        detail: entry.error,
        paramsSchema: null,
        updatedAt: new Date(this.#deps.now()).toISOString(),
      });
    }

    arms.sort((a, b) => a.id.localeCompare(b.id));
    return { arms, ready: this.#ready };
  }

  summary(id: string): ArmSummary {
    const found = this.inventory().arms.find((arm) => arm.id === id);
    if (!found) throw new ArmControlError('not_found', `unknown arm "${id}"`);
    return found;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #require(id: string): ArmRuntime {
    const runtime = this.#runtimes.get(id);
    if (runtime) return runtime;

    if (this.#invalid.some((entry) => entry.id === id)) {
      throw new ArmControlError('invalid_manifest', `arm "${id}" has an invalid manifest and cannot be started`);
    }
    throw new ArmControlError('not_found', `unknown arm "${id}"`);
  }

  #schedulable(runtime: ArmRuntime): SchedulableArm {
    return {
      id: runtime.arm.id,
      gpu: runtime.arm.manifest.resources.gpu,
      lifecycle: runtime.arm.manifest.lifecycle,
    };
  }

  #runningArms(): SchedulableArm[] {
    return [...this.#runtimes.values()]
      .filter((runtime) => runtime.state === 'running' || runtime.state === 'starting')
      .map((runtime) => this.#schedulable(runtime));
  }

  async start(id: string, params: Readonly<Record<string, unknown>> = {}): Promise<{ arm: ArmSummary; evicted: string[] }> {
    if (!this.#ready) {
      throw new ArmControlError('reconciling', 'supervisor is still reconciling previously launched processes');
    }
    return this.#enqueue(() => this.#startNow(id, params));
  }

  async #startNow(
    id: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<{ arm: ArmSummary; evicted: string[] }> {
    const runtime = this.#require(id);

    if (runtime.arm.manifest.lifecycle !== 'resident') {
      throw new ArmControlError(
        'invalid_request',
        `arm "${id}" is one-shot: it runs per job and has no process to keep alive`,
      );
    }

    if (runtime.state === 'running') {
      return { arm: this.summary(id), evicted: [] };
    }

    const startPlan = plan(this.#schedulable(runtime), this.#runningArms(), this.#deps.policy);
    const evicted: string[] = [];

    for (const victimId of startPlan.evict) {
      try {
        await this.#stopNow(victimId);
        evicted.push(victimId);
      } catch (error) {
        throw new ArmControlError(
          'eviction_failed',
          `cannot free the GPU: arm "${victimId}" could not be stopped (${(error as Error).message})`,
        );
      }
    }

    const resolved = this.#resolveLaunch(runtime, params);
    const port = await this.#ports.allocate();

    runtime.state = 'starting';
    runtime.detail = null;
    runtime.port = port;
    runtime.updatedAt = this.#deps.now();

    let launched: LaunchedProcess;
    try {
      launched = this.#deps.launch({
        command: runtime.arm.manifest.launch.command,
        args: resolveArgs({
          args: runtime.arm.manifest.launch.args,
          values: { ...resolved, port },
          storageDir: this.#config.storageDir,
          pathKeys: runtime.arm.pathKeys,
        }),
        cwd: path.resolve(runtime.arm.dir, runtime.arm.manifest.launch.cwd ?? '.'),
        env: runtime.arm.manifest.launch.env,
      });
    } catch (error) {
      this.#ports.release(port);
      return this.#fail(runtime, 'launch_failed', `could not launch arm: ${(error as Error).message}`);
    }

    runtime.process = launched;
    runtime.pid = launched.pid;

    const identity = await this.#deps.inspector.inspect(launched.pid);
    await this.#registry.add({
      armId: runtime.arm.id,
      pid: launched.pid,
      startedAtMs: this.#deps.now(),
      processStartedAtMs: identity?.startedAtMs ?? null,
      commandLine: buildCommandLine(runtime.arm.manifest.launch.command, runtime.arm.manifest.launch.args),
      port,
    });

    try {
      await this.#awaitHealth(runtime, launched);
    } catch (error) {
      await this.#deps.terminateTree(launched.pid, 'force').catch(() => undefined);
      await this.#registry.remove(runtime.arm.id);
      this.#ports.release(port);
      const failure = error as ArmControlError;
      return this.#fail(runtime, failure.code ?? 'launch_failed', failure.message);
    }

    runtime.state = 'running';
    runtime.detail = null;
    runtime.updatedAt = this.#deps.now();

    void launched.exited.then(() => {
      if (runtime.state === 'running' || runtime.state === 'starting') {
        runtime.state = 'failed';
        runtime.detail = `arm exited unexpectedly: ${launched.recentOutput().slice(-500)}`;
        runtime.updatedAt = this.#deps.now();
        this.#ports.release(port);
        void this.#registry.remove(runtime.arm.id);
      }
    });

    return { arm: this.summary(id), evicted };
  }

  #fail(runtime: ArmRuntime, code: ControlErrorCode, message: string): never {
    runtime.state = 'failed';
    runtime.detail = message;
    runtime.port = null;
    runtime.pid = null;
    runtime.process = null;
    runtime.updatedAt = this.#deps.now();
    throw new ArmControlError(code, message);
  }

  #resolveLaunch(runtime: ArmRuntime, params: Readonly<Record<string, unknown>>): Record<string, LaunchValue> {
    const validation = validateParams(runtime.arm.paramsSchema, params);
    if (!validation.ok) {
      throw new ArmControlError(
        'invalid_params',
        validation.issues.map((issue) => (issue.path ? `${issue.path} ${issue.message}` : issue.message)).join('; '),
      );
    }

    const values: Record<string, LaunchValue> = {};
    for (const [key, value] of Object.entries(validation.values)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        values[key] = value;
      }
    }
    return values;
  }

  async #awaitHealth(runtime: ArmRuntime, launched: LaunchedProcess): Promise<void> {
    const health = runtime.arm.manifest.health;
    if (health.type !== 'http') return;

    const deadline = this.#deps.now() + health.timeoutMs;
    let exit: ExitInfo | null = null;
    void launched.exited.then((info) => {
      exit = info;
    });

    const url = `http://${this.#config.host}:${runtime.port}${health.path}`;

    while (this.#deps.now() < deadline) {
      if (exit !== null) {
        throw new ArmControlError(
          'launch_failed',
          `arm exited during startup with code ${(exit as ExitInfo).code}: ${launched.recentOutput().slice(-500)}`,
        );
      }

      try {
        const response = await this.#deps.fetch(url, {
          signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
        });
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }

      await delay(this.#deps.healthIntervalMs);
    }

    throw new ArmControlError(
      'health_timeout',
      `arm did not become healthy within ${health.timeoutMs}ms`,
    );
  }

  async stop(id: string): Promise<ArmSummary> {
    if (!this.#ready) {
      throw new ArmControlError('reconciling', 'supervisor is still reconciling previously launched processes');
    }
    return this.#enqueue(async () => {
      await this.#stopNow(id);
      return this.summary(id);
    });
  }

  async #stopNow(id: string): Promise<void> {
    const runtime = this.#require(id);
    if (runtime.state === 'stopped' || runtime.state === 'failed') {
      runtime.state = 'stopped';
      runtime.detail = null;
      runtime.updatedAt = this.#deps.now();
      return;
    }

    const pid = runtime.pid;
    runtime.state = 'stopping';
    runtime.updatedAt = this.#deps.now();

    if (pid !== null) {
      await this.#deps.terminateTree(pid, 'graceful').catch(() => undefined);

      if (!(await this.#awaitExit(runtime, this.#config.stopGraceMs))) {
        await this.#deps.terminateTree(pid, 'force');
        if (!(await this.#awaitExit(runtime, this.#config.stopGraceMs))) {
          // The process is still alive and still holding its GPU memory, so the
          // arm must keep occupying the slot rather than look stopped.
          runtime.state = 'running';
          runtime.detail = `process ${pid} survived a forced termination`;
          runtime.updatedAt = this.#deps.now();
          throw new Error(`process ${pid} survived a forced termination`);
        }
      }
    }

    if (runtime.port !== null) this.#ports.release(runtime.port);
    await this.#registry.remove(id);

    runtime.state = 'stopped';
    runtime.detail = null;
    runtime.port = null;
    runtime.pid = null;
    runtime.process = null;
    runtime.updatedAt = this.#deps.now();
  }

  async #awaitExit(runtime: ArmRuntime, timeoutMs: number): Promise<boolean> {
    const deadline = this.#deps.now() + timeoutMs;
    while (this.#deps.now() < deadline) {
      if (runtime.pid === null || !this.#deps.processExists(runtime.pid)) return true;
      await delay(this.#deps.healthIntervalMs);
    }
    return runtime.pid === null || !this.#deps.processExists(runtime.pid);
  }

  /** Runs a one-shot arm to completion. VRAM is returned when the process exits. */
  async runOnce(
    id: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<{ exitCode: number | null; output: string }> {
    if (!this.#ready) {
      throw new ArmControlError('reconciling', 'supervisor is still reconciling previously launched processes');
    }

    const runtime = this.#require(id);
    if (runtime.arm.manifest.lifecycle !== 'oneshot') {
      throw new ArmControlError('invalid_request', `arm "${id}" is resident, not one-shot`);
    }

    const resolved = this.#resolveLaunch(runtime, params);
    const launched = this.#deps.launch({
      command: runtime.arm.manifest.launch.command,
      args: resolveArgs({
        args: runtime.arm.manifest.launch.args,
        values: resolved,
        storageDir: this.#config.storageDir,
        pathKeys: runtime.arm.pathKeys,
      }),
      cwd: path.resolve(runtime.arm.dir, runtime.arm.manifest.launch.cwd ?? '.'),
      env: runtime.arm.manifest.launch.env,
    });

    const exit = await launched.exited;
    return { exitCode: exit.code, output: launched.recentOutput() };
  }

  async shutdown(): Promise<void> {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.pid !== null && runtime.state !== 'stopped') {
        await this.#deps.terminateTree(runtime.pid, 'force').catch(() => undefined);
      }
    }
  }
}
