/**
 * The vocabulary of a Figma survey, shared by the browser and the server.
 *
 * A survey is the other half of the requirements work. An analysis reads one
 * block deeply; a survey reads a whole file shallowly and says what is in it --
 * every screen, at every viewport it was drawn at, and every component by the
 * name the designer actually gave it.
 *
 * Two rules the whole feature turns on:
 *
 * **Names are transcribed, never rewritten.** A component called
 * `Card/Article/Horizontal` is reported as `Card/Article/Horizontal`. It is the
 * only handle a developer has on the thing in Figma, and a model that tidies it
 * to "Article card" has destroyed the one fact worth having.
 *
 * **Everything points back.** Every screen, view and component carries its node
 * id, a link a person can open, and the MCP call an agent can make. A survey is
 * an index, and an index whose entries cannot be followed is a summary.
 *
 * The crawl is deterministic: no model decides what a screen is, what a
 * viewport is, or what a component is named. The model is asked only the two
 * questions arithmetic cannot answer -- which module a component belongs to,
 * and what a screen is for -- and its answers live in fields that are all
 * optional, so a survey run with the model off is smaller but not wrong.
 */

import { findFigmaLinks, readFigmaFileLink } from './figma-link';

/**
 * Which drawing of a screen a frame is.
 *
 * Read from the frame's name first and its width second. The name wins because
 * a designer who wrote "Mobile" meant it, even on a 800pt artboard; the width
 * is what answers for the frames nobody labelled.
 */
export const SURVEY_VIEWPORTS = ['desktop', 'tablet', 'mobile', 'other'] as const;
export type SurveyViewport = (typeof SURVEY_VIEWPORTS)[number];

/** One drawing of one screen: a single Figma frame. */
export interface SurveyView {
  /** Canonical, with a colon. What the MCP tools take. */
  nodeId: string;
  /** Exactly as Figma spells it, viewport suffix and all. */
  name: string;
  viewport: SurveyViewport;
  width?: number;
  height?: number;
  /** A link a person can open. */
  url: string;
  /** The artefact holding the render, when one was taken. */
  shot?: string;
}

/**
 * What an author has to supply for one slot in a section.
 *
 * This is the bridge between a design and an authoring model. A `TEXT` layer
 * reading "Wellness with new eyes" is not decoration: it is a headline field
 * that somebody will type into, and the difference between a survey that says
 * "there is a card here" and one a developer can build from is exactly this
 * list.
 *
 * The node id, kind and sample are read out of Figma. The label, the note and
 * the Universal Editor component are the model's, and are absent when it did
 * not run -- the field still stands without them.
 */
export const SURVEY_FIELD_KINDS = ['text', 'richtext', 'image', 'icon', 'link', 'container'] as const;
export type SurveyFieldKind = (typeof SURVEY_FIELD_KINDS)[number];

export interface SurveyField {
  nodeId: string;
  /** The layer's own name, which is usually what the designer called the slot. */
  name: string;
  kind: SurveyFieldKind;
  /** What it says, or what it shows, in the design. */
  sample?: string;
  /** True when siblings share its name: a list rather than a single value. */
  repeated?: boolean;
  /** The component this slot lives in, when it is inside one rather than loose. */
  componentName?: string;
  /** Model-supplied: what the author is actually being asked for. */
  label?: string;
  note?: string;
}

/** A picture, icon or video the section needs before it can be built. */
export interface SurveyAsset {
  nodeId: string;
  name: string;
  kind: 'image' | 'icon' | 'video';
  width?: number;
  height?: number;
  url: string;
}

/**
 * A layer doing visible work that no component accounts for.
 *
 * The single most useful thing a survey can tell a developer, and the reason it
 * is computed rather than asked for: everything inside an instance is already
 * somebody's component and will be built once, but a headline drawn directly
 * onto the page is work nobody has scoped. A section with twelve of these is a
 * section whose design system does not cover it yet.
 */
export interface SurveyOrphan {
  nodeId: string;
  name: string;
  /** Figma's own type: `TEXT`, `RECTANGLE`, `VECTOR`, … */
  type: string;
  sample?: string;
}

/**
 * One band of a screen: a header, a hero, a listing, a footer.
 *
 * Sections come from the crawl, not from a model. A screen frame is a stack of
 * child frames and those children *are* the sections -- that is how the design
 * was built, so reading it back is transcription rather than interpretation.
 * A model asked to list them instead would invent plausible ones, and a
 * plausible section cannot be clicked, rendered or pointed at a node.
 */
