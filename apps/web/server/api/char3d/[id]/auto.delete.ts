import { stopAuto } from '../../../char3d/autopilot';

/** Stop the autopilot once its current run or review is over. The run itself finishes. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return (await stopAuto(config.storageDir, getRouterParam(event, 'id') ?? '')) ?? null;
});
