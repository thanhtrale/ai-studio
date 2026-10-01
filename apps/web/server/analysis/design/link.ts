/**
 * Figma links, as a route has to deal with them.
 *
 * The rules themselves live in `#shared/figma-link`, because the console
 * applies the same ones to tell a person their link is wrong before they spend
 * four minutes finding out. What is here is only the translation from a result
 * into the refusal a route owes its caller.
 *
 * Throwing rather than returning is the right shape at this layer: every caller
 * is a route that has to refuse the request with a reason, and the reasons --
 * not Figma at all, no node in the link, two different files -- differ in ways
 * a null would flatten.
 */

import type { DesignReference } from '#shared/figma-link';
import { figmaLink, readFigmaLink, readFigmaLinks } from '#shared/figma-link';

import { RelayError } from '../../utils/supervisor';

export type { DesignReference };
export { figmaLink };

/** One link, where exactly one is meant. */
export function parseFigmaLink(input: unknown): DesignReference {
  if (typeof input !== 'string') throw new RelayError('invalid_request', 'a Figma link is required');
  const reading = readFigmaLink(input);
  if (!reading.ok) throw new RelayError('invalid_request', reading.reason);
  return reading.reference;
}

/**
 * Every link in a blob of text, which is how the console sends them.
 *
 * A single problem is reported as itself; several are joined, because a person
 * who pasted three links and got two of them wrong should not have to submit
 * three times to learn that.
 */
export function parseFigmaLinks(input: unknown): DesignReference[] {
  const { references, problems } = readFigmaLinks(input);
  if (problems.length > 0) {
    throw new RelayError('invalid_request', problems.join('; and '));
  }
  if (references.length === 0) {
    throw new RelayError('invalid_request', 'at least one Figma link is required');
  }
  return references;
}
