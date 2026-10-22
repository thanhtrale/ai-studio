/**
 * What the autopilot asks the local vision model, and how its answers become a score.
 *
 * The model is asked for one 0-10 number per criterion and a note, never for
 * the total or the verdict: the weights, the floors and the pass mark are
 * here, in code, so a lenient or a harsh answer moves one criterion, not the
 * decision. Every rule a criterion lists is a fault that was actually seen on
 * this pipeline (docs/char3d.md); a criterion that only says "looks good"
 * scores everything 8.
 *
 * English, like the image prompts: the reviewer is Qwen3-VL, which follows an
 * English instruction more closely.
 */

import type { Char3dCriterion, Char3dVerdict } from '#shared/char3d';

export interface Criterion {
  key: string;
  label: string;
  weight: number;
  /** Below this the run cannot pass, whatever the total. */
  floor: number;
  /** What the reviewer looks at, and the faults that cost points. */
  rule: string;
}

// --- describing the reference ------------------------------------------------------

export const DESCRIBE_SYSTEM = `You prepare a character for a 3D pipeline: an image model will redraw the character as a three-view turnaround sheet, a 3D model is built from the sheet, then rigged and animated.
You see ONE reference image of the character. Answer with ONE JSON object and nothing else:
{
  "name": "a short display name, 2-4 English words",
  "subject": "who it is, an English noun phrase of 2-6 words, e.g. \\"girl martial arts student\\" or \\"young knight\\" -- no style words (no chibi, anime, cartoon, 3D)",
  "isChibi": true if the reference already has chibi proportions (head about a third of the height or more),
  "traits": "ONE English paragraph of everything that must be kept: hair (colour, length, how it is tied, the bangs), eye colour, skin tone, the whole outfit from top to bottom with every colour, the shoes, accessories. Name EVERY detail worn on one side and say which side as the CHARACTER's own left or right (the character's left is on the viewer's right in a front view), e.g. \\"a red hairpin above the character's left ear\\". Describe the back too if it can be inferred. Describe only what the character WEARS: never what it holds (weapons, props), the pose or the background, and nothing that simplify removes.",
  "simplify": "English sentences of the FEW changes that let the character be built and animated as a 3D mesh, or an empty string. Only these: remove anything held in the hands (weapons, props, bags); remove long thin parts that hang loose (ribbon tails, strings, tassels, chains, loose strands of hair); shorten a cape or coat tail that reaches below the knees to hip length; bangs stop above the eyebrows so the face is clear. Keep everything else that makes the character recognisable -- armour pieces, fur trim, pauldrons, short capes, emblems and colours stay.",
  "longHair": true if the hair reaches below the shoulders, or there is a large ponytail, twin tails or buns
}
Be concrete about colours ("pastel pink", "dark navy"). Do not invent details you cannot see.`;

export const describePrompt = (chibi: boolean): string =>
  `Describe this character for the pipeline.${chibi ? ' It will be redrawn as a chibi figure, so do not describe body proportions.' : ''}`;

export interface Description {
  name: string;
  subject: string;
  isChibi: boolean;
  traits: string;
  simplify: string;
  longHair: boolean;
}

/**
 * Sentences about what the character holds. The model writes them into the
 * traits even when told not to, and "holds a sword in his right hand" there
 * fights "remove the sword" in the same prompt.
 */
const HOLDING = /\b(hold|holds|holding|grip|grips|gripping|wield|wields|wielding|carries|carrying)\b/i;

export const dropHeld = (traits: string): string =>
  traits
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !HOLDING.test(sentence))
    .join(' ');

export function parseDescription(raw: Record<string, unknown>): Description {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const description = {
    name: text(raw['name']),
    subject: text(raw['subject']),
    isChibi: raw['isChibi'] === true,
    traits: dropHeld(text(raw['traits'])),
    simplify: text(raw['simplify']),
    longHair: raw['longHair'] === true,
  };
  if (!description.traits) throw new Error('the reviewer described no traits');
  return description;
}

// --- the rubrics -------------------------------------------------------------------

