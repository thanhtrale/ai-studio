/**
 * One model pass: ask, parse, validate, and repair once.
 *
 * The arm is a text endpoint. It receives messages and returns text; it has no
 * idea what an analysis is, which schema this pass wants, or what a gap means.
 * Everything that makes a pass a pass lives here.
 *
 * Each pass is a real supervisor job named `<analysisId>-p<n>`, which is what
 * lets the arm's own timeline be grafted under the pass's step, and what makes
 * the broker reuse the loaded arm at no cost after the first.
 *
 * ## Why validate and repair rather than constrain
 *
 * llama.cpp can force a grammar, which would make malformed JSON impossible.
 * Exposing that means putting a grammar field on the arm's job contract -- a
 * fragment of this feature's schema inside an arm, which is the one thing the
 * design rules out. A repair turn costs seconds on the rare failure; the
 * coupling would cost the arm-agnosticism that lets one model be swapped for
 * another. If small models turn out to fail often, the honest fix is a
 * `responseFormat: json` flag, which is a property of any text arm rather than
 * a schema belonging to this feature.
 */

import type { JobProgress } from '@ai-studio/arm-contract';

import type { AnalysisRun } from '../registry';

export interface ArmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** What the arm is asked. Sampling is the pass's, not the arm's default. */
export interface PassRequest {
  system: string;
  messages: ArmMessage[];
  maxTokens: number;
  /**
   * Thinking is off for every pass.
   *
   * These are extraction and reconciliation tasks against material that is
   * already in the prompt, and a thought block is most of a thinking job's wall
   * time. The reasoning that matters here is the four-pass structure, not the
   * model's private deliberation.
   */
  thinking?: boolean;
  temperature?: number;
}

/** The arm's reply, as the text arm reports it. */
export interface ArmTextReport {
  text: string;
  reasoning?: string | null;
  finish_reason?: string;
  tokens_prompt?: number;
  tokens_generated?: number;
  seconds_total?: number;
  generate_tokens_per_second?: number;
}

/** What the runner needs from the supervisor, and nothing more. */
export interface ArmCaller {
  job(armId: string, request: { jobId: string; params?: Record<string, unknown>; job: unknown }): Promise<ArmTextReport>;
  progress(jobId: string): Promise<JobProgress>;
}

export class PassError extends Error {
  readonly pass: string;
  /** What the model actually said, kept so a failure can be read rather than guessed at. */
  readonly raw: string;

  constructor(pass: string, message: string, raw: string) {
    super(message);
    this.name = 'PassError';
    this.pass = pass;
    this.raw = raw;
  }
}

/**
 * Pulls the JSON out of a reply.
 *
 * A model asked for JSON commonly wraps it in a fence, prefixes it with a
 * sentence, or does both. Rejecting that would be pedantry: the document is
 * right there. What is *not* done is guessing at malformed JSON -- that goes to
 * the repair turn, where the model is told exactly what the parser complained
 * about.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new SyntaxError('the model returned nothing');

  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  // The outermost braces or brackets, for a reply that opened with a sentence.
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const first = trimmed.indexOf(open);
    const last = trimmed.lastIndexOf(close);
    if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  }

  let failure: SyntaxError | undefined;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      failure ??= error as SyntaxError;
    }
  }

  throw failure ?? new SyntaxError('no JSON in the reply');
}

export interface PassDefinition<T> {
  /** Stable, and the suffix of this pass's supervisor job id: `p1`, `p2`, … */
  id: string;
  /** The step on the analysis timeline this pass advances. */
  step: string;
  request: PassRequest;
  /**
   * Turns parsed JSON into the pass's own type, or throws with a message the
   * repair turn can quote back at the model.
   */
  validate(value: unknown): T;
}

