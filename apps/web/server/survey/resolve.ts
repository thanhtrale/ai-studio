/**
 * Reading each component, rather than only naming it.
 *
 * A list of names is an index nobody can act on. `Content-card/split/media`
 * tells a developer where to look in Figma and nothing at all about what the
 * thing is. After this step every component carries the layers inside it, the
 * words it was drawn with, and the components it is built out of.
 *
 * The read is one `get_metadata` on the *main* component -- the node the
 * Inspect panel's "go to main component" arrow jumps to -- which buys three
 * things at once:
 *
 * **The name.** An instance carries whatever name it was given, and a designer
 * who renamed one on one screen renamed it only there. The main component
 * carries the name the component actually has.
 *
 * **The reach.** Main components usually live on their own page -- a library,
 * a design system tab -- and a survey pointed at the product pages never visits
 * it. Following the id gets there without being told to.
 *
 * **The substance.** Everything below the component node: its text slots, its
 * images, its nested components, and for a set, every variant it declares
 * rather than only the ones somebody happened to place.
 *
 * One read per distinct component, not per instance, so a file with four
 * thousand instances of seventy components costs seventy calls. Each is a small
 * subtree, and a component that will not read leaves what the crawl already
 * knew in place rather than failing anything.
 */

import type { SurveyComponent, SurveyComponentType, SurveyInventory } from '#shared/survey';
import { figmaNodeUrl } from '#shared/survey';

import type { DesignNode } from '../analysis/design/digest';
import { buildDigest } from '../analysis/design/digest';
import { parseFigmaMetadata } from '../analysis/design/figma-metadata';
import type { McpSession } from '../analysis/design/mcp';
import { textOfResult } from '../analysis/design/mcp';

/** A ceiling on the extra reads, so a library file cannot run away with the run. */
export const MAX_RESOLVES = 400;

/** Enough outline to see the shape of a component without reprinting the file. */
const STRUCTURE_NODES = 60;
const STRUCTURE_CHARS = 2_000;

const MAX_TEXT_SAMPLES = 12;
const MAX_USES = 24;

export interface ResolveOptions {
  fileKey: string;
  fileName?: string;
  maxResolves?: number;
  onProgress?(done: number, total: number): void;
  onWarning?(warning: string): void;
}

const DEFINITION_TYPES = new Set(['COMPONENT', 'COMPONENT_SET']);

