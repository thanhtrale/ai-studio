/**
 * Getting pictures out of Figma, by whichever route works.
 *
 * There are two, and they fail in opposite circumstances, which is why both are
 * here rather than one.
 *
 * **The REST endpoint.** `GET /v1/images/:key?ids=…` renders up to several
 * dozen nodes in one request and answers with URLs. It needs a personal access
 * token and it does not need the desktop application at all -- so it works on a
 * file nobody has open, and it is roughly two orders of magnitude faster than
 * asking for three hundred renders one at a time. When a token is configured
 * this is the route.
 *
 * **The local MCP server.** `get_screenshot`, one node per call. No token, but
 * the file has to be open in the running Figma session. It is the fallback, and
 * the only route when no token is set.
 *
 * The reason this file exists at all is a bug worth naming: `get_screenshot`
 * used to answer with base64 and now usually answers with a link into Figma's
 * own asset server, and the reader only understood base64. Every render came
 * back empty and every component was shown as a name with no picture. Both
 * shapes are handled now -- and since a link has to be fetched over HTTP
 * anyway, fetching a REST URL is the same code.
 */

import { imageOfResult, imageUrlOfResult } from '../analysis/design/mcp';
import type { McpSession } from '../analysis/design/mcp';

export interface Shot {
  bytes: Buffer;
  mimeType: string;
}

/** A render at twice the drawn size, which is what a screenshot is read at. */
const SCALE = 2;

/**
 * Node ids per REST request.
 *
 * Figma renders every id in a request before answering any of them, so a large
 * batch is a long wait with no progress to report. Thirty is a compromise
 * between the round trips and the granularity of the meter.
 */
const REST_BATCH = 30;

/** A render that takes longer than this is one the run is better off without. */
const RENDER_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 60_000;

/** No single frame is worth this much memory. */
const MAX_BYTES = 24 * 1024 * 1024;

export interface ShotSource {
  readonly name: string;
  /** Renders what it can. A node absent from the result simply did not render. */
  shots(nodeIds: string[]): Promise<Map<string, Shot>>;
}

/** Fetches an image URL, whether it is Figma's CDN or the local asset server. */
async function fetchImage(url: string): Promise<Shot | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;

  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_BYTES) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;

  return { bytes, mimeType: response.headers.get('content-type') ?? 'image/png' };
}

interface ImagesAnswer {
  err?: string | null;
  images?: Record<string, string | null>;
}

/**
 * Figma's own render endpoint.
 *
 * The token is a personal access token with `file_content:read`; it is read
 * from the environment and never leaves the server. The batch is rendered by
 * Figma and then each URL is fetched here, because the URLs are short-lived and
 * what the survey stores is the bytes.
 */
export class FigmaRestShots implements ShotSource {
  readonly name = 'figma-rest';

  readonly #fileKey: string;
  readonly #token: string;

  constructor(fileKey: string, token: string) {
    this.#fileKey = fileKey;
    this.#token = token;
  }

  async shots(nodeIds: string[]): Promise<Map<string, Shot>> {
    const found = new Map<string, Shot>();

    for (let at = 0; at < nodeIds.length; at += REST_BATCH) {
      const batch = nodeIds.slice(at, at + REST_BATCH);
      const url =
        `https://api.figma.com/v1/images/${encodeURIComponent(this.#fileKey)}` +
        `?ids=${encodeURIComponent(batch.join(','))}&format=png&scale=${SCALE}`;

      const response = await fetch(url, {
        headers: { 'X-Figma-Token': this.#token },
        signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
      });

      if (!response.ok) {
        // 403 is the token; 404 is the file. Both are worth saying out loud,
        // and both are fatal for this source rather than for this batch.
        throw new Error(
          `Figma's image endpoint answered ${response.status} -- ` +
            (response.status === 403
              ? 'the personal access token is missing, expired, or has no access to this file'
              : response.status === 404
                ? 'no file with that key'
                : await response.text().then((text) => text.slice(0, 200)).catch(() => 'no detail')),
        );
      }

      const answer = (await response.json()) as ImagesAnswer;
      if (answer.err) throw new Error(`Figma's image endpoint refused: ${answer.err}`);

      // Fetched in parallel: these are CDN reads, not renders, and Figma has
      // already done the slow part by the time the URLs exist.
      const entries = Object.entries(answer.images ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      );

      const fetched = await Promise.all(
        entries.map(async ([nodeId, href]) => {
          try {
            return [nodeId, await fetchImage(href)] as const;
          } catch {
            return [nodeId, null] as const;
          }
        }),
      );

      for (const [nodeId, shot] of fetched) if (shot) found.set(nodeId, shot);
    }

    return found;
  }
}

/** The local Dev Mode server, one node at a time. */
export class FigmaMcpShots implements ShotSource {
  readonly name = 'figma-mcp';

  readonly #session: McpSession;

  constructor(session: McpSession) {
    this.#session = session;
  }

  async shots(nodeIds: string[]): Promise<Map<string, Shot>> {
    const found = new Map<string, Shot>();

    for (const nodeId of nodeIds) {
      const shot = await this.one(nodeId);
      if (shot) found.set(nodeId, shot);
    }

    return found;
  }

  /** One render, by whichever of the two shapes the server chose to answer in. */
  async one(nodeId: string): Promise<Shot | null> {
    try {
      const result = await this.#session.call('get_screenshot', { nodeId });
      if (result.isError) return null;

      const inline = imageOfResult(result);
      if (inline) return inline;

      // The common case on current builds: a link into the local asset server.
      const url = imageUrlOfResult(result);
      return url ? await fetchImage(url) : null;
    } catch {
      return null;
    }
  }
}
