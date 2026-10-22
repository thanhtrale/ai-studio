import { optionsOf, reviewRun } from '../../../../../char3d/autopilot';
import { getCharacter } from '../../../../../char3d/store';
import { supervisorClient } from '../../../../../utils/relay';

/**
 * Have the local vision model review one finished run, as the autopilot would,
 * and write the review on it: `{ reviewer?, passScore?, chibi? }`. Waits for
 * the answer (the arm may first have to be put on the card). `save: false`
 * only answers, leaving the run's review as it is.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const id = getRouterParam(event, 'id') ?? '';
  const body = (await readBody<Record<string, unknown>>(event)) ?? {};
  const character = await getCharacter(config.storageDir, id);
  const options = optionsOf({ chibi: character.chibi ?? false, ...body });
  try {
    return await reviewRun(config.storageDir, supervisorClient(event), id, getRouterParam(event, 'run') ?? '', options, body['save'] !== false);
  } catch (error) {
    throw createError({
      statusCode: 502,
      statusMessage: 'review_failed',
      data: { message: (error as { data?: { message?: string } })?.data?.message ?? (error instanceof Error ? error.message : String(error)) },
    });
  }
});
