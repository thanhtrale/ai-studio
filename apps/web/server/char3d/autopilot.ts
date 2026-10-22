/**
 * The autopilot: one character from its reference to a rig, with a local
 * vision model in the place of the person.
 *
 * ```
 * describe  the vision model reads the reference -> subject, traits, what to simplify for 3D
 * ref       a sheet run -> split cross-check -> the vision model reviews it   (retry with its fix, up to refTries)
 * mesh      a mesh run from the passing sheet -> reviewed                     (a new random seed each, up to meshTries;
 *           a snout-like face is retried once as a re-texture with faceFix)
 * rig       a rig run of the passing mesh -> its numbers + the vision model   (a failed rig spends a mesh try)
 * ```
 *
 * The runs are ordinary runs on the ordinary queue, and the reviews ordinary
 * reviews (`by: "local:<arm>"`), so a pass lands in the step's gallery and
 * the page shows every attempt exactly as it shows a hand-made one. The
 * rubric and the arithmetic are in `autoPrompts.ts`.
 *
 * State lives in `<character>/auto.json`, apart from character.json, which
 * the reviews also write. One autopilot per character, in this process; one
 * left `running` by a server that stopped reads back as `interrupted`.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createError } from 'h3';

import {
  CHAR3D_AUTO_DEFAULTS,
  SHEET_VIEWS,
  type Char3dAuto,
  type Char3dAutoEvent,
  type Char3dAutoOptions,
  type Char3dAutoStage,
  type Char3dCharacter,
  type Char3dCriterion,
  type Char3dRun,
  type Char3dSheetSet,
  type Char3dStep,
} from '#shared/char3d';

import {
  ARMS_QUESTION,
  capFaults,
  dropHeld,
  DESCRIBE_SYSTEM,
  isRigFault,
  describePrompt,
  MESH_CRITERIA,
  meshReviewPrompt,
  parseDescription,
  parseJsonAnswer,
  REF_CRITERIA,
  refReviewPrompt,
  RIG_CRITERIA,
  RIG_FAULTS,
  rigMeasured,
  rigReviewPrompt,
  rewriteTraits,
  score,
  type Criterion,
  type RigFault,
} from './autoPrompts';
import { BODY_PROFILES, profileOf } from './profiles';
import { type Char3dCaller, createRun, TOOLS_ARM } from './runner';
import { collectOut, outRel, stageIn } from './staging';
import { charDir, charFile, getCharacter, getRun, listRuns, patchCharacter, patchRun, saveCharacter, saveRun } from './store';

const autoFile = (storageDir: string, id: string): string => path.join(charDir(storageDir, id), 'auto.json');
const live = new Set<string>();

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: 'conflict', data: { message } });
}

export async function readAuto(storageDir: string, id: string): Promise<Char3dAuto | undefined> {
  const file = autoFile(storageDir, id);
  if (!existsSync(file)) return undefined;
  try {
    const auto = JSON.parse(await readFile(file, 'utf8')) as Char3dAuto;
    if (auto.status === 'running' && !live.has(id)) auto.status = 'interrupted';
    return auto;
  } catch {
    return undefined;
  }
}

const writeAuto = (storageDir: string, id: string, auto: Char3dAuto): Promise<void> =>
  writeFile(autoFile(storageDir, id), JSON.stringify(auto, null, 1), 'utf8');

export function optionsOf(raw: Record<string, unknown> = {}): Char3dAutoOptions {
  const int = (value: unknown, low: number, high: number, fallback: number): number => {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && value !== undefined && value !== null && value !== '' ? Math.max(low, Math.min(high, number)) : fallback;
  };
  const stopAfter = raw['stopAfter'];
  return {
    chibi: raw['chibi'] === undefined ? CHAR3D_AUTO_DEFAULTS.chibi : raw['chibi'] === true || raw['chibi'] === 'true',
    passScore: int(raw['passScore'], 40, 100, CHAR3D_AUTO_DEFAULTS.passScore),
    refTries: int(raw['refTries'], 1, 12, CHAR3D_AUTO_DEFAULTS.refTries),
    meshTries: int(raw['meshTries'], 1, 20, CHAR3D_AUTO_DEFAULTS.meshTries),
    reviewer: typeof raw['reviewer'] === 'string' && raw['reviewer'] ? raw['reviewer'] : CHAR3D_AUTO_DEFAULTS.reviewer,
    ...(stopAfter === 'ref' || stopAfter === 'mesh' ? { stopAfter } : {}),
  };
}

export async function stopAuto(storageDir: string, id: string): Promise<Char3dAuto | undefined> {
  const auto = await readAuto(storageDir, id);
  if (!auto || !live.has(id)) return auto;
  auto.stopRequested = true;
  await writeAuto(storageDir, id, auto);
  return auto;
}

/** Start the autopilot; answers at once with its state, the work carries on. */
export async function startAuto(
  storageDir: string,
  caller: Char3dCaller,
  id: string,
  raw: Record<string, unknown> = {},
): Promise<Char3dAuto> {
  await getCharacter(storageDir, id);
  if (live.has(id)) conflict('the autopilot is already running on this character');
  const auto: Char3dAuto = { status: 'running', options: optionsOf(raw), startedAt: Date.now(), events: [] };
  live.add(id);
  await writeAuto(storageDir, id, auto);
  void drive(storageDir, caller, id, auto).finally(() => live.delete(id));
  return auto;
}

