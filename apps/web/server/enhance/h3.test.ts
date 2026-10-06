import { describe, expect, it } from 'vitest';

import {
  alignmentLine,
  cleanRewrite,
  danglingPictureTags,
  finishRewrite,
  h3RewriteRequest,
  lastShotNumber,
  missingQuotedLines,
  missingSections,
  quotedLines,
  SECTIONS,
  type H3RewriteInput,
} from './h3';

const base: H3RewriteInput = {
  mode: 'fl2v',
  prompt: 'a crane lands on a rock',
  comment: 'make it dawn, add wind',
  references: 1,
  seconds: 124 / 24,
  width: 1344,
  height: 768,
};

describe('h3RewriteRequest', () => {
  it('asks fl2v for the three base-guide fields, and not the alignment line', () => {
    const { system, prompt } = h3RewriteRequest(base);

    expect(system).toContain('You are H3-Context-IR');
    for (const field of SECTIONS.fl2v) expect(system).toContain(`${field}:`);
    expect(system).toContain('Do NOT write it yourself');
    expect(system).toContain('[Shot 1] marks the opening shot and has NO timestamp');
    expect(prompt).toContain('it is <Picture 1>, the first frame at 0.00 seconds (I2VA)');
    // Cut times have to land inside the clip the console will ask for.
    expect(prompt).toContain('5.17 seconds');
    expect(prompt).toContain('before 00:05.167');
    expect(prompt).toContain('<<<\na crane lands on a rock\n>>>');
    expect(prompt).toContain('<<<\nmake it dawn, add wind\n>>>');
  });

  it('names the fl2v task by keyframe count', () => {
    expect(h3RewriteRequest({ ...base, references: 0 }).prompt).toContain('T2VA');
    expect(h3RewriteRequest({ ...base, references: 2 }).prompt).toContain(
      'Picture 1 is the first frame and Picture 2 is the last frame (FL2VA)',
    );
  });

  it('asks ref2v for six sections built on <Subject N>', () => {
    const { system, prompt } = h3RewriteRequest({ ...base, mode: 'ref2v', references: 2 });

    for (const section of SECTIONS.ref2v) expect(system).toContain(`${section}:`);
    expect(system).toContain('refer to the content by its <Subject N> label');
    expect(system).toContain('Do NOT refer to a person or place as <Picture N> there');
    expect(system).toContain('[reference generation]');
    expect(system).toContain('fully_preserved');
    expect(prompt).toContain('2 reference images attached, in order: <Picture 1>, <Picture 2>.');
    expect(prompt).toContain('then call them <Subject N>');
  });

  it('writes in English and keeps quoted lines as <d> dialogue, in both modes', () => {
    for (const mode of ['fl2v', 'ref2v'] as const) {
      const { system, prompt } = h3RewriteRequest({ ...base, mode, comment: 'cho trời mưa, nói "Đi thôi!"' });

      expect(system).toContain('English or in Vietnamese');
      expect(system).toContain('Everything you write is in English');
      expect(system).toContain('QUOTED TEXT IS DIALOGUE, KEPT VERBATIM');
      expect(system).toContain('<d>[Language] exact words</d>');
      expect(system).toContain('a Vietnamese line stays Vietnamese and is tagged [Vietnamese]');
      expect(prompt).toContain('cho trời mưa, nói "Đi thôi!"');
      expect(prompt.trim().endsWith('in English.')).toBe(true);
    }
  });

  it('says so when there is no draft or no note, rather than sending empty quotes', () => {
    const { prompt } = h3RewriteRequest({ ...base, prompt: '  ', comment: '' });

    expect(prompt).toContain('(none -- write it from the note and the images)');
    expect(prompt).toContain("(none -- keep the draft's content");
    expect(prompt).not.toContain('<<<\n\n>>>');
  });
});

