/**
 * The 3D character pipeline's records, as both sides see them.
 *
 * A character goes through three steps, one run at a time, and each run is
 * looked at and scored before the next step uses it:
 *
 * ```
 * reference ─(Qwen-Image-2.1-Turbo)→ three-view A-pose sheet ─(Pixal3D)→ textured GLB ─(MIA v2 + SkinTokens)→ Mixamo rig + clips
 * ```
 *
 * A run records `parent`, the run it took its input from, so a rig reads back
 * to the mesh it was made from and that mesh to its sheet. The review is
 * written by whoever looked at the outputs, never by the runner: a model does
 * not get to grade itself, and neither does the code that ran it. The
 * autopilot (`Char3dAuto`) has a separate local vision model look and write
 * the review, as `by: "local:<arm>"`.
 *
 * Identifiers and enum values are English; `name`, `notes` and review text are
 * whatever the person typed.
 */

export type Char3dStep = 'ref' | 'mesh' | 'rig';
export const CHAR3D_STEPS: readonly Char3dStep[] = ['ref', 'mesh', 'rig'];

/** Pixal3D's camera rig. "left" is the character's own left side. */
export type Char3dView = 'front' | 'left' | 'back' | 'right';
export const CHAR3D_VIEWS: readonly Char3dView[] = ['front', 'left', 'back', 'right'];
/** The three a sheet is drawn with, left to right on the canvas. */
export const SHEET_VIEWS: readonly Char3dView[] = ['front', 'left', 'back'];

export type Char3dRunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type Char3dVerdict = 'pass' | 'retry' | 'fail';

export interface Char3dNote {
  at: number;
  text: string;
}

export interface Char3dCharacter {
  id: string;
  /** What the person called it, in their own language. */
  name: string;
  /** Who is in the picture, in English: it goes into every prompt ("chibi boy"). */
  subject: string;
  /** What must be kept -- hair, outfit, colours, one-sided details -- in English, for every prompt. */
  traits: string;
  style: string;
  /**
   * The body profile (`char3dBody`): true draws the sheet as a chibi figure
   * whatever the reference's style; false draws a game model with adult
   * proportions. Absent: keep the reference's own proportions, which for the
   * hand-made characters were already chibi (and use the chibi defaults).
   */
  chibi?: boolean;
  /** The autopilot's reading of the reference: what to change so it meshes ("remove the ribbon tails"), added to every sheet it draws. */
  autoExtra?: string;
  /** The autopilot's reading: long or big hair, which meshes at the finer remesh. */
  autoLongHair?: boolean;
  /**
   * What made this character's rigs fail, as the reviewer saw it on the model
   * ("the cape edges touch the hands"). Every later sheet and mesh review is
   * told to look for these first.
   */
  autoLessons?: string[];
  /** Sentences for the sheet prompt that prevent those faults, added to every sheet the autopilot draws. */
  autoSheetFixes?: string[];
  /** The traits as first read off the picture, before they were rewritten to agree with `autoSheetFixes`. */
  autoTraitsOriginal?: string;
  /** The name is the uploaded file's: the autopilot may replace it with the one it reads off the picture. */
  nameFromFile?: boolean;
  /** The original reference's file name inside the character's directory. */
  ref: string;
  createdAt: number;
  /** What was learnt on this character. General lessons belong in docs/char3d.md. */
  notes?: Char3dNote[];
  /** The run currently held as best, per step. */
  best?: Partial<Record<Char3dStep, string>>;
  /**
   * Outputs that passed, per step -- the only things the next step is offered.
   * A `pass` review adds a run; a later retry or fail takes it out again,
   * unless the person added it by hand.
   */
  gallery?: Char3dGalleryItem[];
}

export interface Char3dGalleryItem {
  step: Char3dStep;
  run: string;
  /** For a sheet run: which sheet of the batch (`outputs.sets[set]`). */
  set?: number;
  /** For a ref run: the views the mesh step will use, relative to the character's directory. */
  views?: Partial<Record<Char3dView, string>>;
  at: number;
  /** `review` = added by a pass; `user` = added by hand and kept through later reviews. */
  by: 'review' | 'user';
}

export interface Char3dCriterion {
  key: string;
  label: string;
  /** 0-10. */
  score: number;
  note?: string;
}

export interface Char3dReview {
  at: number;
  by: string;
  /** 0-100. The reviewer weighs the criteria and says why in `summary`. */
  score: number;
  verdict: Char3dVerdict;
  criteria: Char3dCriterion[];
  summary: string;
  issues: string[];
  improve: string[];
  /** The decision taken: "regenerate the sheet because ...", "mesh from front_1 + back_0". */
  next?: string;
  /** For a ref run of separate views: which image of each view the mesh step should use. */
  picks?: Partial<Record<Char3dView, string>>;
}

/** One supervisor job a run made, in order, so the page can follow the live one. */
export interface Char3dRunJob {
  id: string;
  arm: string;
  label: string;
}

