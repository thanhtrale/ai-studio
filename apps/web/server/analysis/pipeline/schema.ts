/**
 * Validators for what each pass must return.
 *
 * Hand-written rather than a schema library, for one reason that matters: the
 * message a validator produces is fed straight back to the model as the repair
 * turn's complaint. "elements[2].nodeId must be a string" is something a model
 * can act on; a JSON-Schema error path is not.
 *
 * Every validator is total -- it either returns the typed value or throws with
 * a sentence -- and none of them repairs anything. Coercing a near-miss would
 * hide exactly the failures the repair turn exists to surface.
 */

import type {
  DesignElement,
  DesignNodeKind,
  Gap,
  GapKind,
  TicketClaim,
  TicketClaimKind,
  UeBlockModel,
  UeField,
} from '#shared/analysis';
import { DESIGN_NODE_KINDS, GAP_KINDS, TICKET_CLAIM_KINDS } from '#shared/analysis';

function fail(what: string): never {
  throw new Error(what);
}

function asArray(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const nested = (value as Record<string, unknown>)[key];
    // A model asked for `{"elements": [...]}` often returns the bare array, and
    // the other way round. Both are the document; neither is worth a round trip.
    if (Array.isArray(nested)) return nested;
  }
  fail(`expected an object with an array "${key}"`);
}

