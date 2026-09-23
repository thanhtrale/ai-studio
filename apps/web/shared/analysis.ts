/**
 * The vocabulary of a requirements analysis, shared by the browser and the server.
 *
 * An analysis reads a design and a ticket and produces one consolidated
 * requirement, the disagreements between the two, and a proposed Universal
 * Editor content model. The design is the authority: where the two sources
 * disagree, the design's reading becomes the requirement and the ticket's
 * becomes a gap.
 *
 * Every statement here that claims to come from a source carries the evidence
 * for it -- a design node id, a ticket passage id, or both. That is not a
 * courtesy to the reader: the ids are checked against what the sources actually
 * contained, and a statement whose evidence does not resolve is demoted to an
 * inference rather than reported as a requirement.
 */

/** Where a ticket came from, and therefore how much of it could be recovered. */
export const TICKET_FORMATS = ['jira-xml', 'html', 'pdf', 'text'] as const;
export type TicketFormat = (typeof TICKET_FORMATS)[number];

/**
 * A citable part of a ticket.
 *
 * Passages exist so that a requirement can name the paragraph it came from
 * rather than the ticket as a whole.
 *
 * The id is a short ordinal -- `p1`, `p2` -- and that is a correction, not a
 * shortcut. It was first the source's own anchor, slugified: Confluence writes
 * `<a name="ScenariosSiteVisitor%28GuestUserExperience%29">`, which becomes
 * `scenariossitevisitor-guestuserexperience`. Forty characters of run-together
 * lowercase is not something a model transcribes reliably, and a real run
 * proved it: of 61 extracted claims, 28 were discarded for citing
 * `sitevisitor-guestuserexperience` (the prefix dropped) or `Introduction`
 * (the heading used instead of the id). Both were the fault of the id, not of
 * the model. `p3` cannot be mistyped.
 *
 * The anchor and the heading are kept beside it, because they are what makes
 * the citation mean something to a person reading the output.
 */
export interface TicketPassage {
  /** Short and unique within one ticket: `p1`, `p2`, … and `c1` for comments. */
  id: string;
  heading: string;
  /** The source's own anchor, where it had one. Display only -- never cited. */
  anchor?: string;
  /** Markdown. */
  body: string;
}

export interface TicketComment {
  id: string;
  /** Display name where the export carries one; never an account identifier. */
  author?: string;
  createdAt?: string;
  /** Markdown. */
  body: string;
}

/**
 * An attachment, named but not read.
 *
 * The import path carries no credentials, so the bytes behind these are
 * unreachable. They are listed anyway: a reader has to be able to tell "the
 * ticket had no screenshot" from "the ticket had three and none was consulted".
 */
export interface TicketAttachment {
  id: string;
  name: string;
  bytes?: number;
}

/** One ticket, whatever it was imported from. Absent fields were absent. */
export interface NormalisedTicket {
  format: TicketFormat;
  key?: string;
  summary?: string;
  status?: string;
  type?: string;
  priority?: string;
  /** The epic or parent issue key, when the export names one. */
  parent?: string;
  labels?: string[];
  createdAt?: string;
  updatedAt?: string;
  /** The whole description as Markdown, headings and tables preserved. */
  description: string;
  passages: TicketPassage[];
  comments: TicketComment[];
  attachments: TicketAttachment[];
  /** Custom fields that carried a value. Empty ones are dropped, not recorded. */
  fields?: Record<string, string>;
}

/** What a node is, as far as the analysis cares. */
export const DESIGN_NODE_KINDS = [
  'frame',
  'text',
  'image',
  'icon',
  'button',
  'link',
  'input',
  'container',
  'other',
] as const;
export type DesignNodeKind = (typeof DESIGN_NODE_KINDS)[number];

/** A design token, named as well as resolved. */
export interface DesignToken {
  name: string;
  value: string;
  /** `color`, `spacing`, `typography`, … as the source reported it. */
  kind?: string;
}

/**
 * A design reduced to something a context window holds.
 *
 * `digest` is indented text rather than JSON on purpose: braces, quotes and
 * repeated keys are a large share of a JSON tree's tokens and carry nothing the
 * model needs, so the same budget buys more of the design.
 */
export interface NormalisedDesign {
  /** Which adapter read it, e.g. `figma-mcp`. */
  adapter: string;
  fileKey: string;
  nodeId: string;
  name?: string;
  digest: string;
  /**
   * Every node id the digest mentions.
   *
   * This is the ground truth evidence is checked against. An id a model returns
   * that is not in here did not come from the design, whatever the model says.
   */
  nodeIds: string[];
  tokens: DesignToken[];
  /**
   * Figma's own design-to-code guess, when the adapter could supply one.
   *
   * Evidence about styling and hierarchy, never about structure: it is an
   * interpretation in a framework this project does not use, and it carries no
   * checkable node ids.
   */
  interpretation?: string;
  /** Media id of the rendered frame, when one was taken. */
  renderId?: string;
  /** Nodes the reduction dropped, so a reader knows the digest is a reduction. */
  droppedNodes: number;
  /** Set when the tree was cut at a depth to fit the budget. */
  truncatedAtDepth?: number;
}

