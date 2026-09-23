import { lanStatus } from '../../utils/lan';

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return lanStatus(config.storageDir, config.lanPort);
});
