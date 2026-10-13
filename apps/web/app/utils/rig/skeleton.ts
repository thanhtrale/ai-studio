/**
 * The skeleton as the editor changes it: bones with a head and a tail, and the
 * operations a person performs on them.
 *
 * Plain data and pure functions -- no three.js -- so every operation is
 * testable and an undo is a copy of an array.
 *
 * Joints. The network predicts a head and a tail per bone, and a parent's tail
 * lands within a centimetre or so of its main child's head. They are one
 * joint to a person, so the editor treats them as one: a bone whose head is
 * that close to its parent's tail is *connected*, and moving either moves both.
 *
 * The frame is the rig's own: y up, +z the way the character faces, +x its
 * left, hips at the origin, about two units tall.
 */

import type { RigBoneEdits, RigDraftInfo, Vec3 } from '#shared/generate';

export interface Bone {
  name: string;
  parent: number;
  head: Vec3;
  tail: Vec3;
}

export interface Skeleton {
  bones: Bone[];
  children: number[][];
  /** Per bone: the child whose head is this bone's tail, or -1. */
  connectedChild: number[];
}

/** Which end of a bone a handle moves. */
export type End = 'head' | 'tail';

export interface Handle {
  bone: number;
  end: End;
}

/** How close, as a share of the parent's length, a child's head must be to count as connected. */
const CONNECT_SHARE = 0.25;

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export function cloneBones(bones: readonly Bone[]): Bone[] {
  return bones.map((bone) => ({ ...bone, head: [...bone.head] as Vec3, tail: [...bone.tail] as Vec3 }));
}

export function buildSkeleton(info: Pick<RigDraftInfo, 'bones'>): Skeleton {
  const bones = cloneBones(info.bones);
  const children = bones.map(() => [] as number[]);
  bones.forEach((bone, index) => {
    if (bone.parent >= 0) children[bone.parent]!.push(index);
  });
  const connectedChild = bones.map((bone, index) => {
    const reach = CONNECT_SHARE * Math.max(distance(bone.head, bone.tail), 1e-6);
    let best = -1;
    let bestDistance = Infinity;
    for (const child of children[index]!) {
      const gap = distance(bones[child]!.head, bone.tail);
      if (gap < bestDistance) {
        best = child;
        bestDistance = gap;
      }
    }
    return bestDistance <= reach ? best : -1;
  });
  // Close the small gaps the network leaves, so a connected joint is one point.
  connectedChild.forEach((child, parent) => {
    if (child >= 0) bones[parent]!.tail = [...bones[child]!.head] as Vec3;
  });
  return { bones, children, connectedChild };
}

/** The bone whose tail is this bone's head, if they are connected. */
export function connectedParent(skeleton: Skeleton, bone: number): number {
  const parent = skeleton.bones[bone]!.parent;
  return parent >= 0 && skeleton.connectedChild[parent] === bone ? parent : -1;
}

/**
 * The handles a person drags: every head, and the tails that are not
 * also a connected child's head.
 */
export function handles(skeleton: Skeleton): Handle[] {
  const out: Handle[] = skeleton.bones.map((_, bone) => ({ bone, end: 'head' as const }));
  skeleton.connectedChild.forEach((child, bone) => {
    if (child < 0) out.push({ bone, end: 'tail' });
  });
  return out;
}

export function handlePosition(bones: readonly Bone[], handle: Handle): Vec3 {
  return bones[handle.bone]![handle.end];
}

/** Every bone below `bone`, itself included, parents before children. */
export function subtree(skeleton: Skeleton, bone: number): number[] {
  const out = [bone];
  for (let i = 0; i < out.length; i++) out.push(...skeleton.children[out[i]!]!);
  return out;
}

/**
 * Bones with a handle moved to `to`.
 *
 * A head drags its connected parent's tail along; a tail drags its connected
 * child's head. With `withChildren`, everything below the joint moves by the
 * same amount instead -- a whole arm rather than one elbow.
 */
export function moveHandle(
  skeleton: Skeleton,
  bones: readonly Bone[],
  handle: Handle,
  to: Vec3,
  withChildren = false,
): Bone[] {
  const out = cloneBones(bones);
  const bone = out[handle.bone]!;
  const delta = sub(to, bone[handle.end]);

  if (withChildren) {
    const moved = handle.end === 'head' ? subtree(skeleton, handle.bone) : subtreeBelowTail(skeleton, handle.bone);
    for (const index of moved) {
      out[index]!.head = add(out[index]!.head, delta);
      out[index]!.tail = add(out[index]!.tail, delta);
    }
    if (handle.end === 'tail') bone.tail = [...to] as Vec3;
  } else {
    bone[handle.end] = [...to] as Vec3;
    if (handle.end === 'tail') {
      const child = skeleton.connectedChild[handle.bone]!;
      if (child >= 0) out[child]!.head = [...to] as Vec3;
    }
  }

  if (handle.end === 'head') {
    const parent = connectedParent(skeleton, handle.bone);
    if (parent >= 0) out[parent]!.tail = [...out[handle.bone]!.head] as Vec3;
  }
  return out;
}

/** The bones hanging off a bone's tail: its connected child's subtree, or nothing. */
function subtreeBelowTail(skeleton: Skeleton, bone: number): number[] {
  const child = skeleton.connectedChild[bone]!;
  return child >= 0 ? subtree(skeleton, child) : [];
}

