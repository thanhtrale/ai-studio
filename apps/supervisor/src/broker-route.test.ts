import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type { JobProgressResponse } from '@ai-studio/arm-contract';
import { afterEach, describe, expect, it } from 'vitest';

import { ArmManager } from './arm-manager.js';
import { GpuSampler } from './gpu.js';
import { JobStore } from './jobs.js';
import { createControlServer } from './server.js';
import {
  createHarness,
  makeConfig,
  makeTempRoot,
  residentManifest,
  writeArms,
  type Harness,
} from './test-utils.js';

const TOKEN = 'test-token-0123456789abcdef';
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

/** An offload knob with a default, so "same configuration" has something to compare. */
const OFFLOAD_SCHEMA = {
  type: 'object',
  properties: { offload: { type: 'string', default: 'stream' } },
} as const;

interface Fixture {
  baseUrl: string;
  harness: Harness;
  close: () => Promise<void>;
}

const open: Fixture[] = [];

async function startServer(): Promise<Fixture> {
  const root = await makeTempRoot();
  await writeArms(path.join(root, 'arms'), [
    { dirName: 'video-fake', manifest: residentManifest('video-fake'), paramsSchema: OFFLOAD_SCHEMA },
    { dirName: 'image-fake', manifest: residentManifest('image-fake'), paramsSchema: OFFLOAD_SCHEMA },
  ]);

  const config = makeConfig(root);
  const harness = createHarness();
  harness.serve = {
    generate: (body) => ({ status: 200, body: { ran: body['prompt'], jobId: body['jobId'] } }),
    progress: (jobId) => ({
      jobId,
      steps: [{ key: 'denoise', label: 'Denoise', state: 'running' }],
      meters: [{ key: 'denoise', label: 'Denoise', done: 3, total: 8 }],
      vram: [{ at: 1, gib: 5.17 }],
    }),
  };

  const manager = new ArmManager(config, {
    launch: harness.launch,
    terminateTree: harness.terminateTree,
    processExists: harness.processExists,
    fetch: harness.fetch,
    inspector: harness.inspector,
    healthIntervalMs: 5,
  });
  await manager.init();

  const server = createControlServer(config, { manager, jobs: new JobStore(), gpu: new GpuSampler() });
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const address = server.address() as AddressInfo;

  const fixture: Fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    harness,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  open.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((fixture) => fixture.close()));
});

