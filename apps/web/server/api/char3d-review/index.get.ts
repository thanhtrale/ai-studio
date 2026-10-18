import { listSaved } from '../../char3d/review';

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return { saved: await listSaved(config.storageDir) };
});
