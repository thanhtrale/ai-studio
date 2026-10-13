/**
 * Skin weights as the editor paints them: four influences per vertex, always
 * normalised, the way the GLB will store them.
 *
 * Every write goes through `setWeight`, which keeps three rules a painter
 * should never have to think about:
 *
 * - a vertex's weights sum to 1 (Blender's auto-normalise): raising one bone
 *   lowers the others in proportion, lowering it raises them;
 * - at most four bones per vertex: a fifth replaces the weakest;
 * - a vertex is never left with nothing: weight taken from a vertex's only
 *   bone goes to that bone's parent.
 *
 * Vertices split along UV seams sit on the same spot, and painting them
 * apart opens the seam. `weldGroups` finds them; brushes and smoothing treat a
 * group as one vertex.
 */

import { INFLUENCES, type InfluenceBuffers } from './draft';

export type BrushMode = 'add' | 'subtract' | 'set' | 'smooth';

export interface Brush {
  mode: BrushMode;
  /** World units, in the rig's frame (about two units to a body). */
  radius: number;
  /** 0..1: how far one dab moves a weight toward its goal. */
  strength: number;
  /** For `set`: the weight to paint toward. */
  value: number;
  /** 0 is a hard edge, 1 is a smooth bell. */
  falloff: number;
}

export function cloneInfluences(weights: InfluenceBuffers): InfluenceBuffers {
  return { indices: weights.indices.slice(), values: weights.values.slice() };
}

export function weightOf(weights: InfluenceBuffers, vertex: number, bone: number): number {
  const base = vertex * INFLUENCES;
  let total = 0;
  for (let slot = 0; slot < INFLUENCES; slot++) {
    if (weights.indices[base + slot] === bone) total += weights.values[base + slot]!;
  }
  return total;
}

/** The bone with the most weight on a vertex. */
export function dominantBone(weights: InfluenceBuffers, vertex: number): number {
  const base = vertex * INFLUENCES;
  let best = 0;
  for (let slot = 1; slot < INFLUENCES; slot++) {
    if (weights.values[base + slot]! > weights.values[base + best]!) best = slot;
  }
  return weights.indices[base + best]!;
}

/**
 * Set one bone's weight on one vertex to `target`, rescaling the rest so the
 * vertex still sums to 1. `fallback` is the bone that takes what is left when
 * nothing else holds any -- the painted bone's parent, as a rule.
 */
export function setWeight(
  weights: InfluenceBuffers,
  vertex: number,
  bone: number,
  target: number,
  fallback: number,
): void {
  const { indices, values } = weights;
  const base = vertex * INFLUENCES;
  const value = Math.min(1, Math.max(0, target));

  let slot = -1;
  for (let s = 0; s < INFLUENCES; s++) {
    if (indices[base + s] === bone && values[base + s]! > 0) slot = s;
  }
  if (slot < 0) {
    if (value <= 0) return;
    // The weakest slot -- an empty one if there is one -- makes room.
    slot = 0;
    for (let s = 1; s < INFLUENCES; s++) {
      if (values[base + s]! < values[base + slot]!) slot = s;
    }
    indices[base + slot] = bone;
    values[base + slot] = 0;
  }

  let others = 0;
  for (let s = 0; s < INFLUENCES; s++) {
    if (s !== slot) others += values[base + s]!;
  }

  if (others <= 1e-8) {
    values[base + slot] = value;
    if (value < 1 && fallback >= 0 && fallback !== bone) {
      const free = (slot + 1) % INFLUENCES;
      indices[base + free] = fallback;
      values[base + free] = 1 - value;
    } else {
      values[base + slot] = 1;
    }
    return;
  }

  const rescale = (1 - value) / others;
  for (let s = 0; s < INFLUENCES; s++) {
    if (s === slot) values[base + s] = value;
    else values[base + s] = values[base + s]! * rescale;
  }
  // Nothing at zero keeps its bone index: a later fifth bone takes the slot.
  for (let s = 0; s < INFLUENCES; s++) {
    if (values[base + s]! < 1e-6) {
      values[base + s] = 0;
      indices[base + s] = 0;
    }
  }
}

/**
 * Vertices on the same spot, grouped: `group[v]` is the first vertex at v's
 * position. Positions are quantised to a millionth of the mesh's extent.
 */
