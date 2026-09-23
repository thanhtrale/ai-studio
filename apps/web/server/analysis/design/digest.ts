/**
 * A node tree reduced to something a context window holds.
 *
 * This is the part of the feature that decides how good it is, and none of it
 * is model work. A design hands over hundreds of nodes of which most are
 * geometry -- the stroke of an icon, a mask, a spacer -- and the handful that
 * matter are the ones carrying text, an image, or a repeat. Getting that
 * selection right is worth more than any prompt.
 *
 * Three properties the rest of the pipeline depends on:
 *
 * **Deterministic.** The same design produces the same digest, because a run
 * that cannot be repeated cannot be debugged.
 *
 * **Ids preserved.** Everything kept carries its node id, and `nodeIds` is the
 * set those ids form. That set is the ground truth evidence is checked
 * against: an id a model returns that is not in it did not come from the
 * design, whatever the model believes.
 *
 * **Honest about what it dropped.** The count of dropped nodes and the depth
 * of any truncation travel with the digest, so a reader is never shown a
 * reduction that presents itself as the whole.
 *
 * The output is indented text rather than JSON. Braces, quotes and repeated
 * keys are a large share of a JSON tree's tokens and carry nothing a model
 * needs, so the same budget buys more of the design.
 */

/** A node as the digest cares about it, whatever the adapter read it from. */
export interface DesignNode {
  id: string;
  name: string;
  /** The source's own type name, e.g. `FRAME`, `TEXT`, `INSTANCE`. */
  type: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  visible?: boolean;
  opacity?: number;
  /** Text content, for a text node. */
  text?: string;
  /** The component this is an instance of. */
  component?: string;
  /** The variant properties, already flattened to a string. */
  variant?: string;
  hasImageFill?: boolean;
  /** Auto-layout direction, as the source names it. */
  layout?: string;
  /** Auto-layout gap. */
  spacing?: number;
  children?: DesignNode[];
}

/**
 * Types that are geometry rather than content.
 *
 * Dropped as leaves only. An icon is usually a group or an instance *of* these
 * rather than one of them, so the parent survives and the strokes inside it do
 * not -- which is the outcome wanted: "there is an icon here" without the
 * twenty paths that draw it.
 */
const DECORATIVE_TYPES = new Set([
  'VECTOR',
  'LINE',
  'ELLIPSE',
  'STAR',
  'POLYGON',
  'BOOLEAN_OPERATION',
  'SLICE',
]);

export interface DigestOptions {
  /** Nodes to emit before truncating by depth. */
  maxNodes?: number;
  /** Characters to emit before truncating by depth. */
  maxChars?: number;
}

export interface DigestResult {
  digest: string;
  /** Every id the digest mentions, in document order. */
  nodeIds: string[];
  droppedNodes: number;
  /** Set when the tree was cut to fit the budget. */
  truncatedAtDepth?: number;
}

const DEFAULT_MAX_NODES = 400;
const DEFAULT_MAX_CHARS = 24_000;

/** Nodes with no ink: hidden, or faded to nothing. */
function isInvisible(node: DesignNode): boolean {
  return node.visible === false || node.opacity === 0;
}

function isDecorativeLeaf(node: DesignNode): boolean {
  const childless = !node.children || node.children.length === 0;
  return childless && DECORATIVE_TYPES.has(node.type.toUpperCase()) && !node.hasImageFill;
}

/** Counts a node and everything beneath it, for an accurate dropped tally. */
function countTree(node: DesignNode): number {
  return 1 + (node.children ?? []).reduce((total, child) => total + countTree(child), 0);
}

function round(value: number): number {
  return Math.round(value);
}