export const REF_CRITERIA = (chibi: boolean): Criterion[] => [
  {
    key: 'identity',
    label: 'Same character',
    weight: 3,
    floor: 6,
    rule: `IMAGE 2 is the same character as IMAGE 1: face, hairstyle and hair colour, eye colour, every piece of the outfit and its colours, accessories on the same side.${chibi ? ' The sheet is meant to be a chibi version, so changed body proportions are NOT a fault.' : ''} Missing or invented clothing, wrong colours, a different hairstyle cost points. Text, letters or a watermark drawn on the clothes cost points.`,
  },
  chibi
    ? {
        key: 'chibi',
        label: 'Chibi proportions',
        weight: 2,
        floor: 5,
        rule: 'Chibi proportions in IMAGES 2-4: a big head about a third of the total height, a small short body, short limbs.',
      }
    : {
        key: 'proportions',
        label: 'Adult proportions',
        weight: 2,
        floor: 5,
        rule: 'Adult game-model proportions in IMAGES 2-4: the head about one seventh of the total height, long legs, a natural adult body. A big head or a short chibi body is a fault.',
      },
  {
    key: 'views',
    label: 'Three views',
    weight: 2,
    floor: 6,
    rule: 'IMAGE 2 must face the camera (both eyes visible). IMAGE 3 must be a side profile: only one eye visible, the nose pointing to the LEFT edge of the image (that is correct, not a fault). IMAGE 4 must show the back of the character: the back of the head and hair, NO face, NO eyes. All three in the same pose and the same outfit. Only score down for what you actually see wrong in one of these three images.',
  },
  {
    key: 'pose',
    label: 'A-pose',
    weight: 2,
    floor: 5,
    rule: 'In IMAGE 2 and IMAGE 4: arms straight and raised about 45 degrees away from the body with clear empty space between each arm and the torso; both hands closed into fists; legs straight, feet a little apart; nothing held in the hands. Arms hanging against the body, a T-pose, open hands or a held object cost points.',
  },
  {
    key: 'meshable',
    label: 'Buildable in 3D',
    weight: 3,
    floor: 5,
    rule: 'Can be built as a clean 3D mesh: the hair is made of large solid locks (thin separate strands, flyaway wisps or spiky thin tips cost points); no long thin parts hang loose (ribbon tails, strings, tassels); the face is not covered by hair; plain white background, no floor, no shadow, no text; the whole body is visible from the top of the hair to the shoes.',
  },
];

export const MESH_CRITERIA: Criterion[] = [
  {
    key: 'shape',
    label: 'Shape',
    weight: 3,
    floor: 6,
    rule: 'Compare the 3D model (IMAGE 2 textured turntable, IMAGE 3 untextured clay) with the reference sheet (IMAGE 1): the same silhouette and proportions, the hair volume, the arms clear of the torso, two legs. Missing or extra parts, holes, floating pieces, arms welded to the body cost points.',
  },
  {
    key: 'clearance',
    label: 'Arms hang free',
    weight: 3,
    // No floor: the rig decides. From behind, a cape hanging BEHIND a free forearm looks like contact to
    // the 8B model (arthur r22 failed here, its fists are free), and no silhouette measure on the renders
    // tells r22 (free) from r07 (gripping): r07 0.136, r22 0.129 of the height with a gap.
    floor: 0,
    rule: 'IMAGE 5 bottom row shows the arms from below and from behind; IMAGE 3 the clay model. Each hand and forearm must hang free with empty space all around it. A hand or forearm that touches, grips or is merged with the edge of a cape, coat, skirt, hair or the torso is a SERIOUS fault (score 4 or less): the rig drags that cloth with the arm and tears it.',
  },
  {
    key: 'face',
    label: 'Face',
    weight: 3,
    floor: 6,
    rule: 'IMAGE 4 is a close-up of the model\'s face. Two clear eyes of the same colour as the reference, symmetric, with brows and a mouth in the right place. Smeared or blurred eyes, slit cat pupils, streaks or veins across the face, extra eyes or brows, and a face that juts forward like a snout or muzzle cost points.',
  },
  {
    key: 'hair',
    label: 'Hair',
    weight: 2,
    floor: 5,
    rule: 'The hair matches the reference\'s style and colour and is made of solid locks in the clay view. Shredded thin cards, jagged saw-tooth tips, spikes or holes in the hair cost points.',
  },
  {
    key: 'texture',
    label: 'Colours',
    weight: 2,
    floor: 5,
    rule: 'The colours match the reference: hair, skin, every piece of the outfit. Washed-out white or glaring patches, colours bleeding onto the wrong part, streaks cost points. A slightly darker shade of a pastel is acceptable.',
  },
  {
    key: 'surface',
    label: 'Surface',
    weight: 1,
    floor: 4,
    rule: 'In the clay view the surface is smooth: lumps, pinched or doubled features (two hairpins where there is one), dents and noise cost points.',
  },
];