function walk(node: DesignNode, visit: (node: DesignNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** The words the component was drawn with, deduplicated and kept short. */
function textOf(tree: DesignNode): string[] {
  const seen = new Set<string>();
  walk(tree, (node) => {
    const value = node.text?.replace(/\s+/g, ' ').trim();
    if (!value || seen.size >= MAX_TEXT_SAMPLES) return;
    seen.add(value.length > 100 ? `${value.slice(0, 100)}…` : value);
  });
  return [...seen];
}

/** What this component is built out of, by exact name. */
function usesOf(tree: DesignNode): string[] {
  const seen = new Set<string>();
  walk(tree, (node) => {
    if (node.id === tree.id) return;
    const type = node.type.toUpperCase();
    if (type !== 'INSTANCE' && type !== 'COMPONENT') return;
    const name = (type === 'INSTANCE' ? (node.component ?? node.name) : node.name)?.trim();
    if (name && seen.size < MAX_USES) seen.add(name);
  });
  return [...seen];
}

/**
 * The variants a set declares.
 *
 * A component set's children *are* its variants, and their names are the
 * property strings -- `Size=Large, State=Hover`. The crawl only ever saw the
 * variants somebody placed on a screen; this is the full list.
 */
function variantsOf(tree: DesignNode): string[] {
  if (tree.type.toUpperCase() !== 'COMPONENT_SET') return [];
  return (tree.children ?? [])
    .filter((child) => child.type.toUpperCase() === 'COMPONENT')
    .map((child) => child.name.trim())
    .filter(Boolean);
}

function countNodes(tree: DesignNode): number {
  let total = 0;
  walk(tree, () => (total += 1));
  return total;
}

/** Fills a component in from its own node. */
function absorb(
  component: SurveyComponent,
  tree: DesignNode,
  nodeId: string,
  options: ResolveOptions,
): void {
  const type = tree.type.toUpperCase();

  // The name is only taken when the node really is a component. A read that
  // landed somewhere else is worse than no read.
  if (tree.name && DEFINITION_TYPES.has(type)) {
    component.name = tree.name;
    component.type = type as SurveyComponentType;
    component.resolved = true;
  }

  component.definitionNodeId = nodeId;
  component.nodeId = nodeId;
  component.url = figmaNodeUrl(options.fileKey, nodeId, options.fileName);

  if (tree.width !== undefined) component.width = Math.round(tree.width);
  if (tree.height !== undefined) component.height = Math.round(tree.height);

  component.structure = buildDigest(tree, {
    maxNodes: STRUCTURE_NODES,
    maxChars: STRUCTURE_CHARS,
  }).digest;
  component.nodeCount = countNodes(tree);

  const text = textOf(tree);
  if (text.length) component.text = text;

  const uses = usesOf(tree);
  if (uses.length) component.uses = uses;

  const variants = variantsOf(tree);
  if (variants.length) {
    component.variants = [...new Set([...component.variants, ...variants])].sort();
  }
}

/**
 * Reads each component's own node.
 *
 * Mutates in place, because the inventory is the survey and there is nothing to
 * gain from a second copy of four hundred entries. Returns how many read.
 */
export async function resolveMainComponents(
  session: McpSession,
  inventory: SurveyInventory,
  options: ResolveOptions,
): Promise<number> {
  const { components } = inventory;

  // Everything not yet read, whether or not its name needs correcting: a
  // component found as a definition in a crawled page still has no outline of
  // its own until somebody asks for one.
  const wanted = components.filter((component) => component.structure === undefined);

  const budget = wanted.slice(0, options.maxResolves ?? MAX_RESOLVES);
  if (budget.length < wanted.length) {
    options.onWarning?.(
      `${wanted.length - budget.length} components were not read; the run was capped at ${budget.length}`,
    );
  }

  let read = 0;
  let refused = 0;

  for (const [at, component] of budget.entries()) {
    const nodeId = component.componentId ?? component.definitionNodeId ?? component.nodeId;

    try {
      const result = await session.call('get_metadata', { nodeId });
      const tree = result.isError ? null : parseFigmaMetadata(textOfResult(result));

      if (tree) {
        absorb(component, tree, nodeId, options);
        read += 1;
      } else {
        refused += 1;
      }
    } catch {
      refused += 1;
    }

    options.onProgress?.(at + 1, budget.length);
  }

  if (refused > 0) {
    options.onWarning?.(
      `${refused} components would not read -- their library may not be open in this Figma ` +
        'session, so those entries still carry an instance’s name and no outline',
    );
  }

  // Two instances renamed differently merge here rather than at the crawl: it
  // is only now that both are known to be the same component.
  const folded = dedupe(components);
  if (folded.size > 0) {
    for (const screen of inventory.screens) {
      screen.componentIds = [
        ...new Set(screen.componentIds.map((id) => folded.get(id) ?? id)),
      ].sort();
    }
  }

  return read;
}

/**
 * Folds entries that turned out to be one component once their names agreed.
 *
 * Returns what moved where, because the screens still point at the ids that are
 * about to stop existing.
 */
function dedupe(components: SurveyComponent[]): Map<string, string> {
  const byNode = new Map<string, SurveyComponent>();
  const survivors: SurveyComponent[] = [];
  const folded = new Map<string, string>();

  for (const component of components) {
    const key = component.definitionNodeId ?? component.nodeId;
    const existing = byNode.get(key);
    if (!existing) {
      byNode.set(key, component);
      survivors.push(component);
      continue;
    }

    existing.instances += component.instances;
    existing.variants = [...new Set([...existing.variants, ...component.variants])].sort();
    existing.screenIds = [...new Set([...existing.screenIds, ...component.screenIds])];
    folded.set(component.id, existing.id);
  }

  if (folded.size === 0) return folded;
  components.length = 0;
  components.push(...survivors);
  return folded;
}