// --- the vision model --------------------------------------------------------------

interface VisionReport {
  text?: string;
  finish_reason?: string;
}

/** One question to the vision arm; images are files of the character. Retried once on an unreadable answer. */
async function ask(
  storageDir: string,
  caller: Char3dCaller,
  id: string,
  reviewer: string,
  request: { system: string; prompt: string; images: string[] },
): Promise<Record<string, unknown>> {
  const images = await Promise.all(request.images.map((file) => stageIn(storageDir, id, file)));
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const report = await caller.job<VisionReport>(reviewer, {
      jobId: `c3a-${id.slice(0, 20)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      params: {},
      job: { system: request.system, prompt: request.prompt, images, maxTokens: 2048, temperature: 0 },
    });
    try {
      return parseJsonAnswer(report.text ?? '');
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

// --- reviewing one run -------------------------------------------------------------

export interface LocalReview {
  review: Record<string, unknown>;
  /** The reviewer's own extras: `fix` for a sheet, `snout` for a mesh. */
  answer: Record<string, unknown>;
}

const firstSet = (run: Char3dRun): Char3dSheetSet | undefined => ((run.outputs?.['sets'] ?? []) as Char3dSheetSet[])[0];

function reviewOf(
  reviewer: string,
  criteria: Criterion[],
  answer: Record<string, unknown>,
  passScore: number,
  measured: Char3dCriterion[] = [],
): Record<string, unknown> {
  const scored = score(criteria, answer, passScore, measured);
  const issues = Array.isArray(answer['issues']) ? answer['issues'].map(String).filter(Boolean) : [];
  const weakest = scored.criteria.slice().sort((a, b) => a.score - b.score)[0];
  return {
    by: `local:${reviewer}`,
    score: scored.score,
    verdict: scored.verdict,
    criteria: scored.criteria,
    summary:
      scored.verdict === 'pass'
        ? `Passed at ${scored.score}; weakest: ${weakest?.label} ${weakest?.score}/10.`
        : scored.score < passScore
          ? `${scored.score} < ${passScore}${scored.below.length ? `; under the floor: ${scored.below.join(', ')}` : ''}.`
          : `${scored.score}, but under the floor: ${scored.below.join(', ')}.`,
    issues,
    improve: typeof answer['fix'] === 'string' && answer['fix'] ? [answer['fix']] : [],
  };
}

/** Review a finished run with the vision model and write the review on it. */
export async function reviewRun(
  storageDir: string,
  caller: Char3dCaller,
  id: string,
  runId: string,
  options: Pick<Char3dAutoOptions, 'reviewer' | 'passScore' | 'chibi'>,
  /** false: answer only, leave the run's own review as it is (for comparing reviewers). */
  save = true,
): Promise<LocalReview> {
  const run = await getRun(storageDir, id, runId);
  if (run.status !== 'done') throw new Error(`${runId} is ${run.status}, not done`);
  const character = await getCharacter(storageDir, id);
  const file = (rel: string): string => charFile(storageDir, id, rel);
  let review: Record<string, unknown>;
  let answer: Record<string, unknown> = {};

  if (run.step === 'ref') {
    const set = firstSet(run);
    // Only a sheet that did not cut into three figures is refused unasked. The
    // front/back width check is a score, not a gate: a cape that flares in front
    // and hangs straight behind is 9-21 % wider in front on a good sheet
    // (honeyview-arthur-1 r03-r05); the model looks at the pose itself.
    if (!set?.views || set.check?.segments !== 3) {
      review = {
        by: `local:${options.reviewer}`,
        score: 0,
        verdict: 'retry',
        criteria: [{ key: 'views', label: 'Three views', score: 0, note: `split: ${set?.check?.segments ?? 0} figures, width ${set?.check?.widthDiff ?? '—'}, height ${set?.check?.heightDiff ?? '—'}` }],
        summary: 'The sheet did not split into three matching figures.',
        issues: ['split / cross-check failed'],
        improve: [],
      };
    } else {
      const prompt = refReviewPrompt(options.chibi, character.autoLessons ?? []);
      answer = await ask(storageDir, caller, id, options.reviewer, {
        ...prompt,
        images: [file(character.ref), ...SHEET_VIEWS.map((view) => file(String(set.views?.[view])))],
      });
      // A sheet split before the pose was measured is cut again on the tools arm (half a second).
      if (!set.check.pose || set.check.pose.front?.gapRows === undefined) {
        const report = await caller.job<{ result: { sets?: Char3dSheetSet[] } }>(TOOLS_ARM, {
          jobId: `c3a-${id.slice(0, 20)}-${runId}-pose-${Math.random().toString(36).slice(2, 6)}`,
          params: {},
          job: { task: 'split', sheets: [await stageIn(storageDir, id, file(set.sheet))], outDir: outRel(id, runId, 'pose-check') },
        });
        await collectOut(storageDir, id, runId);
        set.check.pose = report.result.sets?.[0]?.check.pose;
        await saveRun(storageDir, id, run);
      }
      const pose = poseCriteria(set.check.pose, profileOf({ chibi: options.chibi }).handBand);
      review = reviewOf(options.reviewer, REF_CRITERIA(options.chibi), answer, options.passScore, [
        { key: 'split', label: 'Cross-check (measured)', score: splitScore(set.check), note: `width ${(Number(set.check.widthDiff) * 100).toFixed(1)}%, height ${(Number(set.check.heightDiff) * 100).toFixed(1)}%` },
        ...pose.criteria,
      ]);
      // The measured pose writes its own sentence for the next sheet, ahead of the model's.
      if (pose.fix) {
        answer['fix'] = [pose.fix, typeof answer['fix'] === 'string' ? answer['fix'] : ''].filter(Boolean).join(' ');
        review['improve'] = [answer['fix']];
      }
      review['picks'] = set.views;
    }
  } else if (run.step === 'mesh') {
    const files = (run.outputs?.['renders']?.files ?? {}) as Record<string, unknown>;
    const parent = run.parent ? await getRun(storageDir, id, run.parent).catch(() => undefined) : undefined;
    const sheet = parent?.step === 'ref' ? firstSet(parent)?.sheet : parent?.step === 'mesh' ? await sheetOfMesh(storageDir, id, parent) : undefined;
    const images = [sheet, files['sheet_tex'], files['sheet_clay'], files['face_front'], files['sheet_detail']].map((rel) =>
      typeof rel === 'string' ? rel : '',
    );
    if (images.some((rel) => !rel)) throw new Error(`${runId} lacks the sheet or its check renders`);
    answer = await ask(storageDir, caller, id, options.reviewer, {
      ...meshReviewPrompt(character.autoLessons ?? []),
      images: images.map(file),
    });
    // On the whole sheets the 8B model misses a fist gripping a cape edge (r07,
    // r09: "no" twice); on the arm close-ups alone, one question, it sees it.
    const sleeves = ((files['detail'] ?? []) as string[]).filter((rel) => /detail_sleeve_/.test(rel));
    if (sleeves.length) {
      // The close-ups decide this one fault both ways: on the whole sheets the
      // model said no to Arthur's gripped cape and yes to the girl's free fists (r45).
      const arms = await ask(storageDir, caller, id, options.reviewer, { ...ARMS_QUESTION, images: sleeves.map(file) });
      answer['faults'] = { ...((answer['faults'] ?? {}) as Record<string, unknown>), cloth_arms: arms['touches'] === true };
      if (arms['touches'] === true) {
        if (typeof arms['where'] === 'string' && arms['where']) {
          answer['issues'] = [`arms: ${arms['where']}`, ...((answer['issues'] ?? []) as string[])];
        }
      }
    }
    const capped = capFaults(answer, character.autoLessons ?? []);
    answer['capped'] = capped;
    review = reviewOf(options.reviewer, MESH_CRITERIA, answer, options.passScore);
    if (capped.length) {
      review['issues'] = [...capped.map((key) => `rig fault: ${RIG_FAULTS[key].question}`), ...(review['issues'] as string[])];
    }
  } else {
    const files = (run.outputs?.['renders']?.files ?? {}) as { clips?: Record<string, Record<string, unknown>> };
    const clips = files.clips ?? {};
    const measured = rigMeasured(clips as Parameters<typeof rigMeasured>[0]);
    const shown = ['Walk', 'Jump', 'Dance'].filter((name) => typeof clips[`${name}_Armature`]?.['sheet'] === 'string');
    const rest = `runs/${runId}/renders/rest_bones.png`;
    // The standing model the rig was made from, for the cause.
    const mesh = run.parent ? await getRun(storageDir, id, run.parent).catch(() => undefined) : undefined;
    const still = (mesh?.outputs?.['renders']?.files ?? {}) as Record<string, unknown>;
    if (!existsSync(file(rest)) || !shown.length || typeof still['sheet_clay'] !== 'string' || typeof still['sheet_detail'] !== 'string') {
      throw new Error(`${runId} lacks its check renders or its mesh's`);
    }
    answer = await ask(storageDir, caller, id, options.reviewer, {
      ...rigReviewPrompt(shown),
      images: [
        file(rest),
        ...shown.map((name) => file(String(clips[`${name}_Armature`]?.['sheet']))),
        file(still['sheet_clay']),
        file(still['sheet_detail']),
      ],
    });
    review = reviewOf(options.reviewer, RIG_CRITERIA, answer, options.passScore, measured.criteria);
    const cause = answer['cause'];
    if (review['verdict'] !== 'pass' && isRigFault(cause)) {
      review['next'] = `cause in the model: ${cause}`;
      review['improve'] = [RIG_FAULTS[cause].sheetFix];
      review['issues'] = [`cause: ${RIG_FAULTS[cause].lesson}`, ...(review['issues'] as string[])];
    }
  }

  if (save) await patchRun(storageDir, id, runId, { review });
  return { review, answer };
}