export const RIG_CRITERIA: Criterion[] = [
  {
    key: 'deform',
    label: 'Deformation',
    weight: 3,
    floor: 5,
    rule: 'Across every frame the body keeps its shape: no stretched or torn limbs, no long spikes or strings of mesh, no collapsed or twisted torso, the head stays on the neck.',
  },
  {
    key: 'joints',
    label: 'Joints',
    weight: 2,
    floor: 5,
    rule: 'Arms and legs bend at the elbows, knees, shoulders and hips, not in the middle of a bone; the hands stay at the ends of the sleeves.',
  },
  {
    key: 'cloth',
    label: 'Hair and clothes',
    weight: 2,
    floor: 4,
    rule: 'Hair, sleeves and the hem follow the body without tearing open, stretching into sheets, or sinking deep into the body. Look closely at the locks of hair that hang beside the face: a lock that sticks to an arm and is pulled along with it, or smears across the chest, is a serious fault.',
  },
];

// --- the review prompts ------------------------------------------------------------

const ANSWER = (criteria: Criterion[], extra: string): string =>
  `Answer with ONE JSON object and nothing else:
{
  "criteria": { ${criteria.map((criterion) => `"${criterion.key}": {"score": 0-10, "note": "what you saw"}`).join(', ')} },
  "issues": ["each concrete fault you see, short"],
  ${extra}
}
Score each criterion on its own rule: 10 flawless, 8 a small fault, 6 noticeable faults, 4 a serious fault, 2 unusable. Be strict and concrete; do not praise. Look at the images before scoring.`;

const rules = (criteria: Criterion[]): string =>
  criteria.map((criterion) => `- ${criterion.key} (${criterion.label}): ${criterion.rule}`).join('\n');

export const refReviewPrompt = (chibi: boolean, lessons: string[] = []): { system: string; prompt: string } => ({
  system: `You review a generated character turnaround sheet before a 3D model is built from it.
IMAGE 1 is the original reference of the character. IMAGES 2, 3 and 4 are the three figures cut from the generated sheet: IMAGE 2 the front view, IMAGE 3 the left side profile, IMAGE 4 the back view.
Criteria:
${rules(REF_CRITERIA(chibi))}
${lessonsBlock(lessons)}${ANSWER(REF_CRITERIA(chibi), '"fix": "ONE short English sentence for the image prompt that would fix the worst fault next time, or an empty string"')}`,
  prompt: 'IMAGE 1: the original reference. IMAGE 2: generated front view. IMAGE 3: generated side profile. IMAGE 4: generated back view. Review IMAGES 2-4.',
});

/**
 * The faults that break a rig, seen on the model standing still. An 8B
 * reviewer names them unreliably in its own words (asked for "the cause", it
 * copied the prompt's example about hair onto a short-haired knight whose
 * cape was the problem) but answers a yes/no question about each one and
 * picks one from a list well. So the list, the lesson and the fix to the
 * drawing are written here, and the model only says which.
 */
