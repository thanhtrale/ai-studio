import { describe, expect, it } from 'vitest';

import { decodeWeights, encodeWeights, type InfluenceBuffers } from './draft';
import { History } from './history';
import { applyDab, SpatialGrid, swapStroke, type PaintContext, type StrokeRecord } from './paint';
import {
  adjacency,
  clean,
  dominantBone,
  groupMembers,
  heat,
  setWeight,
  weightOf,
  weldGroups,
  type Brush,
} from './weights';

function influences(rows: [number, number][][]): InfluenceBuffers {
  const indices = new Uint8Array(rows.length * 4);
  const values = new Float32Array(rows.length * 4);
  rows.forEach((row, v) =>
    row.forEach(([bone, value], s) => {
      indices[v * 4 + s] = bone;
      values[v * 4 + s] = value;
    }),
  );
  return { indices, values };
}

const sum = (w: InfluenceBuffers, v: number): number => [0, 1, 2, 3].reduce((t, s) => t + w.values[v * 4 + s]!, 0);

describe('setWeight', () => {
  it('raises one bone and lowers the others in proportion', () => {
    const w = influences([[[0, 0.5], [1, 0.3], [2, 0.2]]]);
    setWeight(w, 0, 0, 0.8, -1);
    expect(weightOf(w, 0, 0)).toBeCloseTo(0.8);
    expect(weightOf(w, 0, 1)).toBeCloseTo(0.12);
    expect(weightOf(w, 0, 2)).toBeCloseTo(0.08);
    expect(sum(w, 0)).toBeCloseTo(1);
  });

  it('a fifth bone takes the weakest slot', () => {
    const w = influences([[[0, 0.4], [1, 0.3], [2, 0.2], [3, 0.1]]]);
    setWeight(w, 0, 7, 0.5, -1);
    expect(weightOf(w, 0, 7)).toBeCloseTo(0.5);
    expect(weightOf(w, 0, 3)).toBe(0);
    expect(sum(w, 0)).toBeCloseTo(1);
  });

  it('weight taken from a vertex owned by one bone goes to the fallback', () => {
    const w = influences([[[4, 1]]]);
    setWeight(w, 0, 4, 0.25, 2);
    expect(weightOf(w, 0, 4)).toBeCloseTo(0.25);
    expect(weightOf(w, 0, 2)).toBeCloseTo(0.75);
  });

  it('without a fallback, a lone bone keeps the vertex whole', () => {
    const w = influences([[[4, 1]]]);
    setWeight(w, 0, 4, 0.25, -1);
    expect(weightOf(w, 0, 4)).toBe(1);
  });

  it('painting a bone to zero frees its slot', () => {
    const w = influences([[[0, 0.5], [1, 0.5]]]);
    setWeight(w, 0, 1, 0, -1);
    expect(weightOf(w, 0, 0)).toBeCloseTo(1);
    expect(dominantBone(w, 0)).toBe(0);
  });
});

describe('welding and adjacency', () => {
  it('groups vertices on the same spot and links groups across faces', () => {
    // Two triangles sharing an edge, the shared edge's vertices duplicated as if split on a seam.
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const group = weldGroups(positions);
    expect([...group]).toEqual([0, 1, 2, 1, 2, 5]);
    const graph = adjacency([0, 1, 2, 3, 5, 4], group);
    const of = (v: number) => [...graph.neighbours.slice(graph.offsets[v]!, graph.offsets[v + 1]!)].sort();
    expect(of(1)).toEqual([0, 2, 5]);
    expect(of(5)).toEqual([1, 2]);
    expect(groupMembers(group).get(1)).toEqual([1, 3]);
  });
});