/** Rotate `point` about `pivot` by the unit quaternion `q` = [x, y, z, w]. */
export function rotateAbout(point: Vec3, pivot: Vec3, q: [number, number, number, number]): Vec3 {
  const [x, y, z] = sub(point, pivot);
  const [qx, qy, qz, qw] = q;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return add(pivot, [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ]);
}

/**
 * Bones with everything from `bone` down turned about its head: re-aiming a
 * limb without moving where it starts. The connected parent keeps its tail,
 * which is that head.
 */
export function rotateSubtree(
  skeleton: Skeleton,
  bones: readonly Bone[],
  bone: number,
  q: [number, number, number, number],
): Bone[] {
  const out = cloneBones(bones);
  const pivot = bones[bone]!.head;
  for (const index of subtree(skeleton, bone)) {
    out[index]!.head = rotateAbout(bones[index]!.head, pivot, q);
    out[index]!.tail = rotateAbout(bones[index]!.tail, pivot, q);
  }
  return out;
}

/** `LeftArm` <-> `RightArm`; a bone on the middle line is its own mirror. */
export function mirrorName(name: string): string {
  if (name.includes('Left')) return name.replace('Left', 'Right');
  if (name.includes('Right')) return name.replace('Right', 'Left');
  return name;
}

export function mirrorIndex(bones: readonly Bone[], bone: number): number {
  const name = mirrorName(bones[bone]!.name);
  return name === bones[bone]!.name ? -1 : bones.findIndex((candidate) => candidate.name === name);
}

/** The x of the plane the body is mirrored in: through the root's head. */
export function mirrorPlane(bones: readonly Bone[]): number {
  const root = bones.find((bone) => bone.parent < 0) ?? bones[0];
  return root ? root.head[0] : 0;
}

export function reflect(point: Vec3, plane: number): Vec3 {
  return [2 * plane - point[0], point[1], point[2]];
}

/**
 * Bones with `changed` copied onto their mirror images, as Blender's X-Axis
 * Mirror does it: every bone in `changed` that has a counterpart puts that
 * counterpart at its own reflection.
 */
export function mirrorBones(bones: readonly Bone[], changed: Iterable<number>, plane = mirrorPlane(bones)): Bone[] {
  const out = cloneBones(bones);
  for (const index of changed) {
    const other = mirrorIndex(bones, index);
    if (other < 0) continue;
    out[other]!.head = reflect(out[index]!.head, plane);
    out[other]!.tail = reflect(out[index]!.tail, plane);
  }
  return out;
}

/**
 * `moveHandle`, and with `mirror` the same joint on the other side moved to
 * the reflection -- what one drag in the editor does.
 */
export function moveJoint(
  skeleton: Skeleton,
  bones: readonly Bone[],
  handle: Handle,
  to: Vec3,
  options: { mirror: boolean; withChildren: boolean },
): Bone[] {
  const plane = mirrorPlane(bones);
  let out = moveHandle(skeleton, bones, handle, to, options.withChildren);
  if (options.mirror) {
    const other = mirrorIndex(bones, handle.bone);
    if (other >= 0) {
      out = moveHandle(skeleton, out, { bone: other, end: handle.end }, reflect(to, plane), options.withChildren);
    }
  }
  return out;
}

/** Bones whose head or tail differ from `before` by more than `epsilon`. */
export function changedBones(before: readonly Bone[], after: readonly Bone[], epsilon = 1e-6): number[] {
  return after.flatMap((bone, index) =>
    distance(bone.head, before[index]!.head) > epsilon || distance(bone.tail, before[index]!.tail) > epsilon
      ? [index]
      : [],
  );
}

/** The bones that differ from what was detected, as the bind request wants them. */
export function boneEdits(detected: readonly Bone[], current: readonly Bone[]): RigBoneEdits {
  const out: RigBoneEdits = {};
  for (const index of changedBones(detected, current)) {
    const bone = current[index]!;
    out[bone.name] = { head: [...bone.head] as Vec3, tail: [...bone.tail] as Vec3 };
  }
  return out;
}

/**
 * Where a joint sits in the middle of the mesh around it.
 *
 * The cross-section of the mesh through `point`, square to `axis`: vertices
 * within a thin slab of that plane and within `radius` of the point. The joint
 * moves within the plane to their centre -- along the bone it stays put, so
 * an elbow stays at the elbow. Null when the section is empty.
 */
export function centreInSection(
  positions: ArrayLike<number>,
  point: Vec3,
  axis: Vec3,
  radius: number,
  slab: number,
): Vec3 | null {
  const unit = scale(axis, 1 / (length(axis) || 1));
  let count = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const offset: Vec3 = [positions[i]! - point[0], positions[i + 1]! - point[1], positions[i + 2]! - point[2]];
    const along = dot(offset, unit);
    if (Math.abs(along) > slab) continue;
    const across = sub(offset, scale(unit, along));
    if (length(across) > radius) continue;
    sx += across[0];
    sy += across[1];
    sz += across[2];
    count++;
  }
  if (count === 0) return null;
  return add(point, [sx / count, sy / count, sz / count]);
}

/** The axis a joint's cross-section is square to: along its bone, or its parent's for a tail. */
export function jointAxis(bones: readonly Bone[], handle: Handle): Vec3 {
  const bone = bones[handle.bone]!;
  return sub(bone.tail, bone.head);
}