export interface SurveySection {
  id: string;
  /** Exactly as Figma spells it. */
  name: string;
  nodeId: string;
  url: string;
  /** Top to bottom, which is the order a page is read and built in. */
  order: number;
  width?: number;
  height?: number;
  /** Set when the whole section is one instance of a main component. */
  componentId?: string;
  componentName?: string;
  /** Main components used inside it, by survey component id. */
  componentIds: string[];
  /** What an author fills in. */
  fields: SurveyField[];
  /** What a build needs delivered to it. */
  assets: SurveyAsset[];
  /** Work no component covers. */
  orphans: SurveyOrphan[];
  nodeCount: number;
  shot?: string;
  /** Model-supplied. */
  purpose?: string;
  /** How this is authored in the Universal Editor, in prose. */
  authoring?: string;
}

/**
 * One screen, however many frames it was drawn as.
 *
 * Desktop, tablet and mobile are three frames of one screen, and a reader
 * wants them side by side rather than as three unrelated entries. They are
 * grouped by the name with the viewport marker taken off it.
 */
export interface SurveyScreen {
  id: string;
  /** The base name, without the viewport marker. Still the designer's words. */
  name: string;
  /** The Figma page the frames sit on. */
  page: string;
  /** The Figma section the frames sit in, when the page uses them. */
  group?: string;
  /** Widest first, which is the view that shows the most. */
  views: SurveyView[];
  /** Components found on it, by id. */
  componentIds: string[];
  /** The bands it is built from, top to bottom. Read, not invented. */
  sections: SurveySection[];
  /** Layers beneath it, so a reader can tell a screen from a sticker. */
  nodeCount: number;
  /** Model-supplied, and absent when the model was not run. */
  purpose?: string;
  content?: string[];
  moduleId?: string;
}

export const SURVEY_COMPONENT_TYPES = ['COMPONENT_SET', 'COMPONENT', 'INSTANCE'] as const;
export type SurveyComponentType = (typeof SURVEY_COMPONENT_TYPES)[number];

/** One component, counted across the whole file. */
export interface SurveyComponent {
  id: string;
  /**
   * The exact Figma name.
   *
   * Taken from the main component where the file exposes one and from the
   * instance's own name where it does not. Never normalised, never split on
   * its slashes, never title-cased.
   */
  name: string;
  type: SurveyComponentType;
  /** Variant property strings seen on instances, e.g. `Size=Large, State=Hover`. */
  variants: string[];
  /** How many instances were found. */
  instances: number;
  /** The node the reader is pointed at: the main component where there is one. */
  nodeId: string;
  url: string;
  /**
   * The main component's own node, as Figma's "go to main component" resolves it.
   *
   * This is the component's real identity. An instance can be renamed in place,
   * and two renamed differently would be counted as two components without it.
   */
  componentId?: string;
  /** Set when the main component itself was read. */
  definitionNodeId?: string;
  /** True when the name came from the main component rather than an instance. */
  resolved?: boolean;
  width?: number;
  height?: number;
  screenIds: string[];
  shot?: string;
  moduleId?: string;
  /**
   * The component's own layers, as an indented outline.
   *
   * A name is a handle, not a description. This is what is actually inside the
   * thing -- which slots hold text, which hold an image, what nests in it --
   * and it is read out of Figma rather than guessed at, so it is true whether
   * or not a model ever ran.
   */
  structure?: string;
  /** The words the component was drawn with, which is what it is for, in miniature. */
  text?: string[];
  /** Components used inside this one, by exact name. */
  uses?: string[];
  /** Layers beneath it, so a wrapper reads differently from a real component. */
  nodeCount?: number;
  /** Model-supplied. */
  purpose?: string;
}

/**
 * A functional area of the product.
 *
 * Proposed by the model where it ran, and otherwise taken from the first
 * segment of the component's own path name -- which is how most design systems
 * already spell their grouping, so the fallback is usually right.
 */
export interface SurveyModule {
  id: string;
  name: string;
  summary?: string;
  componentIds: string[];
  screenIds: string[];
}

export interface SurveyPage {
  name: string;
  nodeId: string;
  url: string;
  screenIds: string[];
}

/** Everything a crawl found. Written to disk, and what the console renders. */
export interface SurveyInventory {
  fileKey: string;
  fileName?: string;
  pages: SurveyPage[];
  modules: SurveyModule[];
  components: SurveyComponent[];
  screens: SurveyScreen[];
  /** Things that went wrong without stopping the crawl. */
  warnings: string[];
}

