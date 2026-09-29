/**
 * The proposed content model, explained to the person who has to fill it in.
 *
 * `_<block>.json` is for a developer: it is merged into the repository and the
 * Universal Editor reads it. Nobody authoring a page reads JSON, and the
 * questions they actually have -- what goes in this box, why are there two
 * boxes for one image, what happens if I change this -- are answered nowhere in
 * it. This renders those answers.
 *
 * It is also the first thing that looks at pass 4's output critically. Pass 4
 * is the least reliable of the four, and its failures are quiet: an empty
 * filter still parses, a container mixed with an item definition still parses,
 * an image with no alt field still parses. The guide ends with what it found
 * wrong, because a proposal presented without its doubts reads as a decision.
 *
 * Rendered from the model in code. No pass writes this, for the same reason no
 * pass writes `requirements.md`: a model asked to describe its own output is an
 * opportunity for the description and the output to differ.
 */

import type { UeBlockModel, UeDefinition, UeField, UeModel } from '#shared/analysis';

const BLOCK_TYPE = 'core/franklin/components/block/v1/block';
const ITEM_TYPE = 'core/franklin/components/block/v1/block/item';

/**
 * The suffixes the editor uses to collapse several fields into one control.
 *
 * An author sees one "image" with a description box under it; the model holds
 * `image` and `imageAlt`. Listing the second as a field of its own would be
 * true and misleading, so it is rendered under the field it belongs to.
 */
const COMPANION_SUFFIXES = ['Alt', 'Text', 'Title', 'Type', 'MimeType'] as const;

/** What each field component asks the author for, in their terms. */
const COMPONENT_PROSE: Record<string, string> = {
  text: 'A single line of plain text.',
  richtext: 'Formatted text — bold, links, lists.',
  number: 'A number.',
  select: 'Choose one.',
  multiselect: 'Choose any number.',
  boolean: 'On or off.',
  checkbox: 'On or off.',
  'checkbox-group': 'Choose any number.',
  'radio-group': 'Choose one.',
  'date-time': 'A date and a time.',
  reference: 'Pick an asset — an image or a file — from the DAM.',
  'aem-content': 'Pick a page to link to, or type a URL.',
  'aem-tag': 'Pick one or more tags.',
  container: 'A group. The fields listed under it belong to this group.',
  tab: 'A tab in the editor. Organisation only — it holds no content of its own.',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The resource type a definition declares, however deeply it is buried. */
function resourceTypeOf(definition: UeDefinition): string {
  const xwalk = isObject(definition.plugins) ? definition.plugins['xwalk'] : undefined;
  const page = isObject(xwalk) ? xwalk['page'] : undefined;
  const type = isObject(page) ? page['resourceType'] : undefined;
  return typeof type === 'string' ? type : '';
}

/** The model a definition's template points at. */
function modelIdOf(definition: UeDefinition): string {
  const xwalk = isObject(definition.plugins) ? definition.plugins['xwalk'] : undefined;
  const page = isObject(xwalk) ? xwalk['page'] : undefined;
  const template = isObject(page) ? page['template'] : undefined;
  const id = isObject(template) ? template['model'] : undefined;
  return typeof id === 'string' ? id : '';
}

function isVariant(field: UeField): boolean {
  return field.name === 'classes' || field.name.startsWith('classes_');
}

/** The sibling fields that belong to this one under the suffix convention. */
function companionsOf(field: UeField, all: readonly UeField[]): UeField[] {
  return all.filter((other) =>
    COMPANION_SUFFIXES.some((suffix) => other.name === `${field.name}${suffix}`),
  );
}

function labelOf(field: UeField): string {
  return field.label?.trim() || field.name;
}

function optionsOf(field: UeField): string {
  if (!field.options?.length) return '';
  const listed = field.options
    .map((option) => `${option.name}${option.value ? ` (\`${option.value}\`)` : ''}`)
    .join(', ');
  return ` Choices: ${listed}.`;
}

/** One field, as a bullet with its companions folded underneath it. */
function renderField(field: UeField, all: readonly UeField[]): string[] {
  const out = [`- **${labelOf(field)}** — \`${field.name}\``];

  const prose = COMPONENT_PROSE[field.component] ?? `A \`${field.component}\` field.`;
  const multi = field.multi ? ' Several may be added.' : '';
  out.push(`  ${prose}${optionsOf(field)}${multi}`);

  for (const companion of companionsOf(field, all)) {
    out.push(
      `  - Its **${labelOf(companion)}** is a second field, \`${companion.name}\`. The editor shows ` +
        'the pair as one control, so an author fills in both without needing to know there are two.',
    );
  }

  // A container's own children, which are fields rather than companions.
  for (const child of field.fields ?? []) {
    out.push(`  - **${labelOf(child)}** — \`${child.name}\`. ${COMPONENT_PROSE[child.component] ?? ''}`.trimEnd());
  }

  return out;
}

function renderModel(model: UeModel, title: string): string[] {
  const out: string[] = [];
  const companions = new Set(
    model.fields.flatMap((field) => companionsOf(field, model.fields).map((entry) => entry.name)),
  );

  const content = model.fields.filter((field) => !isVariant(field) && !companions.has(field.name));
  const variants = model.fields.filter(isVariant);

  out.push(`### ${title}`);
  out.push('');

  if (content.length === 0) {
    out.push('_This model asks for no content at all, which is almost certainly wrong._');
  } else {
    for (const field of content) out.push(...renderField(field, model.fields));
  }
  out.push('');

  if (variants.length > 0) {
    out.push('**Visual variants.** These are not content. They reach the block as CSS classes, so they');
    out.push('change how it looks and never what it says.');
    out.push('');
    for (const field of variants) out.push(...renderField(field, model.fields));
    out.push('');
  }

  return out;
}

/**
 * What the guide found wrong with the proposal.
 *
 * Every check here is for a failure that parses cleanly and is therefore
 * invisible until somebody tries to author with the model. Two of them --
 * the empty filter and the container mixed with an item definition -- were
 * produced by both arms on the first real run, which is why they are checked
 * rather than assumed.
 */
function findings(model: UeBlockModel): string[] {
  const out: string[] = [];
  const modelIds = new Set(model.models.map((entry) => entry.id));
  const items = model.definitions.filter((definition) => resourceTypeOf(definition) === ITEM_TYPE);
  const blocks = model.definitions.filter((definition) => resourceTypeOf(definition) === BLOCK_TYPE);

  for (const filter of model.filters) {
    if (filter.components.length === 0) {
      out.push(
        `The filter \`${filter.id}\` names no components, so the editor would offer nothing to add ` +
          'inside the block. A filter exists to say what may go in; an empty one says nothing may.',
      );
    }
  }

  if (items.length > 0 && model.filters.length === 0) {
    out.push(
      'There is an item definition but no filter. Without one the editor has no way to know that ' +
        'the item may be placed inside the block, so the block would author as empty.',
    );
  }

  for (const definition of model.definitions) {
    const id = modelIdOf(definition);
    if (id && !modelIds.has(id)) {
      out.push(`The definition "${definition.title}" points at a model \`${id}\` that is not in this document.`);
    }
    if (!resourceTypeOf(definition)) {
      out.push(`The definition "${definition.title}" declares no resource type, so the editor cannot place it.`);
    }
  }

  for (const entry of model.models) {
    const names = entry.fields.map((field) => field.name);
    const duplicates = [...new Set(names.filter((name, at) => names.indexOf(name) !== at))];
    if (duplicates.length > 0) {
      out.push(`The model \`${entry.id}\` uses the field name ${duplicates.map((n) => `\`${n}\``).join(', ')} twice.`);
    }

    for (const field of entry.fields) {
      if (!field.label?.trim()) {
        out.push(`The field \`${field.name}\` has no label, so the editor would show its raw name to an author.`);
      }
      if (field.component === 'reference' && companionsOf(field, entry.fields).length === 0) {
        out.push(
          `The image field \`${field.name}\` has no \`${field.name}Alt\` beside it, so there is nowhere ` +
            'to write alt text. That is an accessibility failure rather than a style preference.',
        );
      }
      if (
        (field.component === 'select' ||
          field.component === 'multiselect' ||
          field.component === 'radio-group' ||
          field.component === 'checkbox-group') &&
        !field.options?.length
      ) {
        out.push(`The field \`${field.name}\` offers a choice but lists no options to choose from.`);
      }
      if (field.component === 'container' && items.length > 0) {
        out.push(
          `The model \`${entry.id}\` holds a \`container\` field *and* the document declares a separate ` +
            'item definition. Those are two different ways to repeat something; a block should use one.',
        );
      }
    }
  }

  if (blocks.length === 0) {
    out.push('No definition carries the block resource type, so nothing here can be placed on a page.');
  }

  return out;
}