function str(value: unknown, where: string, { optional = false } = {}): string {
  if (value === undefined || value === null) {
    if (optional) return '';
    fail(`${where} is required`);
  }
  if (typeof value !== 'string') fail(`${where} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && !optional) fail(`${where} must not be empty`);
  return trimmed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  const text = str(value, where).toLowerCase();
  const found = allowed.find((entry) => entry === text);
  if (!found) fail(`${where} must be one of ${allowed.join(', ')} -- got "${text}"`);
  return found;
}

/**
 * String ids, however the model spelled the container.
 *
 * Never throws: an id list is where a model hedges, and a single id where an
 * array was asked for is not worth a repair turn. Whether the ids are real is a
 * separate question, settled by the evidence check rather than here.
 */
function ids(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
    .filter((entry, at, all) => all.indexOf(entry) === at);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

/** Pass 1: the elements the design contains. */
export function validateElements(value: unknown): DesignElement[] {
  const entries = asArray(value, 'elements');
  if (entries.length === 0) fail('elements must not be empty -- the design has something in it');

  return entries.map((entry, at) => {
    const item = object(entry, `elements[${at}]`);
    const element: DesignElement = {
      nodeId: str(item['nodeId'], `elements[${at}].nodeId`),
      role: str(item['role'], `elements[${at}].role`),
      kind: oneOf<DesignNodeKind>(item['kind'], DESIGN_NODE_KINDS, `elements[${at}].kind`),
      repeated: item['repeated'] === true,
    };
    const sample = str(item['sample'], `elements[${at}].sample`, { optional: true });
    if (sample) element.sample = sample;
    const variant = str(item['variant'], `elements[${at}].variant`, { optional: true });
    if (variant) element.variant = variant;
    return element;
  });
}

/** Pass 2: what the ticket asserts. */
export function validateClaims(value: unknown): TicketClaim[] {
  const entries = asArray(value, 'claims');

  return entries.map((entry, at) => ({
    id: str(object(entry, `claims[${at}]`)['id'], `claims[${at}].id`),
    passageId: str(object(entry, `claims[${at}]`)['passageId'], `claims[${at}].passageId`),
    statement: str(object(entry, `claims[${at}]`)['statement'], `claims[${at}].statement`),
    kind: oneOf<TicketClaimKind>(
      object(entry, `claims[${at}]`)['kind'],
      TICKET_CLAIM_KINDS,
      `claims[${at}].kind`,
    ),
  }));
}

export interface ReconcileOutput {
  requirements: { id: string; statement: string; nodeIds: string[]; passageIds: string[] }[];
  gaps: Gap[];
}

/** Pass 3: the consolidation and the disagreements. */
export function validateReconcile(value: unknown): ReconcileOutput {
  const root = object(value, 'the reply');

  const requirements = asArray(root['requirements'] ?? [], 'requirements').map((entry, at) => {
    const item = object(entry, `requirements[${at}]`);
    return {
      id: str(item['id'], `requirements[${at}].id`),
      statement: str(item['statement'], `requirements[${at}].statement`),
      nodeIds: ids(item['nodeIds']),
      passageIds: ids(item['passageIds']),
    };
  });

  if (requirements.length === 0) {
    fail('requirements must not be empty -- the design shows something, so something is required');
  }

  const gaps = asArray(root['gaps'] ?? [], 'gaps').map((entry, at): Gap => {
    const item = object(entry, `gaps[${at}]`);
    const gap: Gap = {
      id: str(item['id'], `gaps[${at}].id`),
      kind: oneOf<GapKind>(item['kind'], GAP_KINDS, `gaps[${at}].kind`),
      statement: str(item['statement'], `gaps[${at}].statement`),
      evidence: {
        nodeIds: ids(item['nodeIds']),
        passageIds: ids(item['passageIds']),
      },
      // A gap nobody can act on is noise, so the question is not optional.
      question: str(item['question'], `gaps[${at}].question`),
    };
    const design = str(item['designReading'], `gaps[${at}].designReading`, { optional: true });
    if (design) gap.designReading = design;
    const ticket = str(item['ticketReading'], `gaps[${at}].ticketReading`, { optional: true });
    if (ticket) gap.ticketReading = ticket;

    if (gap.kind === 'contradiction' && !gap.designReading) {
      fail(`gaps[${at}] is a contradiction, so designReading is required -- the design is authoritative`);
    }
    return gap;
  });

  return { requirements, gaps };
}

/** A Universal Editor field, kept loose: the component set is Adobe's, not ours. */
function validateField(value: unknown, where: string): UeField {
  const item = object(value, where);
  const field: UeField = {
    ...item,
    component: str(item['component'], `${where}.component`),
    name: str(item['name'], `${where}.name`),
  };

  if (Array.isArray(item['fields'])) {
    field.fields = item['fields'].map((nested, at) => validateField(nested, `${where}.fields[${at}]`));
  }

  if (item['options'] !== undefined) {
    field.options = asArray(item['options'], 'options').map((option, at) => {
      const entry = object(option, `${where}.options[${at}]`);
      return {
        name: str(entry['name'], `${where}.options[${at}].name`),
        value: str(entry['value'], `${where}.options[${at}].value`, { optional: true }),
      };
    });
  }

  return field;
}

/**
 * Pass 4: the content model, in the shape `aem-boilerplate-xwalk` merges.
 *
 * The three arrays are required even when empty. A document missing `filters`
 * is not a simpler document -- it is one the build's merge glob will skip a
 * key from, and that failure surfaces much later and much less clearly.
 */
export function validateBlockModel(value: unknown): UeBlockModel {
  const root = object(value, 'the reply');

  for (const key of ['definitions', 'models', 'filters']) {
    if (!Array.isArray(root[key])) {
      fail(`"${key}" must be an array -- the document needs all three of definitions, models and filters`);
    }
  }

  const definitions = (root['definitions'] as unknown[]).map((entry, at) => {
    const item = object(entry, `definitions[${at}]`);
    return {
      title: str(item['title'], `definitions[${at}].title`),
      id: str(item['id'], `definitions[${at}].id`),
      plugins: object(item['plugins'], `definitions[${at}].plugins`),
    };
  });

  if (definitions.length === 0) fail('definitions must not be empty -- the block has to be offered somewhere');

  const models = (root['models'] as unknown[]).map((entry, at) => {
    const item = object(entry, `models[${at}]`);
    const fields = asArray(item['fields'], 'fields');
    return {
      id: str(item['id'], `models[${at}].id`),
      fields: fields.map((field, index) => validateField(field, `models[${at}].fields[${index}]`)),
    };
  });

  const filters = (root['filters'] as unknown[]).map((entry, at) => {
    const item = object(entry, `filters[${at}]`);
    return {
      id: str(item['id'], `filters[${at}].id`),
      components: ids(item['components']),
    };
  });

  return { definitions, models, filters };
}
