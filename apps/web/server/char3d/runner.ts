/**
 * Creating a run, and running it.
 *
 * A run is one step of one character, and it is a chain of supervisor jobs:
 *
 * | step | jobs |
 * | --- | --- |
 * | ref  | the image arm once per view (a sheet is one "view"), then the tools arm splits and cross-checks each sheet |
 * | mesh | Pixal3D (skipped by `retexture`), the tools arm re-projects the input views' colours (with `hairFix` fuses the hair, with `faceFix` flattens a chibi muzzle), then renders the checks |
 * | rig  | the rig arm, then the tools arm renders the clips and measures stretch and hands in the body |
 *
 * Every job is a real supervisor job, so the broker puts the right arm on the
 * card for each and the page follows each one's own timeline (`run.jobs`).
 * Runs go through one queue in this process, one at a time: two runs would
 * only take turns evicting each other's arm.
 *
 * Nothing here scores anything. A run ends `done` with its outputs and waits
 * for a review, written by whoever looked at it.
 */

import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { createError } from 'h3';

import {
  CHAR3D_VIEWS,
  type Char3dCharacter,
  type Char3dJson,
  type Char3dRun,
  type Char3dRunJob,
  type Char3dSheetSet,
  type Char3dStep,
} from '#shared/char3d';

import {
  DEFAULT_REF_PROMPTS,
  fillRefPrompt,
  fillSheetPrompt,
  REF_PROMPT_VERSION,
  SHEET_SIZE,
  VIEW_SIZE,
} from './prompts';
import { collectOut, outRel, stageIn } from './staging';
import {
  charDir,
  charFile,
  getCharacter,
  getRun,
  isView,
  markDone,
  markLive,
  nextRunId,
  relOf,
  runDir,
  saveRun,
} from './store';

// Turbo, not Lightning: given an open-handed original, Lightning's four steps
// copy the hand straight into the front view (0/20 fists); Turbo on the same
// sheet prompt closes them 4/4.
export const REF_ARM_DEFAULT = 'image-qwen21-turbo-official-comfy';
export const MESH_ARM_DEFAULT = 'mesh-pixal3d-comfy';
export const RIG_ARM_DEFAULT = 'rig-mia-skintokens';
export const TOOLS_ARM = 'mesh-char3d-tools';

/** The multi-view transformer, int8, for `precision: "int8"`. bf16 is the arm's own default. */
const PIXAL3D_INT8_MULTIVIEW = 'models/pixal3d/pixal3d_multiview_int8_convrot.safetensors';

/**
 * The rig step's default clips, relative to the models directory. The Mixamo
 * dataset names its clips by hash; these six were picked from the automatic
 * catalog and then looked at on the first chibi character. Run is the
 * "Standard Run" shipped with Make-It-Animatable -- the catalog's "run" hunches.
 *
 * Walk is the fixed check clip: it ends with both hands pressed behind the
 * hips, which on a big-bodied chibi is where a hand sinks into the waist.
 * render.py measures `handInBody` on every clip after every rig; keep Walk in.
 */
export const DEFAULT_RIG_ANIMATIONS = [
  { name: 'Idle', path: 'rig/mixamo/animation/3096cfbfdee2ae25839f87f2a1bbb990.fbx' },
  { name: 'Walk', path: 'rig/mixamo/animation/b43f0d184adbb90490e4b2bd8544d06a.fbx' },
  { name: 'Run', path: 'rig/mixamo/extra/Standard Run.fbx' },
  { name: 'Jump', path: 'rig/mixamo/animation/974f88fd4f199ad531617c10db365d73.fbx' },
  { name: 'Wave', path: 'rig/mixamo/animation/155309ffdd8ff5956a48f64278e5bde8.fbx' },
  { name: 'Dance', path: 'rig/mixamo/animation/9696aafe2b85750100df067600778d1b.fbx' },
] as const;

