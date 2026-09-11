import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import {
  jobRequestSchema,
  startArmRequestSchema,
  type ControlErrorBody,
  type ControlErrorCode,
} from '@ai-studio/arm-contract';

import { ArmControlError, type ArmManager } from './arm-manager.js';
import type { SupervisorConfig } from './config.js';
import type { GpuSampler } from './gpu.js';
import type { JobStore } from './jobs.js';

const MAX_BODY_BYTES = 64 * 1024;
/** A busy arm answers its progress endpoint late, not never; this bounds a poll. */
const PROGRESS_TIMEOUT_MS = 3000;

const STATUS_BY_CODE: Record<ControlErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  invalid_manifest: 400,
  invalid_params: 400,
  eviction_failed: 409,
  health_timeout: 504,
  launch_failed: 500,
  arm_not_running: 409,
  arm_error: 502,
  supervisor_unavailable: 503,
  reconciling: 503,
};

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function fail(response: ServerResponse, code: ControlErrorCode, message: string): void {
  const body: ControlErrorBody = { error: { code, message } };
  send(response, STATUS_BY_CODE[code], body);
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;

  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function numericQuery(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ArmControlError('invalid_request', 'request body is too large');
    chunks.push(chunk as Buffer);
  }

  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ArmControlError('invalid_request', 'request body is not valid JSON');
  }
}

export interface ControlServerParts {
  manager: ArmManager;
  jobs: JobStore;
  gpu: GpuSampler;
}

export function createControlServer(config: SupervisorConfig, parts: ControlServerParts): Server {
  return createServer((request, response) => {
    void handle(request, response, config, parts).catch((error: unknown) => {
      if (error instanceof ArmControlError) {
        fail(response, error.code, error.message);
        return;
      }
      fail(response, 'launch_failed', (error as Error).message ?? 'unexpected supervisor error');
    });
  });
}

/**
 * Asks a running arm what it is doing and files the answer under the job.
 *
 * Failure is silent on purpose: an arm mid-generation not answering promptly is
 * a normal state, not a reason to fail the poll that asked. The previous
 * snapshot stands, which is the honest thing to show.
 */
async function pullArmProgress(parts: ControlServerParts, armId: string, jobId: string): Promise<void> {
  try {
    const url = `${parts.manager.endpoint(armId)}/progress?jobId=${encodeURIComponent(jobId)}`;
    const answer = await fetch(url, { signal: AbortSignal.timeout(PROGRESS_TIMEOUT_MS) });
    if (!answer.ok) return;

    const snapshot = (await answer.json()) as {
      jobId?: string;
      steps?: unknown;
      meters?: unknown;
      vram?: unknown;
    };
    // An arm reports whatever job it is on. If it has moved to another one, its
    // steps are not this job's and must not be shown as though they were.
    if (snapshot.jobId !== jobId || !Array.isArray(snapshot.steps)) return;

    parts.jobs.arm(jobId, {
      steps: snapshot.steps as never,
      meters: Array.isArray(snapshot.meters) ? (snapshot.meters as never) : [],
      vram: Array.isArray(snapshot.vram) ? (snapshot.vram as never) : [],
    });
  } catch {
    // Not running, not listening, or busy.
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  config: SupervisorConfig,
  parts: ControlServerParts,
): Promise<void> {
  const { manager, jobs, gpu } = parts;
  const url = new URL(request.url ?? '/', `http://${config.host}:${config.port}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (request.method === 'GET' && url.pathname === '/healthz') {
    send(response, 200, { status: 'ok', ready: manager.ready });
    return;
  }

  if (!isAuthorized(request, config.token)) {
    fail(response, 'unauthorized', 'a valid bearer credential is required');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/arms') {
    send(response, 200, manager.inventory());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/gpu') {
    send(response, 200, gpu.telemetry(numericQuery(url, 'since')));
    return;
  }

  if (request.method === 'GET' && segments[0] === 'v1' && segments[1] === 'jobs' && segments.length === 3) {
    const jobId = decodeURIComponent(segments[2] ?? '');
    const armId = jobs.armIdOf(jobId);
    if (armId === undefined) {
      fail(response, 'not_found', `no job "${jobId}"`);
      return;
    }

    await pullArmProgress(parts, armId, jobId);
    send(response, 200, { job: jobs.snapshot(jobId), gpu: gpu.telemetry(numericQuery(url, 'since')) });
    return;
  }

  if (request.method === 'POST' && segments[0] === 'v1' && segments[1] === 'arms' && segments.length === 4) {
    const armId = decodeURIComponent(segments[2] ?? '');
    const action = segments[3];

    if (action === 'stop') {
      send(response, 200, { arm: await manager.stop(armId) });
      return;
    }

    if (action === 'jobs') {
      const parsed = jobRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) {
        fail(
          response,
          'invalid_request',
          parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
        );
        return;
      }

      const { jobId, params, job } = parsed.data;
      if (jobs.has(jobId)) {
        fail(response, 'invalid_request', `job "${jobId}" has already been submitted`);
        return;
      }

      jobs.open(jobId, armId);
      try {
        // The caller never starts an arm. Whatever is on the card now is this
        // call's problem, and each thing it does is reported as it does it.
        await manager.acquire(armId, params, {
          onPlan: (reason) => jobs.plan(jobId, reason),
          onStep: (key, label, seconds) => jobs.did(jobId, key, label, seconds),
        });
        jobs.acquired(jobId);
      } catch (error) {
        jobs.fail(jobId, (error as Error).message);
        throw error;
      }

      let armResponse: Response;
      try {
        armResponse = await fetch(`${manager.endpoint(armId)}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...job, jobId }),
        });
      } catch (error) {
        const message = `arm "${armId}" did not answer (${(error as Error).message})`;
        jobs.fail(jobId, message);
        throw new ArmControlError('arm_error', message);
      }

      const text = await armResponse.text();
      const body: unknown = text ? JSON.parse(text) : {};

      // One last pull before the job closes, so the finished timeline is the
      // arm's own final state rather than whatever the last poll happened to see.
      await pullArmProgress(parts, armId, jobId);

      if (!armResponse.ok) {
        const detail = body as { error?: { message?: string }; message?: string };
        const message = detail.error?.message ?? detail.message ?? `arm responded ${armResponse.status}`;
        jobs.fail(jobId, message);
        throw new ArmControlError(armResponse.status === 400 ? 'invalid_request' : 'arm_error', message);
      }

      jobs.done(jobId);
      send(response, 200, body);
      return;
    }

    if (action === 'start') {
      const parsed = startArmRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) {
        // Strict schema: a caller cannot supply a command, args, cwd, or env.
        fail(
          response,
          'invalid_request',
          parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
        );
        return;
      }

      send(response, 200, await manager.start(armId, parsed.data.params));
      return;
    }
  }

  fail(response, 'not_found', `no route for ${request.method} ${url.pathname}`);
}
