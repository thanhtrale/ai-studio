import { parsePeer } from '#shared/lan';

import { helloPeer } from '../../utils/lan';

/** Checks an address before anything is sent to it. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const peer = parsePeer(String(getQuery(event)['peer'] ?? ''), config.lanPort);
  if (!peer) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request', data: { message: 'not an address' } });
  }

  try {
    return { ...peer, ...(await helloPeer(peer)) };
  } catch (error) {
    throw createError({
      statusCode: 502,
      statusMessage: 'peer_unreachable',
      data: { message: `${peer.host}:${peer.port} did not answer (${(error as Error).message})` },
    });
  }
});
