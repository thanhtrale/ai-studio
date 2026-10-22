import { startAuto } from '../../../char3d/autopilot';
import { supervisorClient } from '../../../utils/relay';

/**
 * Start the autopilot on one character: `{ chibi?, passScore?, refTries?, meshTries?, reviewer?, stopAfter? }`.
 * Answers at once; the page follows `auto` on the character.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const body = (await readBody<Record<string, unknown>>(event)) ?? {};
  return startAuto(config.storageDir, supervisorClient(event), getRouterParam(event, 'id') ?? '', body);
});
