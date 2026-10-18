/**
 * The reference step's prompts.
 *
 * English, because they go to the image model, and Qwen-Image 2.1 follows an
 * English prompt more closely than a Vietnamese one (one Vietnamese set copied
 * the reference's own pose instead of the one asked for). The reference image
 * must be called `<image1>`: that is how Qwen-Image 2.1 addresses its inputs.
 *
 * Each run records the exact prompt it ran in `config.prompts`, so changing a
 * default here changes later runs only, and an old run still reads back
 * exactly what it was given. The measurements behind every clause are in
 * docs/char3d.md and docs/log/char3d.md (run numbers like r38 are that log's).
 */

import type { Char3dCharacter, Char3dView } from '#shared/char3d';

export const REF_PROMPT_VERSION = 'v3';

// v2: a WIDE A-pose, about 50 degrees. v1 (35) let wide sleeves hang against
// the ribs, Pixal3D welded them to the torso, and the rig tore the armpits on
// every raised arm; a T-pose made MIA put the wrists mid-sleeve (r27-r41).
// v3: loose fists (an open hand comes out of Pixal3D as one flat slab,
// r121-r126); sleeves exactly as the original (an "open sleeves" clause drew
// flared, skin-lined sleeves and a strip of skin on the mesh, r162-r170); no
// gendered pronoun.
const POSE =
  'The character stands straight in a wide A-pose: both arms straight and raised about 50 degrees away from the body, halfway between hanging down and horizontal, with clear empty space between the arms and the torso, the armpits visible; both hands closed into loose fists; legs straight, feet a little apart and flat on the ground. The sleeves keep exactly the shape and length of <image1>, with no skin visible inside the sleeves.';
const KEEP =
  'Keep exactly the same character: same face, same hairstyle, same outfit, same colors and the same chibi proportions with a big head and short body.';
const FRAME =
  'The whole body is visible from the top of the hair to the soles of the shoes, centered, with a small margin. Orthographic-looking straight camera at chest height, no perspective distortion. Plain pure white background, flat even lighting, no cast shadow, no floor, no text, no other characters.';

/** One image per view: the older mode, kept for runs that give their own prompts. */
export const DEFAULT_REF_PROMPTS: Record<Char3dView, string> = {
  front: `Character turnaround reference sheet, single figure: the {subject} from <image1>{traits}, seen from the FRONT, facing the camera directly. ${POSE} ${KEEP} ${FRAME}`,
  back: `Character turnaround reference sheet, single figure: the {subject} from <image1>{traits}, seen from directly BEHIND. The camera is behind the character: we see the back, the back of the head and the hair; the face is not visible. Details worn on one side stay on that side of the body, so from behind they appear mirrored in the image. ${POSE} ${KEEP} ${FRAME}`,
  left: `Character turnaround reference sheet, single figure: the {subject} from <image1>{traits}, seen in exact side profile: the body is turned 90 degrees so the character faces the LEFT edge of the image and we see the left side; the near arm points toward the camera and looks short and foreshortened, not stretched forward. ${POSE} ${KEEP} ${FRAME}`,
  right: `Character turnaround reference sheet, single figure: the {subject} from <image1>{traits}, seen in exact side profile: the body is turned 90 degrees so the character faces the RIGHT edge of the image and we see the right side; the near arm points toward the camera and looks short and foreshortened, not stretched forward. ${POSE} ${KEEP} ${FRAME}`,
};

// The default since the measured flow (docs/char3d.md, "The standard flow"):
// three views in ONE generation, 2048x1024, so the arms and proportions agree
// between views. Separately generated views each take their own pose (r192:
// front 373 px wide, back 484 px -- broken sleeves and hands on the mesh).
// `{traits}` must list the whole outfit and every one-sided detail: Turbo
// draws the hidden side from the words, not from the image. `{extra}` is this
// run's own change ("remove the long hanging ribbon tails").
export const SHEET_PROMPT =
  'Character turnaround reference sheet of the {subject} from <image1>, EXACTLY THREE full-body figures of the SAME character side by side (three figures only, never a fourth) on one plain pure white canvas, evenly spaced, not overlapping, left to right: (1) FRONT view facing the camera, (2) exact LEFT side profile facing the left edge of the image, (3) BACK view seen from directly behind. All three views share exactly the same pose, the same height and scale, the tops of the heads on one line and the soles of the shoes on one baseline. Pose in every view: standing straight, legs straight and feet a little apart, wide A-pose with both arms straight and raised about 45 degrees away from the body (in the side profile the face looks toward the left edge of the image and the near arm points toward the camera, so it looks short and foreshortened, NOT stretched forward), clear empty space between the arms and the torso, both hands closed into loose fists. Outfit exactly as <image1>{traits}.{extra} Details worn on one side stay on that side of the body, so from behind they appear mirrored in the image. The sleeves keep exactly the shape and length of <image1>, with no skin visible inside the sleeves. Same face, same colors and the same chibi proportions with a big head and short body as <image1>. Orthographic-looking straight camera at chest height, no perspective distortion, flat even lighting, no cast shadow, no floor, no text, no labels, no other characters.';

/** The canvas the sheet is drawn on. 1536x1024 fits three figures but spreads the front's hands (4/4). */
export const SHEET_SIZE = { width: 2048, height: 1024 } as const;
/** One image per view, in the older mode. */
export const VIEW_SIZE = { width: 896, height: 1152 } as const;

const trimEnd = (text: string): string => text.trim().replace(/[.\s]+$/, '');

export function fillRefPrompt(template: string, character: Pick<Char3dCharacter, 'subject' | 'traits'>): string {
  const traits = trimEnd(character.traits);
  return template
    .replaceAll('{subject}', character.subject || 'character')
    .replaceAll('{traits}', traits ? ` (${traits})` : '');
}

export function fillSheetPrompt(character: Pick<Char3dCharacter, 'subject' | 'traits'>, extra: string): string {
  const traits = trimEnd(character.traits);
  const change = trimEnd(extra);
  return SHEET_PROMPT.replaceAll('{subject}', character.subject || 'character')
    .replaceAll('{traits}', traits ? `: ${traits}` : '')
    .replaceAll('{extra}', change ? ` ${change}.` : '');
}
