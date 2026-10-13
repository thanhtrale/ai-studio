import type { RigDraftRequest, RigDraftResponse } from '#shared/generate';
import { UPLOAD_ROOT } from '#shared/library';

import { relay } from '../../../utils/relay';
import { DRAFTS_DIR, pruneDrafts, stageMesh } from '../../../utils/rig';
import { RelayError } from '../../../utils/supervisor';

interface ArmDraftReport {
  seconds_total: number;
  draft: string;
  bones: number;
  vertices: number;
  faces: number;
}

/**
 * Detect a mesh's skeleton and skin weights, and stop before Blender.
 *
 * The arm writes the draft under `outputs/.rig-drafts/<jobId>/` -- the mesh in
 * the rig's frame, the bones, four influences per vertex -- for the rig editor
 * to load, change and hand back to `POST /api/arms/:id/rig` with `draftId`.
 * Nothing is filed in the library: a draft is not a result.
 */
export default defineEventHandler(async (event): Promise<RigDraftResponse> => {
  const armId = getRouterParam(event, 'id');
  if (!armId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });
  const config = useRuntimeConfig(event);
  const body = await readBody<RigDraftRequest>(event);

  const jobId = body?.jobId;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(jobId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'jobId is required and must be a plain identifier' },
    });
  }

  return relay(async () => {
    const meshId = await stageMesh(config.storageDir, body.meshId);
    const client = supervisorClient(event);
    const { arms } = await client.inventory();
    const target = arms.find((candidate) => candidate.id === armId);
    if (!target) throw new RelayError('not_found', `unknown arm "${armId}"`);
    if (!target.capabilities.includes('mesh.rig')) {
      throw new RelayError('invalid_request', `arm "${armId}" does not rig meshes`);
    }

    await pruneDrafts(config.storageDir);
    const report = await client.job<ArmDraftReport>(armId, {
      jobId,
      params: {},
      job: {
        mode: 'draft',
        meshPath: meshId.slice(`${UPLOAD_ROOT}/`.length),
        draftDir: `${DRAFTS_DIR}/${jobId}`,
        removeFingers: body.removeFingers !== false,
      },
    });

    return {
      draftId: report.draft,
      bones: report.bones,
      vertices: report.vertices,
      faces: report.faces,
      secondsTotal: report.seconds_total,
    };
  });
});
