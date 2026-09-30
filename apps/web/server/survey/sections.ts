/**
 * Cutting a screen into the bands a developer would build it in.
 *
 * This is the step that turns an inventory into a plan. A list of components is
 * a parts bin; what a developer opening a design actually asks is "what are the
 * blocks on this page, top to bottom, and for each one: which of them already
 * exist as components, what does an author type into it, and what is left over
 * that nobody has scoped yet".
 *
 * ## Sections are read, not invented
 *
 * A screen frame is a stack of child frames, and those children *are* the
 * sections -- header, hero, listing, footer. That is how the design was built,
 * so reading it back is transcription. A model asked to list the sections
 * instead produces plausible ones, and a plausible section cannot be clicked,
 * rendered, or pointed at a node. Everything structural here is arithmetic; the
 * model is only ever asked what a slot should be called and how it is authored.
 *
 * ## The three lists, and why they are three
 *
 * **Components** are the parts already scoped: an instance is somebody's
 * component and will be built once for the whole site.
 *
 * **Fields** are what an author supplies -- the text that will differ per page,
 * the images that will be swapped. This is the authoring model in raw form.
 *
 * **Orphans** are layers doing visible work that no instance covers. They are
 * the most useful thing on the page: a section with twelve of them is a section
 * the design system does not cover, and that is an estimate nobody had.
 */

import type {
  SurveyAsset,
  SurveyField,
  SurveyFieldKind,
  SurveyOrphan,
  SurveySection,
} from '#shared/survey';
import { figmaNodeUrl, slugOf } from '#shared/survey';

import type { DesignNode } from '../analysis/design/digest';

/** Below this share of the screen's area, a child is a divider or a stray. */
const MIN_SECTION_AREA = 0.004;

/** A band shorter than this is a rule, a spacer or a badge. */
const MIN_SECTION_HEIGHT = 24;

/** How deep to descend through frames that only wrap one child. */
const MAX_WRAPPER_DEPTH = 3;

const MAX_FIELDS = 40;
const MAX_ASSETS = 24;
const MAX_ORPHANS = 24;
const MAX_COMPONENTS = 32;

/** Text longer than this is a paragraph, and a paragraph is rich text. */
const RICHTEXT_CHARS = 120;

