import type { ImageEnhanceRequest, ImageEnhanceResponse } from '#shared/generate';

import { missingQuotedLines } from '../../enhance/h3';
import { parseQwen21Rewrite, qwen21RewriteRequest } from '../../enhance/qwen21';
import { armImagePath } from '../../utils/jobs';
import { relay } from '../../utils/relay';
import { RelayError } from '../../utils/supervisor';

/**
 * Rewrite a Qwen-Image 2.1 prompt on a vision-language arm, from the user's
 * note and the references the image will be given.
 *
 * The same arrangement as the video enhancer: synchronous, unrecorded, and the
 * answer goes into the prompt box. The rewriter is found by capability, and it
 * and the image arm each want the card, so the supervisor swaps them.
 */
const REQUIRED_CAPABILITY = 'text.vision';
/** The image arm's own ceiling: ComfyUI's encoder takes image1 through image3. */
const MAX_REFERENCES = 3;
const MAX_TEXT = 20_000;
/** One paragraph in a JSON object. The arm's own enhancer stops at 1024. */
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.4;

function invalid(message: string): never {
  throw createError({ statusCode: 400, statusMessage: 'invalid_request', data: { message } });
}

export default defineEventHandler(async (event): Promise<ImageEnhanceResponse> => {
  const config = useRuntimeConfig(event);
  const body = await readBody<ImageEnhanceRequest>(event);

  const jobId = body?.jobId;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(jobId)) {
    invalid('jobId is required and must be a plain identifier');
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (prompt.length > MAX_TEXT || comment.length > MAX_TEXT) invalid(`prompt and note are each at most ${MAX_TEXT} characters`);

  const referenceIds = Array.isArray(body.referenceIds) ? body.referenceIds : [];
  if (referenceIds.length > MAX_REFERENCES) invalid(`at most ${MAX_REFERENCES} reference images`);
  if (!prompt && !comment && referenceIds.length === 0) {
    invalid('nothing to rewrite -- write a prompt or a note, or choose an image');
  }

  const width = Math.trunc(Number(body.width));
  const height = Math.trunc(Number(body.height));
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

    let request;
    try {
      request = await qwen21RewriteRequest(config.armsDir, {
        prompt,
        comment,
        references: images.length,
        width,
        height,
      });
    } catch {
      throw new RelayError(
        'invalid_request',
        'the Qwen-Image 2.1 rewriter instructions are missing -- is arms/image-qwen21-turbo-comfy installed?',
      );
    }

    const startedAt = performance.now();
    const report = await client.job<{ text?: string; finish_reason?: string }>(armId, {
      jobId,
      params: {},
      job: {
        system: request.system,
        prompt: request.prompt,
        ...(images.length > 0 ? { images } : {}),
        maxTokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      },
    });

    if (report.finish_reason === 'length') {
      throw new RelayError(
        'arm_error',
        `the rewrite ran past ${MAX_TOKENS} tokens and was cut off; the prompt is unchanged -- shorten the note`,
      );
    }
    const rewritten = parseQwen21Rewrite(typeof report.text === 'string' ? report.text : '');
    if (!rewritten) {
      throw new RelayError('arm_error', 'the rewriter answered with nothing usable; the prompt is unchanged');
    }

    return {
      prompt: rewritten,
      armId,
      secondsTotal: Math.round((performance.now() - startedAt) / 100) / 10,
      missingQuotes: missingQuotedLines([prompt, comment], rewritten),
    };
  });
});
