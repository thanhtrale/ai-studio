import { describe, expect, it } from 'vitest';

import type { Vec3 } from '#shared/generate';

import {
  boneEdits,
  buildSkeleton,
  centreInSection,
  changedBones,
  handles,
  mirrorBones,
  mirrorName,
  moveHandle,
  rotateSubtree,
  subtree,
} from './skeleton';

/** Hips -> Spine; Hips -> LeftUpLeg; Spine -> LeftArm -> LeftForeArm; Spine -> RightArm. */
const info = {
  bones: [
    { name: 'mixamorig:Hips', parent: -1, head: [0, 0, 0] as Vec3, tail: [0, 0.2, 0] as Vec3 },
    { name: 'mixamorig:Spine', parent: 0, head: [0, 0.21, 0] as Vec3, tail: [0, 0.5, 0] as Vec3 },
    { name: 'mixamorig:LeftArm', parent: 1, head: [0.2, 0.5, 0] as Vec3, tail: [0.5, 0.5, 0] as Vec3 },
    { name: 'mixamorig:LeftForeArm', parent: 2, head: [0.5, 0.5, 0] as Vec3, tail: [0.8, 0.5, 0] as Vec3 },
    { name: 'mixamorig:RightArm', parent: 1, head: [-0.2, 0.5, 0] as Vec3, tail: [-0.5, 0.5, 0] as Vec3 },
  ],
};

describe('buildSkeleton', () => {
  it('connects a child whose head is at its parent tail, and closes the gap', () => {
    const skeleton = buildSkeleton(info);
    expect(skeleton.connectedChild).toEqual([1, -1, 3, -1, -1]);
    expect(skeleton.bones[0]!.tail).toEqual([0, 0.21, 0]);
    // Spine's tail is not any arm's head: neither arm is connected to it.
    expect(skeleton.children[1]).toEqual([2, 4]);
  });

  it('offers a handle per head and per free tail', () => {
    const list = handles(buildSkeleton(info));
    expect(list.filter((h) => h.end === 'head')).toHaveLength(5);
    expect(list.filter((h) => h.end === 'tail').map((h) => h.bone)).toEqual([1, 3, 4]);
  });
});

describe('moveHandle', () => {
  const skeleton = buildSkeleton(info);

  it('moves a connected joint as one point', () => {
    const out = moveHandle(skeleton, skeleton.bones, { bone: 3, end: 'head' }, [0.5, 0.55, 0]);
    expect(out[3]!.head).toEqual([0.5, 0.55, 0]);
    expect(out[2]!.tail).toEqual([0.5, 0.55, 0]);
    expect(out[3]!.tail).toEqual([0.8, 0.5, 0]);
    // The input is untouched.
    expect(skeleton.bones[3]!.head).toEqual([0.5, 0.5, 0]);
  });

  it('with children, carries everything below the joint', () => {
    const out = moveHandle(skeleton, skeleton.bones, { bone: 2, end: 'head' }, [0.2, 0.6, 0], true);
    expect(out[2]!.tail).toEqual([0.5, 0.6, 0]);
    expect(out[3]!.head).toEqual([0.5, 0.6, 0]);
    expect(out[3]!.tail).toEqual([0.8, 0.6, 0]);
    expect(out[4]!.head).toEqual([-0.2, 0.5, 0]);
  });

  it('a free tail moves alone', () => {
    const out = moveHandle(skeleton, skeleton.bones, { bone: 3, end: 'tail' }, [0.9, 0.4, 0]);
    expect(changedBones(skeleton.bones, out)).toEqual([3]);
  });
});

describe('rotateSubtree', () => {
  it('turns a limb about its first joint', () => {
    const skeleton = buildSkeleton(info);
    // 90 degrees about +z: an arm along +x ends up along +y.
    const half = Math.SQRT1_2;
    const out = rotateSubtree(skeleton, skeleton.bones, 2, [0, 0, half, half]);
    expect(out[2]!.head).toEqual([0.2, 0.5, 0]);
    expect(out[3]!.tail[0]).toBeCloseTo(0.2);
    expect(out[3]!.tail[1]).toBeCloseTo(1.1);
    expect(subtree(skeleton, 1)).toEqual([1, 2, 4, 3]);
  });
});

describe('mirroring', () => {
  it('names the other side', () => {
    expect(mirrorName('mixamorig:LeftHand')).toBe('mixamorig:RightHand');
    expect(mirrorName('mixamorig:RightUpLeg')).toBe('mixamorig:LeftUpLeg');
    expect(mirrorName('mixamorig:Spine')).toBe('mixamorig:Spine');
  });

  it('puts the counterpart at the reflection across the root', () => {
    const skeleton = buildSkeleton(info);
    const moved = moveHandle(skeleton, skeleton.bones, { bone: 2, end: 'head' }, [0.25, 0.48, 0.01]);
    const out = mirrorBones(moved, [2]);
    expect(out[4]!.head).toEqual([-0.25, 0.48, 0.01]);
  });
});

describe('boneEdits', () => {
  it('lists only what changed, by name', () => {
    const skeleton = buildSkeleton(info);
    const out = moveHandle(skeleton, skeleton.bones, { bone: 3, end: 'head' }, [0.5, 0.55, 0]);
    expect(Object.keys(boneEdits(skeleton.bones, out)).sort()).toEqual([
      'mixamorig:LeftArm',
      'mixamorig:LeftForeArm',
    ]);
  });
});

describe('centreInSection', () => {
  it('moves a joint to the middle of the ring around it, not along the bone', () => {
    // A ring of radius 0.05 around x = 0.5, centred at y = 0.52.
    const ring: number[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ring.push(0.5, 0.52 + 0.05 * Math.cos(a), 0.05 * Math.sin(a));
    }
    // And something far off that must be ignored.
    ring.push(0.5, -0.8, 0);
    const out = centreInSection(ring, [0.5, 0.5, 0], [1, 0, 0], 0.2, 0.01)!;
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeCloseTo(0.52);
    expect(out[2]).toBeCloseTo(0);
    expect(centreInSection(ring, [3, 3, 3], [1, 0, 0], 0.1, 0.01)).toBeNull();
  });
});
