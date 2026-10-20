// @vitest-environment node
/**
 * The character pipeline end to end, against stand-in arms.
 *
 * The stand-ins do what the real arms do with files and nothing else: read a
 * job's inputs under `inputs/`, write under `outputs/`, and answer with the
 * absolute paths they wrote. That is the part of the pipeline a model never
 * touches and the part most likely to be wrong -- staging, moving into the
 * store, renaming, relative paths in the record, the gallery between steps.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Char3dJson, Char3dRun } from '#shared/char3d';

import { fillSheetPrompt } from './prompts';
import { type Char3dCaller, createRun } from './runner';
import {
  addToGallery,
  charDir,
  charFile,
  createCharacter,
  galleryOf,
  getCharacter,
  getRun,
  patchRun,
  saveRun,
} from './store';

let storage: string;
const calls: { arm: string; job: Record<string, unknown>; params: Record<string, unknown> }[] = [];

function write(relativeToOutputs: string, contents = 'x'): string {
  const target = path.join(storage, 'outputs', relativeToOutputs);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function mustRead(relativeToInputs: string): void {
  if (!existsSync(path.join(storage, 'inputs', relativeToInputs))) {
    throw new Error(`the arm was handed ${relativeToInputs}, which is not under inputs/`);
  }
}

/** The four arms, as far as files go. */
const caller: Char3dCaller = {
  async job<T>(arm: string, request: { jobId: string; params?: Record<string, unknown>; job: unknown }): Promise<T> {
    const job = request.job as Char3dJson;
    calls.push({ arm, job, params: request.params ?? {} });
    if (arm === 'image-qwen21-turbo-official-comfy') {
      for (const ref of job['refImages']) mustRead(ref);
      const stem = String(job['outPath']).replace(/\.png$/, '');
      const images = Array.from({ length: Number(job['batch']) }, (_, index) => ({
        out_path: write(index === 0 ? `${stem}.png` : `${stem}-${index + 1}.png`),
        index,
        seed: 100 + index,
      }));
      return { images, seconds_total: 1, peak_vram_gib: 9, stages: [] } as T;
    }
    if (arm === 'mesh-pixal3d-comfy') {
      for (const view of Object.values(job['views'] as Record<string, string>)) mustRead(view);
      const glb = write(job['outPath'], 'glTF');
      const stem = String(job['outPath']).replace(/\.glb$/, '');
      const views = Object.fromEntries(Object.keys(job['views']).map((view) => [view, write(`${stem}_views/${view}.png`)]));
      return {
        mode: 'multi-view',
        model: 'pixal3d_multiview_bf16.safetensors',
        meshes: [{ out_path: glb, out_bytes: 4, seed: 7, faces: 300000, vertices: 150000, views, basecolor: write(`${stem}_basecolor.png`) }],
        seconds_total: 120,
        peak_vram_gib: 9.7,
        stages: [],
      } as T;
    }
    if (arm === 'mesh-char3d-tools' && job['task'] === 'split') {
      const sets = (job['sheets'] as string[]).map((sheet, index) => {
        mustRead(sheet);
        const views = Object.fromEntries(
          ['front', 'left', 'back'].map((view) => [view, write(`${job['outDir']}/sheet${index}_${view}.png`)]),
        );
        return { index, sheet: path.join(storage, 'inputs', sheet), views, check: { segments: 3, widthDiff: 0.01, heightDiff: index ? 0.05 : 0.01, ok: index === 0 } };
      });
      return { task: 'split', result: { sets }, seconds_total: 0.5, stages: [] } as T;
    }
    if (arm === 'mesh-char3d-tools' && job['task'] === 'reproject') {
      mustRead(job['glb']);
      const out = write(job['outPath'], 'glTF');
      return { task: 'reproject', result: { path: out, basecolor: write(String(job['outPath']).replace(/\.glb$/, '_basecolor.png')), views: {}, texels: {} } } as T;
    }
    if (arm === 'mesh-char3d-tools' && job['task'] === 'render') {
      mustRead(job['glb']);
      const tex = [0, 45].map((angle) => write(`${job['outDir']}/tex_${String(angle).padStart(3, '0')}.png`));
      return { task: 'render', result: { files: { tex, sheet_tex: write(`${job['outDir']}/sheet_tex.png`) }, info: { faces: 300000 } } } as T;
    }
    if (arm === 'rig-mia-skintokens') {
      mustRead(job['meshPath']);
      const out = String(job['outDir']);
      const rigged = write(`${out}/rigged.glb`, 'glTF');
      write(`${out}/rest.glb`, 'glTF');
      write(`${out}/info.json`, JSON.stringify({ restPose: 'A-pose', canonical: true, torsoClear: [] }));
      return { task: 'rig', result: { path: rigged, rest: path.join(path.dirname(rigged), 'rest.glb'), clips: [], bones: 22 } } as T;
    }
    throw new Error(`no stand-in for ${arm} ${job['task'] ?? ''}`);
  },
};

