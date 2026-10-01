import type { VideoGenerateRequest, VideoGenerateResponse } from '#shared/generate';
import { mergePrompt } from '#shared/generate';
import { generatedMediaId, sanitiseCollection } from '#shared/library';

import { armImagePath, mediaIdFromPath } from '../../../utils/jobs';
import { describeMedia, writeMeta } from '../../../utils/library';
import { relay } from '../../../utils/relay';
import { RelayError } from '../../../utils/supervisor';

/**
 * A batch of clips from a ComfyUI video arm.
 *
 * The sibling of `image.post.ts`, and deliberately the same file twice over:
 * one job, several files, a library record each, the seed the arm actually
 * used. `generate.post.ts` stays as it is for the diffusers arm, which returns
 * one clip and has no step count to report.
 *
 * The arm's own ceilings are checked here as well as in the arm, so a bad
 * request is refused before an arm is brokered onto the card for it. Sixteen
 * rather than the image route's hundred: a clip is minutes, not seconds.
 */
const MAX_BATCH = 16;
/** First frame, last frame. The fl2va checkpoint has nowhere to put a third. */
const MAX_REFERENCES = 2;

export default defineEventHandler(async (event): Promise<VideoGenerateResponse> => {
  const armId = getRouterParam(event, 'id');
  if (!armId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const config = useRuntimeConfig(event);
  const body = await readBody<VideoGenerateRequest>(event);

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
      data: { message: `at most ${MAX_REFERENCES} keyframes (first frame, last frame)` },
    });
  }

  const startedAt = new Date();
  // The first clip of a batch keeps this name and the rest are suffixed by the
  // arm. Where a generation is filed stays one rule in one place.
  const collection = sanitiseCollection(body.collection) ?? undefined;
  const plannedId = generatedMediaId(jobId, startedAt, '.mp4', collection);

  return relay(async () => {
    const refImages = referenceIds.map((id) => armImagePath(id));
    const client = supervisorClient(event);

    // The console only offers arms that declare this contract, but the console
    // is not the only caller.
    const { arms } = await client.inventory();
    const target = arms.find((candidate) => candidate.id === armId);
    if (!target) throw new RelayError('not_found', `unknown arm "${armId}"`);
    if (!target.capabilities.includes('video.generate')) {
      throw new RelayError('invalid_request', `arm "${armId}" does not serve video jobs`);
    }

    const report = await client.job<VideoGenerateResponse['report']>(armId, {
      jobId,
      params: body.armParams ?? {},
      job: {
        prompt: promptForArm,
        outPath: plannedId.slice('outputs/'.length),
        width: settings.width,
        height: settings.height,
        numFrames: settings.numFrames,
        frameRate: settings.frameRate,
        seed: settings.seed,
        batch,
        ...(settings.steps !== undefined ? { steps: settings.steps } : {}),
        ...(settings.scheduler ? { scheduler: settings.scheduler } : {}),
        ...(settings.flowShift !== undefined ? { flowShift: settings.flowShift } : {}),
        ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
        ...(refImages.length > 0 ? { refImages } : {}),
      },
    });

    if (!Array.isArray(report.videos) || report.videos.length === 0) {
      throw new RelayError('arm_error', 'the arm reported no clips');
    }

    const promptSeen = report.prompt_used || promptForArm;

    const media = [];
    for (const clip of report.videos) {
      // No fallback to the planned name here, unlike the single-file route: a
      // batch has several names and guessing which one this is would file a
      // record against the wrong clip.
      const mediaId = mediaIdFromPath(config.storageDir, clip.out_path);
      if (!mediaId) {
        throw new RelayError('arm_error', `the arm wrote ${clip.out_path}, which is outside the library`);
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
        ...(promptSeen !== prompt ? { promptUsed: promptSeen } : {}),
        ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
        // The first keyframe is the one the detail panel shows; the whole set
        // is kept beside it so the run can be repeated exactly.
        ...(referenceIds[0] ? { referenceId: referenceIds[0] } : {}),
        ...(referenceIds.length > 1 ? { referenceIds } : {}),
        // Every clip of a batch keeps the whole request, with the seed this
        // one actually used -- which is what makes a single clip of a batch
        // reproducible on its own.
        settings: {
          ...settings,
          batch,
          seed: clip.seed,
          batchIndex: clip.index,
          // The arm rounds the frame count up onto the model's own grid, and
          // what it used is what reruns.
          numFrames: report.num_frames,
          frameRate: report.frame_rate,
        },
        output: { ...body.output, count: report.videos.length },
        report: {
          secondsTotal: report.seconds_total,
          steps: report.steps,
          peakVramGib: report.peak_vram_gib,
          ...(report.vram_scope ? { peakVramScope: report.vram_scope } : {}),
          stages: report.stages.map((entry) => ({ name: entry.name, seconds: entry.seconds })),
        },
      });

      const entry = await describeMedia(config.storageDir, mediaId);
      if (!entry) throw new RelayError('arm_error', `the arm reported ${clip.out_path}, which is not there`);
      media.push(entry);
    }

    return { media, report };
  });
});
