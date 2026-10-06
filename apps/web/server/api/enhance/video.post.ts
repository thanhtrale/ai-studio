import type { VideoEnhanceRequest, VideoEnhanceResponse } from '#shared/generate';
import type { VideoMode } from '#shared/library';

import {
  cleanRewrite,
  danglingPictureTags,
  finishRewrite,
  h3RewriteRequest,
  missingQuotedLines,
  missingSections,
} from '../../enhance/h3';
import { armImagePath } from '../../utils/jobs';
import { relay } from '../../utils/relay';
import { RelayError } from '../../utils/supervisor';

/**
 * Rewrite a MiniMax-H3 prompt on a vision-language arm, from the user's note
 * and the images the clip will be given.
 *
 * Synchronous and unrecorded: what comes back goes into the prompt box, where
 * the user reads and edits it before anything is sampled. Nothing is filed --
 * the clip that is eventually generated keeps the prompt it was actually given.
 *
 * The rewriter is found by capability rather than by id, the same way the
 * analysis finds its text arm. Both it and H3 want the card exclusively, so the
 * supervisor swaps one out for the other: the first enhance after a clip waits
 * for the rewriter to load, and the first clip after an enhance waits for H3.
 */
const REQUIRED_CAPABILITY = 'text.vision';
const MAX_REFERENCES: Record<VideoMode, number> = { fl2v: 2, ref2v: 9 };
const MAX_TEXT = 20_000;
/**
 * A ref2v rewrite is six sections with a 350-500 word description -- about a
 * thousand tokens -- and an fl2v one is less. Room to spare either way.
 */
const MAX_TOKENS = 3072;
const TEMPERATURE = 0.4;

function invalid(message: string): never {
  throw createError({ statusCode: 400, statusMessage: 'invalid_request', data: { message } });
}

export default defineEventHandler(async (event): Promise<VideoEnhanceResponse> => {
  const body = await readBody<VideoEnhanceRequest>(event);

  const jobId = body?.jobId;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(jobId)) {
    invalid('jobId is required and must be a plain identifier');
  }

  const mode = body.mode;
  if (mode !== 'fl2v' && mode !== 'ref2v') invalid('mode must be fl2v or ref2v');

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (prompt.length > MAX_TEXT || comment.length > MAX_TEXT) invalid(`prompt and note are each at most ${MAX_TEXT} characters`);

  const referenceIds = Array.isArray(body.referenceIds) ? body.referenceIds : [];
  if (referenceIds.length > MAX_REFERENCES[mode]) {
    invalid(`at most ${MAX_REFERENCES[mode]} images in ${mode}`);
  }
  if (!prompt && !comment && referenceIds.length === 0) {
    invalid('nothing to rewrite -- write a prompt or a note, or choose an image');
  }

  const seconds = Number(body.seconds);
  const width = Math.trunc(Number(body.width));
  const height = Math.trunc(Number(body.height));
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) invalid('seconds must be between 0 and 60');
  if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192)) invalid('width and height must be positive');

  return relay(async () => {
    const images = referenceIds.map((id) => armImagePath(id));
    const client = supervisorClient(event);

    const { arms } = await client.inventory();
    const candidates = arms.filter((arm) => arm.capabilities.includes(REQUIRED_CAPABILITY));
    if (candidates.length === 0) {
      throw new RelayError(
        'invalid_request',
        `no discovered arm declares ${REQUIRED_CAPABILITY} -- install text-qwen3vl-8b-llamacpp to use the enhancer`,
      );
    }
    const armId = typeof body.armId === 'string' && body.armId ? body.armId : candidates[0]!.id;
    if (!candidates.some((arm) => arm.id === armId)) {
      throw new RelayError('invalid_request', `"${armId}" is not an arm that declares ${REQUIRED_CAPABILITY}`);
    }

    const request = h3RewriteRequest({
      mode,
      prompt,
      comment,
      references: images.length,
      seconds,
      width,
      height,
    });

    const startedAt = performance.now();
    const report = await client.job<{ text?: string; finish_reason?: string }>(armId, {
      jobId,
      params: {},
      job: {
        system: request.system,
        prompt: request.prompt,
        ...(images.length > 0 ? { images } : {}),
        maxTokens: MAX_TOKENS,
        // Lower than the model card's 0.7: this is rule-following, not
        // invention, and an 8B model at 0.7 drops rules from run to run.
        temperature: TEMPERATURE,
      },
    });

    const cleaned = cleanRewrite(typeof report.text === 'string' ? report.text : '');
    if (!cleaned) {
      throw new RelayError('arm_error', 'the rewriter answered with nothing usable; the prompt is unchanged');
    }
    if (report.finish_reason === 'length') {
      throw new RelayError(
        'arm_error',
        `the rewrite ran past ${MAX_TOKENS} tokens and was cut off; the prompt is unchanged -- shorten the note`,
      );
    }

    // The fl2v alignment line is fixed text, computed rather than written by
    // the model; see `alignmentLine`.
    const rewritten = finishRewrite({ mode, references: images.length, seconds }, cleaned);

    return {
      prompt: rewritten,
      armId,
      secondsTotal: Math.round((performance.now() - startedAt) / 100) / 10,
      // Both modes cite <Picture N>: ref2v in its subject definitions, fl2v in
      // the keyframe it starts or ends on.
      danglingTags: danglingPictureTags(rewritten, images.length),
      missingQuotes: missingQuotedLines([prompt, comment], rewritten),
      missingSections: missingSections(mode, rewritten),
    };
  });
});
