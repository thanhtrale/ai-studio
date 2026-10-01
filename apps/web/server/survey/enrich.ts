/**
 * The two questions the crawl cannot answer, asked of a local model.
 *
 * The crawl produces names, counts and node ids. What it cannot produce is
 * *meaning*: which functional area `Chip/Filter/Active` belongs to, and what
 * the screen called "Listing" is actually for. Those are the only two things
 * the model is asked, and both are asked in a shape that fits a small context
 * window on one card.
 *
 * ## Why this is batched the way it is
 *
 * A survey of a real product file has several hundred components. Handing a
 * model several hundred names at once produces a reply that is either truncated
 * or lazy, and one bad batch would poison the whole grouping. So the names go
 * in batches, each batch is its own supervisor job, and a batch that fails is a
 * batch's worth of components falling back to their name-derived module rather
 * than a failed survey. The run degrades in slices.
 *
 * Screens are the opposite shape -- few of them, but each is a whole tree -- so
 * each screen is its own pass over its own digest, and only the widest drawing
 * is read. Three viewports of one screen are three near-identical trees, and
 * the second and third would buy repetition with context.
 *
 * Nothing the model returns is trusted with a name. Its answers are matched
 * back to components by the exact string it was given, and an answer naming
 * something that was not in the batch is dropped. That is what stops a
 * "helpful" rewrite of `Card/Article` to `Article Card` from silently becoming
 * the name in the survey.
 */

import type { SurveyComponent, SurveyScreen, SurveySection } from '#shared/survey';

import type { DesignNode } from '../analysis/design/digest';
import { buildDigest } from '../analysis/design/digest';
import type { ArmCaller, PassDefinition, PassHost } from '../analysis/pipeline/runner';
import { runPass } from '../analysis/pipeline/runner';

/**
 * Components per batch.
 *
 * Thirty entries in, thirty short objects out. Each entry now carries a line of
 * what is actually inside the component, so a batch is several times the tokens
 * it used to be and the count came down to match. It is worth it: asked to say
 * what `Content-card/split/media` is for from the name alone, a model can only
 * paraphrase the name back.
 */
export const MODULE_BATCH = 30;

const MODULE_SYSTEM =
  'You are cataloguing a design system that already exists. You are given component names exactly ' +
  'as they are spelled in Figma, with how often each is used, what is inside it, and which screens ' +
  'it appears on.\n\n' +
  'For each component, say which module of the product it belongs to and what it is for. A module ' +
  'is a functional area a developer would put in one folder -- navigation, search, article, media, ' +
  'forms, layout primitives -- not a visual category. Reuse a module name across components rather ' +
  'than inventing one per component: a grouping where every component is alone has grouped nothing.\n\n' +
  'Write the purpose from what the component contains, not from its name. Say what it shows and ' +
  'what a person does with it. "A card component" is worthless; "shows an article image beside a ' +
  'headline, kicker and date, linking to the article" is the answer.\n\n' +
  'Copy every name back exactly as it was given, character for character, including slashes and ' +
  'capitals. Never rename, tidy, translate or expand a name. Answer with JSON and nothing else.';

const SCREEN_SYSTEM =
  'You are reading one screen of a design file, given as an indented outline of its layers with ' +
  'their text, and the list of bands it is built from.\n\n' +
  'Say what the screen is for and what kinds of content it shows. Describe only what the outline ' +
  'contains. Do not invent behaviour, states or navigation that is not visible in it, and do not ' +
  'describe the design system -- describe this screen. Answer with JSON and nothing else.';

const SECTION_SYSTEM =
  'You are a developer reading one band of a web page in Figma, so that somebody can build it as an ' +
  'authorable block. You are given the band\u2019s name, the design-system components inside it, the ' +
  'slots that hold content, and the layers that no component covers.\n\n' +
  'For each slot, say what the author is actually being asked for -- a short label, the way it ' +
  'would read above an input box -- and add a note only where the label is not enough. Use the ' +
  'sample text to work out what the slot is: \u201cWellness with new eyes\u201d in a large layer is a ' +
  'headline, not a paragraph.\n\n' +
  'Then say in two or three sentences how an author fills this band in: what they type, what they ' +
  'upload, what repeats, and anything that is a setting rather than content.\n\n' +
  'Copy every slot id back exactly as given. Never invent a slot. Answer with JSON and nothing else.';

