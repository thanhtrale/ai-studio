import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The clips the rig arm can put on a mesh: its built-in ones, then every
 * Mixamo FBX in the clip folder, named by file.
 *
 * Read here rather than asked of the arm, so the console can offer them
 * without the arm being on the card. The built-in list is the arm's
 * `builtin_clips.BUILTIN`, and has to change with it.
 */
const BUILTIN = ['Idle', 'Nod', 'Wave'];
const CLIP_DIR = ['models', 'mixamo-clips'];
const CLIP_NAME = /^[A-Za-z0-9 _.()-]{1,80}$/;

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  let files: string[];
  try {
    files = await readdir(path.join(config.storageDir, ...CLIP_DIR));
  } catch {
    files = [];
  }
  const mixamo = files
    .filter((name) => name.toLowerCase().endsWith('.fbx'))
    .map((name) => name.slice(0, -'.fbx'.length))
    .filter((name) => CLIP_NAME.test(name) && !BUILTIN.includes(name))
    .sort((a, b) => a.localeCompare(b));
  return {
    clips: [
      ...BUILTIN.map((name) => ({ name, source: 'builtin' as const })),
      ...mixamo.map((name) => ({ name, source: 'mixamo' as const })),
    ],
    folder: CLIP_DIR.join('/'),
  };
});