export const RIG_FAULTS = {
  cloth_arms: {
    criterion: 'clearance',
    /** Checked on every mesh: no rig survives it. */
    always: true,
    question: 'a hand or forearm touches, grips or is merged with a cape, coat, scarf or other cloth',
    lesson: 'a cape or coat edge touches the hands or forearms, so the rig drags and tears the cloth with the arm',
    // "Arms raised well clear of it" drew a near T-pose with the arm pointing
    // forward in the profile (honeyview-arthur-1 r12): the angle stays named.
    sheetFix:
      'The cape hangs straight down behind the back, narrower than the shoulders; the arms keep the 45 degree A-pose with the fists beside the hips, and there is empty space between each fist and the cape edge.',
    // When the first sentence is in the sheet and the meshes still show it (three
    // meshes of arthur r19 welded the cape flaps to the fists). Not "a short
    // cape": the person keeps a long cape, and Turbo drew the long one anyway
    // from <image1> (r24-r27).
    stronger:
      'The front edges of the cape are tucked behind the back, so from the front the cape is only seen behind the shoulders and beside the legs, far from the hands.',
  },
  hair_body: {
    criterion: 'hair',
    always: false,
    question: 'a lock of hair rests on or touches the shoulders, the chest or an arm',
    lesson: 'hair rests on the shoulders, chest or arms, so the rig pulls it along with the body',
    sheetFix: 'The hair stays above and behind the shoulders and never rests on the chest or the arms.',
    stronger: 'The hair is short or tied up high, well above the shoulders.',
  },
  arms_torso: {
    criterion: 'shape',
    always: false,
    question: 'an arm or sleeve is joined to the torso at the armpit or along the side of the body',
    lesson: 'an arm or sleeve is joined to the torso, so raising the arm tears the side',
    sheetFix: 'Both arms are raised about 50 degrees from the body with clear empty space under each armpit.',
    stronger: 'The sleeves are tight-fitting, so there is a wide white gap between each arm and the body.',
  },
  hem_legs: {
    criterion: 'shape',
    always: false,
    question: 'a skirt, robe or coat tail joins the two legs together',
    lesson: 'a skirt or coat tail joins the legs, so walking stretches it into a sheet',
    sheetFix: 'The hem stops above the knees, so the two legs are separate below it.',
    stronger: 'The outfit has trousers instead of a skirt or long coat tail.',
  },
} as const;

export type RigFault = keyof typeof RIG_FAULTS;
export const isRigFault = (value: unknown): value is RigFault => typeof value === 'string' && value in RIG_FAULTS;
const FAULT_KEYS = Object.keys(RIG_FAULTS) as RigFault[];

/** What earlier rigs of this character failed on, for the reviewer to look for in the next mesh or sheet. */
const lessonsBlock = (lessons: string[]): string =>
  lessons.length
    ? `\nEarlier 3D models of THIS character failed at the rig because:\n${lessons
        .map((lesson) => `- ${isRigFault(lesson) ? RIG_FAULTS[lesson].lesson : lesson}`)
        .join('\n')}\nLook for the same fault first.\n`
    : '';

const faultQuestions = (): string =>
  `"faults": { ${FAULT_KEYS.map((key) => `"${key}": true if ${RIG_FAULTS[key].question}, else false`).join(', ')} }`;

export const meshReviewPrompt = (lessons: string[] = []): { system: string; prompt: string } => ({
  system: `You review a 3D character model generated from a reference sheet, before it is rigged.
IMAGE 1 is the reference sheet (front, left profile, back). IMAGE 2 is the textured model from eight angles. IMAGE 3 is the same model without texture (clay). IMAGE 4 is a close-up of the model's face. IMAGE 5 is close-ups: the top row the neck and the hair, the bottom row the arms and hands from below and from behind.
Criteria:
${rules(MESH_CRITERIA)}
${lessonsBlock(lessons)}${ANSWER(MESH_CRITERIA, `"snout": true if the lower face juts forward like a muzzle or snout, else false,\n  ${faultQuestions()}`)}`,
  prompt: 'IMAGE 1: reference sheet. IMAGE 2: textured model turntable. IMAGE 3: clay model. IMAGE 4: face close-up. IMAGE 5: neck, hair and arm close-ups. Review the model.',
});