export interface ModuleAssignment {
  module: string;
  purpose?: string;
}

/** One batch of components, as a pass. */
function moduleBatch(
  at: number,
  batch: SurveyComponent[],
  screenNames: Map<string, string>,
): PassDefinition<Map<string, ModuleAssignment>> {
  const lines = batch.map((component, index) => {
    const screens = component.screenIds
      .map((id) => screenNames.get(id))
      .filter((name): name is string => Boolean(name))
      .slice(0, 4);

    const facts = [
      component.type.toLowerCase().replace('_', ' '),
      `${component.instances} use${component.instances === 1 ? '' : 's'}`,
    ];
    if (component.width) facts.push(`${component.width}×${component.height ?? '?'}`);
    if (component.variants.length) facts.push(`variants: ${component.variants.slice(0, 3).join(' | ')}`);
    if (screens.length) facts.push(`on: ${screens.join(', ')}`);

    // The contents are what makes a purpose worth reading. Text first, because
    // the words a component was drawn with say more about it than its layer
    // names do; then what it is built out of.
    const inside: string[] = [];
    if (component.text?.length) {
      inside.push(`text: ${component.text.slice(0, 5).map((value) => `“${value}”`).join(', ')}`);
    }
    if (component.uses?.length) inside.push(`contains: ${component.uses.slice(0, 6).join(', ')}`);

    return [
      `${index + 1}. ${component.name}  [${facts.join('; ')}]`,
      ...inside.map((line) => `   ${line}`),
    ].join('\n');
  });

  const user =
    `Components:\n${lines.join('\n')}\n\n` +
    'Answer with exactly this shape, one entry per component above, in the same order:\n' +
    '{"assignments":[{"name":"<the name exactly as given>","module":"<module name>",' +
    '"purpose":"<one sentence saying what it shows and what it is for>"}]}';

  return {
    id: `m${at + 1}`,
    step: 'modules',
    request: {
      system: MODULE_SYSTEM,
      messages: [{ role: 'user', content: user }],
      maxTokens: 3_000,
      thinking: false,
      temperature: 0.2,
    },
    validate(value) {
      const assignments = (value as { assignments?: unknown })?.assignments;
      if (!Array.isArray(assignments)) throw new Error('the reply had no "assignments" array');

      // Matched by the exact string the model was given. An answer about a name
      // that was not in the batch is an invention, and it is dropped rather than
      // reconciled: there is nothing to reconcile it to.
      const byName = new Map(batch.map((component) => [component.name.toLowerCase(), component.id]));
      const found = new Map<string, ModuleAssignment>();

      for (const entry of assignments) {
        if (!entry || typeof entry !== 'object') continue;
        const name = (entry as { name?: unknown }).name;
        const module = (entry as { module?: unknown }).module;
        if (typeof name !== 'string' || typeof module !== 'string' || !module.trim()) continue;

        const id = byName.get(name.trim().toLowerCase());
        if (!id) continue;

        const purpose = (entry as { purpose?: unknown }).purpose;
        found.set(id, {
          module: module.trim().slice(0, 48),
          ...(typeof purpose === 'string' && purpose.trim()
            ? { purpose: purpose.trim().slice(0, 300) }
            : {}),
        });
      }

      if (found.size === 0) throw new Error('none of the names in the reply matched the ones given');
      return found;
    },
  };
}

export interface ScreenDescription {
  purpose: string;
  content: string[];
}

function screenPass(
  at: number,
  screen: SurveyScreen,
  tree: DesignNode,
  componentNames: string[],
): PassDefinition<ScreenDescription> {
  const widest = screen.views[0];
  const digest = buildDigest(tree, { maxNodes: 180, maxChars: 9_000 });

  const viewports = screen.views
    .map((view) => `${view.viewport} ${view.width ?? '?'}x${view.height ?? '?'}`)
    .join(', ');

  const user =
    `Screen: ${screen.name}\nPage: ${screen.page}\n` +
    `Drawn at: ${viewports}\n` +
    (widest ? `Reading the ${widest.viewport} drawing.\n` : '') +
    (screen.sections.length
      ? `Bands, top to bottom: ${screen.sections.map((section) => section.name).join(' → ')}\n`
      : '') +
    (componentNames.length
      ? `Design system components on it: ${componentNames.slice(0, 40).join(', ')}\n`
      : '') +
    `\nLayers:\n${digest.digest}\n\n` +
    'Answer with exactly this shape:\n' +
    '{"purpose":"<one or two sentences>","content":["<a kind of content the screen shows>"]}';

  return {
    id: `s${at + 1}`,
    step: 'screens',
    request: {
      system: SCREEN_SYSTEM,
      messages: [{ role: 'user', content: user }],
      maxTokens: 700,
      thinking: false,
      temperature: 0.2,
    },
    validate(value) {
      const purpose = (value as { purpose?: unknown })?.purpose;
      if (typeof purpose !== 'string' || !purpose.trim()) throw new Error('the reply had no "purpose"');

      const raw = (value as { content?: unknown }).content;
      const content = Array.isArray(raw)
        ? raw
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim().slice(0, 160))
            .slice(0, 16)
        : [];

      return { purpose: purpose.trim().slice(0, 600), content };
    },
  };
}

