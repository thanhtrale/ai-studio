/**
 * Figma links, found in whatever text they arrived in.
 *
 * This lives in `shared/` rather than beside the design source because both
 * sides need it and they need it for different reasons: the server has to
 * refuse a bad link, and the console has to say a link is bad *before* the
 * button is pressed. A run costs minutes, so discovering a typo at the end of
 * one is the worst possible time to discover it. Two implementations of the
 * same rules would eventually disagree about which links are acceptable, and
 * the disagreement would show up as a console that accepts what the server
 * then rejects.
 *
 * Nothing here throws. The server wraps these results in `RelayError` -- see
 * `server/analysis/design/link.ts` -- and the console renders them as text.
 *
 * Two things the input is allowed to be that it was not before:
 *
 * **Prose around the link.** Links are now pasted in the shape they are copied
 * in, which for anyone using an AI editor is `Implement this design from
 * Figma. @https://figma.com/...`. Rejecting the whole paste as "not a URL" was
 * correct and useless. A link is extracted from its surroundings instead.
 *
 * **Several links.** A block is drawn at several viewports -- desktop, tablet,
 * mobile -- and each is its own frame with its own link. They describe one
 * block, so they belong in one analysis.
 */

/** A Figma link, reduced to the two things that identify a design. */
export interface DesignReference {
  fileKey: string;
  /** Canonical form, with a colon -- which is what the tools take. */
  nodeId: string;
  /** The file's name as the URL spells it, when it carries one. */
  fileName?: string;
}

export type FigmaLinkReading =
  | { ok: true; reference: DesignReference }
  | { ok: false; reason: string };

export interface FigmaLinksReading {
  /** Unique, in the order given, all from one file. */
  references: DesignReference[];
  /** Sentences a person can act on. Empty means the text was wholly usable. */
  problems: string[];
}

const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);

/** The path segments Figma puts a file key behind. `board` is FigJam. */
const FILE_SEGMENTS = new Set(['design', 'file', 'proto', 'board', 'slides']);

const FILE_KEY = /^[A-Za-z0-9]{10,64}$/;
const NODE_ID = /^\d+[-:]\d+$/;

/**
 * How many frames one analysis will read.
 *
 * Three breakpoints plus a state or two. The limit is not arbitrary: every
 * frame is an round trip to the Figma application and a share of one context
 * window, so the cost of the eleventh link is paid by the quality of all ten.
 */
export const MAX_DESIGN_LINKS = 6;

/**
 * Anything that could be a Figma file URL, with or without a scheme.
 *
 * A path is required, so `figma.com` mentioned in a sentence does not match.
 * Everything that does match is handed to `readFigmaLink`, which says why it
 * is unusable -- better than silently ignoring a URL the person meant.
 */
const LINK = /(?:https?:\/\/)?(?:[\w-]+\.)*figma\.com\/[^\s<>"'`)\]}]+/gi;

/** Punctuation that ends the sentence rather than the URL. */
const TRAILING = /[.,;:!?]+$/;

/** Every Figma-looking URL in a blob of text, in the order they appear. */
export function findFigmaLinks(text: string): string[] {
  return [...text.matchAll(LINK)].map((match) => match[0].replace(TRAILING, ''));
}

/** Reads one link. The reason, when there is one, says what to do about it. */
export function readFigmaLink(input: string): FigmaLinkReading {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'a Figma link is required' };

  let url: URL;
  try {
    // A pasted link often arrives without its scheme; that is a spelling of the
    // same link rather than a different kind of input.
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: `"${trimmed}" is not a URL` };
  }

  if (!FIGMA_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: `${url.hostname} is not Figma` };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const at = segments.findIndex((segment) => FILE_SEGMENTS.has(segment.toLowerCase()));
  const fileKey = at === -1 ? undefined : segments[at + 1];

  if (!fileKey || !FILE_KEY.test(fileKey)) {
    return {
      ok: false,
      reason: 'that Figma link carries no file key -- copy a link to a frame rather than to a project',
    };
  }

  const raw = url.searchParams.get('node-id') ?? url.searchParams.get('node_id');
  if (!raw) {
    return {
      ok: false,
      reason:
        'that Figma link names no node -- select the block’s frame and copy a link to it, ' +
        'because a whole file is not a block',
    };
  }

  // `new URL` has already decoded `%3A`; the hyphen form has not been touched.
  const nodeId = raw.replace('-', ':');
  if (!NODE_ID.test(nodeId)) return { ok: false, reason: `"${raw}" is not a Figma node id` };

  const reference: DesignReference = { fileKey, nodeId };
  const fileName = segments[at + 2];
  if (fileName) reference.fileName = decodeURIComponent(fileName).replace(/-/g, ' ');
  return { ok: true, reference };
}

/** The position of a link, for a message about one of several. */
function ordinal(at: number): string {
  const names = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
  return names[at] ?? `${at + 1}th`;
}

/**
 * Reads every link in a blob of text.
 *
 * All the links must be to one file. That is not tidiness: a Figma node id is
 * unique within a file and nowhere else, and `nodeIds` is the set every
 * citation in the whole analysis is checked against. Two files could each
 * contain a node `4:19`, and a requirement citing it would then verify against
 * a frame it never came from -- the evidence check would pass while being
 * wrong, which is worse than failing.
 */
export function readFigmaLinks(text: unknown): FigmaLinksReading {
  if (typeof text !== 'string' || !text.trim()) {
    return { references: [], problems: ['at least one Figma link is required'] };
  }

  const found = findFigmaLinks(text);
  if (found.length === 0) {
    return {
      references: [],
      problems: [
        'no Figma link found in that text -- paste a link to a frame. Notes around the link are ' +
          'fine, but there has to be a figma.com URL among them',
      ],
    };
  }

  const references: DesignReference[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  found.forEach((link, at) => {
    const reading = readFigmaLink(link);
    if (!reading.ok) {
      // Name the position only when there is more than one, so the common case
      // reads as a sentence rather than as a report.
      problems.push(found.length === 1 ? reading.reason : `the ${ordinal(at)} link: ${reading.reason}`);
      return;
    }
    // The same link pasted twice is a slip, not a request for two reads.
    const key = `${reading.reference.fileKey}/${reading.reference.nodeId}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reading.reference);
  });

  const files = [...new Set(references.map((reference) => reference.fileKey))];
  if (files.length > 1) {
    problems.push(
      `those links are to ${files.length} different Figma files (${files.join(', ')}) -- ` +
        'one analysis is one block, and a node id only means anything within its own file',
    );
  }

  if (references.length > MAX_DESIGN_LINKS) {
    problems.push(
      `${references.length} links is more than the ${MAX_DESIGN_LINKS} one analysis reads -- ` +
        'every frame is a round trip to Figma and a share of one context window',
    );
  }

  return { references, problems };
}

/** The canonical link for a reference, for a record that has to point back. */
export function figmaLink(reference: DesignReference): string {
  const name = reference.fileName ? encodeURIComponent(reference.fileName.replace(/ /g, '-')) : 'file';
  return `https://www.figma.com/design/${reference.fileKey}/${name}?node-id=${reference.nodeId.replace(':', '-')}`;
}