/** Text worth reading, shortened at a word boundary rather than mid-word. */
function sample(value: string, limit = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${space > limit / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * One line for one node.
 *
 * Deliberately terse and positional: `#1:23 TEXT "Headline" 640x72` reads at a
 * glance and costs a fraction of the equivalent JSON object.
 */
function line(node: DesignNode): string {
  const parts = [`#${node.id}`, node.type.toUpperCase()];

  if (node.name) parts.push(JSON.stringify(sample(node.name, 60)));

  if (node.width !== undefined && node.height !== undefined) {
    parts.push(`${round(node.width)}x${round(node.height)}`);
  }

  if (node.layout) {
    parts.push(node.spacing === undefined ? node.layout : `${node.layout}/gap:${round(node.spacing)}`);
  }

  if (node.component) parts.push(`of:${JSON.stringify(sample(node.component, 48))}`);
  if (node.variant) parts.push(`variant:${JSON.stringify(sample(node.variant, 48))}`);
  if (node.hasImageFill) parts.push('image-fill');
  if (node.text) parts.push(`text:${JSON.stringify(sample(node.text))}`);

  return parts.join(' ');
}

interface Kept {
  node: DesignNode;
  depth: number;
  children: Kept[];
}

/** Prunes the tree, counting everything the pruning removed. */
function prune(node: DesignNode, depth: number, dropped: { count: number }): Kept | null {
  if (isInvisible(node) || isDecorativeLeaf(node)) {
    dropped.count += countTree(node);
    return null;
  }

  const children: Kept[] = [];
  for (const child of node.children ?? []) {
    const keep = prune(child, depth + 1, dropped);
    if (keep) children.push(keep);
  }

  return { node, depth, children };
}

function flatten(kept: Kept, into: Kept[]): void {
  into.push(kept);
  for (const child of kept.children) flatten(child, into);
}

function render(kept: Kept, maxDepth: number, out: string[], ids: string[]): void {
  if (kept.depth > maxDepth) return;
  out.push(`${'  '.repeat(kept.depth)}${line(kept.node)}`);
  ids.push(kept.node.id);
  for (const child of kept.children) render(child, maxDepth, out, ids);
}

/**
 * Reduces a tree to a digest.
 *
 * When the pruned tree still exceeds the budget it is cut by depth rather than
 * mid-tree: losing the deepest level everywhere leaves a coherent, if shallower,
 * picture, while stopping halfway through leaves a picture that is wrong about
 * what the block contains.
 */
export function buildDigest(root: DesignNode, options: DigestOptions = {}): DigestResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const dropped = { count: 0 };
  const kept = prune(root, 0, dropped);

  if (!kept) {
    return { digest: '', nodeIds: [], droppedNodes: dropped.count };
  }

  const all: Kept[] = [];
  flatten(kept, all);
  const deepest = all.reduce((max, entry) => Math.max(max, entry.depth), 0);

  const attempt = (maxDepth: number): { text: string; ids: string[] } => {
    const out: string[] = [];
    const ids: string[] = [];
    render(kept, maxDepth, out, ids);
    return { text: out.join('\n'), ids };
  };

  let depth = deepest;
  let result = attempt(depth);
  // Shave one level at a time rather than estimating: the cost of a level
  // varies enormously between a design that is flat and one that is nested.
  while (depth > 0 && (result.ids.length > maxNodes || result.text.length > maxChars)) {
    depth -= 1;
    result = attempt(depth);
  }

  const digest: DigestResult = {
    digest: result.text,
    nodeIds: result.ids,
    droppedNodes: dropped.count,
  };
  if (depth < deepest) digest.truncatedAtDepth = depth;
  return digest;
}

/** The one-line qualifier the timeline shows beside the design step. */
export function describeDigest(result: DigestResult): string {
  const parts = [`${result.nodeIds.length} node${result.nodeIds.length === 1 ? '' : 's'}`];
  if (result.droppedNodes > 0) parts.push(`${result.droppedNodes} dropped`);
  if (result.truncatedAtDepth !== undefined) parts.push(`cut at depth ${result.truncatedAtDepth}`);
  return parts.join(' · ');
}
