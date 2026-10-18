import { getRun } from '../../../../char3d/store';

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return getRun(config.storageDir, getRouterParam(event, 'id') ?? '', getRouterParam(event, 'run') ?? '');
});