export const SURVEY_STATES = ['queued', 'running', 'done', 'failed'] as const;
export type SurveyState = (typeof SURVEY_STATES)[number];

/** What a run was asked to do. Stored, so a rerun can be the same run. */
export interface SurveyOptions {
  /** Render each screen's frames. The slowest part of a crawl by far. */
  screenshots: boolean;
  /** Render each component too. */
  componentShots: boolean;
  /** A hard cap on screen renders, because each is a round trip to Figma. */
  maxShots: number;
  /**
   * A separate cap on component renders.
   *
   * Separate because one shared budget is a budget the screens always win: a
   * file has twenty screens and three hundred components, so the screens take
   * it all and every component is left as a name with no picture. They are
   * different questions and they get different allowances.
   */
  maxComponentShots: number;
  /**
   * Follow every instance to its main component.
   *
   * One extra read per distinct component, which buys the name the designer
   * gave the component itself rather than the name somebody gave one instance
   * of it, the layers inside it, and the components whose page was never
   * crawled.
   */
  resolveComponents: boolean;
  /** Ask the model for modules and screen purposes. */
  describe: boolean;
  /** How many screens get their own summarising pass. */
  maxScreenSummaries: number;
  /**
   * How many sections get read as an authoring model.
   *
   * The expensive half of the feature and the useful half: one pass per
   * section, over that section's own slots, producing what an author types and
   * how the block is filled in. Tallest first, because a 900pt band is the
   * page and a 40pt one is a divider.
   */
  maxSectionSummaries: number;
}

export const DEFAULT_SURVEY_OPTIONS: SurveyOptions = {
  screenshots: true,
  componentShots: true,
  maxShots: 60,
  maxComponentShots: 120,
  resolveComponents: true,
  describe: true,
  maxScreenSummaries: 12,
  maxSectionSummaries: 24,
};

/** The record written to `storage/surveys/<id>/survey.json`. */
export interface SurveyRecord {
  surveyId: string;
  /** What to call this in a list. The file name, unless one was typed. */
  title: string;
  /** The links as they were typed, so a rerun needs nothing else. */
  links: string;
  fileKey: string;
  fileName?: string;
  armId: string;
  state: SurveyState;
  startedAt: string;
  endedAt?: string;
  detail?: string;
  options: SurveyOptions;
  counts?: {
    pages: number;
    screens: number;
    views: number;
    components: number;
    modules: number;
    shots: number;
  };
}

/** What the browser submits. The id is chosen there, not returned. */
export interface SurveyRequest {
  surveyId: string;
  title?: string;
  links: string;
  armId?: string;
  armParams?: Record<string, unknown>;
  options?: Partial<SurveyOptions>;
}

export interface SurveyResult {
  record: SurveyRecord;
  inventory?: SurveyInventory;
}

/**
 * How many roots one survey crawls.
 *
 * A root is a page, and each is one `get_metadata` call whose answer is the
 * whole subtree. Twelve pages is a large product file; past that the limit is
 * protecting the machine rather than the reader.
 */
export const MAX_SURVEY_ROOTS = 12;

/** A place the crawl starts from. No node means the file's first page. */
export interface SurveyRoot {
  fileKey: string;
  nodeId?: string;
  fileName?: string;
}

export interface SurveyRootsReading {
  roots: SurveyRoot[];
  problems: string[];
}

/**
 * Reads the links a survey starts from.
 *
 * Unlike a block analysis this accepts a link with no node in it: that is a
 * link to the file, and a survey of a file is exactly what this is. Several
 * links are how a multi-page file is covered -- Figma's local server answers
 * about the node it is given, so a page nobody named is a page nobody reads.
 */
