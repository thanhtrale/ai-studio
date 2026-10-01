import { listSurveys } from '../../survey/store';

/**
 * Every survey on disk, newest first.
 *
 * Records only: the index of a large file is a megabyte of JSON, and a list
 * that loaded all of them to render their titles would be a list nobody could
 * open.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return { surveys: await listSurveys(config.storageDir) };
});
