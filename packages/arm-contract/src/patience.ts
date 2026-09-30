/**
 * Waiting out a job that takes longer than five minutes.
 *
 * Node's `fetch` gives up on a response after about 300 seconds and throws
 * `UND_ERR_HEADERS_TIMEOUT`. That ceiling is shorter than the work this studio
 * exists to run: a forty-image batch, or a video clip. Measured, not assumed --
 * a 48-image batch wrote all 48 files and then had its answer thrown away on
 * the way back, twice, leaving the library with no record of any of them.
 *
 * The fix is an undici agent with the ceiling lifted. It is built from the
 * constructor of Node's *own* global dispatcher rather than from the `undici`
 * package, so there is no dependency to add and no second copy of undici whose
 * agent Node's fetch might refuse.
 */

/** Twenty-four days. `0` is rejected as invalid, so this stands in for "never". */
const FOREVER_MS = 2_147_483_647;

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

let cached: unknown;
let built = false;

/**
 * A dispatcher that will not time out, or `undefined` where one cannot be made.
 *
 * `undefined` leaves the caller on Node's default, which is the behaviour this
 * replaces: a runtime without the global dispatcher symbol loses the long
 * jobs, not every job.
 */
export function patientDispatcher(): unknown {
  if (built) return cached;
  built = true;

  const current = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER];
  const Agent = (current as { constructor?: unknown } | undefined)?.constructor;
  if (typeof Agent !== 'function') return cached;

  try {
    cached = new (Agent as new (options: unknown) => unknown)({
      headersTimeout: FOREVER_MS,
      bodyTimeout: FOREVER_MS,
    });
  } catch {
    // An agent whose options this runtime rejects is not worth a failed call.
    cached = undefined;
  }
  return cached;
}

/**
 * Request options for a call whose answer is worth waiting for.
 *
 * Spread into a `fetch` init. Empty when no dispatcher could be built, so the
 * call still goes out.
 */
export function patientFetchInit(): Record<string, unknown> {
  const dispatcher = patientDispatcher();
  return dispatcher ? { dispatcher } : {};
}
