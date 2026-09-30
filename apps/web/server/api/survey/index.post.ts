import type { SurveyOptions, SurveyRequest } from '#shared/survey';
import { DEFAULT_SURVEY_OPTIONS, readSurveyRoots } from '#shared/survey';

import type { ArmCaller } from '../../analysis/pipeline/runner';
import { createSurveyRun, forgetSurveyRun } from '../../survey/run';
import { isSurveyId } from '../../survey/store';
import { runSurvey } from '../../survey/survey';
import { relay, supervisorClient } from '../../utils/relay';
import { RelayError } from '../../utils/supervisor';

/** The capability an arm must declare to describe anything. */
const REQUIRED_CAPABILITY = 'text.generate';

/** Renders are minutes; these are ceilings, not recommendations. */
const MAX_SHOTS = 300;
const MAX_COMPONENT_SHOTS = 400;
const MAX_SCREEN_SUMMARIES = 60;
const MAX_SECTION_SUMMARIES = 120;

function clamp(value: unknown, fallback: number, limit: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(0, Math.round(number)), limit);
}

function optionsFrom(given: Partial<SurveyOptions> | undefined): SurveyOptions {
  return {
    screenshots: given?.screenshots ?? DEFAULT_SURVEY_OPTIONS.screenshots,
    componentShots: given?.componentShots ?? DEFAULT_SURVEY_OPTIONS.componentShots,
    maxShots: clamp(given?.maxShots, DEFAULT_SURVEY_OPTIONS.maxShots, MAX_SHOTS),
    maxComponentShots: clamp(
      given?.maxComponentShots,
      DEFAULT_SURVEY_OPTIONS.maxComponentShots,
      MAX_COMPONENT_SHOTS,
    ),
    resolveComponents: given?.resolveComponents ?? DEFAULT_SURVEY_OPTIONS.resolveComponents,
    describe: given?.describe ?? DEFAULT_SURVEY_OPTIONS.describe,
    maxScreenSummaries: clamp(
      given?.maxScreenSummaries,
      DEFAULT_SURVEY_OPTIONS.maxScreenSummaries,
      MAX_SCREEN_SUMMARIES,
    ),
    maxSectionSummaries: clamp(
      given?.maxSectionSummaries,
      DEFAULT_SURVEY_OPTIONS.maxSectionSummaries,
      MAX_SECTION_SUMMARIES,
    ),
  };
}

/**
 * Starts a survey.
 *
 * Unlike the block analysis this answers immediately rather than when the run
 * finishes. A survey is a crawl of a whole file plus as many renders as the
 * budget allows, and that is long enough that holding a request open for it
 * would be at the mercy of every proxy and browser timeout between here and the
 * page. The run continues on the server; the console follows it at
 * `/api/survey/<id>` and reads the index out of `/api/survey/<id>/result` as it
 * fills in.
 *
 * Everything that can be refused cheaply is refused before the run starts: the
 * id, the links, and whether there is an arm at all when descriptions were
 * asked for. Discovering at the grouping step that nothing declares
 * `text.generate` would be a failure after the expensive part.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const body = await readBody<SurveyRequest>(event);

  const surveyId = body?.surveyId;
  if (!isSurveyId(surveyId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'surveyId is required and must be a plain identifier of 8 to 48 characters' },
    });
  }

  return relay(async () => {
    const reading = readSurveyRoots(body?.links);
    if (reading.problems.length > 0 || reading.roots.length === 0) {
      throw new RelayError(
        'invalid_request',
        reading.problems.join(' ') || 'no Figma link was found in that text',
      );
    }

    const options = optionsFrom(body?.options);
    const client = supervisorClient(event);

    let armId = 'none';
    if (options.describe) {
      const inventory = await client.inventory();
      const candidates = inventory.arms.filter((arm) => arm.capabilities.includes(REQUIRED_CAPABILITY));
      if (candidates.length === 0) {
        throw new RelayError(
          'invalid_request',
          `no discovered arm declares ${REQUIRED_CAPABILITY} -- turn descriptions off to crawl the ` +
            'file without a model, or start an arm that can answer a chat',
        );
      }

      const wanted = typeof body?.armId === 'string' && body.armId ? body.armId : candidates[0]?.id;
      const arm = candidates.find((entry) => entry.id === wanted);
      if (!arm) {
        throw new RelayError('invalid_request', `"${wanted}" is not an arm that declares ${REQUIRED_CAPABILITY}`);
      }
      armId = arm.id;
    }

    const caller: ArmCaller = {
      job: (id, request) => client.job(id, request),
      progress: async (jobId) => (await client.progress(jobId)).job,
    };

    const run = createSurveyRun(surveyId, armId);
    const title =
      (typeof body?.title === 'string' && body.title.trim()) ||
      reading.roots.find((root) => root.fileName)?.fileName ||
      reading.roots[0]?.fileKey ||
      'Figma file';

    // Deliberately not awaited. The response is the id; the run reports itself.
    void runSurvey({
      storageDir: config.storageDir,
      surveyId,
      title,
      links: String(body?.links ?? ''),
      roots: reading.roots,
      armId,
      armParams: body?.armParams ?? {},
      options,
      caller,
      run,
      ...(config.figmaToken ? { figmaToken: config.figmaToken } : {}),
    })
      .catch(() => undefined)
      .finally(() => {
        // Keep the run readable for a while after it ends, so a console that
        // was polling sees the final state rather than falling back to the
        // record it wrote.
        setTimeout(() => forgetSurveyRun(surveyId), 120_000).unref?.();
      });

    setResponseStatus(event, 202);
    return { surveyId, title, armId, options, roots: reading.roots };
  });
});
