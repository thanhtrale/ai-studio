import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { startArmRequestSchema, type ControlErrorBody, type ControlErrorCode } from '@ai-studio/arm-contract';

import { ArmControlError, type ArmManager } from './arm-manager.js';
import type { SupervisorConfig } from './config.js';

const MAX_BODY_BYTES = 64 * 1024;

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

export function createControlServer(config: SupervisorConfig, manager: ArmManager): Server {
  return createServer((request, response) => {
    void handle(request, response, config, manager).catch((error: unknown) => {
      if (error instanceof ArmControlError) {
        fail(response, error.code, error.message);
        return;
      }
      fail(response, 'launch_failed', (error as Error).message ?? 'unexpected supervisor error');
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  config: SupervisorConfig,
  manager: ArmManager,
): Promise<void> {
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

  if (request.method === 'POST' && segments[0] === 'v1' && segments[1] === 'arms' && segments.length === 4) {
    const armId = decodeURIComponent(segments[2] ?? '');
    const action = segments[3];

    if (action === 'stop') {
      send(response, 200, { arm: await manager.stop(armId) });
      return;
    }

    if (action === 'jobs') {
      const body = await readJsonBody(request);
      const target = `${manager.endpoint(armId)}/generate`;

      let armResponse: Response;
      try {
        armResponse = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new ArmControlError('arm_error', `arm "${armId}" did not answer (${(error as Error).message})`);
      }

      const text = await armResponse.text();
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (!armResponse.ok) {
        const detail = (parsed as { error?: string; message?: string });
        throw new ArmControlError(
          armResponse.status === 400 ? 'invalid_request' : 'arm_error',
          detail.message ?? detail.error ?? `arm responded ${armResponse.status}`,
        );
      }

      send(response, 200, parsed);
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