/** Front vs back width and the three heights, as a 0-10 criterion (the split's own pass is 5 % / 3 %). */
export function splitScore(check: Char3dSheetSet['check']): number {
  const width = Number(check.widthDiff ?? 1);
  const height = Number(check.heightDiff ?? 1);
  const byWidth = width <= 0.05 ? 10 : width <= 0.1 ? 7 : width <= 0.2 ? 5 : 3;
  const byHeight = height <= 0.03 ? 10 : height <= 0.06 ? 6 : 3;
  return Math.min(byWidth, byHeight);
}

/**
 * The arm angle, measured: where the figure is widest between 15 % and 75 %
 * of its height (`split_sheet.py` `pose`), front and back. The rigs that
 * worked sat at 0.565-0.587 (chibi-martial-girl r03/r20/r26/r40); arms hanging
 * on a cape 0.61-0.75 (honeyview-arthur-1 r04/r05), a near T-pose 0.31 (r12).
 * The vision model scored all of those 10. That is the chibi band; the game
 * model's is in its profile (`profiles.ts`).
 */
export const HAND_BAND = BODY_PROFILES.chibi.handBand;

type Pose = { handY?: number; gapRows?: number };

const POSE_FIX = {
  high: 'The arms are LOWER than shoulder level: a 45 degree A-pose with the fists level with the hips, not a T-pose, and in the side view the arm hangs beside the body, not pointing forward.',
  low: 'The arms do NOT hang down: both arms are raised 45 degrees away from the body like the letter A, the fists level with the hips and well out to the sides.',
  gap: 'There is a clear white gap between each arm and the body (and the cape) from the armpit down to the fist, in the front and the back view.',
};

