import { copyFile, stat } from 'node:fs/promises';

import type { MeshGenerateRequest, MeshGenerateResponse } from '#shared/generate';
import { generatedMediaId, isMediaId, mediaKind, rootOf, sanitiseCollection, UPLOAD_ROOT } from '#shared/library';

import { armImagePath, mediaIdFromPath } from '../../../utils/jobs';
import { describeMedia, ensureDirectoryFor, mediaPath, writeMeta } from '../../../utils/library';
import { relay } from '../../../utils/relay';
import { RelayError } from '../../../utils/supervisor';

/** Where a generated image is copied to so an arm may read it. */
const STAGED_DIR = 'from-outputs';

/**
 * The reference as an id under `inputs/`, copying it there if it was generated.
 *
 * The natural way to make a mesh is from an image this studio just made, and
 * arms may only read `inputs/`. Copied rather than refused, once per file: the
 * copy keeps the output's own path below `inputs/from-outputs/`, so a second
 * mesh from the same image reuses it and the library can tell where it came from.
 */
async function stageReference(storageDir: string, id: unknown): Promise<string> {
  if (!isMediaId(id) || mediaKind(id) !== 'image') {
    throw new RelayError('invalid_request', 'the reference must be an image in the library');
  }
  if (rootOf(id) === UPLOAD_ROOT) return id;

  const staged = `${UPLOAD_ROOT}/${STAGED_DIR}/${id.slice(id.indexOf('/') + 1)}`;
  if (!isMediaId(staged)) throw new RelayError('invalid_request', `${id} is nested too deeply to stage`);

  const target = mediaPath(storageDir, staged);
  try {
    await stat(target);
  } catch {
    await ensureDirectoryFor(target);
    await copyFile(mediaPath(storageDir, id), target);
  }
  return staged;
}

/**
 * The arm's own ceilings, checked here as well as in the arm so a bad request
 * is refused before an arm is brokered onto the card for it.
 *
 * Eight meshes rather than the image console's hundred: each is a minute or
 * more of card time, and this request stays open until the last is written.
 */
const MAX_BATCH = 8;
const MAX_FACES = 2_000_000;

function invalid(message: string): never {
  throw createError({ statusCode: 400, statusMessage: 'invalid_request', data: { message } });
}

