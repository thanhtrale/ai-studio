import path from 'node:path';

import { isMediaId, mediaKind, rootOf, UPLOAD_ROOT } from '#shared/library';

import { RelayError } from './supervisor';

/**
 * The media id for a file an arm says it wrote, or null if it wrote it somewhere
 * the library does not scan.
 *
 * The arm reports an absolute path, so this is the one place that translates the
 * arm's view of the filesystem into the library's.
 */
export function mediaIdFromPath(storageDir: string, absolute: string): string | null {
  const relative = path.relative(path.resolve(storageDir), path.resolve(absolute)).split(path.sep).join('/');
  return isMediaId(relative) ? relative : null;
}

/**
 * The conditioning image, named relative to the arm's own input directory.
 *
 * This assumes that directory is the storage root's `inputs`, which is the
 * default the arm ships and where uploads are written. An arm started with a
 * different `inputDir` would need its reference chosen from there instead --
 * nothing would silently point at the wrong file, it would fail to find one.
 *
 * The root check is a boundary, not a convenience: the value reaches an arm that
 * resolves it against a directory it is allowed to read, so a reference from
 * anywhere else is refused here rather than reinterpreted.
 */
export function armImagePath(referenceId: unknown): string {
  if (!isMediaId(referenceId)) throw new RelayError('invalid_request', 'reference is not a media id');
  if (rootOf(referenceId) !== UPLOAD_ROOT) {
    throw new RelayError(
      'invalid_request',
      `a reference image must live under ${UPLOAD_ROOT}/ -- arms may not read from anywhere else`,
    );
  }
  if (mediaKind(referenceId) !== 'image') {
    throw new RelayError('invalid_request', 'a reference must be an image');
  }
  return referenceId.slice(UPLOAD_ROOT.length + 1);
}
