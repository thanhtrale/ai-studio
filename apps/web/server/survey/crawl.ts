/**
 * Reading a whole Figma file, without a model.
 *
 * Everything in here is arithmetic. What counts as a screen, which viewport a
 * frame is, what a component is called and how many times it appears are all
 * decided by rules, not by a language model, for three reasons: the answers are
 * checkable, the same file surveys the same way twice, and a name transcribed
 * by a model is a name that can come back subtly wrong. The model's turn comes
 * afterwards, and only for the two questions arithmetic cannot answer.
 *
 * ## The context strategy
 *
 * Figma's `get_metadata` returns the *whole* subtree of the node it is given,
 * as a sparse XML outline. That is the lever this feature pulls: one call per
 * page yields every frame, every instance and every name, and none of it goes
 * anywhere near a context window. A file with two thousand layers costs two or
 * three MCP calls and zero tokens.
 *
 * What does cost tokens is described in `enrich.ts`, and it is deliberately a
 * list of names rather than a tree. The reduction from "a design file" to "a
 * few hundred short lines" happens here, in code, which is why a survey of a
 * large file is possible at all on a single local card.
 */

import type {
  SurveyComponent,
  SurveyComponentType,
  SurveyInventory,
  SurveyModule,
  SurveyPage,
  SurveyRoot,
  SurveyScreen,
  SurveyView,
} from '#shared/survey';
import { figmaNodeUrl, screenBaseName, slugOf, viewportOf } from '#shared/survey';

import type { DesignNode } from '../analysis/design/digest';
import { DesignSourceError } from '../analysis/design/errors';
import { parseFigmaMetadata } from '../analysis/design/figma-metadata';
import type { McpSession } from '../analysis/design/mcp';
import { textOfResult } from '../analysis/design/mcp';

import { sectionsOf } from './sections';

/**
 * Types that hold other nodes rather than being a screen themselves.
 *
 * A link to a page gives one of these and its children are the screens; a link
 * to a single frame gives the frame, and the frame is the screen. Telling the
 * two apart is the only structural decision the crawl makes.
 */
const CONTAINER_TYPES = new Set(['CANVAS', 'PAGE', 'DOCUMENT', 'GROUP', 'SECTION']);

/** The first page of a Figma file, which is the node a file link means. */
const FIRST_PAGE = '0:1';

/** Screens smaller than this in either direction are stickers and notes. */
const MIN_SCREEN_SIDE = 80;

export interface CrawlLimits {
  /** Screens to keep. Beyond this the file is a library, not a product. */
  maxScreens: number;
  /** Components to keep, by instance count. */
  maxComponents: number;
}

export const DEFAULT_CRAWL_LIMITS: CrawlLimits = { maxScreens: 250, maxComponents: 400 };

export interface CrawlOutcome {
  inventory: SurveyInventory;
  /** The widest frame of each screen, kept so a later pass can digest it. */
  trees: Map<string, DesignNode>;
}

export interface CrawlProgress {
  /** Called once per root, before it is read. */
  root?(at: number, total: number, label: string): void;
}

/**
 * Asks Figma for a node's subtree, trying the spellings its server has used.
 *
 * The local server's argument names are not pinned by any contract this project
 * controls, and a file link carries no node at all. Rather than insist on one
 * shape, the call is attempted in decreasing order of specificity and the first
 * answer that parses wins. A reader who gets all the way to the end gets a
 * message naming the thing they can actually do about it.
 */
async function readTree(session: McpSession, root: SurveyRoot): Promise<DesignNode> {
  const attempts: Record<string, unknown>[] = [];
  if (root.nodeId) {
    attempts.push({ nodeId: root.nodeId });
    attempts.push({ nodeId: root.nodeId, fileKey: root.fileKey });
  } else {
    // A file link means "whatever is open". Figma answers for the current
    // selection when given nothing, and `0:1` is the first page when it does
    // not -- between them they cover both versions of the server.
    attempts.push({});
    attempts.push({ nodeId: FIRST_PAGE });
    attempts.push({ nodeId: FIRST_PAGE, fileKey: root.fileKey });
  }

  const refusals: string[] = [];

  for (const args of attempts) {
    try {
      const result = await session.call('get_metadata', args);
      if (result.isError) {
        refusals.push(textOfResult(result) || 'refused');
        continue;
      }
      const tree = parseFigmaMetadata(textOfResult(result));
      if (tree) return tree;
      refusals.push('no layers in the answer');
    } catch (error) {
      refusals.push(error instanceof Error ? error.message : String(error));
    }
  }

  const where = root.nodeId ? `node ${root.nodeId}` : `file ${root.fileKey}`;
  throw new DesignSourceError(
    'node-unreadable',
    'get_metadata',
    `Figma would not read ${where}: ${refusals.join('; ')} -- open that file in the Figma desktop ` +
      'app, select the page you want surveyed, and paste a link to the page rather than to the project',
  );
}

