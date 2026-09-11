import type { GenerateRequest, GenerateResponse } from '#shared/generate';
import { generatedMediaId } from '#shared/library';

import { armImagePath, mediaIdFromPath } from '../../../utils/jobs';
import { describeMedia, writeMeta } from '../../../utils/library';
import { relay } from '../../../utils/relay';
import { RelayError } from '../../../utils/supervisor';

export default defineEventHandler(async (event): Promise<GenerateResponse> => {
  const armId = getRouterParam(event, 'id');
  if (!armId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const config = useRuntimeConfig(event);
  const body = await readBody<GenerateRequest>(event);

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'prompt is required' },
    });
  }

  // The browser supplies the id rather than receiving one, because it has to
  // be able to poll the job's progress while this request is still open.
  const jobId = body.jobId;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(jobId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'jobId is required and must be a plain identifier' },
    });
  }

  const startedAt = new Date();
  // The date directory is decided here rather than by the arm, so that where a
  // generation is filed is one rule in one place -- and the same rule whether
  // the arm is this one or the next.
  const plannedId = generatedMediaId(jobId, startedAt);
  const settings = body.settings;

  return relay(async () => {
    const image = body.referenceId ? armImagePath(body.referenceId) : undefined;
    const client = supervisorClient(event);

    const report = await client.job<GenerateResponse['report']>(armId, {
      jobId,
      // How the arm has to be configured. The supervisor reloads it if what is
      // on the card does not match, which is why this travels with the job.
      params: body.armParams ?? {},
      job: {
        prompt,
        outPath: plannedId.slice('outputs/'.length),
        width: settings.width,
        height: settings.height,
        numFrames: settings.numFrames,
        frameRate: settings.frameRate,
        seed: settings.seed,
        enhancePrompt: settings.enhancePrompt,
        spatialUpsample: settings.spatialUpsample,
        temporalUpsample: settings.temporalUpsample,
        ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
        ...(image ? { image } : {}),
      },
    });

    // Trust what the arm says it wrote over what we asked it to write. They
    // agree today; if they ever stop, the record points at the real file.
    const mediaId = mediaIdFromPath(config.storageDir, report.out_path) ?? plannedId;

    await writeMeta(config.storageDir, mediaId, {
      source: 'generated',
      createdAt: startedAt.toISOString(),
      jobId,
      armId,
      prompt,
      ...(body.armParams && Object.keys(body.armParams).length > 0
        ? { armParams: body.armParams }
        : {}),
      ...(report.prompt_used && report.prompt_used !== prompt ? { promptUsed: report.prompt_used } : {}),
      ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
      ...(body.referenceId ? { referenceId: body.referenceId } : {}),
      // The seed the arm actually used, which is the one worth keeping: a
      // request of -1 means "choose one", and the chosen one is what reruns.
      settings: { ...settings, seed: report.seed },
      output: body.output,
      report: {
        secondsTotal: report.seconds_total,
        steps: report.steps,
        peakVramGib: report.peak_vram_reserved_gib,
        stages: report.stages.map((entry) => ({ name: entry.name, seconds: entry.seconds })),
      },
    });

    const media = await describeMedia(config.storageDir, mediaId);
    if (!media) throw new RelayError('arm_error', `the arm reported ${report.out_path}, which is not there`);

    return { media, report };
  });
});