/**
 * A step's outputs and timings: what its scripts reported, nested to any
 * depth. Written by name on the server and read by name on the page, and not
 * typed field by field because the shape belongs to the scripts, which were
 * measured in companion-web and are vendored as they are.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form script output, see above
export type Char3dJson = Record<string, any>;

export interface Char3dRun {
  id: string;
  n: number;
  step: Char3dStep;
  createdAt: number;
  /** The run this one took its input from. */
  parent?: string;
  /** Why this run exists and what it changes from the last. */
  intent?: string;
  config: Record<string, unknown>;
  status: Char3dRunStatus;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Every supervisor job the run submitted, the last one being the current one while it runs. */
  jobs?: Char3dRunJob[];
  /** What is happening now, while the run is live. */
  stage?: string;
  outputs?: Char3dJson;
  timing?: Char3dJson;
  review?: Char3dReview;
}

/** One sheet of a `mode: "sheet"` ref run, after it was split and cross-checked. */
export interface Char3dSheetSet {
  index: number;
  sheet: string;
  seed?: number;
  views: Partial<Record<Char3dView, string>> | null;
  check: {
    segments: number;
    widths?: number[];
    heights?: number[];
    widthDiff?: number;
    heightDiff?: number;
    ok: boolean;
    /** Where the front and back figures are widest (the fists), as a share of the height from the top. */
    pose?: { front?: { handY: number; span: number; gapRows?: number }; back?: { handY: number; span: number; gapRows?: number } };
  };
}

export interface Char3dCharacterSummary extends Char3dCharacter {
  runs: number;
  lastRun?: Char3dRun;
}

export interface Char3dDetail {
  character: Char3dCharacter;
  runs: Char3dRun[];
  gallery: Char3dGalleryItem[];
  auto?: Char3dAuto;
}

/**
 * The two ways a character is built. Each step takes its defaults from the
 * profile (`server/char3d/profiles.ts`): the sheet's proportions, the measured
 * arm band, the face close-up, the rig's arm space. Stored as `chibi`.
 */
export type Char3dBody = 'chibi' | 'game';

export const CHAR3D_BODIES: readonly { value: Char3dBody; label: string; hint: string }[] = [
  { value: 'chibi', label: 'Chibi', hint: 'Big head, short body, PVC-figure look, whatever the picture’s style.' },
  { value: 'game', label: 'Game model (real proportions)', hint: 'Adult anime proportions, head about 1/7 of the height, like a gacha game 3D model.' },
];

export const char3dBody = (character: { chibi?: boolean }): Char3dBody => (character.chibi === false ? 'game' : 'chibi');

/** How the autopilot runs one character from the reference to a rig. */
export interface Char3dAutoOptions {
  /** The body profile: true chibi, false game model (`Char3dBody`). */
  chibi: boolean;
  /** 0-100: a run passes at or above this, with no criterion below its floor. */
  passScore: number;
  /** Sheets to try before giving up. */
  refTries: number;
  /** Meshes to try (each passing mesh is rigged; a failed rig spends a mesh try). */
  meshTries: number;
  /** The vision arm that writes the prompt and the reviews. */
  reviewer: string;
  /** Stop after this step passes instead of going on to the rig. */
  stopAfter?: Char3dStep;
}

export type Char3dAutoStage = 'describe' | Char3dStep;

export interface Char3dAutoEvent {
  at: number;
  stage: Char3dAutoStage;
  text: string;
  run?: string;
  score?: number;
  verdict?: Char3dVerdict;
}

/** One autopilot pass over a character (`<character>/auto.json`). */
export interface Char3dAuto {
  /** `interrupted`: the server stopped while it ran. */
  status: 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';
  stage?: Char3dAutoStage;
  options: Char3dAutoOptions;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** The runs that passed, per step. */
  result?: Partial<Record<Char3dStep, string>>;
  events: Char3dAutoEvent[];
  stopRequested?: boolean;
}

export const CHAR3D_AUTO_DEFAULTS: Char3dAutoOptions = {
  chibi: true,
  passScore: 75,
  refTries: 4,
  meshTries: 6,
  reviewer: 'text-qwen3vl-8b-llamacpp',
};

/** A rigged character saved for the animation review page. */
export interface Char3dReviewEntry {
  id: string;
  name: string;
  character: string;
  run: string;
  /** Relative to the character's directory. */
  model: string;
  thumb?: string;
  savedAt: number;
  missing?: boolean;
}

/** One clip of the Mixamo clip library (`rig/mixamo-lib/index.json`, built by `cliplib.py`). */
export interface Char3dClip {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  /** The clip's primary group (cliplib.py `category_of`): weapon, combat, dance, locomotion... or other. */
  category?: string;
  durS?: number;
  frames?: number;
  thumb?: boolean;
  source?: string;
}

export interface Char3dClipLibrary {
  clips: Char3dClip[];
  tagGroups: Record<string, string>;
  groupOrder: string[];
  builtAt?: number;
}

/** The key a gallery item is selected by: a run, or a run's sheet. */
export const galleryKey = (item: { run: string; set?: number }): string =>
  item.set === undefined ? item.run : `${item.run}#${item.set}`;

/** A character or run id: lowercase, digits, dash and underscore, starting with a letter or digit. */
export const CHAR3D_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * A character's id from its name: accents dropped, everything else a dash.
 *
 * The id is an identifier, so it is ASCII; the name stays as typed. Vietnamese
 * `đ` is spelled out because NFD does not decompose it.
 */
export function slugFor(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'char';
}