let counter = 0;
const submit = (baseUrl: string, armId: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${baseUrl}/v1/arms/${armId}/jobs`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

const newJobId = (): string => `job-${(counter += 1)}`;

describe('the broker route', () => {
  it('starts the arm a job needs without anyone having asked for it', async () => {
    const { baseUrl, harness } = await startServer();

    const jobId = newJobId();
    const response = await submit(baseUrl, 'video-fake', { jobId, params: {}, job: { prompt: 'a river' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: 'a river', jobId });
    expect(harness.processes).toHaveLength(1);
  });

  it('passes the job through untouched, with the job id added for progress', async () => {
    const { baseUrl } = await startServer();

    const jobId = newJobId();
    await submit(baseUrl, 'video-fake', { jobId, params: {}, job: { prompt: 'a river' } });

    // The arm echoed what it was sent: the supervisor does not rewrite a job.
    const seen = await (
      await fetch(`${baseUrl}/v1/jobs/${jobId}`, { headers: auth })
    ).json() as JobProgressResponse;
    expect(seen.job.armId).toBe('video-fake');
  });

  it('stops the arm holding the card first, and says so in the timeline', async () => {
    const { baseUrl, harness } = await startServer();

    await fetch(`${baseUrl}/v1/arms/image-fake/start`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ params: {} }),
    });

    const jobId = newJobId();
    expect((await submit(baseUrl, 'video-fake', { jobId, params: {}, job: {} })).status).toBe(200);

    const seen = (await (await fetch(`${baseUrl}/v1/jobs/${jobId}`, { headers: auth })).json()) as JobProgressResponse;
    const acquire = seen.job.steps[0];

    expect(acquire?.label).toBe('Queued for the card');
    expect(acquire?.detail).toContain('image-fake');
    expect(acquire?.children?.map((child) => child.label)).toEqual([
      'Stopped image-fake to free the card',
      'Started video-fake',
    ]);
    expect(harness.terminations).toHaveLength(1);
  });

  it('reuses an arm already loaded the way the next job needs it', async () => {
    const { baseUrl, harness } = await startServer();

    await submit(baseUrl, 'video-fake', { jobId: newJobId(), params: {}, job: {} });
    const jobId = newJobId();
    await submit(baseUrl, 'video-fake', { jobId, params: { offload: 'stream' }, job: {} });

    // The second job supplied explicitly what the first took as a default, so
    // the configurations match and 36 GiB of weights are not reloaded.
    expect(harness.processes).toHaveLength(1);

    const seen = (await (await fetch(`${baseUrl}/v1/jobs/${jobId}`, { headers: auth })).json()) as JobProgressResponse;
    expect(seen.job.steps[0]?.detail).toContain('already loaded');
  });

  it('reloads the same arm when the job needs a different configuration', async () => {
    const { baseUrl, harness } = await startServer();

    await submit(baseUrl, 'video-fake', { jobId: newJobId(), params: {}, job: {} });
    const jobId = newJobId();
    await submit(baseUrl, 'video-fake', { jobId, params: { offload: 'disk' }, job: {} });

    expect(harness.processes).toHaveLength(2);

    const seen = (await (await fetch(`${baseUrl}/v1/jobs/${jobId}`, { headers: auth })).json()) as JobProgressResponse;
    expect(seen.job.steps[0]?.children?.map((child) => child.label)).toEqual([
      'Unloaded video-fake',
      'Started video-fake',
    ]);
  });

  it("merges the arm's own steps in behind the broker's", async () => {
    const { baseUrl } = await startServer();

    const jobId = newJobId();
    await submit(baseUrl, 'video-fake', { jobId, params: {}, job: {} });

    const seen = (await (await fetch(`${baseUrl}/v1/jobs/${jobId}`, { headers: auth })).json()) as JobProgressResponse;

    expect(seen.job.steps.map((step) => step.label)).toEqual(['Queued for the card', 'Denoise']);
    expect(seen.job.meters[0]?.total).toBe(8);
    expect(seen.job.armVram).toEqual([{ at: 1, gib: 5.17 }]);
    expect(seen.job.state).toBe('done');
  });

  it('records why a job failed, rather than only returning an error', async () => {
    const { baseUrl, harness } = await startServer();
    harness.serve = {
      generate: () => ({ status: 500, body: { error: { code: 'arm_error', message: 'CUDA out of memory' } } }),
    };

    const jobId = newJobId();
    const response = await submit(baseUrl, 'video-fake', { jobId, params: {}, job: {} });
    expect(response.status).toBe(502);

    const seen = (await (await fetch(`${baseUrl}/v1/jobs/${jobId}`, { headers: auth })).json()) as JobProgressResponse;
    expect(seen.job.state).toBe('failed');
    expect(seen.job.detail).toBe('CUDA out of memory');
  });

  it('refuses a job id that has already been used', async () => {
    const { baseUrl } = await startServer();

    const jobId = newJobId();
    await submit(baseUrl, 'video-fake', { jobId, params: {}, job: {} });
    const second = await submit(baseUrl, 'video-fake', { jobId, params: {}, job: {} });

    expect(second.status).toBe(400);
  });

  it('rejects a request that is not a job', async () => {
    const { baseUrl } = await startServer();

    const response = await submit(baseUrl, 'video-fake', { job: { prompt: 'no id' } });

    expect(response.status).toBe(400);
  });

  it('says nothing about a job it has never seen', async () => {
    const { baseUrl } = await startServer();

    expect((await fetch(`${baseUrl}/v1/jobs/unknown`, { headers: auth })).status).toBe(404);
  });
});