export function readSurveyRoots(text: unknown): SurveyRootsReading {
  if (typeof text !== 'string' || !text.trim()) {
    return { roots: [], problems: ['a Figma link is required'] };
  }

  const found = findFigmaLinks(text);
  if (found.length === 0) {
    return {
      roots: [],
      problems: [
        'no Figma link found in that text -- paste a link to the file, or to a page inside it. ' +
          'Notes around the link are fine, but there has to be a figma.com URL among them',
      ],
    };
  }

  const roots: SurveyRoot[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const link of found) {
    const reading = readFigmaFileLink(link);
    if (!reading.ok) {
      problems.push(reading.reason);
      continue;
    }
    const { fileKey, nodeId, fileName } = reading.target;
    const key = `${fileKey}/${nodeId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const root: SurveyRoot = { fileKey };
    if (nodeId) root.nodeId = nodeId;
    if (fileName) root.fileName = fileName;
    roots.push(root);
  }

  const files = [...new Set(roots.map((root) => root.fileKey))];
  if (files.length > 1) {
    problems.push(
      `those links are to ${files.length} different Figma files (${files.join(', ')}) -- ` +
        'one survey is one file, and a node id only means anything within its own file',
    );
  }

  if (roots.length > MAX_SURVEY_ROOTS) {
    problems.push(
      `${roots.length} links is more than the ${MAX_SURVEY_ROOTS} one survey crawls -- ` +
        'each is a full read of a page out of the Figma application',
    );
  }

  return { roots, problems };
}

/** A link a person can open, for any node in the surveyed file. */
export function figmaNodeUrl(fileKey: string, nodeId: string, fileName?: string): string {
  const name = fileName ? encodeURIComponent(fileName.replace(/ /g, '-')) : 'file';
  return `https://www.figma.com/design/${fileKey}/${name}?node-id=${nodeId.replace(':', '-')}`;
}

/**
 * The MCP call that reads a node, as a line an agent can be handed.
 *
 * The point of a survey is that the next step is automatable: a developer or an
 * agent picks a component out of the list and reads it properly. This is that
 * step, written out, rather than left as something the reader has to know.
 */
export function mcpCallFor(nodeId: string, fileKey: string, tool = 'get_design_context'): string {
  return `${tool}({ fileKey: "${fileKey}", nodeId: "${nodeId}" })`;
}

/** Words in a frame name that name a viewport rather than the screen. */
const VIEWPORT_WORDS: Record<string, SurveyViewport> = {
  desktop: 'desktop',
  desktops: 'desktop',
  web: 'desktop',
  pc: 'desktop',
  lg: 'desktop',
  xl: 'desktop',
  tablet: 'tablet',
  tablets: 'tablet',
  ipad: 'tablet',
  md: 'tablet',
  mobile: 'mobile',
  mobiles: 'mobile',
  mob: 'mobile',
  phone: 'mobile',
  sm: 'mobile',
  xs: 'mobile',
};

/** `Home — Desktop`, `Home / Mobile 390`, `Home (tablet)`, `Home@1440`. */
const TRAILING_MARKER = /\s*[–—\-/|·•@([]?\s*([A-Za-z]+)?\s*(\d{3,4})?\s*(px|pt)?\s*[)\]]?\s*$/;

/** The viewport a name declares, when it declares one. */
export function viewportFromName(name: string): SurveyViewport | undefined {
  for (const word of name.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const found = VIEWPORT_WORDS[word];
    if (found) return found;
  }
  return undefined;
}

/** The viewport a width implies. Figma frames are drawn at real widths. */
export function viewportFromWidth(width: number | undefined): SurveyViewport {
  if (width === undefined || !Number.isFinite(width)) return 'other';
  if (width >= 1200) return 'desktop';
  if (width >= 700) return 'tablet';
  if (width >= 200) return 'mobile';
  return 'other';
}

/** The name wins; the width answers for the frames nobody labelled. */
export function viewportOf(name: string, width: number | undefined): SurveyViewport {
  return viewportFromName(name) ?? viewportFromWidth(width);
}

/**
 * A frame's name with its viewport marker taken off.
 *
 * Two passes, because `Home – Mobile 390` carries two markers. Anything that
 * would leave nothing behind is left alone: a frame honestly called `Desktop`
 * is a screen named `Desktop`, not a screen with no name.
 */
export function screenBaseName(name: string): string {
  let current = name.trim();

  for (let pass = 0; pass < 2; pass += 1) {
    const match = TRAILING_MARKER.exec(current);
    if (!match) break;

    const [whole, word, digits] = match;
    if (!whole || whole === current) break;

    const isViewportWord = word !== undefined && VIEWPORT_WORDS[word.toLowerCase()] !== undefined;
    const isWidth = digits !== undefined && Number(digits) >= 200 && Number(digits) <= 4000;
    if (!isViewportWord && !isWidth) break;
    if (word !== undefined && !isViewportWord) break;

    const stripped = current
      .slice(0, current.length - whole.length)
      .trim()
      .replace(/[–—\-/|·•@([]+$/, '')
      .trim();
    if (!stripped) break;
    current = stripped;
  }

  return current;
}

/** A stable, readable id. Not unique on its own -- the caller resolves clashes. */
export function slugOf(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'item';
}
