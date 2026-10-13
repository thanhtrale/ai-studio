/**
 * One dab of a weight brush: which vertices it reaches and what it does to them.
 *
 * Kept apart from the viewport so a stroke is a pure function of positions,
 * weights and a hit point -- the same in a test as under the mouse.
 */

import type { Vec3 } from '#shared/generate';

import { INFLUENCES, type InfluenceBuffers } from './draft';
import {
  type Adjacency,
  type Brush,
  brushGoal,
  cloneInfluences,
  falloffAt,
  setWeight,
  smoothVertex,
  syncGroup,
  weightOf,
} from './weights';

/** Vertices bucketed in cubes, for "everything within r of p" without a scan of the mesh. */
export class SpatialGrid {
  private readonly cells = new Map<string, number[]>();

  constructor(
    private readonly positions: ArrayLike<number>,
    private readonly cell: number,
    /** Only these vertices are indexed -- weld-group leaders, so a seam is one entry. */
    vertices?: Iterable<number>,
  ) {
    const all = vertices ?? Array.from({ length: positions.length / 3 }, (_, v) => v);
    for (const v of all) {
      const key = this.key(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(v);
      else this.cells.set(key, [v]);
    }
  }

  private key(x: number, y: number, z: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
  }

  /** Vertices within `radius` of `centre`, with their distances. */
  near(centre: Vec3, radius: number): { vertex: number; distance: number }[] {
    const out: { vertex: number; distance: number }[] = [];
    const reach = Math.ceil(radius / this.cell);
    const cx = Math.floor(centre[0] / this.cell);
    const cy = Math.floor(centre[1] / this.cell);
    const cz = Math.floor(centre[2] / this.cell);
    for (let x = cx - reach; x <= cx + reach; x++) {
      for (let y = cy - reach; y <= cy + reach; y++) {
        for (let z = cz - reach; z <= cz + reach; z++) {
          for (const v of this.cells.get(`${x},${y},${z}`) ?? []) {
            const dx = this.positions[v * 3]! - centre[0];
            const dy = this.positions[v * 3 + 1]! - centre[1];
            const dz = this.positions[v * 3 + 2]! - centre[2];
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (distance < radius) out.push({ vertex: v, distance });
          }
        }
      }
    }
    return out;
  }
}

export interface PaintContext {
  weights: InfluenceBuffers;
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  grid: SpatialGrid;
  members: Map<number, number[]>;
  graph: Adjacency;
  /** Each bone's parent, which takes what is left when a vertex's only bone is painted down. */
  parents: readonly number[];
}

export interface Dab {
  centre: Vec3;
  bone: number;
  brush: Brush;
  /**
   * With a view direction, only vertices facing the camera are painted: a
   * brush on the chest must not reach through to the back.
   */
  view?: Vec3;
}

/** Before-images of every vertex a stroke touched, by group leader, for undo. */
export type StrokeRecord = Map<number, { indices: Uint8Array; values: Float32Array }>;

function remember(record: StrokeRecord, weights: InfluenceBuffers, leader: number): void {
  if (record.has(leader)) return;
  const base = leader * INFLUENCES;
  record.set(leader, {
    indices: weights.indices.slice(base, base + INFLUENCES),
    values: weights.values.slice(base, base + INFLUENCES),
  });
}

function facing(context: PaintContext, vertex: number, view: Vec3 | undefined): boolean {
  if (!view) return true;
  const n = context.normals;
  return n[vertex * 3]! * view[0] + n[vertex * 3 + 1]! * view[1] + n[vertex * 3 + 2]! * view[2] < 0.1;
}

/** Apply one dab; returns the group leaders it changed. */
export function applyDab(context: PaintContext, dab: Dab, record: StrokeRecord): number[] {
  const reached = context.grid
    .near(dab.centre, dab.brush.radius)
    .filter(({ vertex }) => facing(context, vertex, dab.view));
  if (reached.length === 0) return [];

  const { weights } = context;
  const touched: number[] = [];

  if (dab.brush.mode === 'smooth') {
    const source = cloneInfluences(weights);
    for (const { vertex, distance } of reached) {
      const amount = dab.brush.strength * falloffAt(distance, dab.brush);
      if (amount <= 0) continue;
      remember(record, weights, vertex);
      smoothVertex(source, weights, vertex, context.graph, amount);
      touched.push(vertex);
    }
  } else {
    const goal = brushGoal(dab.brush);
    const fallback = context.parents[dab.bone] ?? -1;
    for (const { vertex, distance } of reached) {
      const amount = dab.brush.strength * falloffAt(distance, dab.brush);
      if (amount <= 0) continue;
      const current = weightOf(weights, vertex, dab.bone);
      const next = current + (goal - current) * amount;
      if (Math.abs(next - current) < 1e-5) continue;
      remember(record, weights, vertex);
      setWeight(weights, vertex, dab.bone, next, fallback >= 0 ? fallback : nearestOther(weights, vertex, dab.bone));
      touched.push(vertex);
    }
  }

  for (const leader of touched) syncGroup(weights, context.members.get(leader) ?? [leader]);
  return touched;
}

/** A bone other than `bone` on this vertex, or -1. */
function nearestOther(weights: InfluenceBuffers, vertex: number, bone: number): number {
  const base = vertex * INFLUENCES;
  for (let s = 0; s < INFLUENCES; s++) {
    if (weights.indices[base + s] !== bone && weights.values[base + s]! > 0) return weights.indices[base + s]!;
  }
  return -1;
}

/**
 * Smooth one bone's region of the mesh: every vertex it holds, and their
 * neighbours, `passes` times. The whole-bone version of the smooth brush.
 */
export function smoothBone(
  context: PaintContext,
  bone: number,
  passes: number,
  amount: number,
  record: StrokeRecord,
): number {
  const region = new Set<number>();
  for (const leader of context.members.keys()) {
    if (weightOf(context.weights, leader, bone) > 0) region.add(leader);
  }
  for (const leader of [...region]) {
    const { offsets, neighbours } = context.graph;
    for (let i = offsets[leader]!; i < offsets[leader + 1]!; i++) region.add(neighbours[i]!);
  }
  for (let pass = 0; pass < passes; pass++) {
    const source = cloneInfluences(context.weights);
    for (const leader of region) {
      remember(record, context.weights, leader);
      smoothVertex(source, context.weights, leader, context.graph, amount);
    }
  }
  for (const leader of region) syncGroup(context.weights, context.members.get(leader) ?? [leader]);
  return region.size;
}

/** Every influence below `threshold` dropped and the rest renormalised, recorded for undo. */
export function cleanSmall(context: PaintContext, threshold: number, record: StrokeRecord): number {
  const { weights } = context;
  let changed = 0;
  for (const [leader, members] of context.members) {
    const base = leader * INFLUENCES;
    let dropped = false;
    for (let s = 0; s < INFLUENCES; s++) {
      const value = weights.values[base + s]!;
      if (value > 0 && value < threshold) dropped = true;
    }
    if (!dropped) continue;
    remember(record, weights, leader);
    let total = 0;
    for (let s = 0; s < INFLUENCES; s++) {
      if (weights.values[base + s]! < threshold) {
        weights.values[base + s] = 0;
        weights.indices[base + s] = 0;
      }
      total += weights.values[base + s]!;
    }
    if (total <= 0) {
      // Everything was below the threshold: keep what was there.
      const before = record.get(leader)!;
      weights.indices.set(before.indices, base);
      weights.values.set(before.values, base);
      record.delete(leader);
      continue;
    }
    for (let s = 0; s < INFLUENCES; s++) weights.values[base + s] = weights.values[base + s]! / total;
    syncGroup(weights, members);
    changed++;
  }
  return changed;
}

/** Swap a stroke's before-images with the current state; applying it twice is a no-op. */
export function swapStroke(weights: InfluenceBuffers, record: StrokeRecord, members: Map<number, number[]>): void {
  for (const [leader, before] of record) {
    const base = leader * INFLUENCES;
    const now = {
      indices: weights.indices.slice(base, base + INFLUENCES),
      values: weights.values.slice(base, base + INFLUENCES),
    };
    weights.indices.set(before.indices, base);
    weights.values.set(before.values, base);
    record.set(leader, now);
    syncGroup(weights, members.get(leader) ?? [leader]);
  }
}
