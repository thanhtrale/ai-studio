/**
 * Reading a design, behind one contract.
 *
 * The pipeline reaches a design only through `DesignSource`. One
 * implementation exists -- Figma's Dev Mode MCP server, running locally beside
 * the desktop app -- and a REST adapter using a personal access token would
 * satisfy the same interface without any pass, prompt, route or page changing.
 * That is the point of the interface: the MCP server needs the desktop
 * application open, and the day that becomes intolerable the replacement
 * should be a day's work rather than a rewrite.
 */

import type { DesignToken, NormalisedDesign } from '#shared/analysis';

import type { DigestOptions } from './digest';
import { buildDigest } from './digest';
import { DesignSourceError } from './errors';
import { parseFigmaMetadata, parseVariableDefs } from './figma-metadata';
import type { DesignReference } from './link';
import type { McpSession, OpenSessionOptions } from './mcp';
import { imageOfResult, openFigmaSession, textOfResult } from './mcp';

export interface ReadDesignOptions {
  /**
   * Ask for a rendering of the frame.
   *
   * Off when the selected arm cannot read images: requesting a screenshot no
   * pass can use spends seconds and proves nothing.
   */
  wantRender?: boolean;
  digest?: DigestOptions;
}

export interface DesignRead {
  design: NormalisedDesign;
  /** The rendering, when one was taken. The caller decides where it is filed. */
  render?: { bytes: Buffer; mimeType: string };
  /** Calls that failed without failing the read, for the step's note. */
  degraded: string[];
}

export interface DesignSource {
  readonly name: string;
  read(reference: DesignReference, options?: ReadDesignOptions): Promise<DesignRead>;
}

/** How much of Figma's own code guess to keep. It is evidence, not the structure. */
const MAX_INTERPRETATION_CHARS = 6_000;

export interface FigmaMcpSourceOptions extends OpenSessionOptions {
  /** Test seam: supply a session instead of opening one over HTTP. */
  openSession?: (options: OpenSessionOptions) => Promise<McpSession>;
}

export class FigmaMcpSource implements DesignSource {
  readonly name = 'figma-mcp';

  readonly #options: FigmaMcpSourceOptions;

  constructor(options: FigmaMcpSourceOptions = {}) {
    this.#options = options;
  }

  async read(reference: DesignReference, options: ReadDesignOptions = {}): Promise<DesignRead> {
    const open = this.#options.openSession ?? openFigmaSession;
    const session = await open(this.#options);

    try {
      return await this.#readWith(session, reference, options);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async #readWith(
    session: McpSession,
    reference: DesignReference,
    options: ReadDesignOptions,
  ): Promise<DesignRead> {
    const { nodeId } = reference;
    const degraded: string[] = [];

    // The structure, and the only call that is allowed to fail the read. Its
    // ids are what every requirement is later checked against, so there is no
    // useful analysis without it.
    const metadata = await session.call('get_metadata', { nodeId });
    if (metadata.isError) {
      throw new DesignSourceError(
        'node-unreadable',
        'get_metadata',
        `Figma would not read ${nodeId}: ${textOfResult(metadata) || 'no reason given'} -- ` +
          'the file may not be open in the running session',
      );
    }

    const tree = parseFigmaMetadata(textOfResult(metadata));
    if (!tree) {
      throw new DesignSourceError(
        'node-unreadable',
        'get_metadata',
        `Figma returned no layers for ${nodeId} -- check that the node is in the file that is open`,
      );
    }

    const digest = buildDigest(tree, options.digest);

    const design: NormalisedDesign = {
      adapter: this.name,
      fileKey: reference.fileKey,
      nodeId,
      digest: digest.digest,
      nodeIds: digest.nodeIds,
      tokens: [],
      droppedNodes: digest.droppedNodes,
    };
    if (tree.name) design.name = tree.name;
    if (digest.truncatedAtDepth !== undefined) design.truncatedAtDepth = digest.truncatedAtDepth;

    // Everything below is best effort. A design with a digest and no tokens is
    // worth analysing; failing the whole read because one optional call was
    // refused would throw away the expensive part for the cheap part.
    const tokens = await this.#optional(session, 'get_variable_defs', { nodeId }, degraded);
    if (tokens) {
      design.tokens = parseVariableDefs(textOfResult(tokens)).map(
        (token): DesignToken => ({ name: token.name, value: token.value }),
      );
    }

    const context = await this.#optional(session, 'get_design_context', { nodeId }, degraded);
    if (context) {
      const text = textOfResult(context);
      // Labelled as an interpretation where it is used: it is Figma's own
      // design-to-code guess, in a framework this project does not use, and it
      // carries no ids anything can check.
      if (text) design.interpretation = text.slice(0, MAX_INTERPRETATION_CHARS);
    }

    const read: DesignRead = { design, degraded };

    if (options.wantRender) {
      const shot = await this.#optional(session, 'get_screenshot', { nodeId }, degraded);
      const image = shot ? imageOfResult(shot) : null;
      if (image) read.render = image;
    }

    return read;
  }

  /** A call whose failure is recorded rather than raised. */
  async #optional(
    session: McpSession,
    tool: string,
    args: Record<string, unknown>,
    degraded: string[],
  ): Promise<Awaited<ReturnType<McpSession['call']>> | null> {
    try {
      const result = await session.call(tool, args);
      if (result.isError) {
        degraded.push(`${tool}: ${textOfResult(result) || 'refused'}`);
        return null;
      }
      return result;
    } catch (error) {
      degraded.push(`${tool}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
