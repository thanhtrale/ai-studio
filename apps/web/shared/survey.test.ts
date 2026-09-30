import { describe, expect, it } from 'vitest';

import { readSurveyRoots, screenBaseName, viewportOf } from './survey';

describe('viewportOf', () => {
  it('believes the name over the width', () => {
    // A designer who wrote "Mobile" meant it, whatever the artboard measures.
    expect(viewportOf('Home — Mobile', 1440)).toBe('mobile');
    expect(viewportOf('Home — Desktop', 390)).toBe('desktop');
  });

  it('falls back to the width for the frames nobody labelled', () => {
    expect(viewportOf('Home', 1440)).toBe('desktop');
    expect(viewportOf('Home', 834)).toBe('tablet');
    expect(viewportOf('Home', 390)).toBe('mobile');
    expect(viewportOf('Badge', 24)).toBe('other');
    expect(viewportOf('Home', undefined)).toBe('other');
  });
});

describe('screenBaseName', () => {
  it('takes off a viewport marker however it was spelled', () => {
    expect(screenBaseName('Home — Desktop')).toBe('Home');
    expect(screenBaseName('Home / Mobile')).toBe('Home');
    expect(screenBaseName('Home (tablet)')).toBe('Home');
    expect(screenBaseName('Home@1440')).toBe('Home');
  });

  it('takes off both markers when a name carries two', () => {
    expect(screenBaseName('Article detail – Mobile 390')).toBe('Article detail');
  });

  it('leaves a name that is only a marker alone', () => {
    // A frame honestly called "Desktop" is a screen named Desktop, not a screen
    // with no name at all.
    expect(screenBaseName('Desktop')).toBe('Desktop');
    expect(screenBaseName('1440')).toBe('1440');
  });

  it('does not mistake an ordinary last word for a marker', () => {
    expect(screenBaseName('Search results')).toBe('Search results');
    expect(screenBaseName('Card 1')).toBe('Card 1');
  });
});

describe('readSurveyRoots', () => {
  const FILE = 'https://www.figma.com/design/AbCdEf123456/Product-file';

  it('accepts a link with no node, because a file is what a survey reads', () => {
    const { roots, problems } = readSurveyRoots(FILE);
    expect(problems).toEqual([]);
    expect(roots).toEqual([{ fileKey: 'AbCdEf123456', fileName: 'Product file' }]);
  });

  it('takes several page links and canonicalises their node ids', () => {
    const { roots, problems } = readSurveyRoots(
      `Survey these please:\n${FILE}?node-id=0-1\n${FILE}?node-id=17%3A4`,
    );
    expect(problems).toEqual([]);
    expect(roots.map((root) => root.nodeId)).toEqual(['0:1', '17:4']);
  });

  it('drops a link that was pasted twice', () => {
    const { roots } = readSurveyRoots(`${FILE}?node-id=0-1 ${FILE}?node-id=0-1`);
    expect(roots).toHaveLength(1);
  });

  it('refuses links to two files, because a node id only means anything in one', () => {
    const { problems } = readSurveyRoots(
      `${FILE}?node-id=0-1 https://www.figma.com/design/ZyXwVu987654/Other?node-id=0-1`,
    );
    expect(problems.join(' ')).toContain('2 different Figma files');
  });

  it('says so when there is no link in the text at all', () => {
    expect(readSurveyRoots('have a look at the design').problems).toHaveLength(1);
    expect(readSurveyRoots('').problems).toHaveLength(1);
  });
});