export default defineEventHandler(async (event): Promise<MeshGenerateResponse> => {
  const armId = getRouterParam(event, 'id');
  if (!armId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const config = useRuntimeConfig(event);
  const body = await readBody<MeshGenerateRequest>(event);

  const jobId = body?.jobId;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(jobId)) {
    invalid('jobId is required and must be a plain identifier');
  }
  if (typeof body.referenceId !== 'string' || body.referenceId === '') {
    invalid('a reference image is required -- the shape is made from it');
  }

  const settings = body.settings;
  if (settings?.kind !== 'model') invalid('settings must describe a mesh');
  // `hunyuan3d` is still a valid engine in the library's older records, but
  // the untextured ComfyUI arm that ran it is gone.
  if (settings.engine !== 'trellis2' && settings.engine !== 'hunyuan3d-paint') {
    invalid('engine must be trellis2 or hunyuan3d-paint');
  }
  const batch = Math.trunc(settings.batch ?? 1);
  if (!Number.isFinite(batch) || batch < 1 || batch > MAX_BATCH) {
    invalid(`batch must be between 1 and ${MAX_BATCH}`);
  }
  const targetFaces = Math.trunc(settings.targetFaces ?? 0);
  if (!Number.isFinite(targetFaces) || targetFaces < 0 || targetFaces > MAX_FACES) {
    invalid(`targetFaces must be between 0 and ${MAX_FACES}`);
  }

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const startedAt = new Date();
  const collection = sanitiseCollection(body.collection) ?? undefined;
  const plannedId = generatedMediaId(jobId, startedAt, '.glb', collection);

  return relay(async () => {
    const referenceId = await stageReference(config.storageDir, body.referenceId);
    const reference = armImagePath(referenceId);
    const client = supervisorClient(event);

    const { arms } = await client.inventory();
    const target = arms.find((candidate) => candidate.id === armId);
    if (!target) throw new RelayError('not_found', `unknown arm "${armId}"`);
    if (!target.capabilities.includes('mesh.generate')) {
      throw new RelayError('invalid_request', `arm "${armId}" does not serve mesh jobs`);
    }

    const report = await client.job<MeshGenerateResponse['report']>(armId, {
      jobId,
      params: body.armParams ?? {},
      job: {
        outPath: plannedId.slice('outputs/'.length),
        refImages: [reference],
        seed: settings.seed,
        batch,
        cfgScale: settings.cfgScale,
        targetFaces,
        removeBackground: settings.removeBackground,
        // Each arm's own knobs. Sent only when set, so an arm never receives a
        // field it does not know -- both refuse nothing they are not sent, and
        // the console only fills in the ones for the arm it is pointed at.
        ...(settings.engine === 'trellis2'
          ? {
              structureSteps: settings.structureSteps,
              shapeSteps: settings.shapeSteps,
              refineSteps: settings.refineSteps,
              textureSteps: settings.textureSteps,
              shapeResolution: settings.shapeResolution,
              textureSize: settings.textureSize,
              bakeNormals: settings.bakeNormals,
              bakeOcclusion: settings.bakeOcclusion,
              compressTextures: settings.compressTextures,
              textureQuality: settings.textureQuality,
            }
          : {
              steps: settings.steps,
              octreeResolution: settings.octreeResolution,
              texture: settings.texture,
              paintViews: settings.paintViews,
              paintResolution: settings.paintResolution,
              paintSteps: settings.paintSteps,
              paintGuidance: settings.paintGuidance,
              textureSize: settings.textureSize,
              upscale: settings.upscale,
              compressTextures: settings.compressTextures,
              textureQuality: settings.textureQuality,
            }),
      },
    });

    if (!Array.isArray(report.meshes) || report.meshes.length === 0) {
      throw new RelayError('arm_error', 'the arm reported no meshes');
    }

    const media = [];
    for (const mesh of report.meshes) {
      const mediaId = mediaIdFromPath(config.storageDir, mesh.out_path);
      if (!mediaId) {
        throw new RelayError('arm_error', `the arm wrote ${mesh.out_path}, which is outside the library`);
      }

      await writeMeta(config.storageDir, mediaId, {
        source: 'generated',
        createdAt: startedAt.toISOString(),
        jobId,
        armId,
        ...(note ? { prompt: note } : {}),
        ...(body.armParams && Object.keys(body.armParams).length > 0 ? { armParams: body.armParams } : {}),
        // The photograph is the whole input, so it is what the library shows as
        // this file's thumbnail until the viewer has loaded the mesh itself.
        referenceId,
        settings: { ...settings, batch, targetFaces, seed: mesh.seed, batchIndex: mesh.index },
        output: {
          count: report.meshes.length,
          ...(mesh.faces ? { faces: mesh.faces } : {}),
          ...(mesh.vertices ? { vertices: mesh.vertices } : {}),
          ...(mesh.textured !== undefined ? { textured: mesh.textured } : {}),
        },
        report: {
          secondsTotal: report.seconds_total,
          steps: report.steps,
          peakVramGib: report.peak_vram_gib,
          ...(report.vram_scope ? { peakVramScope: report.vram_scope } : {}),
          stages: report.stages.map((entry) => ({ name: entry.name, seconds: entry.seconds })),
        },
      });

      const entry = await describeMedia(config.storageDir, mediaId);
      if (!entry) throw new RelayError('arm_error', `the arm reported ${mesh.out_path}, which is not there`);
      media.push(entry);
    }

    return { media, report };
  });
});