describe('a paint stroke', () => {
  // A row of vertices along x, all on bone 0, two of them on the same spot.
  const positions = [0, 0, 0, 0.1, 0, 0, 0.2, 0, 0, 0.2, 0, 0, 0.6, 0, 0];
  const normals = Array.from({ length: 5 }, () => [0, 0, 1]).flat();
  const index = [0, 1, 2, 1, 3, 4];
  const brush: Brush = { mode: 'add', radius: 0.25, strength: 1, value: 0.5, falloff: 0 };

  function context(): PaintContext {
    const group = weldGroups(positions);
    const members = groupMembers(group);
    return {
      weights: influences([[[0, 1]], [[0, 1]], [[0, 1]], [[0, 1]], [[0, 1]]]),
      positions,
      normals,
      grid: new SpatialGrid(positions, 0.1, members.keys()),
      members,
      graph: adjacency(index, group),
      parents: [-1, 0],
    };
  }

  it('reaches what is inside the brush, keeps seams shut, and undoes exactly', () => {
    const ctx = context();
    const record: StrokeRecord = new Map();
    const touched = applyDab(ctx, { centre: [0, 0, 0], bone: 1, brush }, record);
    expect(touched.sort()).toEqual([0, 1, 2]);
    expect(weightOf(ctx.weights, 0, 1)).toBe(1);
    expect(weightOf(ctx.weights, 3, 1)).toBe(1);
    expect(weightOf(ctx.weights, 4, 1)).toBe(0);

    swapStroke(ctx.weights, record, ctx.members);
    expect(weightOf(ctx.weights, 0, 0)).toBe(1);
    expect(weightOf(ctx.weights, 3, 0)).toBe(1);
    swapStroke(ctx.weights, record, ctx.members);
    expect(weightOf(ctx.weights, 3, 1)).toBe(1);
  });

  it('paints only what faces the camera when it is told where the camera is', () => {
    const ctx = context();
    const touched = applyDab(ctx, { centre: [0, 0, 0], bone: 1, brush, view: [0, 0, 1] }, new Map());
    expect(touched).toEqual([]);
  });

  it('smooths toward the neighbours', () => {
    const ctx = context();
    applyDab(ctx, { centre: [0, 0, 0], bone: 1, brush: { ...brush, radius: 0.05 } }, new Map());
    applyDab(ctx, { centre: [0.1, 0, 0], bone: 1, brush: { ...brush, mode: 'smooth', radius: 0.05 } }, new Map());
    const middle = weightOf(ctx.weights, 1, 1);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(1);
    expect(sum(ctx.weights, 1)).toBeCloseTo(1);
  });
});

describe('clean', () => {
  it('drops stray weights and renormalises', () => {
    const w = influences([[[0, 0.97], [5, 0.03]], [[1, 1]]]);
    expect(clean(w, 0.05)).toBe(1);
    expect(weightOf(w, 0, 0)).toBeCloseTo(1);
    expect(weightOf(w, 0, 5)).toBe(0);
  });
});

describe('the draft layout', () => {
  it('round-trips through bytes and refuses a wrong size or a bone out of range', () => {
    const w = influences([[[0, 0.75], [2, 0.25]], [[1, 1]]]);
    const bytes = encodeWeights(w);
    expect(bytes.byteLength).toBe(2 * 4 * 5);
    const back = decodeWeights(bytes.slice().buffer, 2, 3);
    expect([...back.indices]).toEqual([...w.indices]);
    expect([...back.values]).toEqual([...w.values]);
    expect(() => decodeWeights(bytes.slice(1).buffer, 2, 3)).toThrow(/bytes/);
    expect(() => decodeWeights(bytes.slice().buffer, 2, 2)).toThrow(/bone 2/);
  });
});

describe('heat', () => {
  it('runs blue to green to red', () => {
    expect(heat(0)[2]).toBeGreaterThan(heat(0)[0]);
    expect(heat(0.5)).toEqual([0, 1, 0]);
    expect(heat(1)).toEqual([1, 0, 0]);
  });
});

describe('History', () => {
  it('undoes, redoes, and forgets the redo side on a new edit', () => {
    const state = { value: 0 };
    const history = new History();
    const set = (to: number, from: number) => {
      state.value = to;
      return { label: `set ${to}`, undo: () => (state.value = from), redo: () => (state.value = to) };
    };
    history.push(set(1, 0));
    history.push(set(2, 1));
    expect(history.nextUndo).toBe('set 2');
    history.undo();
    expect(state.value).toBe(1);
    history.redo();
    expect(state.value).toBe(2);
    history.undo();
    history.push(set(5, 1));
    expect(history.canRedo).toBe(false);
    history.undo();
    history.undo();
    expect(state.value).toBe(0);
    expect(history.canUndo).toBe(false);
  });
});