/** `rig.py`'s switches a run may set; the arm refuses anything else. */
const RIG_OPTIONS = [
  'restPose',
  'noFingers',
  'retarget',
  'inplace',
  'weightFix',
  'headTarget',
  'seed',
  'prep',
  'weights',
  'armSmooth',
  'legSmooth',
  'rigidHand',
  'armSpace',
  'torsoClear',
  'kneeRaise',
  'sleeveSkinFix',
  'faceFromRef',
  'canonical',
];

/**
 * The Pixal3D job's own fields a run may set, and the older companion-web
 * names some runs use for them.
 */
const MESH_FIELDS: Record<string, string> = {
  seed: 'seed',
  structureSteps: 'structureSteps',
  shapeSteps: 'shapeSteps',
  refineSteps: 'refineSteps',
  textureSteps: 'textureSteps',
  structureCfg: 'structureCfg',
  shapeCfg: 'shapeCfg',
  shapeResolution: 'shapeResolution',
  resolution: 'shapeResolution',
  remeshResolution: 'remeshResolution',
  targetFaces: 'targetFaces',
  faces: 'targetFaces',
  textureSize: 'textureSize',
  fov: 'fov',
  pad: 'pad',
  dropInverted: 'dropInverted',
  dropEnclosed: 'dropEnclosed',
  bakeNormals: 'bakeNormals',
  bakeOcclusion: 'bakeOcclusion',
};
const MESH_RUNNER_KEYS = ['arm', 'views', 'reproject', 'retexture', 'precision', 'hairFix', 'faceFix'];

/** What the runner needs from the supervisor. */
export interface Char3dCaller {
  job<T>(armId: string, request: { jobId: string; params?: Record<string, unknown>; job: unknown }): Promise<T>;
}

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: 'invalid_request', data: { message } });
}

// --- creating a run -----------------------------------------------------------

export interface NewRun {
  parent?: unknown;
  intent?: unknown;
  config?: Record<string, unknown>;
}

/**
 * A run's config, made complete before anything runs, so run.json says
 * exactly what was asked -- the prompt in full, the size, the arm.
 *
 *   ref:  { mode?: 'sheet' (default) | 'views', extra?, arm?, views?, prompts?, batch?, width?, height?, seed?, extraRefs? }
 *   mesh: { arm?, views: {front, left?, back?, right?}, seed?, reproject?, retexture?, precision?, hairFix?, faceFix?, ...Pixal3D fields }
 *   rig:  { arm?, mesh, animations?, predFrom?, skinFrom?, ...rig.py switches }
 */