/** The readable companion to `_<block>.json`. */
export function renderAuthoringGuide(model: UeBlockModel, blockName: string): string {
  const out: string[] = [];
  const items = model.definitions.filter((definition) => resourceTypeOf(definition) === ITEM_TYPE);
  const byId = new Map(model.models.map((entry) => [entry.id, entry]));

  out.push(`# ${blockName} — what an author fills in`);
  out.push('');
  out.push(
    '> A proposal, not a verified model. This is what the fourth pass suggested from the design and ' +
      'the consolidated requirement, and it is the least reliable of the four. Read it against the ' +
      'design before any of it is built.',
  );
  out.push('');

  out.push('## How the block is authored');
  out.push('');
  if (items.length > 0) {
    const names = items.map((definition) => `**${definition.title}**`).join(', ');
    out.push(
      `**This block repeats.** The block is a container, and an author adds children inside it: ` +
        `${names}. Each one is authored separately, with its own set of fields.`,
    );
  } else {
    out.push('**One instance, one set of fields.** Nothing inside this block repeats.');
  }
  out.push('');

  out.push('## The fields');
  out.push('');
  if (model.models.length === 0) {
    out.push('_The proposal contains no model at all, so there is nothing for an author to fill in._');
    out.push('');
  }

  // Definition order rather than model order: it is the order the editor shows
  // them in, which is the order the author meets them in.
  const rendered = new Set<string>();
  for (const definition of model.definitions) {
    const entry = byId.get(modelIdOf(definition)) ?? byId.get(definition.id);
    if (!entry || rendered.has(entry.id)) continue;
    rendered.add(entry.id);
    out.push(...renderModel(entry, definition.title || entry.id));
  }
  for (const entry of model.models) {
    if (rendered.has(entry.id)) continue;
    out.push(...renderModel(entry, entry.id));
  }

  if (model.filters.length > 0) {
    out.push('## What may be placed inside');
    out.push('');
    for (const filter of model.filters) {
      out.push(
        filter.components.length > 0
          ? `- Inside \`${filter.id}\`: ${filter.components.map((name) => `\`${name}\``).join(', ')}`
          : `- Inside \`${filter.id}\`: **nothing** — the filter lists no components`,
      );
    }
    out.push('');
  }

  const problems = findings(model);
  out.push('## Worth checking');
  out.push('');
  if (problems.length === 0) {
    out.push('_Nothing in the proposal tripped the checks. That is not the same as it being right._');
  } else {
    out.push(problems.map((problem) => `- ${problem}`).join('\n'));
  }
  out.push('');

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
