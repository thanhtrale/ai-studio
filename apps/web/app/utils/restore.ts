import type { MediaMeta } from '#shared/library';

/**
 * Which record a form was filled in from.
 *
 * `?from=` hands a console a record to restore, and the console restores it
 * whenever that record changes. Object identity cannot answer "changed": the
 * library refetches after every upload and every generation, and each fetch
 * builds new objects out of the same JSON. Watching the object meant the form
 * was refilled -- overwriting whatever had been typed since -- every time
 * something unrelated touched the library.
 *
 * These three fields are what a record is: one job, made at one time, by one
 * arm. Two fetches of the same record agree on all of them.
 */
export function restoreKey(meta: MediaMeta): string {
  return [meta.jobId ?? '', meta.createdAt, meta.armId ?? ''].join('|');
}