async function normalise(
  storageDir: string,
  character: Char3dCharacter,
  step: Char3dStep,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = { ...raw };
  const id = character.id;
  const extraRefs = Array.isArray(config['extraRefs']) ? config['extraRefs'].map(String) : [];
  for (const rel of extraRefs) if (!existsSync(charFile(storageDir, id, rel))) bad(`no file ${rel}`);

  if (step === 'ref') {
    config['arm'] ||= REF_ARM_DEFAULT;
    config['extraRefs'] = extraRefs;
    if ((config['mode'] ?? 'sheet') === 'sheet' && !config['prompts']) {
      // One pseudo-view called `sheet`: the arm draws `ref/sheet.png` (and
      // `sheet-2.png`...), then split_sheet.py cuts each into three views and
      // cross-checks them.
      const extra = String(config['extra'] ?? '');
      config['mode'] = 'sheet';
      config['views'] = ['sheet'];
      config['extra'] = extra;
      config['prompts'] = { sheet: fillSheetPrompt(character, extra) };
      config['promptVersion'] = `sheet-${REF_PROMPT_VERSION}`;
      // Exactly one sheet per run: each generation is reviewed on its own before
      // anything else is drawn. More sheets are more runs.
      config['batch'] = 1;
      config['width'] = SHEET_SIZE.width;
      config['height'] = SHEET_SIZE.height;
    } else {
      const views = (Array.isArray(config['views']) && config['views'].length ? config['views'] : ['front'])
        .map(String)
        .filter(isView);
      if (!views.length) bad('config.views must name front, left, back or right');
      const given = (config['prompts'] ?? {}) as Record<string, string>;
      config['mode'] = 'views';
      config['views'] = views;
      config['prompts'] = Object.fromEntries(
        views.map((view) => [view, fillRefPrompt(given[view] || DEFAULT_REF_PROMPTS[view], character)]),
      );
      config['promptVersion'] = Object.keys(given).length ? 'custom' : REF_PROMPT_VERSION;
      config['batch'] = Math.max(1, Math.min(8, Number(config['batch']) || 2));
      config['width'] = Number(config['width']) || VIEW_SIZE.width;
      config['height'] = Number(config['height']) || VIEW_SIZE.height;
    }
    return config;
  }

  if (step === 'mesh') {
    config['arm'] ||= MESH_ARM_DEFAULT;
    const unknown = Object.keys(config).filter((key) => !(key in MESH_FIELDS) && !MESH_RUNNER_KEYS.includes(key));
    if (unknown.length) bad(`unknown mesh setting ${unknown.join(', ')}`);
    if (config['retexture']) {
      const source = await getRun(storageDir, id, String(config['retexture']));
      if (source.step !== 'mesh' || source.status !== 'done') bad('retexture must name a finished mesh run');
      return config;
    }
    const views = (config['views'] ?? {}) as Record<string, string>;
    if (!views['front']) bad('config.views.front is required');
    for (const [view, rel] of Object.entries(views)) {
      if (!isView(view)) bad(`unknown view ${view}`);
      if (!existsSync(charFile(storageDir, id, rel))) bad(`no file ${rel}`);
    }
    return config;
  }

  config['arm'] ||= RIG_ARM_DEFAULT;
  if (!config['mesh'] || !existsSync(charFile(storageDir, id, String(config['mesh'])))) {
    bad('config.mesh must point at a GLB of this character');
  }
  const unknown = Object.keys(config).filter(
    (key) => !RIG_OPTIONS.includes(key) && !['arm', 'mesh', 'animations', 'predFrom', 'skinFrom'].includes(key),
  );
  if (unknown.length) bad(`unknown rig setting ${unknown.join(', ')}`);
  for (const key of ['predFrom', 'skinFrom']) {
    if (config[key] && !existsSync(charFile(storageDir, id, String(config[key])))) bad(`no file ${config[key]}`);
  }
  return config;
}

export async function createRun(
  storageDir: string,
  caller: Char3dCaller,
  id: string,
  step: unknown,
  body: NewRun,
): Promise<Char3dRun> {
  if (step !== 'ref' && step !== 'mesh' && step !== 'rig') bad(`step must be ref, mesh or rig`);
  const character = await getCharacter(storageDir, id);
  const config = await normalise(storageDir, character, step, body.config ?? {});
  const { id: runId, n } = await nextRunId(storageDir, id, step);
  const run: Char3dRun = {
    id: runId,
    n,
    step,
    createdAt: Date.now(),
    ...(body.parent ? { parent: String(body.parent) } : {}),
    ...(body.intent ? { intent: String(body.intent) } : {}),
    config,
    status: 'queued',
    jobs: [],
  };
  await saveRun(storageDir, id, run);
  enqueue(storageDir, caller, id, runId);
  return run;
}

// --- the queue ------------------------------------------------------------------

let tail: Promise<void> = Promise.resolve();

function enqueue(storageDir: string, caller: Char3dCaller, id: string, runId: string): void {
  markLive(id, runId);
  const work = (): Promise<void> => execute(storageDir, caller, id, runId).finally(() => markDone(id, runId));
  tail = tail.then(work, work);
}

// --- running it -----------------------------------------------------------------

interface ArmReportBase {
  seconds_total?: number;
  peak_vram_gib?: number;
  stages?: { name: string; seconds: number }[];
}

interface ImageReport extends ArmReportBase {
  images: { out_path: string; index: number; seed: number }[];
}

interface MeshReport extends ArmReportBase {
  mode: string;
  model: string;
  meshes: {
    out_path: string;
    out_bytes: number;
    seed: number;
    faces: number | null;
    vertices: number | null;
    views: Record<string, string>;
    basecolor: string | null;
  }[];
}

