import { Ajv, type ErrorObject } from 'ajv';

/**
 * JSON Schema `format` marking a string parameter as a filesystem path.
 * Values in these fields are confined to the managed storage directory.
 */
export const PATH_FORMAT = 'aistudio-path';

export type ParamsSchema = Record<string, unknown>;

export interface ParamsIssue {
  path: string;
  message: string;
}

export type ParamsValidationResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; issues: ParamsIssue[] };

function sealSchema(schema: ParamsSchema): ParamsSchema {
  if (schema['type'] !== 'object' || 'additionalProperties' in schema) return schema;
  return { ...schema, additionalProperties: false };
}

function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  // Confinement is enforced during launch resolution, not by the schema itself.
  ajv.addFormat(PATH_FORMAT, () => true);
  return ajv;
}

function toIssues(errors: readonly ErrorObject[] | null | undefined): ParamsIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath.replace(/^\//, '').replace(/\//g, '.'),
    message: error.message ?? 'is invalid',
  }));
}

export function validateParams(
  schema: ParamsSchema,
  params: Readonly<Record<string, unknown>>,
): ParamsValidationResult {
  const ajv = createAjv();
  let validate;
  try {
    validate = ajv.compile(sealSchema(schema));
  } catch (error) {
    return { ok: false, issues: [{ path: '', message: `invalid parameter schema: ${(error as Error).message}` }] };
  }

  const values = structuredClone(params) as Record<string, unknown>;
  if (validate(values)) return { ok: true, values };

  return { ok: false, issues: toIssues(validate.errors) };
}

export function collectPathKeys(schema: ParamsSchema): Set<string> {
  const properties = schema['properties'];
  const keys = new Set<string>();
  if (!properties || typeof properties !== 'object') return keys;

  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (value && typeof value === 'object' && (value as { format?: unknown }).format === PATH_FORMAT) {
      keys.add(key);
    }
  }
  return keys;
}