export interface SectionDescription {
  purpose: string;
  authoring: string;
  /** Keyed by the slot's node id, which is what the model was given. */
  labels: Map<string, { label: string; note?: string }>;
}

function sectionPass(
  at: number,
  screen: SurveyScreen,
  section: SurveySection,
  componentNames: string[],
): PassDefinition<SectionDescription> {
  const slots = section.fields.map((field) => {
    const facts: string[] = [field.kind];
    if (field.repeated) facts.push('repeats');
    if (field.componentName) facts.push(`in ${field.componentName}`);
    const shown = field.sample ? ` — “${field.sample}”` : '';
    return `  ${field.nodeId} | ${field.name} [${facts.join('; ')}]${shown}`;
  });

  const loose = section.orphans
    .slice(0, 12)
    .map((orphan) => `  ${orphan.name} (${orphan.type})${orphan.sample ? ` — “${orphan.sample}”` : ''}`);

  const user =
    `Band: ${section.name}\nOn screen: ${screen.name}\n` +
    (section.componentName ? `The whole band is one component: ${section.componentName}\n` : '') +
    `Size: ${section.width ?? '?'}×${section.height ?? '?'}\n` +
    (componentNames.length ? `Components inside: ${componentNames.slice(0, 20).join(', ')}\n` : '') +
    (section.assets.length
      ? `Assets: ${section.assets.length} (${[...new Set(section.assets.map((asset) => asset.kind))].join(', ')})\n`
      : '') +
    (slots.length ? `\nSlots:\n${slots.join('\n')}\n` : '\nNo content slots were found.\n') +
    (loose.length ? `\nLayers no component covers:\n${loose.join('\n')}\n` : '') +
    '\nAnswer with exactly this shape:\n' +
    '{"purpose":"<one sentence: what this band is>",' +
    '"authoring":"<two or three sentences: how an author fills it in>",' +
    '"slots":[{"id":"<the slot id exactly as given>","label":"<what to call the input>",' +
    '"note":"<only when the label is not enough>"}]}';

  return {
    id: `b${at + 1}`,
    step: 'sections',
    request: {
      system: SECTION_SYSTEM,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1_400,
      thinking: false,
      temperature: 0.2,
    },
    validate(value) {
      const purpose = (value as { purpose?: unknown })?.purpose;
      if (typeof purpose !== 'string' || !purpose.trim()) throw new Error('the reply had no "purpose"');

      const authoring = (value as { authoring?: unknown })?.authoring;
      const ids = new Set(section.fields.map((field) => field.nodeId));
      const labels = new Map<string, { label: string; note?: string }>();

      for (const entry of ((value as { slots?: unknown }).slots as unknown[]) ?? []) {
        if (!entry || typeof entry !== 'object') continue;
        const id = (entry as { id?: unknown }).id;
        const label = (entry as { label?: unknown }).label;
        // A slot the model made up has no node behind it and is dropped: there
        // is nothing in the design for it to be about.
        if (typeof id !== 'string' || !ids.has(id.trim())) continue;
        if (typeof label !== 'string' || !label.trim()) continue;

        const note = (entry as { note?: unknown }).note;
        labels.set(id.trim(), {
          label: label.trim().slice(0, 60),
          ...(typeof note === 'string' && note.trim() ? { note: note.trim().slice(0, 200) } : {}),
        });
      }

      return {
        purpose: purpose.trim().slice(0, 400),
        authoring: typeof authoring === 'string' ? authoring.trim().slice(0, 800) : '',
        labels,
      };
    },
  };
}

