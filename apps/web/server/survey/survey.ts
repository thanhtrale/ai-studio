/**
 * One survey, start to finish.
 *
 * The order is chosen so that the cheapest thing that can fail fails first and
 * the most valuable thing that can succeed is saved earliest. Reaching Figma is
 * one round trip and it is the failure a person most often has to fix, so it is
 * the first step rather than a surprise five minutes in. The crawl comes next
 * and its result is written to disk the moment it is done -- everything after
 * it is annotation, and a survey whose renders time out or whose model batches
 * fail is still an index of the file.
 *
 * Nothing in here raises past the caller for a partial failure. A page that
 * would not read, a frame that would not render, a batch the model mangled: all
 * of them land in `inventory.warnings`, because the honest report is "this is
 * what was found, and this is what was missed", not an exception that throws
 * away the nine tenths that worked.
 */

import type {
  SurveyInventory,
  SurveyOptions,
  SurveyRecord,
  SurveyRoot,
} from '#shared/survey';

import { openFigmaSession } from '../analysis/design/mcp';
import type { McpSession, OpenSessionOptions } from '../analysis/design/mcp';
import type { ArmCaller } from '../analysis/pipeline/runner';

import { crawlFigma, groupIntoModules } from './crawl';
import type { CrawlLimits } from './crawl';
import { MODULE_BATCH, describeComponents, describeScreens, describeSections } from './enrich';
import { FigmaMcpShots, FigmaRestShots } from './images';
import type { Shot } from './images';
import { resolveMainComponents } from './resolve';
import type { SurveyRun } from './run';
import { shotName, writeSurveyArtifact, writeSurveyInventory, writeSurveyRecord } from './store';

export interface RunSurveyOptions {
  storageDir: string;
  surveyId: string;
  title: string;
  links: string;
  roots: SurveyRoot[];
  armId: string;
  armParams: Record<string, unknown>;
  options: SurveyOptions;
  caller: ArmCaller;
  run: SurveyRun;
  limits?: CrawlLimits;
  /**
   * A Figma personal access token, when one is configured.
   *
   * Its only use is rendering: with it, frames come from Figma's own image
   * endpoint thirty at a time and the desktop app need not have the file open.
   * Without it every render is a separate call to the local MCP server.
   */
  figmaToken?: string;
  /** Test seam: supply a session instead of opening one over HTTP. */
  openSession?: (options: OpenSessionOptions) => Promise<McpSession>;
}

/** How often the index is rewritten while rendering, in frames. */
const SHOT_CHECKPOINT = 10;

/** Nodes per request to Figma's image endpoint, and per tick of the meter. */
const SHOT_BATCH = 30;