/**
 * The arm pose, measured, as two criteria and the sentence for the next
 * sheet. `gapRows`: the share of the height where a row cuts the figure into
 * three separate pieces -- white space between an arm and the body. The girl's
 * sheets that rigged 0.21-0.41; Arthur's arms hanging on the cape 0.06-0.16.
 */
export function poseCriteria(
  pose: { front?: Pose; back?: Pose } | undefined,
  band: readonly [number, number] = HAND_BAND,
): { criteria: Char3dCriterion[]; fix: string } {
  const views = [pose?.front, pose?.back].filter((view): view is Pose => !!view);
  const ys = views.map((view) => view.handY).filter((value): value is number => typeof value === 'number');
  // The gap is the front view's: from behind, a long cape always fills the space behind the arms (arthur r19 back 0.20 with the cape clear).
  const gaps = [pose?.front?.gapRows].filter((value): value is number => typeof value === 'number');
  const criteria: Char3dCriterion[] = [];
  const fixes: string[] = [];
  if (!ys.length) {
    criteria.push({ key: 'armAngle', label: 'Arm angle (measured)', score: 5, note: 'not measured' });
  } else {
    const off = Math.max(...ys.map((y) => (y < band[0] ? band[0] - y : y > band[1] ? y - band[1] : 0)));
    const value = off <= 0 ? 10 : off <= 0.03 ? 7 : off <= 0.07 ? 4 : 2;
    const high = Math.min(...ys) < band[0];
    if (value < 5) fixes.push(high ? POSE_FIX.high : POSE_FIX.low);
    criteria.push({
      key: 'armAngle',
      label: 'Arm angle (measured)',
      score: value,
      note: `widest at ${ys.map((y) => y.toFixed(2)).join(' / ')} of the height, want ${band.join('-')}${off <= 0 ? '' : high ? ', arms too high' : ', arms too low'}`,
    });
  }
  if (gaps.length) {
    const least = Math.min(...gaps);
    const value = least >= 0.2 ? 10 : least >= 0.15 ? 7 : least >= 0.1 ? 4 : 2;
    if (value < 5) fixes.push(POSE_FIX.gap);
    criteria.push({ key: 'armGap', label: 'Arm gap (measured)', score: value, note: `gap between arm and body on ${gaps.map((gap) => gap.toFixed(2)).join(' / ')} of the height, want 0.2` });
  }
  return { criteria, fix: [...new Set(fixes)].join(' ') };
}

