import type { RigGenerateRequest, RigGenerateResponse } from '#shared/generate';
import { generatedMediaId, sanitiseCollection, UPLOAD_ROOT } from '#shared/library';

import { mediaIdFromPath } from '../../../utils/jobs';
import { describeMedia, writeMeta } from '../../../utils/library';
import { relay } from '../../../utils/relay';
import { checkBoneEdits, DRAFTS_DIR, isDraftId, readDraftInfo, stageMesh } from '../../../utils/rig';
import { RelayError } from '../../../utils/supervisor';

const MAX_CLIPS = 16;
const CLIP_NAME = /^[A-Za-z0-9 _.()-]{1,80}$/;

function invalid(message: string): never {
  throw createError({ statusCode: 400, statusMessage: 'invalid_request', data: { message } });
}

export default defineEventHandler(async (event): Promise<RigGenerateResponse> => {
  const armId = getRouterParam(event, 'id');
  if (!armId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const config = useRuntimeConfig(event);
  const body = await readBody<RigGenerateRequest>(event);

  const jobId = body?.jobId;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(jobId)) {
    invalid('jobId is required and must be a plain identifier');
  }
  if (typeof body.meshId !== 'string' || body.meshId === '') invalid('a mesh to rig is required');

  const settings = body.settings;
  if (settings?.kind !== 'rig') invalid('settings must describe a rig');
  if (!Array.isArray(settings.clips) || settings.clips.length > MAX_CLIPS) {
    invalid(`clips must be a list of at most ${MAX_CLIPS} names`);
  }
  if (!settings.clips.every((name) => typeof name === 'string' && CLIP_NAME.test(name))) {
    invalid('every clip must be a plain clip name');
  }

  const draftId = body.draftId;
  if (draftId !== undefined && !isDraftId(draftId)) invalid('draftId is not a draft id');
  if (body.bones !== undefined && draftId === undefined) invalid('bones are edits to a draft: send draftId with them');

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const startedAt = new Date();
  const collection = sanitiseCollection(body.collection) ?? undefined;
  const plannedId = generatedMediaId(jobId, startedAt, '.glb', collection);

  return relay(async () => {
    // A reviewed draft carries its own mesh; only a fresh rig reads the library's.
    const draft = draftId ? await readDraftInfo(config.storageDir, draftId) : null;
    const bones = draft ? checkBoneEdits(body.bones, draft) : {};
    const meshId = draft ? null : await stageMesh(config.storageDir, body.meshId);
    const client = supervisorClient(event);

    const { arms } = await client.inventory();
    const target = arms.find((candidate) => candidate.id === armId);
    if (!target) throw new RelayError('not_found', `unknown arm "${armId}"`);
    if (!target.capabilities.includes('mesh.rig')) {
      throw new RelayError('invalid_request', `arm "${armId}" does not rig meshes`);
    }

    const report = await client.job<RigGenerateResponse['report']>(armId, {
      jobId,
      params: {},
      job: {
        outPath: plannedId.slice('outputs/'.length),
        ...(meshId === null
          ? { mode: 'bind', draftDir: `${DRAFTS_DIR}/${draftId}`, bones }
          : { mode: 'rig', meshPath: meshId.slice(`${UPLOAD_ROOT}/`.length) }),
        clips: settings.clips,
        removeFingers: settings.removeFingers,
        inPlace: settings.inPlace,
        compressTextures: settings.compressTextures,
        textureQuality: settings.textureQuality,
      },
    });

    const mediaId = mediaIdFromPath(config.storageDir, report.out_path);
    if (!mediaId) throw new RelayError('arm_error', `the arm wrote ${report.out_path}, which is outside the library`);

    await writeMeta(config.storageDir, mediaId, {
      source: 'generated',
      createdAt: startedAt.toISOString(),
      jobId,
      armId,
      ...(note ? { prompt: note } : {}),
      // The original, not the staged copy: that is the file the library shows.
      referenceId: body.meshId,
      settings: { ...settings, clips: report.clips, seed: 0, batch: 1, batchIndex: 0 },
      output: {
        count: 1,
        faces: report.faces,
        vertices: report.vertices,
        textured: report.texture_bytes_before > 0,
        bones: report.bones,
        clips: report.clips,
      },
      report: {
        secondsTotal: report.seconds_total,
        steps: 0,
        peakVramGib: report.peak_vram_gib,
        peakVramScope: report.vram_scope,
        stages: report.stages.map((entry) => ({ name: entry.name, seconds: entry.seconds })),
      },
    });

    const entry = await describeMedia(config.storageDir, mediaId);
    if (!entry) throw new RelayError('arm_error', `the arm reported ${report.out_path}, which is not there`);
    return { media: [entry], report };
  });
});
