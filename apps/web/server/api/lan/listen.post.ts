import { lanStatus, startListener, stopListener } from '../../utils/lan';
import { startBeacon, stopBeacon } from '../../utils/lan-discovery';

/** Opens or closes the LAN inbox. Off until asked: nothing listens on the network by default. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const body = await readBody<{ on?: unknown }>(event);

  try {
    if (body?.on === true) {
      await startListener(config.storageDir, config.lanPort);
      await startBeacon(config.lanPort, config.lanDiscoveryPort);
    } else {
      stopBeacon();
      await stopListener();
    }
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: 'listen_failed',
      data: { message: (error as Error).message },
    });
  }
  return lanStatus(config.storageDir, config.lanPort);
});
