import { parsePeer, sanitiseTransferName } from '#shared/lan';

import { forwardToPeer } from '../../utils/lan';

/**
 * Relays the request body to a peer's inbox as it streams in.
 *
 * The browser uploads to its own studio rather than straight to the peer, so
 * the peer needs no CORS and the progress the browser sees is the progress of
 * the transfer itself: bytes only leave the browser as fast as the peer takes them.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const query = getQuery(event);

  const peer = parsePeer(String(query['peer'] ?? ''), config.lanPort);
  const name = sanitiseTransferName(String(query['name'] ?? ''));
  if (!peer || !name) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: !peer ? 'not an address' : 'not a usable file name' },
    });
  }

  let result;
  try {
    result = await forwardToPeer(peer, name, event.node.req);
  } catch (error) {
    throw createError({
      statusCode: 502,
      statusMessage: 'peer_unreachable',
      data: { message: `${peer.host}:${peer.port}: ${(error as Error).message}` },
    });
  }

  if (result.status !== 200) {
    throw createError({
      statusCode: 502,
      statusMessage: 'peer_refused',
      data: { message: result.payload.message ?? `peer answered ${result.status}` },
    });
  }
  return { name: result.payload.name ?? name };
});