function nowIso(): string {
  return new Date().toISOString();
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSurvey(options: RunSurveyOptions): Promise<SurveyRecord> {
  const { storageDir, surveyId, run } = options;

  const record: SurveyRecord = {
    surveyId,
    title: options.title,
    links: options.links,
    fileKey: options.roots[0]?.fileKey ?? '',
    ...(options.roots.find((root) => root.fileName)?.fileName === undefined
      ? {}
      : { fileName: options.roots.find((root) => root.fileName)?.fileName }),
    armId: options.armId,
    state: 'running',
    startedAt: nowIso(),
    options: options.options,
  };

  // Written before the slow part, so a run killed by a reload is still listed
  // and still reports why it stopped.
  await writeSurveyRecord(storageDir, record);

  let session: McpSession | undefined;

  try {
    run.start('connect');
    const open = options.openSession ?? openFigmaSession;
    session = await open({});
    run.done('connect', 'the local Figma MCP server answered');

    run.start('crawl', `${options.roots.length} page${options.roots.length === 1 ? '' : 's'}`);
    run.meter('crawl', 'Pages read', 0, options.roots.length);

    const { inventory, trees } = await crawlFigma(session, options.roots, options.limits, {
      root: (at, total, label) => {
        run.describe('crawl', `page ${at + 1} of ${total} — ${label}`);
        run.meter('crawl', 'Pages read', at, total);
      },
    });

    run.meter('crawl', 'Pages read', options.roots.length, options.roots.length);
    run.done(
      'crawl',
      `${inventory.screens.length} screens, ${inventory.components.length} components, ` +
        `${inventory.screens.reduce((total, screen) => total + screen.views.length, 0)} frames`,
    );

    await writeSurveyInventory(storageDir, surveyId, inventory);
    await writeSurveyRecord(storageDir, { ...record, ...countsOf(record, inventory, 0) });

    await resolve(session, inventory, options);
    await writeSurveyInventory(storageDir, surveyId, inventory);

    const shots = await captureShots(session, inventory, options);
    await writeSurveyInventory(storageDir, surveyId, inventory);

    // Figma has nothing more to give, and the model passes are minutes. Holding
    // the session open through them would keep another application's server
    // busy for no reason.
    await session.close().catch(() => undefined);
    session = undefined;

    await describe(inventory, trees, options);
    await writeSurveyInventory(storageDir, surveyId, inventory);

    run.start('write');
    const finished: SurveyRecord = {
      ...record,
      state: 'done',
      endedAt: nowIso(),
      ...countsOf(record, inventory, shots),
    };
    await writeSurveyRecord(storageDir, finished);
    run.done('write', `saved as ${surveyId}`);
    run.finish();

    return finished;
  } catch (error) {
    const detail = reasonOf(error);
    // The step that was running is the step that failed; nothing else knows
    // which that was, so the run's own current step is what gets marked.
    const current = run.progress().steps.find((step) => step.state === 'running');
    run.fail(current?.key ?? 'connect', detail);

    const failed: SurveyRecord = { ...record, state: 'failed', endedAt: nowIso(), detail };
    await writeSurveyRecord(storageDir, failed).catch(() => undefined);
    return failed;
  } finally {
    await session?.close().catch(() => undefined);
  }
}

function countsOf(
  record: SurveyRecord,
  inventory: SurveyInventory,
  shots: number,
): Pick<SurveyRecord, 'counts' | 'fileName'> {
  const counts = {
    pages: inventory.pages.length,
    screens: inventory.screens.length,
    views: inventory.screens.reduce((total, screen) => total + screen.views.length, 0),
    components: inventory.components.length,
    modules: inventory.modules.length,
    shots,
  };
  const fileName = inventory.fileName ?? record.fileName;
  return fileName === undefined ? { counts } : { counts, fileName };
}

/**
 * Follows every instance to its main component, which is where the real names
 * are, what is inside them, and often the page nobody linked.
 */
async function resolve(
  session: McpSession,
  inventory: SurveyInventory,
  options: RunSurveyOptions,
): Promise<void> {
  const { run } = options;

  if (!options.options.resolveComponents) {
    run.skip('resolve', 'not asked for — names come from the instances');
    return;
  }

  const outstanding = inventory.components.filter(
    (component) => component.structure === undefined,
  ).length;

  if (outstanding === 0) {
    run.skip('resolve', 'every component had already been read');
    return;
  }

  run.start('resolve', `${outstanding} to read`);
  run.meter('resolve', 'Components read', 0, outstanding);

  const before = inventory.components.length;
  const read = await resolveMainComponents(session, inventory, {
    fileKey: inventory.fileKey,
    ...(inventory.fileName === undefined ? {} : { fileName: inventory.fileName }),
    onProgress: (done, total) => run.meter('resolve', 'Components read', done, total),
    onWarning: (warning) => inventory.warnings.push(warning),
  });

  const folded = before - inventory.components.length;
  // The names the grouping was derived from have just changed under it.
  inventory.modules = groupIntoModules(inventory.components, inventory.screens);
  run.done('resolve', folded > 0 ? `${read} read, ${folded} folded into another entry` : `${read} read`);
}

/**
 * Renders what the budget allows, widest drawing of each screen first.
 *
 * The order is the point of the cap. A file with two hundred frames and a
 * budget of sixty should spend it on one drawing of each of sixty screens, not
 * on three drawings of twenty -- so every screen is given its first view before
 * any screen is given its second.
 */
async function captureShots(
  session: McpSession,
  inventory: SurveyInventory,
  options: RunSurveyOptions,
): Promise<number> {
  const { run, storageDir, surveyId } = options;
  const settings = options.options;

  if (!settings.screenshots && !settings.componentShots) {
    run.skip('shots', 'not asked for');
    return 0;
  }

  const targets: { nodeId: string; assign(name: string): void }[] = [];

  if (settings.screenshots) {
    // Every screen gets its first drawing before any screen gets its second: a
    // budget of sixty should buy sixty screens, not twenty screens three times.
    const depth = Math.max(0, ...inventory.screens.map((screen) => screen.views.length));
    const views: { nodeId: string; assign(name: string): void }[] = [];
    for (let round = 0; round < depth; round += 1) {
      for (const screen of inventory.screens) {
        const view = screen.views[round];
        if (!view) continue;
        views.push({ nodeId: view.nodeId, assign: (name) => (view.shot = name) });
      }
    }
    targets.push(...views.slice(0, Math.max(0, settings.maxShots)));
    if (views.length > settings.maxShots) {
      inventory.warnings.push(
        `${views.length - settings.maxShots} screen frames were not rendered; the run was capped at ` +
          `${settings.maxShots}`,
      );
    }
  }

  if (settings.componentShots) {
    // Busiest first, so a cap costs the components nobody uses.
    const ranked = [...inventory.components].sort((a, b) => b.instances - a.instances);
    const budget = Math.max(0, settings.maxComponentShots);
    targets.push(
      ...ranked.slice(0, budget).map((component) => ({
        nodeId: component.nodeId,
        assign: (name: string) => (component.shot = name),
      })),
    );
    if (ranked.length > budget) {
      inventory.warnings.push(
        `${ranked.length - budget} components were not rendered; the run was capped at ${budget}`,
      );
    }
  }

  const budget = targets;
  if (budget.length === 0) {
    run.skip('shots', 'nothing to render');
    return 0;
  }

  // One node can be both a screen's frame and a component's; it is rendered
  // once and both entries point at the same file.
  const assigned = new Map<string, ((name: string) => void)[]>();
  for (const target of budget) {
    const list = assigned.get(target.nodeId) ?? [];
    list.push(target.assign);
    assigned.set(target.nodeId, list);
  }
  const nodeIds = [...assigned.keys()];
  const total = nodeIds.length;

  const rest = options.figmaToken
    ? new FigmaRestShots(inventory.fileKey, options.figmaToken)
    : undefined;
  const local = new FigmaMcpShots(session);

  run.start('shots', `${total} frames via ${rest ? 'the Figma image API' : 'the local Figma server'}`);
  run.meter('shots', 'Frames rendered', 0, total);

  const filed = new Set<string>();

  const file = async (nodeId: string, shot: Shot): Promise<void> => {
    const name = shotName(nodeId);
    await writeSurveyArtifact(storageDir, surveyId, name, shot.bytes);
    for (const assign of assigned.get(nodeId) ?? []) assign(name);
    filed.add(nodeId);
  };

  // The batch route first: one request renders thirty nodes, and the local
  // server is then only asked about what it did not return.
  if (rest) {
    try {
      for (let at = 0; at < total; at += SHOT_BATCH) {
        const slice = nodeIds.slice(at, at + SHOT_BATCH);
        const found = await rest.shots(slice);
        for (const [nodeId, shot] of found) await file(nodeId, shot);

        run.meter('shots', 'Frames rendered', Math.min(at + slice.length, total), total);
        // Checkpointed, so a process that dies part-way through keeps the
        // renders it already wrote rather than orphaning them on disk.
        await writeSurveyInventory(storageDir, surveyId, inventory);
      }
    } catch (error) {
      // A token that will not authorise is not a reason to render nothing: the
      // local server is right there and needs no token at all.
      inventory.warnings.push(`${reasonOf(error)} -- falling back to the local Figma server`);
    }
  }

  const missing = nodeIds.filter((nodeId) => !filed.has(nodeId));
  const alreadyDone = total - missing.length;

  for (const [at, nodeId] of missing.entries()) {
    const shot = await local.one(nodeId);
    if (shot) await file(nodeId, shot);

    run.meter('shots', 'Frames rendered', alreadyDone + at + 1, total);
    if ((at + 1) % SHOT_CHECKPOINT === 0) {
      await writeSurveyInventory(storageDir, surveyId, inventory);
    }
  }

  const refused = total - filed.size;
  if (refused > 0) {
    inventory.warnings.push(
      `${refused} of ${total} frames would not render. ` +
        (rest
          ? 'Figma renders a node only when it belongs to the file the key names.'
          : 'Set AISTUDIO_FIGMA_TOKEN to a Figma personal access token and this uses Figma’s own ' +
            'image endpoint instead, which renders thirty nodes a request and does not need the ' +
            'file open in the desktop app.'),
    );
  }

  run.meter('shots', 'Frames rendered', total, total);
  run.done('shots', refused === 0 ? `${filed.size} rendered` : `${filed.size} rendered, ${refused} refused`);
  return filed.size;
}

/** The model's two questions, and what they change about the inventory. */
async function describe(
  inventory: SurveyInventory,
  trees: Parameters<typeof describeScreens>[1],
  options: RunSurveyOptions,
): Promise<void> {
  const { run } = options;

  if (!options.options.describe) {
    run.skip('modules', 'grouped by name — the model was not asked');
    run.skip('screens', 'not asked for');
    run.skip('sections', 'read from the design, but not modelled');
    return;
  }

  const shared = {
    surveyId: options.surveyId,
    armId: options.armId,
    armParams: options.armParams,
    caller: options.caller,
    run,
    onWarning: (warning: string) => inventory.warnings.push(warning),
  };

  run.start('modules', `${inventory.components.length} components`);
  run.meter('modules', 'Batches', 0, Math.ceil(inventory.components.length / MODULE_BATCH) || 1);

  const assignments = await describeComponents(inventory.components, inventory.screens, {
    ...shared,
    onProgress: (done, total) => run.meter('modules', 'Batches', done, total),
  });

  for (const component of inventory.components) {
    const purpose = assignments.get(component.id)?.purpose;
    if (purpose) component.purpose = purpose;
  }

  // Rebuilt in one place from whatever module each component ended up with,
  // named or inferred, so a partly-described survey is still one shape.
  inventory.modules = groupIntoModules(
    inventory.components,
    inventory.screens,
    new Map([...assignments].map(([id, assignment]) => [id, assignment.module])),
  );

  run.done('modules', `${inventory.modules.length} modules`);

  const wanted = inventory.screens.slice(0, Math.max(0, options.options.maxScreenSummaries));
  if (wanted.length === 0) {
    run.skip('screens', 'not asked for');
  } else {
    run.start('screens', `${wanted.length} of ${inventory.screens.length}`);
    run.meter('screens', 'Screens described', 0, wanted.length);

    const described = await describeScreens(wanted, trees, inventory.components, {
      ...shared,
      onProgress: (done, total) => run.meter('screens', 'Screens described', done, total),
    });

    for (const screen of inventory.screens) {
      const description = described.get(screen.id);
      if (!description) continue;
      screen.purpose = description.purpose;
      screen.content = description.content;
    }

    run.done('screens', `${described.size} described`);
  }

  // A module's screens are the screens its components appear on, which is only
  // knowable once both lists are final.
  const moduleByComponent = new Map(
    inventory.components.map((component) => [component.id, component.moduleId]),
  );
  for (const screen of inventory.screens) {
    const counts = new Map<string, number>();
    for (const componentId of screen.componentIds) {
      const moduleId = moduleByComponent.get(componentId);
      if (moduleId) counts.set(moduleId, (counts.get(moduleId) ?? 0) + 1);
    }
    const leading = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (leading) screen.moduleId = leading[0];
  }

  await modelSections(inventory, options, shared);
}

/**
 * The drill-down: one pass per band, producing what an author types into it.
 *
 * Tallest first. A 900pt band is the page and a 40pt one is a divider, so when
 * the budget runs out it should run out on the dividers -- and height is a
 * better proxy for "this is the thing being built" than document order is.
 */
async function modelSections(
  inventory: SurveyInventory,
  options: RunSurveyOptions,
  shared: Omit<Parameters<typeof describeSections>[2], 'onProgress'>,
): Promise<void> {
  const { run } = options;

  const all = inventory.screens.flatMap((screen) =>
    screen.sections.map((section) => ({ screen, section })),
  );

  const wanted = [...all]
    .sort((a, b) => (b.section.height ?? 0) - (a.section.height ?? 0))
    .slice(0, Math.max(0, options.options.maxSectionSummaries));

  if (wanted.length === 0) {
    run.skip('sections', all.length === 0 ? 'no bands were found' : 'not asked for');
    return;
  }

  run.start('sections', `${wanted.length} of ${all.length}`);
  run.meter('sections', 'Sections modelled', 0, wanted.length);

  const described = await describeSections(wanted, inventory.components, {
    ...shared,
    onProgress: (done, total) => run.meter('sections', 'Sections modelled', done, total),
  });

  for (const screen of inventory.screens) {
    for (const section of screen.sections) {
      const description = described.get(`${screen.id}/${section.id}`);
      if (!description) continue;

      section.purpose = description.purpose;
      if (description.authoring) section.authoring = description.authoring;

      // The labels are matched back by node id, so a slot the model renamed or
      // invented cannot displace a real one.
      for (const field of section.fields) {
        const named = description.labels.get(field.nodeId);
        if (!named) continue;
        field.label = named.label;
        if (named.note) field.note = named.note;
      }
    }
  }

  run.done('sections', `${described.size} modelled`);
}
