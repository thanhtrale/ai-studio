/**
 * A section's slots, as a Universal Editor block model.
 *
 * The last mile of the survey: a developer who has read what a section is made
 * of still has to write `_<block>.json` before an author can type anything into
 * it, and that file is mechanical. Its shape follows from the field kinds --
 * a text layer is a `text` field, a paragraph is `richtext`, an image is a
 * `reference` plus the alt text that must go with it -- so it is assembled here
 * rather than asked of a model.
 *
 * The model's contribution is the labels, which is the part that needs
 * judgement: `Wellness with new eyes` is a headline, and only something that
 * has read the section knows that. Where it did not run, the layer's own name
 * is used, which is what the designer called the slot and is usually right.
 *
 * In `shared/` because both sides build it: the console renders it beside the
 * section, and a route that writes it to disk must produce byte-identical
 * output. Two implementations would eventually disagree about a field name, and
 * the disagreement would show up as a file that does not match what was on
 * screen when somebody copied it.
 *
 * This is `aem-boilerplate-xwalk`'s spelling of the model, so the output is
 * meant to be pasted into a block folder rather than translated first.
 */

import type { UeBlockModel, UeField } from './analysis';
import type { SurveyField, SurveySection } from './survey';

/** How a field kind is authored. Two entries where one slot needs two boxes. */
const AUTHORING: Record<SurveyField['kind'], (name: string, label: string) => UeField[]> = {
  text: (name, label) => [{ component: 'text', valueType: 'string', name, label }],
  richtext: (name, label) => [{ component: 'richtext', valueType: 'string', name, label }],
  // An image is never one field: a reference with no alt text is an
  // accessibility defect shipped by the model rather than by the author.
  image: (name, label) => [
    { component: 'reference', valueType: 'string', name, label },
    { component: 'text', valueType: 'string', name: `${name}Alt`, label: `${label} alt text` },
  ],
  icon: (name, label) => [{ component: 'text', valueType: 'string', name, label }],
  link: (name, label) => [
    { component: 'aem-content', name, label },
    { component: 'text', valueType: 'string', name: `${name}Text`, label: `${label} text` },
  ],
  container: (name, label) => [{ component: 'text', valueType: 'string', name, label }],
};

/** A JSON field name: camel case, and never empty or repeated. */
function fieldName(value: string, taken: Set<string>): string {
  const parts = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  const head = parts[0] ?? 'field';
  const base =
    head +
    parts
      .slice(1, 4)
      .map((part) => (part[0] ?? '').toUpperCase() + part.slice(1))
      .join('');

  let name = base;
  for (let at = 2; taken.has(name); at += 1) name = `${base}${at}`;
  taken.add(name);
  return name;
}

/** The label the model gave the slot, or the designer's own layer name. */
function labelFor(field: SurveyField): string {
  if (field.label) return field.label;
  const words = field.name.replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field.kind;
}

/** The block id a section would be built as, e.g. `hero-global`. */
export function blockNameFor(section: SurveySection): string {
  const source = section.componentName ?? section.name;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'block';
}

/**
 * Builds the model for one section.
 *
 * Fields that belong to a nested component are still included: an author fills
 * in a card's headline whether or not the card is its own component, and a
 * model that omitted them would produce a block nobody can write content for.
 */
export function ueModelFor(section: SurveySection): UeBlockModel {
  const id = blockNameFor(section);
  const taken = new Set<string>();

  const fields: UeField[] = [];
  for (const field of section.fields) {
    const label = labelFor(field);
    const name = fieldName(field.name || field.kind, taken);
    fields.push(...AUTHORING[field.kind](name, label));
  }

  return {
    definitions: [
      {
        title: section.name,
        id,
        plugins: {
          xwalk: {
            page: {
              resourceType: 'core/franklin/components/block/v1/block',
              template: { name: section.name, model: id },
            },
          },
        },
      },
    ],
    models: [{ id, fields }],
    filters: [{ id, components: [] }],
  };
}

/** The file a developer would paste this into. */
export function ueFileNameFor(section: SurveySection): string {
  return `_${blockNameFor(section)}.json`;
}
