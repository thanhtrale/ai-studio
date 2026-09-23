import { stopListener } from '../utils/lan';
import { stopDiscovery } from '../utils/lan-discovery';

/** Releases the LAN ports when the server shuts down, so the next start can bind them. */
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', async () => {
    stopDiscovery();
    await stopListener();
  });
});