interface ScreenCandidate {
  node: DesignNode;
  section?: string;
}

/** Frames, with sections treated as grouping rather than as screens. */
function collectScreens(node: DesignNode, depth = 0, section?: string): ScreenCandidate[] {
  const type = node.type.toUpperCase();
  const isContainer = depth === 0 ? CONTAINER_TYPES.has(type) : type === 'SECTION';

  if (!isContainer) return section === undefined ? [{ node }] : [{ node, section }];

  const inner = type === 'SECTION' ? node.name || section : section;
  return (node.children ?? []).flatMap((child) => collectScreens(child, depth + 1, inner));
}

function walk(node: DesignNode, visit: (node: DesignNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function countNodes(node: DesignNode): number {
  let total = 0;
  walk(node, () => (total += 1));
  return total;
}

/** A screen a person drew, rather than a note they left beside one. */
function isScreenLike(node: DesignNode): boolean {
  if (node.visible === false) return false;
  if ((node.width ?? 0) < MIN_SCREEN_SIDE || (node.height ?? 0) < MIN_SCREEN_SIDE) return false;
  return true;
}

/** Makes an id unique without making it unreadable. */
function unique(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let at = 2; ; at += 1) {
    const candidate = `${base}-${at}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * The exact name of the component a node is.
 *
 * The main component's name where the outline exposes one, and the instance's
 * own name where it does not -- which is the same string in every file where
 * nobody renamed an instance, and the honest best guess where somebody did.
 */
function componentNameOf(node: DesignNode, type: SurveyComponentType): string {
  const name = type === 'INSTANCE' ? (node.component ?? node.name) : node.name;
  return (name ?? '').trim() || '(unnamed component)';
}

interface ComponentDraft {
  name: string;
  type: SurveyComponentType;
  variants: Set<string>;
  instances: number;
  componentId?: string;
  definitionNodeId?: string;
  sampleNodeId: string;
  width?: number;
  height?: number;
  screenIds: Set<string>;
}

/**
 * The identity of a component, which is its main component's node where the
 * outline gives one up and its name otherwise.
 *
 * The id is the better answer and the reason is the Inspect panel's own "go to
 * main component" arrow: it goes somewhere definite. A name does not. An
 * instance can be renamed in place -- `Content-card/split/media` on one screen
 * and `media card` on another -- and two drafts keyed by name would report one
 * component as two. Keyed by id they merge, which is what a person counting
 * components means.
 */
function identityOf(draft: ComponentDraft): string {
  return draft.componentId ? `#${draft.componentId}` : draft.name.toLowerCase();
}

/**
 * Folds drafts that turned out to be the same component together.
 *
 * The crawl keys by name as it goes, because that is all an instance always
 * carries; this is where the ones that also carried an id are reconciled.
 */
function mergeDrafts(drafts: Map<string, ComponentDraft>): {
  merged: Map<string, ComponentDraft>;
  keyMap: Map<string, string>;
} {
  const merged = new Map<string, ComponentDraft>();
  const keyMap = new Map<string, string>();

  for (const [original, draft] of drafts) {
    const key = identityOf(draft);
    keyMap.set(original, key);

    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, draft);
      continue;
    }

    existing.instances += draft.instances;
    for (const variant of draft.variants) existing.variants.add(variant);
    for (const screenId of draft.screenIds) existing.screenIds.add(screenId);
    existing.componentId ??= draft.componentId;
    existing.width ??= draft.width;
    existing.height ??= draft.height;

    // A definition's name is the component's own; an instance's is whatever
    // somebody typed over it.
    if (!existing.definitionNodeId && draft.definitionNodeId) {
      existing.definitionNodeId = draft.definitionNodeId;
      existing.type = draft.type;
      existing.name = draft.name;
    }
  }

  return { merged, keyMap };
}

/**
 * The module a component belongs to, before any model has been asked.
 *
 * Most design systems already spell their grouping into the name --
 * `Card/Article/Horizontal` is in the card module and says so -- so the first
 * path segment is a better default than "ungrouped", and for a file with no
 * slashes in it, it degrades to the component's own name, which is at worst
 * a module of one.
 */
export function moduleHintFor(name: string): string {
  const head = name.split('/')[0]?.trim();
  return head || name;
}

