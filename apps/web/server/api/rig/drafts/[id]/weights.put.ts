import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { relay } from '../../../../utils/relay';
import { draftDir, EDITED_WEIGHTS, readDraftInfo, WEIGHT_BYTES_PER_VERTEX } from '../../../../utils/rig';
import { RelayError } from '../../../../utils/supervisor';

/**
 * The editor's repainted weights, in `weights.bin`'s own layout: four float32
 * weights per vertex, then four uint8 bone indices per vertex.
 *
 * Raw bytes rather than JSON: eighty thousand vertices is 1.6 MB this way and
 * several times that as numbers in text. The binding job reads the file from
 * the draft, so the request to the arm stays small.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const id = getRouterParam(event, 'id') ?? '';

  return relay(async () => {
    const info = await readDraftInfo(config.storageDir, id);
    const body = await readRawBody(event, false);
    const expected = info.vertexCount * WEIGHT_BYTES_PER_VERTEX;
    if (!body || body.length !== expected) {
      throw new RelayError(
        'invalid_request',
        `weights are ${body?.length ?? 0} bytes; ${info.vertexCount} vertices need ${expected}`,
      );
    }

    // Copied: a pooled Buffer need not start on a four-byte boundary.
    const floats = new Float32Array(Uint8Array.prototype.slice.call(body, 0, info.vertexCount * 16).buffer);
    if (floats.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new RelayError('invalid_request', 'weights must be finite and not negative');
    }
    const indices = body.subarray(info.vertexCount * 16);
    if (indices.some((index) => index >= info.bones.length)) {
      throw new RelayError('invalid_request', `a weight names a bone past the ${info.bones.length} the rig has`);
    }

    await writeFile(path.join(draftDir(config.storageDir, id), EDITED_WEIGHTS), body);
    return { bytes: body.length };
  });
});