async function settle(id: string, run: string): Promise<Char3dRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await getRun(storage, id, run);
    if (record.status !== 'queued' && record.status !== 'running') return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${run} did not finish`);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeEach(() => {
  storage = mkdtempSync(path.join(tmpdir(), 'ai-studio-char3d-'));
  calls.length = 0;
});

afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
});

describe('a character from reference to rig', () => {
  it('runs each step on its own, through the gallery, and keeps every file in the store', async () => {
    const character = await createCharacter(storage, {
      name: 'Cậu bé võ sinh',
      subject: 'chibi boy',
      traits: 'white wrap shirt tied at the left hip',
      image: PNG,
      filename: 'boy.png',
    });
    expect(character.id).toBe('cau-be-vo-sinh');

    // 1. reference: ONE sheet, split and cross-checked -- a run asking for more still gets one
    const ref = await createRun(storage, caller, character.id, 'ref', { config: { batch: 2 } });
    expect(ref.config['mode']).toBe('sheet');
    expect(ref.config['batch']).toBe(1);
    expect(ref.config['width']).toBe(2048);
    expect(String((ref.config['prompts'] as Record<string, string>)['sheet'])).toContain('white wrap shirt tied at the left hip');
    const refDone = await settle(character.id, ref.id);
    expect(refDone.status, refDone.error).toBe('done');
    expect(refDone.outputs?.['images'].map((image: { file: string }) => image.file)).toEqual(['runs/r01-ref/ref/sheet_0.png']);
    const sets = refDone.outputs?.['sets'];
    expect(sets[0].views.front).toBe('runs/r01-ref/ref/sheet0_front.png');
    expect(sets[0].seed).toBe(100);
    expect(existsSync(charFile(storage, character.id, sets[0].views.back))).toBe(true);
    // Nothing is left in the arms' staging tree.
    expect(readdirSync(path.join(storage, 'outputs', '.char3d', character.id))).toEqual([]);

    // A pass with no picks puts every sheet that passed the cross-check in the gallery.
    await patchRun(storage, character.id, ref.id, { review: { score: 80, verdict: 'pass', summary: 'ok' } });
    const gallery = await galleryOf(storage, await getCharacter(storage, character.id));
    expect(gallery.map((item) => [item.run, item.set])).toEqual([[ref.id, 0]]);

    // 2. mesh from the gallery's sheet, re-projected, rendered
    const views = gallery[0]?.views ?? {};
    const mesh = await createRun(storage, caller, character.id, 'mesh', { parent: ref.id, config: { views } });
    const meshDone = await settle(character.id, mesh.id);
    expect(meshDone.status, meshDone.error).toBe('done');
    expect(meshDone.outputs?.['glb']).toBe('runs/r02-mesh/mesh.glb');
    expect(meshDone.outputs?.['raw']).toBe('runs/r02-mesh/mesh_pixal.glb');
    expect(meshDone.outputs?.['views']['front']).toBe('runs/r02-mesh/mesh_views/front.png');
    expect(meshDone.outputs?.['basecolor']).toBe('runs/r02-mesh/mesh_basecolor.png');
    expect(meshDone.outputs?.['renders'].files.tex[1]).toBe('runs/r02-mesh/renders/tex_045.png');
    const pixal = calls.find((call) => call.arm === 'mesh-pixal3d-comfy');
    expect(pixal?.job['compressTextures']).toBe(false);
    expect(Object.keys(pixal?.job['views'] as object)).toEqual(['front', 'left', 'back']);
    expect(pixal?.params).toEqual({});

    await patchRun(storage, character.id, mesh.id, { review: { score: 85, verdict: 'pass', summary: 'face ok' } });

    // 3. rig: the default clips are not on disk, so they are left out and said so
    const rig = await createRun(storage, caller, character.id, 'rig', {
      parent: mesh.id,
      config: { mesh: meshDone.outputs?.['glb'], armSpace: 30 },
    });
    const rigDone = await settle(character.id, rig.id);
    expect(rigDone.status, rigDone.error).toBe('done');
    expect(rigDone.outputs?.['glb']).toBe('runs/r03-rig/rig/rigged.glb');
    expect(rigDone.outputs?.['rest']).toBe('runs/r03-rig/rig/rest.glb');
    expect(rigDone.outputs?.['rigInfo'].restPose).toBe('A-pose');
    expect(rigDone.outputs?.['clipsMissing']).toHaveLength(6);
    const rigCall = calls.find((call) => call.arm === 'rig-mia-skintokens');
    expect(rigCall?.job['options']).toEqual({ armSpace: 30 });
    expect(rigDone.jobs?.map((job) => job.label)).toEqual(['Rig', 'Render clips']);
  });

  it('asks Pixal3D for the int8 transformer only when a run says so', async () => {
    const character = await createCharacter(storage, { name: 'A', image: PNG });
    mkdirSync(path.join(charDir(storage, character.id), 'views'), { recursive: true });
    writeFileSync(path.join(charDir(storage, character.id), 'views', 'f.png'), PNG);
    const run = await createRun(storage, caller, character.id, 'mesh', {
      config: { views: { front: 'views/f.png' }, precision: 'int8', faces: 100000, reproject: false },
    });
    await settle(character.id, run.id);
    const pixal = calls.find((call) => call.arm === 'mesh-pixal3d-comfy');
    expect(pixal?.params).toEqual({ multiviewModel: 'models/pixal3d/pixal3d_multiview_int8_convrot.safetensors' });
    // companion-web's name for the face budget reaches the arm under the arm's own.
    expect(pixal?.job['targetFaces']).toBe(100000);
    expect(calls.some((call) => call.job['task'] === 'reproject')).toBe(false);
  });
});

describe('refusals', () => {
  it('refuses a setting the rig would not understand, before anything is queued', async () => {
    const character = await createCharacter(storage, { name: 'B', image: PNG });
    writeFileSync(path.join(charDir(storage, character.id), 'mesh.glb'), 'glTF');
    await expect(
      createRun(storage, caller, character.id, 'rig', { config: { mesh: 'mesh.glb', armSpaceDeg: 30 } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toEqual([]);
  });

  it('never resolves a path outside the character', async () => {
    const character = await createCharacter(storage, { name: 'C', image: PNG });
    expect(() => charFile(storage, character.id, '../other/ref.png')).toThrow();
    expect(() => charFile(storage, character.id, path.resolve(storage, 'x.png'))).toThrow();
  });

  it('only lets a finished ref run into the gallery with a sheet that split', async () => {
    const character = await createCharacter(storage, { name: 'D', image: PNG });
    await saveRun(storage, character.id, {
      id: 'r01-ref',
      n: 1,
      step: 'ref',
      createdAt: 0,
      config: {},
      status: 'done',
      outputs: { sets: [{ index: 0, sheet: 's.png', views: null, check: { segments: 4, ok: false } }] },
    });
    await expect(addToGallery(storage, character.id, { run: 'r01-ref', set: 0 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('a run the server lost', () => {
  it('reads as interrupted rather than as running for ever', async () => {
    const character = await createCharacter(storage, { name: 'E', image: PNG });
    await saveRun(storage, character.id, { id: 'r01-mesh', n: 1, step: 'mesh', createdAt: 0, config: {}, status: 'running' });
    const run = await getRun(storage, character.id, 'r01-mesh');
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/interrupted/);
  });
});

describe('the sheet prompt', () => {
  it('carries the traits and the run’s own change, and calls the reference <image1>', () => {
    const prompt = fillSheetPrompt({ subject: 'chibi girl', traits: 'pink hairpin on the left. ' }, 'no ribbon tails.');
    expect(prompt).toContain('the chibi girl from <image1>');
    expect(prompt).toContain('Outfit exactly as <image1>: pink hairpin on the left. no ribbon tails.');
    expect(prompt).toContain('EXACTLY THREE full-body figures');
  });
});