export function weldGroups(positions: ArrayLike<number>): Int32Array {
  const count = positions.length / 3;
  let extent = 0;
  for (let i = 0; i < positions.length; i++) extent = Math.max(extent, Math.abs(positions[i]!));
  const quantum = (extent || 1) * 1e-6;
  const seen = new Map<string, number>();
  const group = new Int32Array(count);
  for (let v = 0; v < count; v++) {
    const key = `${Math.round(positions[v * 3]! / quantum)},${Math.round(positions[v * 3 + 1]! / quantum)},${Math.round(positions[v * 3 + 2]! / quantum)}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, v);
      group[v] = v;
    } else {
      group[v] = first;
    }
  }
  return group;
}

/** Neighbours over the mesh's edges, between weld groups, as compressed rows keyed by group leader. */
export interface Adjacency {
  offsets: Int32Array;
  neighbours: Int32Array;
}

export function adjacency(index: ArrayLike<number>, group: Int32Array): Adjacency {
  const count = group.length;
  const sets: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  for (let i = 0; i < index.length; i += 3) {
    const a = group[index[i]!]!;
    const b = group[index[i + 1]!]!;
    const c = group[index[i + 2]!]!;
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      if (from === to) continue;
      sets[from]!.add(to);
      sets[to]!.add(from);
    }
  }
  const offsets = new Int32Array(count + 1);
  for (let v = 0; v < count; v++) offsets[v + 1] = offsets[v]! + sets[v]!.size;
  const neighbours = new Int32Array(offsets[count]!);
  for (let v = 0; v < count; v++) neighbours.set([...sets[v]!], offsets[v]!);
  return { offsets, neighbours };
}

/** Members of each weld group, keyed by leader. */
export function groupMembers(group: Int32Array): Map<number, number[]> {
  const out = new Map<number, number[]>();
  group.forEach((leader, vertex) => {
    const members = out.get(leader);
    if (members) members.push(vertex);
    else out.set(leader, [vertex]);
  });
  return out;
}

/** Copy a leader's influences onto the rest of its group. */
export function syncGroup(weights: InfluenceBuffers, members: readonly number[]): void {
  const leader = members[0]!;
  const from = leader * INFLUENCES;
  for (let i = 1; i < members.length; i++) {
    const to = members[i]! * INFLUENCES;
    weights.indices.copyWithin(to, from, from + INFLUENCES);
    weights.values.copyWithin(to, from, from + INFLUENCES);
  }
}

/** How much of a dab a vertex `distance` from the centre gets. */
export function falloffAt(distance: number, brush: Pick<Brush, 'radius' | 'falloff'>): number {
  if (distance >= brush.radius) return 0;
  const t = distance / brush.radius;
  const smooth = (1 - t * t) ** 2;
  return 1 - brush.falloff + brush.falloff * smooth;
}

/** The weights of a vertex's neighbours, averaged, as bone -> weight. */
function neighbourAverage(weights: InfluenceBuffers, leader: number, graph: Adjacency): Map<number, number> {
  const sums = new Map<number, number>();
  const start = graph.offsets[leader]!;
  const end = graph.offsets[leader + 1]!;
  if (end === start) return sums;
  for (let i = start; i < end; i++) {
    const base = graph.neighbours[i]! * INFLUENCES;
    for (let s = 0; s < INFLUENCES; s++) {
      const value = weights.values[base + s]!;
      if (value > 0) sums.set(weights.indices[base + s]!, (sums.get(weights.indices[base + s]!) ?? 0) + value);
    }
  }
  const count = end - start;
  for (const [bone, total] of sums) sums.set(bone, total / count);
  return sums;
}

/**
 * Move a vertex's whole set of weights `amount` of the way toward its
 * neighbours' average, keeping the four strongest. Reads `source` and writes
 * `target`, so a pass over many vertices sees one consistent state.
 */
export function smoothVertex(
  source: InfluenceBuffers,
  target: InfluenceBuffers,
  leader: number,
  graph: Adjacency,
  amount: number,
): void {
  const around = neighbourAverage(source, leader, graph);
  if (around.size === 0) return;
  const blended = new Map<number, number>();
  const base = leader * INFLUENCES;
  for (let s = 0; s < INFLUENCES; s++) {
    const value = source.values[base + s]!;
    if (value > 0) blended.set(source.indices[base + s]!, value * (1 - amount));
  }
  for (const [bone, value] of around) blended.set(bone, (blended.get(bone) ?? 0) + value * amount);
  writeTop(target, leader, blended);
}

/** The four strongest of `weights` onto a vertex, normalised. */
export function writeTop(target: InfluenceBuffers, vertex: number, weights: Map<number, number>): void {
  const top = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, INFLUENCES);
  const total = top.reduce((sum, [, value]) => sum + value, 0) || 1;
  const base = vertex * INFLUENCES;
  for (let s = 0; s < INFLUENCES; s++) {
    const entry = top[s];
    target.indices[base + s] = entry ? entry[0] : 0;
    target.values[base + s] = entry ? entry[1] / total : 0;
  }
}

/** The weight a brush moves toward. */
export function brushGoal(brush: Pick<Brush, 'mode' | 'value'>): number {
  if (brush.mode === 'add') return 1;
  if (brush.mode === 'subtract') return 0;
  return brush.value;
}

/**
 * Every weight below `threshold` taken away, the rest renormalised: the
 * stray few percent a network leaves on far-off bones.
 */
export function clean(weights: InfluenceBuffers, threshold: number): number {
  let changed = 0;
  const count = weights.values.length / INFLUENCES;
  for (let v = 0; v < count; v++) {
    const base = v * INFLUENCES;
    let total = 0;
    let dropped = false;
    for (let s = 0; s < INFLUENCES; s++) {
      if (weights.values[base + s]! > 0 && weights.values[base + s]! < threshold) {
        weights.values[base + s] = 0;
        weights.indices[base + s] = 0;
        dropped = true;
      }
      total += weights.values[base + s]!;
    }
    if (!dropped || total <= 0) continue;
    for (let s = 0; s < INFLUENCES; s++) weights.values[base + s] = weights.values[base + s]! / total;
    changed++;
  }
  return changed;
}

/** Colour for a weight, as every DCC paints them: blue at 0, green at 0.5, red at 1. */
export function heat(weight: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, weight));
  if (t <= 0) return [0.05, 0.07, 0.35];
  if (t < 0.25) return [0, t * 4, 1];
  if (t < 0.5) return [0, 1, 1 - (t - 0.25) * 4];
  if (t < 0.75) return [(t - 0.5) * 4, 1, 0];
  return [1, 1 - (t - 0.75) * 4, 0];
}

/** A distinct, stable colour per bone, for the dominant-bone view. */
export function boneColour(bone: number): [number, number, number] {
  const hue = (bone * 0.618033988749895) % 1;
  const h = hue * 6;
  const c = 0.75;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = 0.2;
  const [r, g, b] =
    h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}
