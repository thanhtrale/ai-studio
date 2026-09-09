import { describe, expect, it, vi } from 'vitest';

import { RelayError, SupervisorClient, classifyControlError } from './supervisor';

const BASE_URL = 'http://127.0.0.1:4319';
const TOKEN = 'test-token-0123456789abcdef';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clientWith(fetchImpl: typeof globalThis.fetch): SupervisorClient {
  return new SupervisorClient({ baseUrl: BASE_URL, token: TOKEN, fetchImpl });
}

describe('SupervisorClient', () => {
  it('returns the inventory on success', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(200, { arms: [], ready: true })));

    await expect(client.inventory()).resolves.toEqual({ arms: [], ready: true });
  });

  it('presents the shared credential to the supervisor', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { arms: [], ready: true }));
    await clientWith(fetchImpl).inventory();

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('never returns the credential to its caller', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(200, { arms: [], ready: true })));

    const payload = await client.inventory();

    expect(JSON.stringify(payload)).not.toContain(TOKEN);
  });

  it('sends only params on start, never a command', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { arm: {}, evicted: [] }));
    await clientWith(fetchImpl).start('text-fake', { prompt: 'hi' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/arms/text-fake/start`);
    expect(JSON.parse(String(init.body))).toEqual({ params: { prompt: 'hi' } });
  });

  it('maps a transport failure to supervisor_unreachable', async () => {
    const client = clientWith(
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const error = (await client.inventory().catch((caught: unknown) => caught)) as RelayError;

    expect(error).toBeInstanceOf(RelayError);
    expect(error.kind).toBe('supervisor_unreachable');
    expect(error.status).toBe(503);
  });

  it('distinguishes an arm that is not running', async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse(409, { error: { code: 'arm_not_running', message: 'not running' } })),
    );

    const error = (await client.stop('text-fake').catch((caught: unknown) => caught)) as RelayError;

    expect(error.kind).toBe('arm_not_running');
    expect(error.status).toBe(409);
  });

  it('distinguishes an arm that returned an error', async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse(502, { error: { code: 'arm_error', message: 'boom' } })),
    );

    const error = (await client.inventory().catch((caught: unknown) => caught)) as RelayError;

    expect(error.kind).toBe('arm_error');
    expect(error.status).toBe(502);
  });

  it('reports supervisor_unavailable as unreachable rather than an arm fault', async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse(503, { error: { code: 'supervisor_unavailable', message: 'down' } })),
    );

    const error = (await client.inventory().catch((caught: unknown) => caught)) as RelayError;

    expect(error.kind).toBe('supervisor_unreachable');
  });
});

describe('classifyControlError', () => {
  it.each([
    ['health_timeout', 'arm_error'],
    ['launch_failed', 'arm_error'],
    ['arm_not_running', 'arm_not_running'],
    ['supervisor_unavailable', 'supervisor_unreachable'],
    ['reconciling', 'conflict'],
    ['eviction_failed', 'conflict'],
    ['invalid_params', 'invalid_request'],
    ['not_found', 'not_found'],
  ])('maps %s to %s', (code, expected) => {
    expect(classifyControlError(code, 'message').kind).toBe(expected);
  });

  it('falls back to a generic supervisor error for an unknown code', () => {
    expect(classifyControlError('something-new', 'message').kind).toBe('supervisor_error');
  });
});