/** One element the design contains, as pass 1 enumerated it. */
export interface DesignElement {
  nodeId: string;
  /** What it appears to be for, in the block's terms: `eyebrow`, `headline`, … */
  role: string;
  kind: DesignNodeKind;
  /** Text content, or a short description of the visual. */
  sample?: string;
  /** True when the same component appears more than once at this level. */
  repeated: boolean;
  /** The variant name, when the element belongs to a component variant. */
  variant?: string;
}

/** One thing the ticket asserts, as pass 2 extracted it. */
export const TICKET_CLAIM_KINDS = [
  'content',
  'behaviour',
  'layout',
  'constraint',
  'authoring',
  'accessibility',
  'analytics',
] as const;
export type TicketClaimKind = (typeof TICKET_CLAIM_KINDS)[number];

export interface TicketClaim {
  id: string;
  passageId: string;
  statement: string;
  kind: TicketClaimKind;
}

/** Where a statement came from. At least one side is always present. */
export interface Evidence {
  nodeIds: string[];
  passageIds: string[];
}

export interface Requirement {
  id: string;
  statement: string;
  evidence: Evidence;
}

/**
 * A statement no source supports.
 *
 * Kept rather than dropped, because a model's guess about a hover state is
 * often right and always worth a question -- but it is never a requirement.
 */
export interface Inference {
  id: string;
  statement: string;
  /** Why the evidence did not hold: unresolved ids, or none offered. */
  reason: string;
}

export const GAP_KINDS = [
  /** The ticket describes something the design does not show. */
  'not-in-design',
  /** The design shows something the ticket never describes. */
  'undocumented',
  /** The two disagree. The design's reading is the requirement. */
  'contradiction',
  /** Visible but undetermined: a truncation rule, an empty state, a breakpoint. */
  'ambiguous',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

export interface Gap {
  id: string;
  kind: GapKind;
  statement: string;
  /** What the design shows, when the gap is a contradiction. */
  designReading?: string;
  /** What the ticket claims, when the gap is a contradiction. */
  ticketReading?: string;
  evidence: Evidence;
  /**
   * The question to put to a person.
   *
   * Required: a gap nobody can act on is noise, so one without a question is
   * not reported at all.
   */
  question: string;
}

/** A field in a Universal Editor model, as `aem-boilerplate-xwalk` spells it. */
export interface UeField {
  component: string;
  name: string;
  label?: string;
  valueType?: string;
  value?: unknown;
  multi?: boolean;
  options?: { name: string; value: string }[];
  fields?: UeField[];
  [key: string]: unknown;
}

export interface UeModel {
  id: string;
  fields: UeField[];
}

export interface UeDefinition {
  title: string;
  id: string;
  plugins: Record<string, unknown>;
}

export interface UeFilter {
  id: string;
  components: string[];
}

/** The document saved as `blocks/<name>/_<name>.json`. */
export interface UeBlockModel {
  definitions: UeDefinition[];
  models: UeModel[];
  filters: UeFilter[];
}

export const ANALYSIS_STATES = ['queued', 'running', 'done', 'failed'] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number];

/** What the browser submits. The id is chosen here, not returned. */
export interface AnalysisRequest {
  /**
   * Chosen by the browser, not returned to it.
   *
   * Progress has to be askable while the submitting request is still open, and
   * per-pass supervisor job ids derive from this, so it is constrained to the
   * same character set a job id is.
   */
  analysisId: string;
  /** The block being specified, e.g. `featured-story-card`. */
  blockName: string;
  /** A Figma link carrying a file key and a node id. */
  designUrl: string;
  /** The ticket, already normalised by the ticket route. */
  ticket: NormalisedTicket;
  /** Which arm runs the passes. Any arm declaring `text.generate`. */
  armId: string;
  /** How that arm has to be configured; travels with every pass. */
  armParams?: Record<string, unknown>;
}

/** The record written to `storage/analyses/<id>/analysis.json`. */
export interface AnalysisRecord {
  analysisId: string;
  blockName: string;
  armId: string;
  state: AnalysisState;
  startedAt: string;
  endedAt?: string;
  /** Why it failed, when it did. */
  detail?: string;
  design?: Pick<NormalisedDesign, 'adapter' | 'fileKey' | 'nodeId' | 'name'>;
  ticket?: Pick<NormalisedTicket, 'format' | 'key' | 'summary'>;
  counts?: {
    requirements: number;
    inferences: number;
    gaps: number;
  };
}

/** Everything a completed analysis produced. */
export interface AnalysisResult {
  record: AnalysisRecord;
  requirements: Requirement[];
  inferences: Inference[];
  gaps: Gap[];
  model: UeBlockModel;
  /** The readable consolidation, rendered from the above rather than generated. */
  markdown: string;
}
