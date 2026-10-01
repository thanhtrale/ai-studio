import { cloudWorker } from '../../../utils/cloud/worker';

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);

  return cloudWorker().start({
    storageDir: config.storageDir as string,
    supervisorUrl: config.supervisorUrl as string,
    supervisorToken: config.supervisorToken as string,
  });
});