/** Types that draw rather than contain. */
const VECTOR_TYPES = new Set(['VECTOR', 'LINE', 'ELLIPSE', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION']);

/** Names that mean the layer is a control rather than a caption. */
const LINK_NAMES = /\b(button|btn|cta|link|action)\b/i;

function isVisible(node: DesignNode): boolean {
  return node.visible !== false && node.opacity !== 0;
}

function area(node: DesignNode): number {
  return (node.width ?? 0) * (node.height ?? 0);
}

/** Whether a child is really the parent wearing a coat. */
function fills(child: DesignNode, parent: DesignNode): boolean {
  const width = parent.width ?? 0;
  const height = parent.height ?? 0;
  if (width === 0 || height === 0) return false;
  return (child.width ?? 0) >= width * 0.9 && (child.height ?? 0) >= height * 0.9;
}

/**
 * The node whose children are the sections.
 *
 * A screen is often wrapped once or twice -- an auto-layout column inside the
 * frame, a "Content" group inside that -- and taking the frame's direct
 * children literally would report one section called "Content" containing the
 * whole page. Wrappers are descended through; anything that branches is where
 * the sections are.
 */
function bodyOf(root: DesignNode): DesignNode {
  let node = root;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
    const children = (node.children ?? []).filter(isVisible);
    const only = children.length === 1 ? children[0] : undefined;
    if (!only || !fills(only, node) || !only.children?.length) break;
    node = only;
  }
  return node;
}

function walk(node: DesignNode, visit: (node: DesignNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  for (const child of node.children ?? []) walk(child, visit, depth + 1);
}

function sample(value: string, limit = 160): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function isImage(node: DesignNode): boolean {
  return node.hasImageFill === true;
}

/** An icon is a small vector; a picture is a large anything with an image fill. */
function assetKindOf(node: DesignNode): SurveyAsset['kind'] | null {
  if (isImage(node)) return area(node) < 48 * 48 ? 'icon' : 'image';
  if (VECTOR_TYPES.has(node.type.toUpperCase())) return 'icon';
  return null;
}

function fieldKindOf(node: DesignNode): SurveyFieldKind | null {
  const type = node.type.toUpperCase();

  if (type === 'TEXT' && node.text) {
    if (LINK_NAMES.test(node.name)) return 'link';
    return node.text.length > RICHTEXT_CHARS ? 'richtext' : 'text';
  }
  if (isImage(node)) return 'image';
  if (VECTOR_TYPES.has(type) && !node.children?.length) return 'icon';
  return null;
}

interface SectionParts {
  fields: SurveyField[];
  assets: SurveyAsset[];
  orphans: SurveyOrphan[];
  /** Exact component names used inside, busiest first. */
  components: string[];
  nodeCount: number;
}

/**
 * Everything a section is made of, in one walk.
 *
 * `insideComponent` carries the name of the nearest enclosing instance, which
 * is what separates a field that belongs to somebody's component from one drawn
 * loose on the page. That distinction is the whole point: the first is already
 * built, the second is work.
 */
function partsOf(section: DesignNode): SectionParts {
  const fields: SurveyField[] = [];
  const assets: SurveyAsset[] = [];
  const orphans: SurveyOrphan[] = [];
  const components = new Map<string, number>();
  let nodeCount = 0;

  // Siblings sharing a name are a list. The first stands for all of them, and
  // carries the fact that it repeats -- which is what makes it a multi-field
  // rather than three fields with the same label.
  const repeated = new Set<string>();
  walk(section, (node) => {
    const names = new Map<string, number>();
    for (const child of node.children ?? []) {
      const key = child.name.trim().toLowerCase();
      if (!key) continue;
      const seen = (names.get(key) ?? 0) + 1;
      names.set(key, seen);
      if (seen > 1) repeated.add(key);
    }
  });

  const seenFields = new Set<string>();

  const visit = (node: DesignNode, insideComponent?: string, insideRepeated = false): void => {
    nodeCount += 1;
    if (!isVisible(node)) return;

    const type = node.type.toUpperCase();
    const isInstance = type === 'INSTANCE';
    const componentName = isInstance ? (node.component ?? node.name).trim() : undefined;
    const key = node.name.trim().toLowerCase();

    if (componentName && node.id !== section.id) {
      components.set(componentName, (components.get(componentName) ?? 0) + 1);
    }

    const kind = fieldKindOf(node);
    if (kind) {
      const slot = `${kind}:${key}:${insideComponent ?? ''}`;
      if (!seenFields.has(slot) && fields.length < MAX_FIELDS) {
        seenFields.add(slot);
        const field: SurveyField = { nodeId: node.id, name: node.name || kind, kind };
        if (node.text) field.sample = sample(node.text);
        // Either the slot itself has twins, or it lives inside a component that
        // does -- a card's headline in a three-card row is one field an author
        // fills in three times, not three fields.
        if (repeated.has(key) || insideRepeated) field.repeated = true;
        if (insideComponent) field.componentName = insideComponent;
        fields.push(field);
      }
    }

    const assetKind = assetKindOf(node);
    if (assetKind && assets.length < MAX_ASSETS) {
      const asset: SurveyAsset = { nodeId: node.id, name: node.name || assetKind, kind: assetKind, url: '' };
      if (node.width !== undefined) asset.width = Math.round(node.width);
      if (node.height !== undefined) asset.height = Math.round(node.height);
      assets.push(asset);
    }

    // Loose work: visible, carrying content, and not inside anybody's
    // component. A container is not an orphan -- its contents are what matter.
    if (!insideComponent && node.id !== section.id && orphans.length < MAX_ORPHANS) {
      const carries = (type === 'TEXT' && node.text) || isImage(node) || VECTOR_TYPES.has(type);
      if (carries && area(node) >= 64) {
        const orphan: SurveyOrphan = { nodeId: node.id, name: node.name || type, type };
        if (node.text) orphan.sample = sample(node.text, 100);
        orphans.push(orphan);
      }
    }

    const next = componentName ?? insideComponent;
    const nextRepeated = insideRepeated || (componentName !== undefined && repeated.has(key));
    for (const child of node.children ?? []) visit(child, next, nextRepeated);
  };

  visit(section);

  return {
    fields,
    assets,
    orphans,
    components: [...components.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_COMPONENTS)
      .map(([name]) => name),
    nodeCount,
  };
}

export interface SectionContext {
  fileKey: string;
  fileName?: string;
  /** Resolves an exact component name to the survey's id for it. */
  idForComponent(name: string): string | undefined;
}

/**
 * Cuts one screen's widest drawing into sections.
 *
 * The widest drawing because it shows the most: a mobile frame stacks the same
 * bands into one column and would report the same sections with less in them.
 */
export function sectionsOf(root: DesignNode, context: SectionContext): SurveySection[] {
  const body = bodyOf(root);
  const total = Math.max(1, area(root));

  const candidates = (body.children ?? [])
    .filter(isVisible)
    .filter((child) => (child.height ?? 0) >= MIN_SECTION_HEIGHT)
    .filter((child) => area(child) / total >= MIN_SECTION_AREA);

  // Top to bottom, then left to right, which is the order a page is read and
  // built in. Auto-layout frames carry no coordinates, in which case document
  // order already is the stacking order.
  const ordered = [...candidates].sort(
    (a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0),
  );

  const taken = new Set<string>();

  return ordered.map((node, at) => {
    const parts = partsOf(node);
    const type = node.type.toUpperCase();

    let id = slugOf(node.name || `section-${at + 1}`);
    while (taken.has(id)) id = `${id}-${at + 1}`;
    taken.add(id);

    const section: SurveySection = {
      id,
      name: node.name || `Section ${at + 1}`,
      nodeId: node.id,
      url: figmaNodeUrl(context.fileKey, node.id, context.fileName),
      order: at,
      componentIds: parts.components
        .map((name) => context.idForComponent(name))
        .filter((value): value is string => value !== undefined),
      fields: parts.fields,
      assets: parts.assets.map((asset) => ({
        ...asset,
        url: figmaNodeUrl(context.fileKey, asset.nodeId, context.fileName),
      })),
      orphans: parts.orphans,
      nodeCount: parts.nodeCount,
    };

    if (node.width !== undefined) section.width = Math.round(node.width);
    if (node.height !== undefined) section.height = Math.round(node.height);

    // A section that is itself one instance is the common and the best case:
    // the whole band is already somebody's component.
    if (type === 'INSTANCE') {
      const name = (node.component ?? node.name).trim();
      if (name) {
        section.componentName = name;
        const id = context.idForComponent(name);
        if (id) section.componentId = id;
      }
    }

    return section;
  });
}