export interface EnrichOptions {
  surveyId: string;
  armId: string;
  armParams: Record<string, unknown>;
  caller: ArmCaller;
  run: PassHost;
  /** Called after each batch or screen, so the meter advances. */
  onProgress?(done: number, total: number): void;
  /** Called when one slice failed, so the survey can say so without stopping. */
  onWarning?(warning: string): void;
}

/**
 * Asks for a module and a purpose for every component.
 *
 * Returns what it learned rather than mutating: the caller owns the inventory
 * and rebuilds the module list from this in one place, which is what keeps a
 * described survey and an undescribed one the same shape.
 */
export async function describeComponents(
  components: SurveyComponent[],
  screens: SurveyScreen[],
  options: EnrichOptions,
): Promise<Map<string, ModuleAssignment>> {
  const screenNames = new Map(screens.map((screen) => [screen.id, screen.name]));
  const batches: SurveyComponent[][] = [];
  for (let at = 0; at < components.length; at += MODULE_BATCH) {
    batches.push(components.slice(at, at + MODULE_BATCH));
  }

  const found = new Map<string, ModuleAssignment>();

  for (const [at, batch] of batches.entries()) {
    try {
      const result = await runPass(moduleBatch(at, batch, screenNames), {
        armId: options.armId,
        armParams: options.armParams,
        analysisId: options.surveyId,
        caller: options.caller,
        run: options.run,
      });
      for (const [id, assignment] of result.value) found.set(id, assignment);
    } catch (error) {
      // A batch that would not answer costs its own components their module,
      // and nothing else. They fall back to the name-derived grouping.
      options.onWarning?.(
        `components ${at * MODULE_BATCH + 1}–${at * MODULE_BATCH + batch.length} were not grouped: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    options.onProgress?.(at + 1, batches.length);
  }

  return found;
}

/** Asks what each screen is for, one screen at a time. */
export async function describeScreens(
  screens: SurveyScreen[],
  trees: Map<string, DesignNode>,
  components: SurveyComponent[],
  options: EnrichOptions,
): Promise<Map<string, ScreenDescription>> {
  const nameById = new Map(components.map((component) => [component.id, component.name]));
  const found = new Map<string, ScreenDescription>();

  for (const [at, screen] of screens.entries()) {
    const tree = trees.get(screen.id);
    if (!tree) {
      options.onProgress?.(at + 1, screens.length);
      continue;
    }

    const names = screen.componentIds
      .map((id) => nameById.get(id))
      .filter((name): name is string => Boolean(name));

    try {
      const result = await runPass(screenPass(at, screen, tree, names), {
        armId: options.armId,
        armParams: options.armParams,
        analysisId: options.surveyId,
        caller: options.caller,
        run: options.run,
      });
      found.set(screen.id, result.value);
    } catch (error) {
      options.onWarning?.(
        `"${screen.name}" was not described: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    options.onProgress?.(at + 1, screens.length);
  }

  return found;
}

/**
 * Asks what each band is and how an author fills it in.
 *
 * One pass per section rather than one per screen, and that is the expensive
 * decision in this file. It is made deliberately: a screen-wide pass has to
 * describe six bands in one reply and gives each of them a sentence, while the
 * thing a developer is about to build is one band. The slots are named
 * individually or the authoring model is guesswork.
 */
export async function describeSections(
  work: { screen: SurveyScreen; section: SurveySection }[],
  components: SurveyComponent[],
  options: EnrichOptions,
): Promise<Map<string, SectionDescription>> {
  const nameById = new Map(components.map((component) => [component.id, component.name]));
  const found = new Map<string, SectionDescription>();

  for (const [at, { screen, section }] of work.entries()) {
    const names = section.componentIds
      .map((id) => nameById.get(id))
      .filter((name): name is string => Boolean(name));

    try {
      const result = await runPass(sectionPass(at, screen, section, names), {
        armId: options.armId,
        armParams: options.armParams,
        analysisId: options.surveyId,
        caller: options.caller,
        run: options.run,
      });
      found.set(`${screen.id}/${section.id}`, result.value);
    } catch (error) {
      options.onWarning?.(
        `"${section.name}" on ${screen.name} was not described: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    options.onProgress?.(at + 1, work.length);
  }

  return found;
}
