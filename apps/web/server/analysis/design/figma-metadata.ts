/**
 * Figma's `get_metadata` output into a node tree.
 *
 * The tool returns a sparse XML outline -- layer id, name, type, position,
 * size -- which exists for the same reason the digest does: navigating a large
 * file without spending the whole context on it. That removes most of the work
 * a REST adapter would have had to do against a full file document, and it is
 * the reason this tree is the structural authority while `get_design_context`
 * is only evidence about styling.
 *
 * Attribute names are read from a list of candidates rather than one fixed
 * spelling. The tool's exact output has changed more than once and is not
 * pinned by any contract this project controls, so a reader that insists on
 * one name is a reader that breaks on an upgrade with no symptom but an empty
 * digest. Anything unrecognised is simply absent.
 */

import type { DesignNode } from './digest';
import { isElement, parseMarkup, textOf } from '../markup';
import type { MarkupElement } from '../markup';

/** Reads the first attribute present from a list of spellings. */
function attr(node: MarkupElement, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = node.attrs[name.toLowerCase()];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function num(node: MarkupElement, ...names: string[]): number | undefined {
  const raw = attr(node, ...names);
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

function bool(node: MarkupElement, ...names: string[]): boolean | undefined {
  const raw = attr(node, ...names);
  if (raw === undefined) return undefined;
  if (/^(false|0|no)$/i.test(raw)) return false;
  if (/^(true|1|yes)$/i.test(raw)) return true;
  return undefined;
}

/**
 * The node's own text, not its descendants'.
 *
 * A text layer may carry its content as an attribute or as the element's text.
 * Taking the whole subtree's text instead would put every child's words on the
 * parent, which reads as one enormous string and loses which layer said what.
 */
function ownText(node: MarkupElement): string | undefined {
  const fromAttribute = attr(node, 'characters', 'text', 'content', 'value');
  if (fromAttribute) return fromAttribute;

  const direct = node.children
    .filter((child) => child.type === 'text')
    .map((child) => textOf(child))
    .join('')
    .trim();
  return direct || undefined;
}

/** Whether a node paints an image, however the source says so. */
function hasImageFill(node: MarkupElement): boolean | undefined {
  if (bool(node, 'hasimagefill', 'image') === true) return true;
  const fills = attr(node, 'fill', 'fills', 'background');
  if (fills && /image/i.test(fills)) return true;
  return undefined;
}

/** The element's tag is the type unless an attribute says otherwise. */
function typeOf(node: MarkupElement): string {
  return (attr(node, 'type', 'nodetype') ?? node.name).toUpperCase();
}

/** Elements that are wrappers in the output rather than layers in the design. */
const WRAPPERS = new Set(['#root', 'metadata', 'nodes', 'document', 'result', 'response']);

function convert(node: MarkupElement): DesignNode | null {
  const id = attr(node, 'id', 'nodeid', 'node-id');
  if (!id) return null;

  const design: DesignNode = {
    id,
    name: attr(node, 'name', 'label') ?? '',
    type: typeOf(node),
  };

  const width = num(node, 'width', 'w');
  const height = num(node, 'height', 'h');
  const x = num(node, 'x', 'left');
  const y = num(node, 'y', 'top');
  if (width !== undefined) design.width = width;
  if (height !== undefined) design.height = height;
  if (x !== undefined) design.x = x;
  if (y !== undefined) design.y = y;

  const visible = bool(node, 'visible');
  if (visible !== undefined) design.visible = visible;
  const opacity = num(node, 'opacity');
  if (opacity !== undefined) design.opacity = opacity;

  const text = ownText(node);
  if (text !== undefined) design.text = text;

  const component = attr(node, 'componentname', 'component', 'mainComponent');
  if (component !== undefined) design.component = component;
  const variant = attr(node, 'variant', 'variantproperties', 'variants');
  if (variant !== undefined) design.variant = variant;

  const image = hasImageFill(node);
  if (image !== undefined) design.hasImageFill = image;

  const layout = attr(node, 'layoutmode', 'layout', 'direction');
  if (layout !== undefined && layout.toUpperCase() !== 'NONE') design.layout = layout.toUpperCase();
  const spacing = num(node, 'itemspacing', 'spacing', 'gap');
  if (spacing !== undefined) design.spacing = spacing;

  const children = collect(node);
  if (children.length > 0) design.children = children;

  return design;
}

/** Converts a node's element children, skipping wrappers but keeping their contents. */
function collect(parent: MarkupElement): DesignNode[] {
  const out: DesignNode[] = [];
  for (const child of parent.children) {
    if (!isElement(child)) continue;
    if (WRAPPERS.has(child.name)) {
      out.push(...collect(child));
      continue;
    }
    const converted = convert(child);
    // An element with no id is a wrapper by another name -- keep what is inside
    // it rather than losing the subtree to a tag this reader does not know.
    if (converted) out.push(converted);
    else out.push(...collect(child));
  }
  return out;
}

/**
 * Parses a `get_metadata` response.
 *
 * Returns null when nothing in it carried a node id, which is what an empty or
 * unrecognised response looks like -- and is reported as the node being
 * unreadable rather than as a design with no layers.
 */
export function parseFigmaMetadata(xml: string): DesignNode | null {
  const roots = collect(parseMarkup(xml));
  if (roots.length === 0) return null;
  if (roots.length === 1) return roots[0] ?? null;

  // More than one root: the response listed siblings rather than one frame.
  // A synthetic parent keeps them in one tree without inventing an id that
  // evidence checking could then resolve against.
  const first = roots[0];
  return {
    id: first?.id ?? 'root',
    name: 'selection',
    type: 'GROUP',
    children: roots,
  };
}

/**
 * Parses a `get_variable_defs` response into tokens.
 *
 * JSON where the tool returns JSON, `name: value` lines where it returns text.
 * Both have been seen; neither is guaranteed.
 */
export function parseVariableDefs(raw: string): { name: string; value: string }[] {
  const text = raw.trim();
  if (!text) return [];

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({
        name,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      }));
    }
  } catch {
    // Not JSON. Fall through to the line form.
  }

  const tokens: { name: string; value: string }[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*[-*]?\s*(.+?)\s*[:=]\s*(.+?)\s*$/.exec(line);
    if (match?.[1] && match[2]) tokens.push({ name: match[1], value: match[2] });
  }
  return tokens;
}