export async function crawlFigma(
  session: McpSession,
  roots: SurveyRoot[],
  limits: CrawlLimits = DEFAULT_CRAWL_LIMITS,
  progress: CrawlProgress = {},
): Promise<CrawlOutcome> {
  const fileKey = roots[0]?.fileKey ?? '';
  const fileName = roots.find((root) => root.fileName)?.fileName;

  const warnings: string[] = [];
  const pages: SurveyPage[] = [];
  const screens: SurveyScreen[] = [];
  const trees = new Map<string, DesignNode>();
  const drafts = new Map<string, ComponentDraft>();

  const screenIds = new Set<string>();
  let truncated = false;

  for (const [at, root] of roots.entries()) {
    progress.root?.(at, roots.length, root.nodeId ?? root.fileKey);

    let tree: DesignNode;
    try {
      tree = await readTree(session, root);
    } catch (error) {
      // One unreadable page must not lose the pages that did read. The first
      // root is different: nothing has been found yet, so there is nothing to
      // salvage and the reason is the whole answer.
      if (at === 0 && roots.length === 1) throw error;
      warnings.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const pageName = tree.name || root.fileName || `Page ${at + 1}`;
    const page: SurveyPage = {
      name: pageName,
      nodeId: tree.id,
      url: figmaNodeUrl(fileKey, tree.id, fileName),
      screenIds: [],
    };
    pages.push(page);

    // Frames of one screen arrive as siblings with viewport-suffixed names.
    // They are grouped by the name with the suffix removed, so the reader gets
    // one screen with three drawings rather than three unrelated entries.
    const groups = new Map<string, { name: string; section?: string; views: DesignNode[] }>();

    for (const candidate of collectScreens(tree)) {
      if (!isScreenLike(candidate.node)) continue;

      const base = screenBaseName(candidate.node.name || 'Untitled');
      const key = `${candidate.section ?? ''}::${base.toLowerCase()}`;
      const group = groups.get(key) ?? { name: base, ...(candidate.section === undefined ? {} : { section: candidate.section }), views: [] };
      group.views.push(candidate.node);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      if (screens.length >= limits.maxScreens) {
        truncated = true;
        break;
      }

      // Widest first: it is the drawing that shows the most, so it is the one
      // a reader is shown first and the one a later pass digests.
      const ordered = [...group.views].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
      const id = unique(slugOf(group.name), screenIds);

      const views: SurveyView[] = ordered.map((node) => {
        const view: SurveyView = {
          nodeId: node.id,
          name: node.name || group.name,
          viewport: viewportOf(node.name || group.name, node.width),
          url: figmaNodeUrl(fileKey, node.id, fileName),
        };
        if (node.width !== undefined) view.width = Math.round(node.width);
        if (node.height !== undefined) view.height = Math.round(node.height);
        return view;
      });

      const screen: SurveyScreen = {
        id,
        name: group.name,
        page: pageName,
        ...(group.section === undefined ? {} : { group: group.section }),
        views,
        componentIds: [],
        sections: [],
        nodeCount: ordered.reduce((total, node) => total + countNodes(node), 0),
      };

      const widest = ordered[0];
      if (widest) trees.set(id, widest);

      // Components are counted from every drawing, because a component that
      // only appears on mobile is exactly the kind of thing a survey exists to
      // notice -- but each is counted once per screen, not once per viewport.
      const onThisScreen = new Set<string>();
      for (const node of ordered) {
        walk(node, (child) => {
          const type = child.type.toUpperCase();
          if (type !== 'INSTANCE' && type !== 'COMPONENT' && type !== 'COMPONENT_SET') return;

          const kind = type as SurveyComponentType;
          const name = componentNameOf(child, kind);
          const key = name.toLowerCase();

          const draft = drafts.get(key) ?? {
            name,
            type: kind,
            variants: new Set<string>(),
            instances: 0,
            sampleNodeId: child.id,
            screenIds: new Set<string>(),
          };

          // A definition outranks an instance, both as the node to point at and
          // as the spelling of the name: it is the component itself.
          if (kind === 'COMPONENT_SET' || (kind === 'COMPONENT' && draft.type === 'INSTANCE')) {
            draft.type = kind;
            draft.name = name;
            draft.definitionNodeId = child.id;
            draft.componentId ??= child.id;
          }
          if (kind === 'INSTANCE') draft.instances += 1;
          if (child.componentId) draft.componentId ??= child.componentId;
          if (child.variant) draft.variants.add(child.variant);
          if (draft.width === undefined && child.width !== undefined) draft.width = Math.round(child.width);
          if (draft.height === undefined && child.height !== undefined) draft.height = Math.round(child.height);
          draft.screenIds.add(id);
          drafts.set(key, draft);
          onThisScreen.add(key);
        });
      }

      screen.componentIds = [...onThisScreen];
      screens.push(screen);
      page.screenIds.push(id);
    }
  }

  if (truncated) {
    warnings.push(
      `the crawl stopped at ${limits.maxScreens} screens -- this file has more, so the survey is a ` +
        'sample rather than an index. Survey one page at a time to cover all of it',
    );
  }

  // Ids are assigned after the whole crawl, so the busiest components get the
  // readable ids and the cap falls on the ones nobody uses.
  const { merged, keyMap } = mergeDrafts(drafts);
  const ranked = [...merged.entries()].sort((a, b) => b[1].instances - a[1].instances);
  if (ranked.length > limits.maxComponents) {
    warnings.push(
      `${ranked.length} distinct components were found and the ${limits.maxComponents} most used ` +
        'are reported; the rest appear once or twice each',
    );
  }

  const componentIds = new Set<string>();
  const idByKey = new Map<string, string>();
  const components: SurveyComponent[] = [];

  for (const [key, draft] of ranked.slice(0, limits.maxComponents)) {
    const id = unique(slugOf(draft.name), componentIds);
    idByKey.set(key, id);

    const nodeId = draft.definitionNodeId ?? draft.componentId ?? draft.sampleNodeId;
    const component: SurveyComponent = {
      id,
      name: draft.name,
      type: draft.type,
      variants: [...draft.variants].sort(),
      instances: draft.instances,
      nodeId,
      url: figmaNodeUrl(fileKey, nodeId, fileName),
      screenIds: [...draft.screenIds],
    };
    if (draft.componentId) component.componentId = draft.componentId;
    if (draft.definitionNodeId) component.definitionNodeId = draft.definitionNodeId;
    if (draft.width !== undefined) component.width = draft.width;
    if (draft.height !== undefined) component.height = draft.height;
    components.push(component);
  }

  components.sort((a, b) => a.name.localeCompare(b.name));

  // The screens' component lists were keyed by name while crawling; they become
  // ids here, and anything the merge folded or the cap dropped follows.
  for (const screen of screens) {
    screen.componentIds = [
      ...new Set(
        screen.componentIds
          .map((key) => idByKey.get(keyMap.get(key) ?? key))
          .filter((id): id is string => id !== undefined),
      ),
    ].sort();
  }

  // Sections are cut last, because a section's component list is in the same
  // ids as everything else and those ids only exist now.
  const idForComponent = (name: string): string | undefined => {
    const key = name.toLowerCase();
    return idByKey.get(keyMap.get(key) ?? key);
  };

  for (const screen of screens) {
    const tree = trees.get(screen.id);
    if (!tree) continue;
    screen.sections = sectionsOf(tree, {
      fileKey,
      ...(fileName === undefined ? {} : { fileName }),
      idForComponent,
    });
  }

  const inventory: SurveyInventory = {
    fileKey,
    ...(fileName === undefined ? {} : { fileName }),
    pages,
    modules: groupIntoModules(components, screens),
    components,
    screens,
    warnings,
  };

  return { inventory, trees };
}

/**
 * Builds the module list from whatever module each component claims.
 *
 * Called twice: once with the name-derived hints, and again after the model has
 * proposed better ones. Keeping it in one function is what guarantees the two
 * shapes are identical, so the console renders a described survey and an
 * undescribed one with the same code.
 */
export function groupIntoModules(
  components: SurveyComponent[],
  screens: SurveyScreen[],
  named: Map<string, string> = new Map(),
): SurveyModule[] {
  const byName = new Map<string, SurveyModule>();
  const ids = new Set<string>();

  for (const component of components) {
    const name = named.get(component.id) ?? moduleHintFor(component.name);
    const key = name.toLowerCase();

    let module = byName.get(key);
    if (!module) {
      module = { id: unique(slugOf(name), ids), name, componentIds: [], screenIds: [] };
      byName.set(key, module);
    }

    component.moduleId = module.id;
    module.componentIds.push(component.id);
  }

  // A module's screens are the screens its components appear on. Derived rather
  // than asked for: the model has no way to know, and the crawl already does.
  const screenNames = new Map(screens.map((screen) => [screen.id, screen]));
  for (const module of byName.values()) {
    const seen = new Set<string>();
    for (const componentId of module.componentIds) {
      const component = components.find((entry) => entry.id === componentId);
      for (const screenId of component?.screenIds ?? []) {
        if (screenNames.has(screenId)) seen.add(screenId);
      }
    }
    module.screenIds = [...seen].sort();
  }

  return [...byName.values()].sort((a, b) => b.componentIds.length - a.componentIds.length);
}