export interface RunPassOptions {
  armId: string;
  armParams?: Record<string, unknown>;
  analysisId: string;
  caller: ArmCaller;
  run?: AnalysisRun;
  /** Poll the arm's own progress while the pass runs, to nest it under the step. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 700;

function messagesFor(request: PassRequest): Record<string, unknown> {
  return {
    system: request.system,
    messages: request.messages,
    maxTokens: request.maxTokens,
    thinking: request.thinking ?? false,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
}

export interface PassResult<T> {
  value: T;
  raw: string;
  report: ArmTextReport;
  /** True when the first reply did not validate and a repair turn was needed. */
  repaired: boolean;
}

/**
 * Runs one pass, with a single repair turn.
 *
 * One, not several: a model that cannot produce the shape after being shown
 * its own output and the validator's complaint is not going to on the third
 * attempt, and an analysis that silently costs four extra minutes is worse
 * than one that fails with the reply on disk.
 */
export async function runPass<T>(
  definition: PassDefinition<T>,
  options: RunPassOptions,
): Promise<PassResult<T>> {
  const { armId, analysisId, caller, run } = options;

  const ask = async (messages: ArmMessage[], attempt: number): Promise<{ raw: string; report: ArmTextReport }> => {
    const jobId = attempt === 0 ? `${analysisId}-${definition.id}` : `${analysisId}-${definition.id}r`;

    const watch = run
      ? setInterval(() => {
          void caller
            .progress(jobId)
            .then((progress) => run.graft(definition.step, progress))
            .catch(() => undefined);
        }, options.pollMs ?? DEFAULT_POLL_MS)
      : undefined;

    try {
      const report = await caller.job(armId, {
        jobId,
        params: options.armParams ?? {},
        job: { ...messagesFor(definition.request), messages },
      });
      return { raw: report.text ?? '', report };
    } finally {
      if (watch) clearInterval(watch);
    }
  };

  const first = await ask(definition.request.messages, 0);

  try {
    return {
      value: definition.validate(extractJson(first.raw)),
      raw: first.raw,
      report: first.report,
      repaired: false,
    };
  } catch (error) {
    /**
     * A reply cut off at the token cap is not malformed JSON, and telling the
     * model to "only fix the shape" guarantees it truncates again at exactly
     * the same place. The child reports the difference, so the repair turn
     * asks for the right thing: the same content, said shorter.
     *
     * Found by running a real ticket through pass 2, which produced 14 467
     * characters of perfectly good claims and stopped mid-object.
     */
    const truncated = first.report.finish_reason === 'length';

    const complaint = truncated
      ? `your reply was cut off at the ${definition.request.maxTokens}-token limit, ` +
        'part-way through an object, so it could not be parsed'
      : error instanceof Error
        ? error.message
        : String(error);

    // Show the model its own reply and the exact complaint. Restating the
    // instruction instead would be asking it to guess what went wrong.
    const repairMessages: ArmMessage[] = [
      ...definition.request.messages,
      { role: 'assistant', content: first.raw },
      {
        role: 'user',
        content: truncated
          ? `That reply could not be used: ${complaint}\n\n` +
            'Answer again, complete this time. Keep every entry -- do not merge or drop any of ' +
            'them -- but write each statement in one short sentence, and omit any field that is ' +
            'empty. The JSON document only: no prose, no code fence, no commentary.'
          : `That reply could not be used: ${complaint}\n\n` +
            'Answer again with the JSON document only -- no prose, no code fence, ' +
            'no trailing commentary. Keep every value you already worked out; only fix the shape.',
      },
    ];

    const second = await ask(repairMessages, 1);

    try {
      return {
        value: definition.validate(extractJson(second.raw)),
        raw: second.raw,
        report: second.report,
        repaired: true,
      };
    } catch (again) {
      const stillTruncated = second.report.finish_reason === 'length';
      throw new PassError(
        definition.id,
        stillTruncated
          ? `${definition.id} was cut off at its ${definition.request.maxTokens}-token limit twice. ` +
            'The material is larger than this pass allows for; raise the pass’s maxTokens.'
          : `${definition.id} did not return usable JSON after a repair turn: ` +
            `${again instanceof Error ? again.message : String(again)}`,
        second.raw,
      );
    }
  }
}
