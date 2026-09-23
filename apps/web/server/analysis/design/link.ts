/**
 * A Figma link, reduced to the two things that identify a design.
 *
 * A whole file is not a block, and reading one would be neither affordable nor
 * meaningful, so a reference without a node is refused rather than widened to
 * the file. The node id is the awkward part: a browser URL writes it with a
 * hyphen (`node-id=123-456`) while every API and MCP tool wants a colon
 * (`123:456`), and older links percent-encode the colon. All three forms are
 * the same node and all three are accepted.
 */

import { RelayError } from '../../utils/supervisor';

export interface DesignReference {
  fileKey: string;
  /** Canonical form, with a colon -- which is what the tools take. */
  nodeId: string;
  /** The file's name as the URL spells it, when it carries one. */
  fileName?: string;
}

const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);

/** The path segments Figma puts a file key behind. `board` is FigJam. */
const FILE_SEGMENTS = new Set(['design', 'file', 'proto', 'board', 'slides']);

const FILE_KEY = /^[A-Za-z0-9]{10,64}$/;
const NODE_ID = /^\d+[-:]\d+$/;

/**
 * Parses a Figma design link.
 *
 * Throws rather than returning null: every caller is a route that has to refuse
 * the request with a reason, and the reason differs -- not Figma at all, no
 * node in it, a key that is not a key -- in ways a null would flatten.
 */
export function parseFigmaLink(input: unknown): DesignReference {
  if (typeof input !== 'string' || !input.trim()) {
    throw new RelayError('invalid_request', 'a Figma link is required');
  }

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new RelayError('invalid_request', `"${input}" is not a URL`);
  }

  if (!FIGMA_HOSTS.has(url.hostname.toLowerCase())) {
    throw new RelayError('invalid_request', `${url.hostname} is not Figma`);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const at = segments.findIndex((segment) => FILE_SEGMENTS.has(segment.toLowerCase()));
  const fileKey = at === -1 ? undefined : segments[at + 1];

  if (!fileKey || !FILE_KEY.test(fileKey)) {
    throw new RelayError(
      'invalid_request',
      'that Figma link carries no file key -- copy a link to a frame rather than to a project',
    );
  }

  const raw = url.searchParams.get('node-id') ?? url.searchParams.get('node_id');
  if (!raw) {
    throw new RelayError(
      'invalid_request',
      'that Figma link names no node -- select the block’s frame and copy a link to it, ' +
        'because a whole file is not a block',
    );
  }

  // `new URL` has already decoded `%3A`; the hyphen form has not been touched.
  const nodeId = raw.replace('-', ':');
  if (!NODE_ID.test(nodeId)) {
    throw new RelayError('invalid_request', `"${raw}" is not a Figma node id`);
  }

  const reference: DesignReference = { fileKey, nodeId };
  const fileName = segments[at + 2];
  if (fileName) reference.fileName = decodeURIComponent(fileName).replace(/-/g, ' ');
  return reference;
}

/** The canonical link for a reference, for a record that has to point back. */
export function figmaLink(reference: DesignReference): string {
  const name = reference.fileName ? encodeURIComponent(reference.fileName.replace(/ /g, '-')) : 'file';
  return `https://www.figma.com/design/${reference.fileKey}/${name}?node-id=${reference.nodeId.replace(':', '-')}`;
}
