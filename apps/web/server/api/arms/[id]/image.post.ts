import type { ImageGenerateRequest, ImageGenerateResponse } from '#shared/generate';
import { generatedMediaId } from '#shared/library';

import { armImagePath, mediaIdFromPath } from '../../../utils/jobs';
import { describeMedia, writeMeta } from '../../../utils/library';
import { relay } from '../../../utils/relay';
import { RelayError } from '../../../utils/supervisor';

/**
 * The child's own ceiling: `limits.max_batch_count` from its capabilities.
 *
 * Checked here as well as in the arm so a bad request is refused before an arm
 * is brokered onto the card for it.
 */
const MAX_BATCH = 8;
const MAX_REFERENCES = 4;

export default defineEventHandler(async (event): Promise<ImageGenerateResponse> => {
  const armId = getRouterParam(event, 'id');
  if (!armId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const config = useRuntimeConfig(event);
  const body = await readBody<ImageGenerateRequest>(event);

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'prompt is required' },
    });
  }

  const jobId = body.jobId;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(jobId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'jobId is required and must be a plain identifier' },
    });
  }

  const settings = body.settings;
  const batch = Math.trunc(settings?.batch ?? 1);
  if (!Number.isFinite(batch) || batch < 1 || batch > MAX_BATCH) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: `batch must be between 1 and ${MAX_BATCH}` },
    });
  }

  const referenceIds = body.referenceIds ?? [];
  if (referenceIds.length > MAX_REFERENCES) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: `at most ${MAX_REFERENCES} reference images` },
    });
  }

  const startedAt = new Date();
  // The first image of a batch keeps this name and the rest are suffixed by the
  // arm. Where a generation is filed stays one rule in one place, and it is the
  // same rule as the video console's.
  const plannedId = generatedMediaId(jobId, startedAt, '.png');

  return relay(async () => {
    const refImages = referenceIds.map((id) => armImagePath(id));
    const client = supervisorClient(event);

    const report = await client.job<ImageGenerateResponse['report']>(armId, {
      jobId,
      params: body.armParams ?? {},
      job: {
        prompt,
        outPath: plannedId.slice('outputs/'.length),
        width: settings.width,
        height: settings.height,
        steps: settings.steps,
        cfgScale: settings.cfgScale,
        sampler: settings.sampler,
        scheduler: settings.scheduler,
        flowShift: settings.flowShift,
        seed: settings.seed,
        batch,
        ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
        ...(refImages.length > 0 ? { refImages } : {}),
      },
    });

    if (!Array.isArray(report.images) || report.images.length === 0) {
      throw new RelayError('arm_error', 'the arm reported no images');
    }

    const media = [];
    for (const image of report.images) {
      // No fallback to the planned name here, unlike the single-file route: a
      // batch has several names and guessing which one this is would file a
      // record against the wrong image.
      const mediaId = mediaIdFromPath(config.storageDir, image.out_path);
      if (!mediaId) {
        throw new RelayError('arm_error', `the arm wrote ${image.out_path}, which is outside the library`);
      }

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
        // The first reference is the one the detail panel shows; the whole set
        // is kept beside it so the run can be repeated exactly.
        ...(referenceIds[0] ? { referenceId: referenceIds[0] } : {}),
        ...(referenceIds.length > 1 ? { referenceIds } : {}),
        // Every image of a batch keeps the whole request, with the seed this
        // one actually used -- which is what makes a single image of a batch
        // reproducible on its own.
        settings: { ...settings, batch, seed: image.seed, batchIndex: image.index },
        output: { ...body.output, count: report.images.length },
        report: {
          secondsTotal: report.seconds_total,
          steps: report.steps,
          peakVramGib: report.peak_vram_gib,
          ...(report.vram_scope ? { peakVramScope: report.vram_scope } : {}),
          stages: report.stages.map((entry) => ({ name: entry.name, seconds: entry.seconds })),
        },
      });

      const entry = await describeMedia(config.storageDir, mediaId);
      if (!entry) throw new RelayError('arm_error', `the arm reported ${image.out_path}, which is not there`);
      media.push(entry);
    }

    return { media, report };
  });
});
