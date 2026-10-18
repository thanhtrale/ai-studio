import { clipFile } from '../../../../char3d/review';
import { sendFile } from '../../../../char3d/send';

/** A clip's skeleton-and-animation GLB (`clip`) or its preview gif (`thumb`). */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const { file, type } = clipFile(config.storageDir, getRouterParam(event, 'id') ?? '', getRouterParam(event, 'kind') ?? '');
  return sendFile(event, file, type);
});