/**
 * A yes to a fault caps its criterion at 4, under every floor -- for the faults
 * that always break a rig, and for the ones this character's rigs already
 * failed on. Returns the faults that were applied.
 */
export function capFaults(answer: Record<string, unknown>, lessons: string[]): RigFault[] {
  const said = (answer['faults'] ?? {}) as Record<string, unknown>;
  const criteria = ((answer['criteria'] ??= {}) as Record<string, { score?: unknown; note?: unknown } | number>);
  const applied: RigFault[] = [];
  for (const key of FAULT_KEYS) {
    const fault = RIG_FAULTS[key];
    if (said[key] !== true || !(fault.always || lessons.includes(key))) continue;
    const entry = criteria[fault.criterion];
    const current = typeof entry === 'number' ? entry : Number(entry?.score ?? 10);
    const note = typeof entry === 'object' && entry?.note ? `${String(entry.note)}; ` : '';
    criteria[fault.criterion] = { score: Math.min(current, 4), note: `${note}${fault.question}` };
    applied.push(key);
  }
  return applied;
}

export const rigReviewPrompt = (clips: string[]): { system: string; prompt: string } => ({
  system: `You review a rigged and animated 3D character.
IMAGE 1 is the character in its rest pose with the skeleton drawn in. ${clips
    .map((clip, index) => `IMAGE ${index + 2} is eight frames of the "${clip}" animation`)
    .join('. ')}. IMAGE ${clips.length + 2} is the same model standing still, untextured, from four sides. IMAGE ${clips.length + 3} is close-ups of it: the bottom row the arms and hands from below and from behind.
Criteria:
${rules(RIG_CRITERIA)}
${ANSWER(
    RIG_CRITERIA,
    `"worst": "the clip and frame that looks worst, or an empty string",
  "cause": "look at the standing model (IMAGES ${clips.length + 2} and ${clips.length + 3}) and pick the ONE fault that best explains what goes wrong in the animations: ${FAULT_KEYS.map((key) => `\\"${key}\\" (${RIG_FAULTS[key].question})`).join(', ')}, or \\"none\\""`,
  )}`,
  prompt: `IMAGE 1: rest pose with bones. ${clips.map((clip, index) => `IMAGE ${index + 2}: ${clip}`).join('. ')}. IMAGE ${clips.length + 2}: the model standing still. IMAGE ${clips.length + 3}: its close-ups. Review the rig.`,
});

// --- turning the answer into a review ------------------------------------------------

/** The model's object, from an answer that may wrap it in a code fence or a sentence. */
export function parseJsonAnswer(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the reviewer answered without a JSON object');
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

export interface Scored {
  score: number;
  verdict: Char3dVerdict;
  criteria: Char3dCriterion[];
  /** Criteria under their floor. */
  below: string[];
}

/**
 * The weighted score, 0-100, and the verdict. A missing criterion counts as 0:
 * an answer that skipped one has not looked.
 */
export function score(criteria: Criterion[], answer: Record<string, unknown>, passScore: number, measured: Char3dCriterion[] = []): Scored {
  const given = (answer['criteria'] ?? {}) as Record<string, { score?: unknown; note?: unknown } | number>;
  const out: Char3dCriterion[] = criteria.map((criterion) => {
    const entry = given[criterion.key];
    const raw = typeof entry === 'number' ? entry : Number(entry?.score);
    const note = typeof entry === 'object' && entry?.note ? String(entry.note) : undefined;
    return {
      key: criterion.key,
      label: criterion.label,
      score: Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.round(raw))) : 0,
      ...(note ? { note } : {}),
    };
  });
  const all = [...out, ...measured];
  const weights = new Map(criteria.map((criterion) => [criterion.key, criterion.weight]));
  const floors = new Map(criteria.map((criterion) => [criterion.key, criterion.floor]));
  // A measured criterion weighs 2 and has a floor of 5.
  const weightOf = (key: string): number => weights.get(key) ?? 2;
  const total = all.reduce((sum, criterion) => sum + weightOf(criterion.key), 0);
  const value = Math.round((all.reduce((sum, criterion) => sum + criterion.score * weightOf(criterion.key), 0) / total) * 10);
  const below = all.filter((criterion) => criterion.score < (floors.get(criterion.key) ?? 5)).map((criterion) => criterion.key);
  const verdict: Char3dVerdict = value >= passScore && !below.length ? 'pass' : value < passScore - 25 ? 'fail' : 'retry';
  return { score: value, verdict, criteria: all, below };
}

