/**
 * A rig draft as the editor holds it, and the bytes it travels as.
 *
 * The arm writes three files per draft (see the rig arm's `rigdata.py`):
 * `mesh.glb`, `rig.json`, and `weights.bin` -- four influences per vertex,
 * vertexCount x 4 float32 weights followed by vertexCount x 4 uint8 bone
 * indices. The editor sends the weights back in exactly that layout.
 */

import type { RigDraftInfo } from '#shared/generate';

export const INFLUENCES = 4;

/** Four influences per vertex, flat: vertex `v`'s slots are `v * 4` to `v * 4 + 3`. */
export interface InfluenceBuffers {
  indices: Uint8Array;
  values: Float32Array;
}

export function decodeWeights(buffer: ArrayBuffer, vertexCount: number, boneCount: number): InfluenceBuffers {
  const slots = vertexCount * INFLUENCES;
  if (buffer.byteLength !== slots * 5) {
    throw new Error(`weights.bin is ${buffer.byteLength} bytes; ${vertexCount} vertices need ${slots * 5}`);
  }
  // Copied out, so edits never write through to the fetched buffer.
  const values = new Float32Array(buffer.slice(0, slots * 4));
  const indices = new Uint8Array(buffer.slice(slots * 4));
  for (const index of indices) {
    if (index >= boneCount) throw new Error(`weights.bin names bone ${index}; the rig has ${boneCount}`);
  }
  return { indices, values };
}

export function encodeWeights({ indices, values }: InfluenceBuffers): Uint8Array {
  const out = new Uint8Array(values.byteLength + indices.byteLength);
  out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 0);
  out.set(indices, values.byteLength);
  return out;
}

export function draftUrl(draftId: string, file: 'mesh.glb' | 'rig.json' | 'weights.bin'): string {
  return `/api/rig/drafts/${encodeURIComponent(draftId)}/${file}`;
}

export interface LoadedDraft {
  id: string;
  info: RigDraftInfo;
  weights: InfluenceBuffers;
}

export async function loadDraft(draftId: string): Promise<LoadedDraft> {
  const [info, weightsBuffer] = await Promise.all([
    $fetch<RigDraftInfo>(draftUrl(draftId, 'rig.json')),
    $fetch<ArrayBuffer>(draftUrl(draftId, 'weights.bin'), { responseType: 'arrayBuffer' }),
  ]);
  return { id: draftId, info, weights: decodeWeights(weightsBuffer, info.vertexCount, info.bones.length) };
}
