import path from 'node:path';

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export type LaunchValue = string | number | boolean;

export type LaunchResolutionCode = 'missing_value' | 'path_escape' | 'illegal_value';

export class LaunchResolutionError extends Error {
  readonly code: LaunchResolutionCode;

  constructor(message: string, code: LaunchResolutionCode) {
    super(message);
    this.name = 'LaunchResolutionError';
    this.code = code;
  }
}

export interface ResolveArgsInput {
  args: readonly string[];
  values: Readonly<Record<string, LaunchValue>>;
  storageDir: string;
  pathKeys?: ReadonlySet<string>;
}

/** Resolves `value` against the storage root and rejects anything that escapes it. */
export function resolveWithinStorage(storageDir: string, value: string): string {
  const root = path.resolve(storageDir);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new LaunchResolutionError(
      `path "${value}" resolves outside the managed storage directory`,
      'path_escape',
    );
  }

  return resolved;
}

/**
 * Substitutes `{{name}}` placeholders inside each argument.
 *
 * Substitution happens within a single argv element and never splits or joins
 * arguments, so a value containing shell metacharacters or whitespace reaches
 * the arm as one literal argument.
 */
export function resolveArgs({ args, values, storageDir, pathKeys }: ResolveArgsInput): string[] {
  const paths = pathKeys ?? new Set<string>();

  return args.map((arg) =>
    arg.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
      if (!Object.hasOwn(values, key)) {
        throw new LaunchResolutionError(`no value supplied for placeholder {{${key}}}`, 'missing_value');
      }

      const raw = String(values[key]);
      if (raw.includes('\0')) {
        throw new LaunchResolutionError(`value for {{${key}}} contains a null byte`, 'illegal_value');
      }

      return paths.has(key) ? resolveWithinStorage(storageDir, raw) : raw;
    }),
  );
}