/** A rig's numbers as criteria: hands inside the body, and how far the worst edges stretch. */
export function rigMeasured(clips: Record<string, { stretchWorst?: { p99?: number; over2?: number }; handInBody?: { frames?: number; of?: number } }>): {
  criteria: Char3dCriterion[];
  worst: { p99: number; over2: number; handFrames: number; frames: number };
} {
  let p99 = 0;
  let over2 = 0;
  let handFrames = 0;
  let frames = 0;
  for (const clip of Object.values(clips)) {
    p99 = Math.max(p99, clip.stretchWorst?.p99 ?? 0);
    over2 = Math.max(over2, clip.stretchWorst?.over2 ?? 0);
    handFrames += clip.handInBody?.frames ?? 0;
    frames += clip.handInBody?.of ?? 0;
  }
  // Calibrated on the rigs reviewed by hand: r46 (p99 1.91, 0.86 %, 0 hand frames) scored 84.
  const stretchScore = p99 <= 1.8 ? 10 : p99 <= 2.0 ? 9 : p99 <= 2.5 ? 7 : p99 <= 3 ? 5 : 2;
  // Over 1 % of edges stretched past 2x is under the floor: r14 and r16 (1.2 %) were rejected by hand for it.
  const over2Score = over2 <= 0.005 ? 10 : over2 <= 0.01 ? 8 : over2 <= 0.02 ? 4 : 2;
  const handScore = handFrames === 0 ? 10 : handFrames <= 2 ? 7 : handFrames <= 5 ? 5 : 2;
  return {
    criteria: [
      { key: 'stretch', label: 'Stretch (measured)', score: Math.min(stretchScore, over2Score), note: `worst p99 ${p99.toFixed(2)}, edges over 2x ${(over2 * 100).toFixed(2)}%` },
      { key: 'hands', label: 'Hands in body (measured)', score: handScore, note: `${handFrames} of ${frames} frames` },
    ],
    worst: { p99, over2, handFrames, frames },
  };
}

/** One question on the arm close-ups only (`detail_sleeve_*`): a whole sheet hides it from an 8B model. */
export const ARMS_QUESTION = {
  system: `You see close-ups of a 3D character's arms and hands, from below and from behind.
Every hand comes out of its own sleeve: the arm's OWN sleeve, cuff, glove or bracer is never a fault, however wide.
The question is whether a hand or forearm touches something that hangs from ELSEWHERE on the body: a cape or cloak, a coat tail, a scarf, a lock of hair, the skirt or the side of the torso.
Answer with ONE JSON object and nothing else:
{ "touches": true or false, "where": "what touches what, short, or an empty string" }
A fist closed around the edge of a cape is true. A hand hanging out of a wide sleeve with empty air around it is false.`,
  prompt: 'Close-ups of the arms and hands. Does any hand or forearm touch a cape, coat tail, scarf, hair, skirt or the torso (not its own sleeve)?',
};

/**
 * The traits made to agree with what was learnt. A fix only added to the end
 * of the prompt loses to the traits it contradicts: "a SHORT shoulder cape"
 * after "a red cape ... hanging down his back" drew the long cape again
 * (honeyview-arthur-1 r24-r25).
 */
export const rewriteTraits = (traits: string, fixes: string[]): { system: string; prompt: string } => ({
  system: `You edit the description of a character's outfit that an image model draws from.
Apply every change below to the description: rewrite or remove each sentence that contradicts a change, so the description and the changes agree. Keep everything else word for word.
Answer with ONE JSON object and nothing else: { "traits": "the edited description" }`,
  prompt: `Description:\n${traits}\n\nChanges:\n${fixes.map((fix) => `- ${fix}`).join('\n')}`,
});
