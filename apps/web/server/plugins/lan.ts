import { stopListener } from '../utils/lan';

/** Releases the LAN port when the server shuts down, so the next start can bind it. */
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', stopListener);
});