interface ToolReport extends ArmReportBase {
  task: string;
  result: Char3dJson;
}

const timingOf = (report: ArmReportBase): Record<string, unknown> => ({
  seconds: report.seconds_total,
  peakVramGib: report.peak_vram_gib,
  stages: report.stages,
});

async function execute(storageDir: string, caller: Char3dCaller, id: string, runId: string): Promise<void> {
  let run = await getRun(storageDir, id, runId);
  const started = Date.now();
  const timing: Record<string, unknown> = {};
  const outputs: Char3dJson = {};
  const jobPrefix = `c3-${id.slice(0, 16)}-${runId}-${Math.random().toString(36).slice(2, 6)}`;

  const save = async (patch: Partial<Char3dRun>): Promise<void> => {
    run = { ...run, ...patch };
    await saveRun(storageDir, id, run);
  };

  /** One supervisor job, recorded on the run before it is submitted so the page can follow it. */
  const job = async <T>(arm: string, label: string, body: unknown, params: Record<string, unknown> = {}) => {
    const entry: Char3dRunJob = { id: `${jobPrefix}-${(run.jobs?.length ?? 0) + 1}`, arm, label };
    await save({ jobs: [...(run.jobs ?? []), entry], stage: label });
    return caller.job<T>(arm, { jobId: entry.id, params, job: body });
  };

  const rel = (absolute: string): string => relOf(storageDir, id, absolute);
  /** Every string in a script's result that is a path into the run, made relative to the character. */
  const relDeep = (value: unknown, map: (reported: string) => string): unknown => {
    if (typeof value === 'string' && path.isAbsolute(value)) {
      try {
        return rel(map(value));
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return value.map((entry) => relDeep(entry, map));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, relDeep(entry, map)]));
    }
    return value;
  };

  try {
    await save({ status: 'running', startedAt: started });
    const config = run.config;
    const dir = runDir(storageDir, id, runId);

    if (run.step === 'ref') {
      const character = await getCharacter(storageDir, id);
      const refs = [
        path.join(charDir(storageDir, id), character.ref),
        ...((config['extraRefs'] as string[]) ?? []).map((file) => charFile(storageDir, id, file)),
      ];
      const refImages = await Promise.all(refs.map((file) => stageIn(storageDir, id, file)));
      const images: { view: string; file: string; seed?: number }[] = [];
      const perView: Record<string, unknown> = {};

      for (const view of config['views'] as string[]) {
        const report = await job<ImageReport>(String(config['arm']), `Generate ${view}`, {
          prompt: (config['prompts'] as Record<string, string>)[view],
          outPath: outRel(id, runId, 'ref', `${view}.png`),
          width: config['width'],
          height: config['height'],
          batch: config['batch'],
          refImages,
          ...(config['seed'] !== undefined && config['seed'] !== null ? { seed: Number(config['seed']) } : {}),
        });
        const map = await collectOut(storageDir, id, runId);
        for (const image of report.images) {
          // `sheet.png`, `sheet-2.png`... renamed `sheet_0.png`, `sheet_1.png`, as run records have always named them.
          const from = map(image.out_path);
          const to = path.join(dir, 'ref', `${view}_${image.index}.png`);
          if (from !== to) await rename(from, to);
          images.push({ view, file: rel(to), seed: image.seed });
        }
        perView[view] = timingOf(report);
      }
      outputs['images'] = images;
      timing['perView'] = perView;

      if (config['mode'] === 'sheet') {
        // Cut each sheet into front/left/back and cross-check them. A sheet
        // that cannot be split keeps its image, with no views: it cannot go
        // into the gallery, but it is there to look at.
        await save({ outputs });
        const sheets = await Promise.all(images.map((image) => stageIn(storageDir, id, charFile(storageDir, id, image.file))));
        const report = await job<ToolReport>(TOOLS_ARM, 'Split sheets', {
          task: 'split',
          sheets,
          outDir: outRel(id, runId, 'ref'),
        });
        const map = await collectOut(storageDir, id, runId);
        const sets = (report.result['sets'] ?? []) as Char3dJson[];
        outputs['sets'] = sets.map(
          (set, index): Char3dSheetSet => ({
            index: Number(set['index'] ?? index),
            sheet: images[Number(set['index'] ?? index)]?.file ?? '',
            ...(images[Number(set['index'] ?? index)]?.seed !== undefined
              ? { seed: images[Number(set['index'] ?? index)]?.seed }
              : {}),
            views: set['views']
              ? Object.fromEntries(
                  Object.entries(set['views'] as Record<string, string>).map(([view, file]) => [view, rel(map(file))]),
                )
              : null,
            check: set['check'] as Char3dSheetSet['check'],
          }),
        );
        timing['split'] = timingOf(report);
      }
    } else if (run.step === 'mesh') {
      const meshOut = path.join(dir, 'mesh.glb');
      let views: Record<string, string> = {};
      let basecolor: string | undefined;

      if (config['retexture']) {
        // Keep a geometry that was already approved and only colour it again:
        // Pixal3D is not deterministic even on the same seed, so running it
        // again would change the shape as well.
        const source = await getRun(storageDir, id, String(config['retexture']));
        const so = source.outputs ?? {};
        await copyFile(charFile(storageDir, id, String(so['raw'] ?? so['glb'])), meshOut);
        views = Object.fromEntries(
          Object.entries((so['views'] ?? {}) as Record<string, string>).map(([view, file]) => [view, charFile(storageDir, id, file)]),
        );
        outputs['seed'] = so['seed'];
        outputs['params'] = so['params'];
      } else {
        const inputViews: Record<string, string> = {};
        for (const view of CHAR3D_VIEWS) {
          const file = (config['views'] as Record<string, string>)[view];
          if (file) inputViews[view] = await stageIn(storageDir, id, charFile(storageDir, id, file));
        }
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(config)) {
          const field = MESH_FIELDS[key];
          if (field && value !== undefined && value !== null) fields[field] = value;
        }
        const params = config['precision'] === 'int8' ? { multiviewModel: PIXAL3D_INT8_MULTIVIEW } : {};
        const report = await job<MeshReport>(
          String(config['arm']),
          'Pixal3D',
          {
            ...fields,
            outPath: outRel(id, runId, 'mesh.glb'),
            views: inputViews,
            batch: 1,
            // The re-projection and the rig read the GLB with trimesh, which drops EXT_texture_webp.
            compressTextures: false,
          },
          params,
        );
        const map = await collectOut(storageDir, id, runId);
        const mesh = report.meshes[0];
        if (!mesh) throw new Error('the mesh arm reported no mesh');
        views = Object.fromEntries(Object.entries(mesh.views).map(([view, file]) => [view, map(file)]));
        basecolor = mesh.basecolor ? map(mesh.basecolor) : undefined;
        outputs['seed'] = mesh.seed;
        outputs['faces'] = mesh.faces;
        outputs['params'] = { mode: report.mode, model: report.model, ...fields };
        timing['mesh'] = timingOf(report);
      }
      outputs['glb'] = rel(meshOut);
      outputs['views'] = Object.fromEntries(Object.entries(views).map(([view, file]) => [view, rel(file)]));
      if (basecolor) outputs['basecolor'] = rel(basecolor);

      // Pixal3D's texture is a lottery -- the face, the hairpins, streaks in
      // the hair, a darker pink -- while its shape is stable, and the shape is
      // pixel-aligned to each input view. So the views' own colours are
      // projected back onto the atlas. The untouched GLB stays as mesh_pixal.glb.
      if (config['reproject'] !== false && Object.keys(views).length) {
        const raw = path.join(dir, 'mesh_pixal.glb');
        await rename(meshOut, raw);
        outputs['raw'] = rel(raw);
        outputs['basecolorRaw'] = outputs['basecolor'];
        await save({ outputs });
        try {
          const stagedViews: Record<string, string> = {};
          for (const [view, file] of Object.entries(views)) stagedViews[view] = await stageIn(storageDir, id, file);
          // `reproject: { lumMix, hairChroma, hairLum, flow }` tunes the projection; `true` or absent is the defaults.
          const options = typeof config['reproject'] === 'object' && config['reproject'] !== null ? config['reproject'] : undefined;
          const report = await job<ToolReport>(TOOLS_ARM, 'Re-project colours', {
            task: 'reproject',
            glb: await stageIn(storageDir, id, raw),
            outPath: outRel(id, runId, 'mesh.glb'),
            views: stagedViews,
            ...(options ? { options } : {}),
          });
          const map = await collectOut(storageDir, id, runId);
          outputs['basecolor'] = rel(map(String(report.result['basecolor'])));
          outputs['reproject'] = {
            views: report.result['views'],
            texels: report.result['texels'],
            hair: report.result['hair'],
            lum: report.result['lum'],
          };
          timing['reproject'] = timingOf(report);
        } catch (error) {
          // A failed re-projection still leaves Pixal3D's own mesh: put it
          // back, say why, and carry on.
          await rename(raw, meshOut);
          delete outputs['raw'];
          outputs['basecolor'] = outputs['basecolorRaw'];
          outputs['reproject'] = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      // Pixal3D builds long hair as shredded cards; `hairFix` (true, or the
      // script's options) fuses them into solid locks, keeping the fringe.
      // The mesh before it stays as mesh_prehair.glb.
      if (config['hairFix']) {
        const before = path.join(dir, 'mesh_prehair.glb');
        await rename(meshOut, before);
        outputs['prehair'] = rel(before);
        await save({ outputs });
        try {
          const options = typeof config['hairFix'] === 'object' ? config['hairFix'] : undefined;
          const report = await job<ToolReport>(TOOLS_ARM, 'Fuse hair', {
            task: 'hairfix',
            glb: await stageIn(storageDir, id, before),
            outPath: outRel(id, runId, 'mesh.glb'),
            ...(options ? { options } : {}),
          });
          await collectOut(storageDir, id, runId);
          const stats = { ...report.result };
          delete stats['out'];
          outputs['hairFix'] = stats;
          timing['hairFix'] = timingOf(report);
        } catch (error) {
          await rename(before, meshOut);
          delete outputs['prehair'];
          outputs['hairFix'] = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      // Pixal3D makes a chibi face into a muzzle (a wedge at the mouth, big ears
      // out to the sides); `faceFix` (true, or the script's options) flattens
      // it. The mesh before it stays as mesh_preface.glb.
      if (config['faceFix']) {
        const before = path.join(dir, 'mesh_preface.glb');
        await rename(meshOut, before);
        outputs['preface'] = rel(before);
        await save({ outputs });
        try {
          const options = typeof config['faceFix'] === 'object' ? config['faceFix'] : undefined;
          const report = await job<ToolReport>(TOOLS_ARM, 'Flatten the muzzle', {
            task: 'facefix',
            glb: await stageIn(storageDir, id, before),
            outPath: outRel(id, runId, 'mesh.glb'),
            ...(options ? { options } : {}),
          });
          await collectOut(storageDir, id, runId);
          const stats = { ...report.result };
          delete stats['out'];
          outputs['faceFix'] = stats;
          timing['faceFix'] = timingOf(report);
        } catch (error) {
          await rename(before, meshOut);
          delete outputs['preface'];
          outputs['faceFix'] = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      outputs['bytes'] = (await stat(meshOut)).size;
      await save({ outputs });
      outputs['renders'] = await render(meshOut, 'turntable');
    } else {
      const mesh = charFile(storageDir, id, String(config['mesh']));
      const meshInput = await stageIn(storageDir, id, mesh);
      // rig.py's `faceFromRef` reads the mesh's sibling `mesh_views/front.png`.
      const front = path.join(path.dirname(mesh), 'mesh_views', 'front.png');
      if (existsSync(front)) await stageIn(storageDir, id, front);

      const modelsDir = path.resolve(storageDir, 'models');
      const requested = (config['animations'] as { name: string; path: string }[] | undefined) ?? null;
      // The defaults come from a gated dataset; a clip that is not on disk is
      // left out and said so, rather than failing the rig. Clips a run names
      // itself are not filtered: the arm refuses a missing one.
      const animations = requested ?? DEFAULT_RIG_ANIMATIONS.filter((clip) => existsSync(path.join(modelsDir, clip.path)));
      if (!requested) {
        const skipped = DEFAULT_RIG_ANIMATIONS.filter((clip) => !animations.includes(clip)).map((clip) => clip.name);
        if (skipped.length) outputs['clipsMissing'] = skipped;
      }

      const options: Record<string, unknown> = {};
      for (const key of RIG_OPTIONS) if (config[key] !== undefined) options[key] = config[key];
      const report = await job<ToolReport>(String(config['arm']), 'Rig', {
        task: 'rig',
        meshPath: meshInput,
        outDir: outRel(id, runId, 'rig'),
        animations: animations.map((clip) => ({ name: clip.name, path: clip.path })),
        options,
        ...(config['predFrom']
          ? { predFrom: await stageIn(storageDir, id, charFile(storageDir, id, String(config['predFrom']))) }
          : {}),
        ...(config['skinFrom']
          ? { skinFrom: await stageIn(storageDir, id, charFile(storageDir, id, String(config['skinFrom']))) }
          : {}),
      });
      const map = await collectOut(storageDir, id, runId);
      const result = report.result;
      const rigDir = path.join(dir, 'rig');
      const optional = (name: string): string | undefined =>
        existsSync(path.join(rigDir, name)) ? rel(path.join(rigDir, name)) : undefined;
      Object.assign(outputs, {
        glb: rel(map(String(result['path']))),
        ...(result['fbx'] && existsSync(map(String(result['fbx']))) ? { fbx: rel(map(String(result['fbx']))) } : {}),
        ...(result['rest'] ? { rest: rel(map(String(result['rest']))) } : {}),
        joints: optional('joints.glb'),
        bw: optional('bw.glb'),
        clips: result['clips'],
        bones: result['bones'],
      });
      try {
        const info = JSON.parse(await readFile(path.join(rigDir, 'info.json'), 'utf8')) as Record<string, unknown>;
        // What the rig actually used -- the arm fills in its own defaults --
        // so two runs can be compared on the page.
        outputs['rigInfo'] = Object.fromEntries(
          ['restPose', 'canonical', 'headShrink', 'weightFix', 'noFingers', 'retarget', 'kneeRaise', 'torsoClear', 'armRollFixed', 'phaseMs'].map(
            (key) => [key, info[key]],
          ),
        );
      } catch {
        // info.json is a report; a rig without it is still a rig.
      }
      timing['rig'] = timingOf(report);
      await save({ outputs });
      outputs['renders'] = await render(map(String(result['path'])), 'anim');
    }

    timing['totalMs'] = Date.now() - started;
    await save({ status: 'done', finishedAt: Date.now(), outputs, timing, stage: undefined });
  } catch (error) {
    const message =
      (error as { data?: { message?: string } })?.data?.message ??
      (error instanceof Error ? error.message : String(error));
    timing['totalMs'] = Date.now() - started;
    await save({ status: 'error', error: message, finishedAt: Date.now(), outputs, timing, stage: undefined });
  }

  /** Check renders of a mesh or a rig, on the tools arm. Their own timing, under `renders`. */
  async function render(glb: string, mode: 'turntable' | 'anim'): Promise<Record<string, unknown>> {
    const report = await job<ToolReport>(TOOLS_ARM, mode === 'anim' ? 'Render clips' : 'Render turntable', {
      task: 'render',
      glb: await stageIn(storageDir, id, glb),
      outDir: outRel(id, runId, 'renders'),
      mode,
      options: { res: mode === 'anim' ? 512 : 768, frames: 8 },
    });
    const map = await collectOut(storageDir, id, runId);
    timing[`render-${mode}`] = timingOf(report);
    return { files: relDeep(report.result['files'], map), info: report.result['info'] };
  }
}
