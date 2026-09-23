import type { NormalisedTicket } from '#shared/analysis';

import { importTicket } from '../../analysis/ticket/import';
import { relay } from '../../utils/relay';

export interface TicketImportResponse {
  ticket: NormalisedTicket;
  /** What the file turned out to be, so the console can say so. */
  detail: string;
}

/**
 * Reads a ticket, and nothing else.
 *
 * Separate from submitting an analysis on purpose: the console shows what it
 * understood -- the key, the passages it found, whether comments came with it
 * -- before anything expensive starts. Getting the wrong export is the most
 * likely mistake, and finding out after four model passes is the worst time.
 *
 * Accepts a multipart upload or a JSON body carrying pasted text. Neither path
 * needs a credential, which is the whole reason this is an import rather than
 * an API call.
 */
export default defineEventHandler(async (event): Promise<TicketImportResponse> => {
  const type = getRequestHeader(event, 'content-type') ?? '';

  if (type.includes('multipart/form-data')) {
    const parts = (await readMultipartFormData(event)) ?? [];
    const file = parts.find((part) => part.name === 'file' && part.filename !== undefined);
    const pasted = parts.find((part) => part.name === 'text');

    return relay(() =>
      importTicket({
        ...(file ? { bytes: file.data } : {}),
        ...(pasted ? { text: pasted.data.toString('utf8') } : {}),
      }),
    );
  }

  const body = await readBody<{ text?: string }>(event);
  return relay(() => importTicket({ text: typeof body?.text === 'string' ? body.text : '' }));
});
