// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { capFaults, dropHeld, MESH_CRITERIA, parseJsonAnswer, REF_CRITERIA, rigMeasured, score } from './autoPrompts';
import { profileOf } from './profiles';
import { fillSheetPrompt } from './prompts';

const answer = (scores: Record<string, number>): Record<string, unknown> => ({
  criteria: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, { score: value, note: key }])),
});

describe('the local review score', () => {
  it('weighs the criteria in code and passes at the mark', () => {
    const result = score(MESH_CRITERIA, answer({ shape: 8, clearance: 8, face: 9, hair: 7, texture: 9, surface: 8 }), 75);
    expect(result.score).toBe(82);
    expect(result.verdict).toBe('pass');
  });

  it('does not pass with a criterion under its floor, whatever the total', () => {
    const result = score(MESH_CRITERIA, answer({ shape: 10, clearance: 10, face: 5, hair: 10, texture: 10, surface: 10 }), 75);
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.below).toEqual(['face']);
    expect(result.verdict).toBe('retry');
  });

  it('counts a criterion the answer skipped as 0', () => {
    const result = score(REF_CRITERIA(false), answer({ identity: 10, views: 10, pose: 10 }), 75);
    expect(result.criteria.find((criterion) => criterion.key === 'meshable')?.score).toBe(0);
    expect(result.verdict).not.toBe('pass');
  });

  it('drops what the character holds from the traits', () => {
    expect(dropHeld('Blonde hair. He holds a large sword in his right hand. Red cape.')).toBe('Blonde hair. Red cape.');
  });

  it('reads the object out of a fenced answer', () => {
    expect(parseJsonAnswer('Here:\n```json\n{"criteria": {"a": 1}}\n```')).toEqual({ criteria: { a: 1 } });
    expect(() => parseJsonAnswer('no json')).toThrow();
  });

  it('turns a rig’s stretch over 1% into a score under the floor', () => {
    const clean = rigMeasured({ Jump: { stretchWorst: { p99: 1.91, over2: 0.0086 }, handInBody: { frames: 0, of: 30 } } });
    expect(clean.criteria.map((criterion) => criterion.score)).toEqual([8, 10]);
    const torn = rigMeasured({ Jump: { stretchWorst: { p99: 2.15, over2: 0.0117 }, handInBody: { frames: 0, of: 30 } } });
    expect(torn.criteria[0]?.score).toBeLessThan(5);
  });
});

describe('the sheet prompt per body profile', () => {
  it('draws chibi, a game model, or the reference’s own proportions', () => {
    const plain = fillSheetPrompt({ subject: 'girl', traits: 'red coat' }, '');
    expect(plain).toContain('exactly the same body proportions as <image1>');
    expect(plain).not.toContain('chibi');
    const chibi = fillSheetPrompt({ subject: 'girl', traits: 'red coat', chibi: true }, '');
    expect(chibi).toContain('Redraw the character as a cute chibi figure, whatever the style of <image1>');
    expect(chibi).not.toContain('{proportions}');
    const game = fillSheetPrompt({ subject: 'girl', traits: 'red coat', chibi: false }, '');
    expect(game).toContain('the head about one seventh of the total height');
    expect(game).toContain('NOT chibi');
  });
});

describe('the body profiles', () => {
  it('give a game model its own arm band, face framing and rig arm space', async () => {
    const { poseCriteria } = await import('./autopilot');
    expect(profileOf({ chibi: false }).render).toEqual({ faceFromTop: 0.08 });
    expect(profileOf({ chibi: false }).rig).toEqual({ armSpace: 0 });
    expect(profileOf({}).rig).toEqual({});
    // jade-hanfu-girl r02: fists at 0.44 on a game-model sheet that meshed and rigged.
    const jade = { front: { handY: 0.441, gapRows: 0.167 }, back: { handY: 0.445, gapRows: 0.296 } };
    expect(poseCriteria(jade, profileOf({ chibi: false }).handBand).criteria[0]?.score).toBe(10);
    expect(poseCriteria(jade).criteria[0]?.score).toBeLessThan(5);
  });
});

describe('the mesh rubric', () => {
  it('costs a mesh whose hands touch the cape points, but leaves the verdict to the rig', () => {
    const touching = score(MESH_CRITERIA, answer({ shape: 9, clearance: 4, face: 10, hair: 9, texture: 10, surface: 9 }), 75);
    const free = score(MESH_CRITERIA, answer({ shape: 9, clearance: 9, face: 10, hair: 9, texture: 10, surface: 9 }), 75);
    expect(touching.below).toEqual([]);
    expect(touching.score).toBeLessThan(free.score);
  });
});

describe('the rig faults', () => {
  it('caps the criterion of a fault that always breaks a rig, and of one this character failed on', () => {
    const said: Record<string, unknown> = { ...answer({ shape: 9, clearance: 8, hair: 9 }), faults: { cloth_arms: true, hair_body: true, arms_torso: false } };
    expect(capFaults(said, [])).toEqual(['cloth_arms']);
    expect((said.criteria as Record<string, { score: number }>)['clearance']?.score).toBe(4);
    expect((said.criteria as Record<string, { score: number }>)['hair']?.score).toBe(9);
    expect(capFaults(said, ['hair_body'])).toEqual(['cloth_arms', 'hair_body']);
    expect((said.criteria as Record<string, { score: number }>)['hair']?.score).toBe(4);
  });
});

describe('the measured arm pose', () => {
  it('passes the A-pose that rigged and fails a T-pose and arms hanging on a cape', async () => {
    const { poseCriteria } = await import('./autopilot');
    const good = poseCriteria({ front: { handY: 0.572, gapRows: 0.405 }, back: { handY: 0.575, gapRows: 0.236 } });
    expect(good.criteria.map((criterion) => criterion.score)).toEqual([10, 10]);
    expect(good.fix).toBe('');
    const tpose = poseCriteria({ front: { handY: 0.319, gapRows: 0.076 }, back: { handY: 0.308, gapRows: 0.06 } });
    expect(tpose.criteria.every((criterion) => criterion.score < 5)).toBe(true);
    expect(tpose.fix).toContain('LOWER than shoulder level');
    const hanging = poseCriteria({ front: { handY: 0.676, gapRows: 0.082 }, back: { handY: 0.67, gapRows: 0.081 } });
    expect(hanging.fix).toContain('do NOT hang down');
    expect(poseCriteria(undefined).criteria[0]?.note).toBe('not measured');
  });
});
