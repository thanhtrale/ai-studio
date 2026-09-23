import { discoveredPeers } from '../../utils/lan-discovery';

/** Receivers announcing an open inbox on this network. Polled by the LAN page. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  try {
    return { peers: await discoveredPeers(config.lanDiscoveryPort) };
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: 'discovery_failed',
      data: { message: `cannot listen for receivers on UDP ${config.lanDiscoveryPort}: ${(error as Error).message}` },
    });
  }
});
