/**
 * Why reading a design failed.
 *
 * The Figma MCP server is another application's process, not this studio's, and
 * it is absent for three unrelated reasons that a single "Figma unavailable"
 * would flatten into one useless message:
 *
 * - the desktop app is closed, or its local server is not enabled in
 *   preferences, or the account has no Dev seat -- nothing is listening;
 * - it is listening, but the file is not open in the running session, or the
 *   node is not in it -- the server answers and refuses;
 * - it answered once and then stopped -- a call that hangs.
 *
 * Each needs a different action from the person at the keyboard, so each keeps
 * its own reason all the way to the console.
 */

export const DESIGN_SOURCE_FAILURES = [
  /** Nothing is listening where the local MCP server should be. */
  'unreachable',
  /** The server answered, but would not give up the node. */
  'node-unreadable',
  /** A call exceeded its budget. */
  'timeout',
  /** It answered with something this adapter cannot read. */
  'protocol',
] as const;

export type DesignSourceFailure = (typeof DESIGN_SOURCE_FAILURES)[number];

export class DesignSourceError extends Error {
  readonly reason: DesignSourceFailure;
  /** The call that failed, so a message can name it rather than the feature. */
  readonly where: string;

  constructor(reason: DesignSourceFailure, where: string, message: string) {
    super(message);
    this.name = 'DesignSourceError';
    this.reason = reason;
    this.where = where;
  }
}

/** True for the failures a person can fix by opening or enabling something. */
export function isRecoverable(error: DesignSourceError): boolean {
  return error.reason === 'unreachable' || error.reason === 'node-unreadable';
}