/** The sheet a mesh run was made from, following re-textures back to the first mesh. */
async function sheetOfMesh(storageDir: string, id: string, run: Char3dRun): Promise<string | undefined> {
  for (let current: Char3dRun | undefined = run, hops = 0; current && hops < 8; hops += 1) {
    if (current.step === 'ref') return firstSet(current)?.sheet;
    current = current.parent ? await getRun(storageDir, id, current.parent).catch(() => undefined) : undefined;
  }
  return undefined;
}

// --- the drive ---------------------------------------------------------------------

class Stopped extends Error {}

async function drive(storageDir: string, caller: Char3dCaller, id: string, auto: Char3dAuto): Promise<void> {
  const options = auto.options;
  const note = async (stage: Char3dAutoStage, text: string, extra: Partial<Char3dAutoEvent> = {}): Promise<void> => {
    auto.stage = stage;
    auto.events.push({ at: Date.now(), stage, text, ...extra });
    // A stop asked for from the page is in the file, not in this object.
    const onDisk = await readAuto(storageDir, id);
    if (onDisk?.stopRequested) auto.stopRequested = true;
    await writeAuto(storageDir, id, auto);
    if (auto.stopRequested) throw new Stopped();
  };
  const result: Partial<Record<Char3dStep, string>> = {};

  /** A run on the ordinary queue, awaited. */
  const run = async (step: Char3dStep, body: { parent?: string; intent: string; config: Record<string, unknown> }): Promise<Char3dRun> => {
    const created = await createRun(storageDir, caller, id, step, body);
    await note(step, `${created.id}: ${body.intent}`, { run: created.id });
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const current = await getRun(storageDir, id, created.id);
      if (current.status === 'done' || current.status === 'error' || current.status === 'cancelled') return current;
    }
  };
  const judge = async (step: Char3dStep, done: Char3dRun): Promise<LocalReview | null> => {
    if (done.status !== 'done') {
      await note(step, `${done.id} ${done.status}: ${done.error ?? ''}`.trim(), { run: done.id });
      return null;
    }
    const local = await reviewRun(storageDir, caller, id, done.id, options);
    const verdict = local.review['verdict'] as Char3dAutoEvent['verdict'];
    const issues = (local.review['issues'] as string[]).slice(0, 3).join('; ');
    await note(step, `${done.id} ${verdict} ${local.review['score']}: ${String(local.review['summary'])}${issues ? ` ${issues}` : ''}`, {
      run: done.id,
      score: Number(local.review['score']),
      ...(verdict ? { verdict } : {}),
    });
    return local;
  };

  try {
    // 1. describe: only a character without traits; one with traits was described already (by hand or by an earlier pass).
    let character = await getCharacter(storageDir, id);
    if (character.chibi !== options.chibi) {
      character = await patchCharacter(storageDir, id, { chibi: options.chibi });
    }
    let extra = character.autoExtra ?? '';
    let longHair = character.autoLongHair ?? false;
    if (!character.traits.trim()) {
      await note('describe', 'Reading the reference');
      const description = parseDescription(
        await ask(storageDir, caller, id, options.reviewer, {
          system: DESCRIBE_SYSTEM,
          prompt: describePrompt(options.chibi),
          images: [charFile(storageDir, id, character.ref)],
        }),
      );
      extra = description.simplify;
      longHair = description.longHair;
      character = await getCharacter(storageDir, id);
      Object.assign(character, {
        subject: `${options.chibi && !/chibi/i.test(description.subject) ? 'chibi ' : ''}${description.subject || 'character'}`,
        traits: description.traits,
        style: options.chibi ? 'chibi' : 'game model',
        autoExtra: extra,
        autoLongHair: longHair,
        ...(description.name && character.nameFromFile ? { name: description.name, nameFromFile: false } : {}),
      } satisfies Partial<Char3dCharacter>);
      await saveCharacter(storageDir, character);
      await note('describe', `${character.subject}. ${character.traits}${extra ? ` Simplify: ${extra}` : ''}`);
    }

    // What failed rigs taught: the cause on the model goes to every later
    // review, a sheet-level fix into every later sheet. Failed rigs reviewed
    // before this pass are read back too.
    const learnFault = async (cause: RigFault | '', stage: Char3dAutoStage = 'rig', escalate = true): Promise<boolean> => {
      // The first sentence, then the stronger one once a sheet with the first still
      // shows the fault. Reading old reviews back does not escalate: it would on every start.
      const fixes: string[] = cause ? [RIG_FAULTS[cause].sheetFix, ...(escalate ? [RIG_FAULTS[cause].stronger] : [])] : [];
      const current = await getCharacter(storageDir, id);
      const lessons = current.autoLessons ?? [];
      const sheetFixes = current.autoSheetFixes ?? [];
      let newFix = false;
      if (cause && !lessons.includes(cause)) lessons.push(cause);
      // One fix per failed sheet: the model words the same fault differently each time.
      const fix = fixes.find((sentence) => !sheetFixes.includes(sentence));
      if (fix && sheetFixes.length < 6) {
        sheetFixes.push(fix);
        newFix = true;
      }
      current.autoLessons = lessons.slice(-6);
      current.autoSheetFixes = sheetFixes;
      if (newFix) {
        // The traits are rewritten to agree with the fixes; the reading of the picture is kept.
        current.autoTraitsOriginal ??= current.traits;
        try {
          const edited = await ask(storageDir, caller, id, options.reviewer, { ...rewriteTraits(current.autoTraitsOriginal, sheetFixes), images: [] });
          if (typeof edited['traits'] === 'string' && edited['traits'].trim()) current.traits = dropHeld(edited['traits'].trim());
        } catch {
          // The fix still goes into the prompt; only the traits stay as they were.
        }
      }
      await saveCharacter(storageDir, current);
      if (cause) await note(stage, `learnt: ${RIG_FAULTS[cause].lesson}${newFix ? ` → next sheet: ${fix}` : ''}`);
      return newFix;
    };
    const learn = (review: Char3dRun['review'] | Record<string, unknown> | undefined, escalate = true): Promise<boolean> => {
      const next = String((review as { next?: unknown } | undefined)?.next ?? '');
      const named = next.startsWith('cause in the model: ') ? next.slice('cause in the model: '.length) : '';
      // Only a fault from the list is learnt: free text from older reviews was guessed.
      return learnFault(isRigFault(named) ? named : '', 'rig', escalate);
    };
    const allRuns = await listRuns(storageDir, id);
    for (const failed of allRuns.filter((done) => done.step === 'rig' && done.review && done.review.verdict !== 'pass')) {
      if (failed.review?.next) await learn(failed.review, false);
    }
    // Fixes learnt before the traits were rewritten for them: rewrite once now.
    {
      const current = await getCharacter(storageDir, id);
      if (current.autoSheetFixes?.length && current.autoTraitsOriginal === undefined) {
        current.autoTraitsOriginal = current.traits;
        const edited = await ask(storageDir, caller, id, options.reviewer, { ...rewriteTraits(current.traits, current.autoSheetFixes), images: [] }).catch(() => ({}));
        const traits = (edited as Record<string, unknown>)['traits'];
        if (typeof traits === 'string' && traits.trim()) current.traits = dropHeld(traits.trim());
        await saveCharacter(storageDir, current);
        await note('ref', `traits rewritten for what was learnt: ${current.traits}`);
      }
    }

    const rig = async (mesh: Char3dRun): Promise<'pass' | 'retry' | 'new-sheet'> => {
      result.mesh = mesh.id;
      // hairCut is only for long hanging hair; otherwise it floods from dark headwear into dark
      // clothes (blindfold-lightning-warrior r05: 144K of 399K faces cut, joints off the arms).
      const rigged = await run('rig', {
        parent: mesh.id,
        intent: `auto rig ${mesh.id}`,
        config: { mesh: mesh.outputs?.['glb'], ...(longHair ? {} : { prep: { hairCut: false } }) },
      });
      const rigReview = await judge('rig', rigged);
      if (rigReview?.review['verdict'] === 'pass') {
        result.rig = rigged.id;
        await patchCharacter(storageDir, id, { best: { mesh: mesh.id, rig: rigged.id } });
        return 'pass';
      }
      return rigReview && (await learn(rigReview.review)) ? 'new-sheet' : 'retry';
    };
    /** A sheet drawn before a fix was learnt still has the fault: it is not reused. */
    const hasFixes = async (sheet: Char3dRun): Promise<boolean> => {
      const fixes = (await getCharacter(storageDir, id)).autoSheetFixes ?? [];
      return fixes.every((fix) => String(sheet.config['extra'] ?? '').includes(fix));
    };

    let sheetTries = 0;
    let meshTries = 0;
    const rigParents = new Set(allRuns.filter((done) => done.step === 'rig').map((done) => done.parent));
    for (;;) {
      // 2. the sheet: the best one that passed and carries every fix, or a new one
      const passed = (await listRuns(storageDir, id))
        .filter((done) => done.status === 'done' && done.review?.verdict === 'pass')
        .sort((a, b) => (b.review?.score ?? 0) - (a.review?.score ?? 0));
      let sheetRun: Char3dRun | undefined;
      for (const candidate of passed.filter((done) => done.step === 'ref' && firstSet(done)?.views)) {
        if (await hasFixes(candidate)) {
          sheetRun = candidate;
          break;
        }
      }
      if (sheetRun) await note('ref', `${sheetRun.id} passed (${sheetRun.review?.score}): using it`, { run: sheetRun.id });
      let fix = '';
      while (!sheetRun && sheetTries < options.refTries) {
        sheetTries += 1;
        const learnt = (await getCharacter(storageDir, id)).autoSheetFixes ?? [];
        const done = await run('ref', {
          intent: `auto sheet ${sheetTries}/${options.refTries}${fix ? ` — ${fix}` : ''}${learnt.length ? ` (+${learnt.length} learnt)` : ''}`,
          config: { mode: 'sheet', batch: 1, extra: [extra, ...learnt, fix].filter(Boolean).join(' ') },
        });
        const local = await judge('ref', done);
        if (local?.review['verdict'] === 'pass') sheetRun = done;
        else if (typeof local?.answer['fix'] === 'string') fix = local.answer['fix'];
      }
      if (!sheetRun) throw new Error(`no sheet passed in ${options.refTries} tries`);
      const sheet = sheetRun;
      result.ref = sheet.id;
      await patchCharacter(storageDir, id, { best: { ref: sheet.id } });
      if (options.stopAfter === 'ref') return finish('done');

      // 3. meshes of this sheet that passed and were never rigged -- reviewed
      // again, since what was learnt since may fail them -- then new meshes.
      let outcome: 'pass' | 'retry' | 'new-sheet' = 'retry';
      // A rig fault that two meshes of the same sheet show is in the drawing: a
      // new seed will not move a cape away from the hands (r07, r09).
      const seen = new Map<RigFault, number>();
      const sheetFault = async (local: LocalReview | null): Promise<boolean> => {
        for (const fault of (local?.answer['capped'] ?? []) as RigFault[]) {
          seen.set(fault, (seen.get(fault) ?? 0) + 1);
          if ((seen.get(fault) ?? 0) >= 2 && (await learnFault(fault, 'mesh'))) return true;
        }
        return false;
      };
      for (const mesh of passed.filter((done) => done.step === 'mesh' && done.parent === sheet.id && !rigParents.has(done.id))) {
        rigParents.add(mesh.id);
        const again = await judge('mesh', mesh);
        if (await sheetFault(again)) {
          outcome = 'new-sheet';
          break;
        }
        if (again?.review['verdict'] !== 'pass') continue;
        if (options.stopAfter === 'mesh') {
          result.mesh = mesh.id;
          return finish('done');
        }
        outcome = await rig(mesh);
        if (outcome !== 'retry') break;
      }
      const set = firstSet(sheet)!;
      const views = Object.fromEntries(SHEET_VIEWS.filter((view) => set.views?.[view]).map((view) => [view, set.views?.[view]]));
      while (outcome === 'retry' && meshTries < options.meshTries) {
        meshTries += 1;
        let done = await run('mesh', {
          parent: sheet.id,
          intent: `auto mesh ${meshTries}/${options.meshTries} from ${sheet.id}, random seed`,
          // Big hair needs the finer remesh for the face to keep its detail (docs/char3d.md, r43).
          config: { views, ...(longHair ? { remeshResolution: 1024, targetFaces: 400000 } : {}) },
        });
        let local = await judge('mesh', done);
        if (local && local.review['verdict'] !== 'pass' && local.answer['snout'] === true) {
          // The shape is otherwise kept: re-texture the same geometry with the muzzle flattened.
          const face = (local.review['criteria'] as Char3dCriterion[]).find((criterion) => criterion.key === 'face');
          if (face && face.score < 8) {
            done = await run('mesh', { parent: done.id, intent: `auto: flatten the muzzle of ${done.id}`, config: { retexture: done.id, faceFix: true } });
            local = await judge('mesh', done);
          }
        }
        if (await sheetFault(local)) {
          outcome = 'new-sheet';
          break;
        }
        if (local?.review['verdict'] !== 'pass') continue;
        if (options.stopAfter === 'mesh') {
          result.mesh = done.id;
          await patchCharacter(storageDir, id, { best: { mesh: done.id } });
          return finish('done');
        }
        rigParents.add(done.id);
        outcome = await rig(done);
      }
      if (outcome === 'pass') return finish('done');
      if (outcome === 'new-sheet' && sheetTries < options.refTries) continue;
      throw new Error(
        outcome === 'new-sheet'
          ? `the sheet needs redrawing, but ${options.refTries} sheet tries are spent`
          : `no mesh rigged to a pass in ${options.meshTries} tries`,
      );
    }
  } catch (error) {
    if (error instanceof Stopped) return finish('stopped');
    auto.error = error instanceof Error ? error.message : String(error);
    return finish('failed');
  }

  async function finish(status: Char3dAuto['status']): Promise<void> {
    auto.status = status;
    auto.result = result;
    auto.finishedAt = Date.now();
    auto.events.push({
      at: Date.now(),
      stage: auto.stage ?? 'describe',
      text: status === 'done' ? `Done: ${Object.entries(result).map(([step, runId]) => `${step} ${runId}`).join(', ')}` : status === 'stopped' ? 'Stopped' : `Failed: ${auto.error}`,
    });
    await writeAuto(storageDir, id, auto);
  }
}
