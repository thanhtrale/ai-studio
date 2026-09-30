import type { ImageGenerateRequest, ImageGenerateResponse } from '#shared/generate';
import { mergePrompt } from '#shared/generate';
import { generatedMediaId, sanitiseCollection } from '#shared/library';

import { armImagePath, mediaIdFromPath } from '../../../utils/jobs';
import { describeMedia, writeMeta } from '../../../utils/library';
import { relay } from '../../../utils/relay';
import { RelayError } from '../../../utils/supervisor';

/**
 * The arm's own ceilings, checked here as well as in the arm so a bad request
 * is refused before an arm is brokered onto the card for it.
 *
 * Three references rather than four: ComfyUI's Qwen edit encoder takes image1
 * through image3 and has nowhere to put a fourth.
 *
 * The batch ceiling is about time, not memory. One image is one ComfyUI
 * prompt, so a batch costs no extra VRAM -- but this request stays open until
 * the last one is written, so the number is what keeps a mistyped batch from
 * holding the card for an afternoon.
 */
const MAX_BATCH = 100;
const MAX_REFERENCES = 3;

export default defineEventHandler(async (event): Promise<ImageGenerateResponse> => {
  const armId = getRouterParam(event, 'id');
  if (!armId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const config = useRuntimeConfig(event);
  const body = await readBody<ImageGenerateRequest>(event);

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const stylePrompt = typeof body?.stylePrompt === 'string' ? body.stylePrompt.trim() : '';
  // The console's two boxes are one prompt to the model. Merged here rather
  // than in the browser so the record keeps the halves and the whole.
  const promptForArm = mergePrompt(prompt, stylePrompt);
  if (!promptForArm) {
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
  const collection = sanitiseCollection(body.collection) ?? undefined;
  const plannedId = generatedMediaId(jobId, startedAt, '.png', collection);

  return relay(async () => {
    const refImages = referenceIds.map((id) => armImagePath(id));
    const client = supervisorClient(event);

    // The console only offers arms that declare this contract, but the console
    // is not the only caller. Checking here means an arm that cannot run an
    // image job is refused before the broker puts it on the card and its
    // parameters fail to validate somewhere less legible.
    const { arms } = await client.inventory();
    const target = arms.find((candidate) => candidate.id === armId);
    if (!target) throw new RelayError('not_found', `unknown arm "${armId}"`);
    if (!target.capabilities.includes('image.generate')) {
      throw new RelayError('invalid_request', `arm "${armId}" does not serve image jobs`);
    }

    const report = await client.job<ImageGenerateResponse['report']>(armId, {
      jobId,
      params: body.armParams ?? {},
      job: {
        prompt: promptForArm,
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
        ...(body.enhancePrompt ? { enhancePrompt: true } : {}),
        ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
        ...(refImages.length > 0 ? { refImages } : {}),
      },
    });

    if (!Array.isArray(report.images) || report.images.length === 0) {
      throw new RelayError('arm_error', 'the arm reported no images');
    }

    const promptSeen = report.prompt_used || promptForArm;

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
        ...(stylePrompt ? { stylePrompt } : {}),
        ...(body.armParams && Object.keys(body.armParams).length > 0
          ? { armParams: body.armParams }
          : {}),
        // What reached the model: the enhancer's rewrite if there was one,
        // otherwise the two boxes joined. Recorded only when it differs from
        // what was typed, so a single-box run keeps one prompt and not two.
        ...(promptSeen !== prompt ? { promptUsed: promptSeen } : {}),
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