describe('alignment line', () => {
  it('is the guide text, verbatim, for one and two keyframes', () => {
    expect(alignmentLine({ mode: 'fl2v', references: 1, seconds: 124 / 24 }, 1)).toBe(
      'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.',
    );
    expect(alignmentLine({ mode: 'fl2v', references: 2, seconds: 124 / 24 }, 2)).toBe(
      'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second ' +
        'mark of the target video; Picture 2 (from Shot 2) aligns with the 5.17-second mark of the target video.',
    );
  });

  it('is absent for text-to-video and for ref2v', () => {
    expect(alignmentLine({ mode: 'fl2v', references: 0, seconds: 5 }, 1)).toBeNull();
    expect(alignmentLine({ mode: 'ref2v', references: 3, seconds: 5 }, 1)).toBeNull();
  });

  it('is put on top, replacing any the model wrote, with the last shot it actually has', () => {
    const rewrite =
      'For the target video, at 0.00 seconds into the target video, <Picture 1> is wrong.\n\n' +
      'integrated_multimodal_description: [Shot 1] A. [Shot 2] At 00:03.000, the camera cuts to B.\n\n' +
      'overall_soundscape: Wind.\n\nnon_diegetic_music: N/A';
    const finished = finishRewrite({ mode: 'fl2v', references: 2, seconds: 5 }, rewrite);

    expect(lastShotNumber(rewrite)).toBe(2);
    expect(finished.split('\n')[0]).toContain('Picture 2 (from Shot 2) aligns with the 5.00-second mark');
    expect(finished.split('\n')[1]).toBe('');
    expect(finished).not.toContain('is wrong');
    expect(finished.match(/target video/g)).toHaveLength(3);
  });

  it('leaves a ref2v rewrite as it is', () => {
    expect(finishRewrite({ mode: 'ref2v', references: 1, seconds: 5 }, 'subject_definitions:\nx')).toBe(
      'subject_definitions:\nx',
    );
  });
});

describe('missingSections', () => {
  it('names the fields or sections a rewrite left out', () => {
    expect(
      missingSections('fl2v', 'integrated_multimodal_description: [Shot 1] x\n\noverall_soundscape: y'),
    ).toEqual(['non_diegetic_music']);
    expect(
      missingSections(
        'ref2v',
        'subject_definitions:\na\n\nsummary:\nb\n\ndetailed_description:\nc\n\noverall_soundscape:\nd\n\nnon_diegetic_music:\nN/A',
      ),
    ).toEqual(['retention_analysis']);
  });

  it('does not count a section name that only appears mid-sentence', () => {
    expect(missingSections('fl2v', 'he hums the non_diegetic_music: no')).toContain('non_diegetic_music');
  });
});

describe('cleanRewrite', () => {
  it('passes a plain answer through, trimmed', () => {
    expect(cleanRewrite('  summary:\n[reference generation] x  ')).toBe('summary:\n[reference generation] x');
  });

  it('takes off a code fence, a label, emphasis and headings', () => {
    expect(cleanRewrite('```text\nsummary:\nx\n```')).toBe('summary:\nx');
    expect(cleanRewrite('**Rewritten prompt:** x')).toBe('x');
    expect(cleanRewrite('**summary:**\n[reference generation] a *whoosh*')).toBe(
      'summary:\n[reference generation] a whoosh',
    );
    expect(cleanRewrite('### subject_definitions:\n<Subject 1> is x')).toBe('subject_definitions:\n<Subject 1> is x');
  });

  it('leaves dialogue and a prompt that only starts with the word', () => {
    expect(cleanRewrite('Prompt engineers at dawn.')).toBe('Prompt engineers at dawn.');
    expect(cleanRewrite('he says, <d>[Vietnamese] Đợi đã!</d>')).toBe('he says, <d>[Vietnamese] Đợi đã!</d>');
  });

  it('is null when nothing is left', () => {
    expect(cleanRewrite('')).toBeNull();
    expect(cleanRewrite('```\n```')).toBeNull();
  });
});

describe('quoted dialogue', () => {
  it('finds straight quotes, curly quotes, and <d> lines from an earlier rewrite', () => {
    expect(quotedLines('hét "Đợi mình với!" rồi “Đi thôi” và ""')).toEqual(['Đợi mình với!', 'Đi thôi']);
    expect(quotedLines('(S1) says, <d>[Vietnamese] Công lý không bao giờ ngủ!</d>')).toEqual([
      'Công lý không bao giờ ngủ!',
    ]);
    expect(quotedLines('no quotes here')).toEqual([]);
  });

  it('reports a quoted line the rewrite translated or dropped', () => {
    const note = 'nhân vật hét "Ta sẽ bảo vệ vương quốc này!"';
    const kept = '<Subject 1> (S1) shouts, <d>[Vietnamese] Ta sẽ bảo vệ vương quốc này!</d>';
    const translated = '<Subject 1> (S1) shouts, <d>[English] I will protect this kingdom!</d>';

    expect(missingQuotedLines(['', note], kept)).toEqual([]);
    expect(missingQuotedLines(['', note], translated)).toEqual(['Ta sẽ bảo vệ vương quốc này!']);
    expect(missingQuotedLines([note, note], 'nothing')).toEqual(['Ta sẽ bảo vệ vương quốc này!']);
  });
});

describe('danglingPictureTags', () => {
  it('finds tags with no image behind them', () => {
    expect(danglingPictureTags('<Picture 1> meets <Picture 3> and <Picture 1>', 2)).toEqual([3]);
    expect(danglingPictureTags('<Picture 1> and <Picture 2>', 2)).toEqual([]);
    expect(danglingPictureTags('<Picture 0>', 2)).toEqual([0]);
  });
});
