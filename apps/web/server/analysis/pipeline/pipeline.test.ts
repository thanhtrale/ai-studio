import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NormalisedDesign, NormalisedTicket } from '#shared/analysis';

import type { DesignRead, DesignSource } from '../design/source';
import { DesignSourceError } from '../design/errors';
import { AnalysisRun, clearRuns } from '../registry';
import { readArtifact, readRecord } from '../store';
import { analyse, modelFileName } from './analyse';
import { checkClaims, checkElements, checkEvidence, evidenceSets } from './evidence';
import { renderRequirements } from './render';
import type { ArmCaller, ArmTextReport } from './runner';
import { PassError, extractJson, runPass } from './runner';
import { validateBlockModel, validateClaims, validateElements, validateReconcile } from './schema';

let storage: string;

beforeEach(() => {
  storage = mkdtempSync(path.join(tmpdir(), 'ai-studio-pipeline-'));
});

afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  clearRuns();
});

describe('extractJson', () => {
  it('reads a bare document', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads one inside a fence, which is what a model usually sends', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads one after a sentence', () => {
    expect(extractJson('Here is the document:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('reads an array', () => {
    expect(extractJson('[1,2]')).toEqual([1, 2]);
  });

  it('refuses to guess at malformed JSON', () => {
    // That is the repair turn's job, where the model is told what the parser
    // complained about rather than being second-guessed here.
    expect(() => extractJson('{"a": 1,}')).toThrow();
    expect(() => extractJson('   ')).toThrow(/returned nothing/);
  });
});

describe('the pass validators', () => {
  it('accepts the bare array a model often sends instead of the wrapper', () => {
    const wrapped = validateElements({ elements: [{ nodeId: '1:1', role: 'headline', kind: 'text' }] });
    const bare = validateElements([{ nodeId: '1:1', role: 'headline', kind: 'text' }]);
    expect(bare).toEqual(wrapped);
  });

  it('complains in words a model can act on', () => {
    expect(() => validateElements({ elements: [{ role: 'headline', kind: 'text' }] })).toThrow(
      'elements[0].nodeId is required',
    );
    expect(() => validateElements({ elements: [{ nodeId: '1:1', role: 'x', kind: 'widget' }] })).toThrow(
      /elements\[0\].kind must be one of .*-- got "widget"/,
    );
  });

  it('requires a contradiction to say what the design showed', () => {
    expect(() =>
      validateReconcile({
        requirements: [{ id: 'r1', statement: 'x', nodeIds: ['1:1'] }],
        gaps: [{ id: 'g1', kind: 'contradiction', statement: 's', question: 'q?', ticketReading: 't' }],
      }),
    ).toThrow(/designReading is required -- the design is authoritative/);
  });

  it('requires every gap to carry a question', () => {
    expect(() =>
      validateReconcile({
        requirements: [{ id: 'r1', statement: 'x', nodeIds: ['1:1'] }],
        gaps: [{ id: 'g1', kind: 'ambiguous', statement: 's' }],
      }),
    ).toThrow(/gaps\[0\].question is required/);
  });

  it('requires the content model to carry all three arrays', () => {
    expect(() => validateBlockModel({ definitions: [], models: [] })).toThrow(
      /"filters" must be an array/,
    );
    expect(() => validateBlockModel({ definitions: [], models: [], filters: [] })).toThrow(
      /definitions must not be empty/,
    );
  });

  it('accepts a container block with its item and filter', () => {
    const model = validateBlockModel({
      definitions: [
        { title: 'Cards', id: 'cards', plugins: { xwalk: {} } },
        { title: 'Card', id: 'card', plugins: { xwalk: {} } },
      ],
      models: [{ id: 'card', fields: [{ component: 'richtext', name: 'text', label: 'Text' }] }],
      filters: [{ id: 'cards', components: ['card'] }],
    });
    expect(model.filters[0]?.components).toEqual(['card']);
    expect(model.models[0]?.fields[0]?.component).toBe('richtext');
  });

  it('keeps a select field’s options', () => {
    const model = validateBlockModel({
      definitions: [{ title: 'T', id: 't', plugins: {} }],
      models: [
        {
          id: 't',
          fields: [
            {
              component: 'select',
              name: 'classes',
              options: [{ name: 'Left', value: 'image-left' }, { name: 'Right', value: 'image-right' }],
            },
          ],
        },
      ],
      filters: [],
    });
    expect(model.models[0]?.fields[0]?.options).toHaveLength(2);
  });

  it('reads claims', () => {
    expect(
      validateClaims({ claims: [{ id: 'c1', passageId: 'ac', statement: 's', kind: 'behaviour' }] }),
    ).toHaveLength(1);
  });
});

describe('checkEvidence', () => {
  const sets = evidenceSets(['1:1', '1:2'], ['p1', 'c1']);

  it('keeps a requirement the sources support', () => {
    const { requirements, inferences } = checkEvidence(
      {
        requirements: [
          { id: 'r1', statement: 'The headline is two lines.', nodeIds: ['1:1'], passageIds: [] },
        ],
        gaps: [],
      },
      sets,
    );
    expect(requirements).toHaveLength(1);
    expect(inferences).toHaveLength(0);
  });

  it('accepts the whole label, which is what a ticket pass returns', () => {
    // The prompt labels a section `[passage acceptancecriteria]` and asks for
    // the id verbatim, so a real run returned the entire label. Found the same
    // way as the sigil above: by running it.
    const { requirements } = checkEvidence(
      {
        requirements: [
          {
            id: 'r1',
            statement: 'x',
            nodeIds: [],
            passageIds: ['[p1]'],
          },
        ],
        gaps: [],
      },
      sets,
    );
    expect(requirements[0]?.evidence.passageIds).toEqual(['p1']);

    const { kept } = checkClaims(
      [{ id: 'c1', passageId: '[p1]', statement: 's', kind: 'content' }],
      sets,
    );
    expect(kept[0]?.passageId).toBe('p1');
  });

  it('accepts the sigil the outline itself writes', () => {
    // The digest writes `#1:1`, and the prompt asks for ids verbatim -- so a
    // model that returns `#1:1` has obeyed. Found by running the real thing:
    // a first pass returned nine correct elements and every one was discarded.
    const { requirements } = checkEvidence(
      { requirements: [{ id: 'r1', statement: 'x', nodeIds: ['#1:1'], passageIds: [] }], gaps: [] },
      sets,
    );
    expect(requirements[0]?.evidence.nodeIds).toEqual(['1:1']);

    const { kept } = checkElements(
      [{ nodeId: '#1:2', role: 'headline', kind: 'text', repeated: false }],
      sets,
    );
    // Stored without it, so nothing downstream has to know about the sigil.
    expect(kept[0]?.nodeId).toBe('1:2');
  });

  it('demotes a statement whose node id does not exist', () => {
    // The anti-fabrication mechanism, and it is code rather than prompt
    // wording: an id outside the digest did not come from the design.
    const { requirements, inferences } = checkEvidence(
      {
        requirements: [{ id: 'r1', statement: 'There is a tooltip.', nodeIds: ['9:9'], passageIds: [] }],
        gaps: [],
      },
      sets,
    );
    expect(requirements).toHaveLength(0);
    expect(inferences[0]?.reason).toContain('"9:9"');
    expect(inferences[0]?.statement).toBe('There is a tooltip.');
  });

  it('demotes a statement that cited nothing at all', () => {
    const { inferences } = checkEvidence(
      { requirements: [{ id: 'r1', statement: 'It animates.', nodeIds: [], passageIds: [] }], gaps: [] },
      sets,
    );
    expect(inferences[0]?.reason).toMatch(/no design node or ticket passage/);
  });

  it('keeps a requirement supported on one side only', () => {
    const { requirements } = checkEvidence(
      {
        requirements: [
          { id: 'r1', statement: 'x', nodeIds: ['9:9'], passageIds: ['p1'] },
        ],
        gaps: [],
      },
      sets,
    );
    expect(requirements[0]?.evidence).toEqual({ nodeIds: [], passageIds: ['p1'] });
  });

  it('never demotes a gap, but drops the ids that do not resolve', () => {
    // A gap is a question, and a question with weak evidence is still a
    // question.
    const { gaps } = checkEvidence(
      {
        requirements: [{ id: 'r1', statement: 'x', nodeIds: ['1:1'], passageIds: [] }],
        gaps: [
          {
            id: 'g1',
            kind: 'ambiguous',
            statement: 's',
            question: 'q?',
            evidence: { nodeIds: ['1:2', '9:9'], passageIds: [] },
          },
        ],
      },
      sets,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.evidence.nodeIds).toEqual(['1:2']);
  });

  it('drops a fabricated element before it can father a requirement', () => {
    const { kept, dropped } = checkElements(
      [
        { nodeId: '1:1', role: 'headline', kind: 'text', repeated: false },
        { nodeId: '9:9', role: 'tooltip', kind: 'other', repeated: false },
      ],
      sets,
    );
    expect(kept).toHaveLength(1);
    expect(dropped[0]?.nodeId).toBe('9:9');
  });

  it('drops a claim citing a passage the ticket does not have', () => {
    const { kept, dropped } = checkClaims(
      [
        { id: 'c1', passageId: 'p1', statement: 's', kind: 'content' },
        { id: 'c2', passageId: 'invented', statement: 's', kind: 'content' },
      ],
      sets,
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });
});

/** An arm that answers each pass with whatever is queued for it. */
function stubArm(answers: Record<string, string>, log: string[] = []): ArmCaller {
  return {
    async job(_armId, request) {
      log.push(request.jobId);
      const key = request.jobId.split('-').pop() ?? '';
      const text = answers[key];
      if (text === undefined) throw new Error(`nothing queued for ${key}`);
      return { text } satisfies ArmTextReport;
    },
    async progress() {
      return {
        jobId: 'x',
        armId: 'y',
        state: 'running',
        startedAt: 0,
        steps: [],
        meters: [],
        armVram: [],
      };
    },
  };
}

describe('runPass', () => {
  it('repairs a first reply that does not validate, once', async () => {
    const log: string[] = [];
    const arm = stubArm(
      {
        p1: 'not json at all',
        p1r: '{"elements":[{"nodeId":"1:1","role":"headline","kind":"text"}]}',
      },
      log,
    );

    const result = await runPass(
      {
        id: 'p1',
        step: 'pass1',
        validate: validateElements,
        request: { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10 },
      },
      { armId: 'arm', analysisId: 'analysis-0001', caller: arm },
    );

    expect(result.repaired).toBe(true);
    expect(result.value[0]?.nodeId).toBe('1:1');
    // Each pass is a supervisor job, and the repair is its own.
    expect(log).toEqual(['analysis-0001-p1', 'analysis-0001-p1r']);
  });

  it('tells a truncated reply from a malformed one', async () => {
    // A reply cut off at the token cap is not malformed JSON, and "only fix
    // the shape" guarantees it truncates again at the same place. Found on a
    // real ticket: pass 2 produced 14,467 characters of good claims and
    // stopped mid-object.
    let repairPrompt = '';
    const arm: ArmCaller = {
      async job(_armId, request) {
        const job = request.job as { messages: { role: string; content: string }[] };
        if (request.jobId.endsWith('r')) {
          repairPrompt = job.messages[job.messages.length - 1]?.content ?? '';
          return { text: '{"elements":[{"nodeId":"1:1","role":"h","kind":"text"}]}' };
        }
        return { text: '{"elements":[{"nodeId":"1:1",', finish_reason: 'length' };
      },
      async progress() {
        return { jobId: 'x', armId: 'y', state: 'running', startedAt: 0, steps: [], meters: [], armVram: [] };
      },
    };

    const result = await runPass(
      {
        id: 'p1',
        step: 'pass1',
        validate: validateElements,
        request: { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 4096 },
      },
      { armId: 'arm', analysisId: 'analysis-0001', caller: arm },
    );

    expect(result.repaired).toBe(true);
    expect(repairPrompt).toContain('cut off at the 4096-token limit');
    // The advice has to be "say it shorter", not "fix the shape".
    expect(repairPrompt).toContain('complete this time');
    expect(repairPrompt).not.toContain('only fix the shape');
  });

  it('names the token limit when a reply is cut off twice', async () => {
    const arm: ArmCaller = {
      async job() {
        return { text: '{"elements":[{', finish_reason: 'length' };
      },
      async progress() {
        return { jobId: 'x', armId: 'y', state: 'running', startedAt: 0, steps: [], meters: [], armVram: [] };
      },
    };

    await expect(
      runPass(
        {
          id: 'p2',
          step: 'pass2',
          validate: validateElements,
          request: { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 4096 },
        },
        { armId: 'arm', analysisId: 'analysis-0001', caller: arm },
      ),
    ).rejects.toThrow(/cut off at its 4096-token limit twice.*raise the pass/s);
  });

  it('fails after a second bad reply, keeping what the model said', async () => {
    const arm = stubArm({ p1: 'nope', p1r: 'still nope' });

    await expect(
      runPass(
        {
          id: 'p1',
          step: 'pass1',
          validate: validateElements,
          request: { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10 },
        },
        { armId: 'arm', analysisId: 'analysis-0001', caller: arm },
      ),
    ).rejects.toMatchObject({ name: 'PassError', raw: 'still nope' });
  });

  it('quotes the validator’s complaint back to the model', async () => {
    let repairPrompt = '';
    const arm: ArmCaller = {
      async job(_armId, request) {
        const job = request.job as { messages: { role: string; content: string }[] };
        const last = job.messages[job.messages.length - 1];
        if (request.jobId.endsWith('r')) repairPrompt = last?.content ?? '';
        return {
          text: request.jobId.endsWith('r')
            ? '{"elements":[{"nodeId":"1:1","role":"h","kind":"text"}]}'
            : '{"elements":[{"role":"h","kind":"text"}]}',
        };
      },
      async progress() {
        return { jobId: 'x', armId: 'y', state: 'running', startedAt: 0, steps: [], meters: [], armVram: [] };
      },
    };

    await runPass(
      {
        id: 'p1',
        step: 'pass1',
        validate: validateElements,
        request: { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10 },
      },
      { armId: 'arm', analysisId: 'analysis-0001', caller: arm },
    );

    expect(repairPrompt).toContain('elements[0].nodeId is required');
  });
});

const DESIGN: NormalisedDesign = {
  adapter: 'stub',
  fileKey: 'AbCdEf123456',
  nodeId: '1:1',
  name: 'Featured Story Card',
  digest: '#1:1 FRAME "Featured Story Card"\n  #1:2 TEXT "Headline"',
  nodeIds: ['1:1', '1:2'],
  tokens: [],
  droppedNodes: 3,
};

const TICKET: NormalisedTicket = {
  format: 'jira-xml',
  key: 'CAP-59',
  summary: 'Featured Story Card',
  description: 'body',
  passages: [{ id: 'p1', heading: 'Acceptance Criteria', anchor: 'AcceptanceCriteria', body: '- one' }],
  comments: [{ id: '57484', body: 'video autoplay is supported' }],
  attachments: [{ id: '40139', name: 'desktop.png' }],
};

function stubDesign(read?: Partial<DesignRead>): DesignSource {
  return {
    name: 'stub',
    async read() {
      return { design: DESIGN, degraded: [], ...read } as DesignRead;
    },
  };
}

const ANSWERS = {
  p1: JSON.stringify({
    elements: [
      { nodeId: '1:2', role: 'headline', kind: 'text', sample: 'UNVEIL', repeated: false },
      { nodeId: '9:9', role: 'invented', kind: 'other', repeated: false },
    ],
  }),
  p2: JSON.stringify({
    claims: [
      { id: 'c1', passageId: 'p1', statement: 'Two columns.', kind: 'layout' },
      { id: 'c2', passageId: 'c1', statement: 'Video autoplay is supported.', kind: 'content' },
    ],
  }),
  p3: JSON.stringify({
    requirements: [
      { id: 'r1', statement: 'The headline is a single text field.', nodeIds: ['1:2'], passageIds: [] },
      { id: 'r2', statement: 'It fades in.', nodeIds: [], passageIds: [] },
    ],
    gaps: [
      {
        id: 'g1',
        kind: 'contradiction',
        statement: 'Media type disagrees.',
        designReading: 'The hero is a still image.',
        ticketReading: 'A comment says video autoplay is supported.',
        nodeIds: ['1:2'],
        passageIds: ['c1'],
        question: 'Does the hero accept video, or only images?',
      },
    ],
  }),
  p4: JSON.stringify({
    definitions: [
      {
        title: 'Featured Story Card',
        id: 'featured-story-card',
        plugins: { xwalk: { page: { resourceType: 'core/franklin/components/block/v1/block' } } },
      },
    ],
    models: [
      { id: 'featured-story-card', fields: [{ component: 'text', name: 'headline', label: 'Headline' }] },
    ],
    filters: [],
  }),
};

describe('analyse', () => {
  it('runs four passes and writes three artefacts', async () => {
    const run = new AnalysisRun('analysis-0001', 'text-arm');
    const result = await analyse({
      storageDir: storage,
      analysisId: 'analysis-0001',
      blockName: 'featured-story-card',
      armId: 'text-arm',
      reference: { fileKey: 'AbCdEf123456', nodeId: '1:1' },
      ticket: TICKET,
      design: stubDesign(),
      caller: stubArm(ANSWERS),
      run,
    });

    expect(result.record.state).toBe('done');
    expect(result.record.counts).toEqual({ requirements: 1, inferences: 1, gaps: 1 });

    expect(await readArtifact(storage, 'analysis-0001', 'requirements.md')).toContain(
      'The headline is a single text field.',
    );
    expect(await readArtifact(storage, 'analysis-0001', 'gaps.json')).toContain('Does the hero accept video');
    expect(await readArtifact(storage, 'analysis-0001', '_featured-story-card.json')).toContain(
      'core/franklin/components/block/v1/block',
    );
  });

  it('drops an element that cited a node the design does not have', async () => {
    const run = new AnalysisRun('analysis-0001', 'text-arm');
    await analyse({
      storageDir: storage,
      analysisId: 'analysis-0001',
      blockName: 'featured-story-card',
      armId: 'text-arm',
      reference: { fileKey: 'AbCdEf123456', nodeId: '1:1' },
      ticket: TICKET,
      design: stubDesign(),
      caller: stubArm(ANSWERS),
      run,
    });

    const pass1 = run.progress().steps.find((step) => step.key === 'pass1');
    expect(pass1?.detail).toBe('1 element');
    expect(pass1?.note).toMatch(/1 element\(s\) cited a node id that is not in the design/);
  });

  it('demotes a requirement with no evidence, and says so on the step', async () => {
    const run = new AnalysisRun('analysis-0001', 'text-arm');
    const result = await analyse({
      storageDir: storage,
      analysisId: 'analysis-0001',
      blockName: 'featured-story-card',
      armId: 'text-arm',
      reference: { fileKey: 'AbCdEf123456', nodeId: '1:1' },
      ticket: TICKET,
      design: stubDesign(),
      caller: stubArm(ANSWERS),
      run,
    });

    expect(result.inferences[0]?.statement).toBe('It fades in.');
    expect(result.markdown).toContain('## Inferences (1)');
    expect(run.progress().steps.find((step) => step.key === 'pass3')?.note).toMatch(/demoted/);
  });

  it('writes the sources before the first pass', async () => {
    const run = new AnalysisRun('analysis-0001', 'text-arm');
    // Pass 1 fails, so nothing after it runs -- but the digest and the ticket
    // must already be on disk or the rerun pays for them again.
    await expect(
      analyse({
        storageDir: storage,
        analysisId: 'analysis-0001',
        blockName: 'featured-story-card',
        armId: 'text-arm',
        reference: { fileKey: 'AbCdEf123456', nodeId: '1:1' },
        ticket: TICKET,
        design: stubDesign(),
        caller: stubArm({ p1: 'junk', p1r: 'junk' }),
        run,
      }),
    ).rejects.toThrow(PassError);

    expect(await readArtifact(storage, 'analysis-0001', 'design.json')).toContain('#1:1 FRAME');
    expect(await readArtifact(storage, 'analysis-0001', 'ticket.json')).toContain('CAP-59');
    // The reply is kept, so a failure can be read rather than guessed at.
    expect(await readArtifact(storage, 'analysis-0001', 'passes/p1-failed.txt')).toBe('junk');
    expect((await readRecord(storage, 'analysis-0001'))?.state).toBe('failed');
  });

  it('keeps a design-source failure’s own reason', async () => {
    const run = new AnalysisRun('analysis-0001', 'text-arm');
    const failing: DesignSource = {
      name: 'stub',
      async read() {
        throw new DesignSourceError('unreachable', 'connecting', 'nothing is listening');
      },
    };

    await expect(
      analyse({
        storageDir: storage,
        analysisId: 'analysis-0001',
        blockName: 'x',
        armId: 'text-arm',
        reference: { fileKey: 'AbCdEf123456', nodeId: '1:1' },
        ticket: TICKET,
        design: failing,
        caller: stubArm({}),
        run,
      }),
    ).rejects.toMatchObject({ reason: 'unreachable' });

    const steps = run.progress().steps;
    expect(steps.find((step) => step.key === 'design')?.state).toBe('failed');
    expect(steps.find((step) => step.key === 'pass1')?.state).toBe('pending');
  });
});

describe('renderRequirements', () => {
  it('leads with the requirement and keeps the evidence beside it', () => {
    const markdown = renderRequirements({
      record: { blockName: 'featured-story-card', armId: 'text-arm', startedAt: '2026-09-22T10:00:00.000Z' },
      design: DESIGN,
      ticket: TICKET,
      requirements: [
        { id: 'r1', statement: 'The headline is one text field.', evidence: { nodeIds: ['1:2'], passageIds: [] } },
      ],
      inferences: [{ id: 'r2', statement: 'It fades in.', reason: 'no evidence' }],
      gaps: [
        {
          id: 'g1',
          kind: 'contradiction',
          statement: 'Media type disagrees.',
          designReading: 'A still image.',
          ticketReading: 'A comment says video.',
          evidence: { nodeIds: ['1:2'], passageIds: [] },
          question: 'Video or images?',
        },
      ],
    });

    expect(markdown).toContain('# featured-story-card');
    expect(markdown).toContain('- The headline is one text field. <sub>`#1:2`</sub>');
    expect(markdown).toContain('### Contradictions — the design wins');
    expect(markdown).toContain('**Ask:** Video or images?');
    expect(markdown).toContain('## Inferences (1)');
    // What was not read is part of the report, not a footnote to omit.
    expect(markdown).toContain('3 hidden or decorative nodes were removed');
    expect(markdown).toContain('desktop.png');
    expect(markdown).toContain('1 comment was read');
  });
});

describe('modelFileName', () => {
  it('is the file the boilerplate merges', () => {
    expect(modelFileName('featured-story-card')).toBe('_featured-story-card.json');
    expect(modelFileName('Featured Story Card')).toBe('_featured-story-card.json');
  });
});
