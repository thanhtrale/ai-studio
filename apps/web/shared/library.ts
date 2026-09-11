/**
 * The media library's vocabulary, shared by the browser and the server.
 *
 * Every file the studio knows about lives under the managed storage directory,
 * and its path relative to that directory *is* its identity. That choice is what
 * makes the library able to show files it never created: a clip written by
 * `bench.py` has an id the moment it exists on disk, with no index to update and
 * nothing to reconcile. Records are sidecars keyed by the same path, so a file
 * with no record still lists -- it just shows only what the filesystem knows.
 */

export type MediaKind = 'image' | 'video';

/** Roots that are scanned. `outputs` is what arms write; `inputs` is what they read. */
export const MEDIA_ROOTS = ['outputs', 'inputs'] as const;
export type MediaRoot = (typeof MEDIA_ROOTS)[number];

/** Where sidecar records go, mirroring the media path with a `.json` suffix. */
export const LIBRARY_DIR = 'library';

/** Uploads land in the arm input root, because that is the only place an arm may read. */
export const UPLOAD_ROOT: MediaRoot = 'inputs';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
export const VIDEO_EXTENSIONS = ['.mp4', '.webm'] as const;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export interface MediaItem {
  /** POSIX path relative to the storage directory, e.g. `outputs/2026-09-11/a.mp4`. */
  id: string;
  name: string;
  kind: MediaKind;
  /** The directory the file sits in. This is what the library shows as a folder. */
  group: string;
  bytes: number;
  /** Filesystem mtime. The only timestamp available for files with no record. */
  modifiedAt: string;
  /**
   * Pixel size, read from the file's own header.
   *
   * Images only: a video's dimensions are not in a fixed place in its
   * container, and the one place they are wanted -- the detail panel -- already
   * gets them from the element that plays it. Absent for a format or a file
   * whose header could not be read, which is why every use of it is optional.
   */
  width?: number;
  height?: number;
  /** Present only for media this app recorded -- generated through it, or uploaded. */
  meta?: MediaMeta;
}

/** Everything needed to explain a file, and to run it again. */
export interface MediaMeta {
  source: 'generated' | 'uploaded';
  createdAt: string;
  jobId?: string;
  armId?: string;
  /** What the user typed. */
  prompt?: string;
  /** What actually reached the model, which differs when the enhancer ran. */
  promptUsed?: string;
  negativePrompt?: string;
  /** Media id of the conditioning image, when the run had one. */
  referenceId?: string;
  /**
   * Every conditioning image, when there was more than one.
   *
   * An image edit composes its references rather than choosing between them,
   * so the set is the input. `referenceId` stays the first of them, so a
   * reader that only understands one still shows something true.
   */
  referenceIds?: string[];
  settings?: JobSettings;
  /** Start parameters the arm was brokered into for this run. */
  armParams?: Record<string, unknown>;
  output?: OutputInfo;
  report?: ReportSummary;
  /** Uploads keep the name they arrived with; the stored name is sanitised. */
  originalName?: string;
}

/**
 * The console's own inputs alongside the values derived from them.
 *
 * Both are stored because they answer different questions: the derived values say
 * what the model was asked for, and the console's inputs are what has to be put
 * back into the form for "use these settings again" to mean anything.
 */
interface CommonSettings {
  aspect?: string;
  megapixels?: number;
  width: number;
  height: number;
  seed: number;
}

export interface VideoJobSettings extends CommonSettings {
  /**
   * Absent on every record written before there was a second modality, which
   * is why video is the one that may omit it rather than the one that declares
   * it. A reader narrows on `kind === 'image'` and gets video either way.
   */
  kind?: 'video';
  seconds?: number;
  numFrames: number;
  frameRate: number;
  enhancePrompt: boolean;
  spatialUpsample: boolean;
  temporalUpsample: boolean;
}

export interface ImageJobSettings extends CommonSettings {
  kind: 'image';
  steps: number;
  cfgScale: number;
  sampler: string;
  scheduler: string;
  flowShift: number;
  /** How many images the one job asked for. */
  batch: number;
  /** Which of them this file is, zero-based. Every image of a batch keeps the whole request. */
  batchIndex: number;
}

export type JobSettings = VideoJobSettings | ImageJobSettings;

export function isImageSettings(settings: JobSettings | undefined): settings is ImageJobSettings {
  return settings?.kind === 'image';
}

export function isVideoSettings(settings: JobSettings | undefined): settings is VideoJobSettings {
  return settings !== undefined && settings.kind !== 'image';
}

/** What came out, after the upsamplers or the batch changed it. */
export interface OutputInfo {
  width: number;
  height: number;
  /** Video only. An image has one frame and saying so adds nothing. */
  numFrames?: number;
  fps?: number;
  seconds?: number;
  /** Images only: how many files the job produced. */
  count?: number;
}

export interface ReportSummary {
  secondsTotal: number;
  steps: number;
  peakVramGib: number;
  stages: { name: string; seconds: number }[];
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function mediaKind(name: string): MediaKind | null {
  const ext = extensionOf(name);
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image';
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video';
  return null;
}

export function contentType(name: string): string {
  return CONTENT_TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * Names Win32 resolves to a device rather than a file, at any depth.
 *
 * `storage/outputs/con.png` opens the console, not a file -- and the upload
 * sanitiser produces exactly this character class, so the case is reachable.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function isDeviceName(segment: string): boolean {
  const dot = segment.indexOf('.');
  return WINDOWS_DEVICE.test(dot < 0 ? segment : segment.slice(0, dot));
}

/**
 * Whether `id` is a media path this app will open.
 *
 * Deliberately a whitelist rather than a traversal check: the id must be one of
 * the known roots, then plain segments, then a known media extension. A check
 * that only looked for `..` would still accept a UNC path or a drive letter,
 * both of which Windows resolves off the storage directory entirely.
 */
export function isMediaId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 1024) return false;
  if (id.includes('\0') || id.includes('\\') || id.includes(':')) return false;

  const segments = id.split('/');
  if (segments.length < 2 || segments.length > 8) return false;
  if (!(MEDIA_ROOTS as readonly string[]).includes(segments[0] as string)) return false;

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
    // Trailing dots and spaces are stripped by Win32 path resolution, so "a.png. "
    // and "a.png" would name the same file through two different ids.
    if (segment !== segment.trim() || segment.endsWith('.')) return false;
    if (isDeviceName(segment)) return false;
  }

  return mediaKind(id) !== null;
}

export function rootOf(id: string): MediaRoot {
  return id.split('/')[0] as MediaRoot;
}

export function nameOf(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

/** The folder a file belongs to: its directory, or the root itself if it sits there. */
export function groupOf(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash <= 0 ? id : id.slice(0, slash);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_DIRECTORY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * How a folder reads in the sidebar.
 *
 * Generations are filed by date, so most folders are dates and are shown as
 * such. A folder that is not a date came from somewhere else -- a benchmark
 * script, a batch of test runs -- and keeps its own name, because that name is
 * the only record of what the batch was.
 */
export function groupLabel(group: string): string {
  const last = group.slice(group.lastIndexOf('/') + 1);
  const date = DATE_DIRECTORY.exec(last);
  if (!date) return last;

  const month = MONTHS[Number(date[2]) - 1] ?? date[2];
  return `${Number(date[3])} ${month} ${date[1]}`;
}

/** `2026-09-11`, in local time -- the date the user was looking at when they asked. */
export function dateDirectory(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clockPrefix(at: Date): string {
  const parts = [at.getHours(), at.getMinutes(), at.getSeconds()];
  return parts.map((part) => `${part}`.padStart(2, '0')).join('');
}

/**
 * Where a generation is written: `outputs/<date>/<time>-<job>.mp4`.
 *
 * The date directory is a real directory rather than a field in a record, so the
 * sidebar's folders and the filesystem's folders are the same thing -- and a
 * folder the studio made is indistinguishable from one a script made.
 */
export function generatedMediaId(jobId: string, at: Date, extension = '.mp4'): string {
  return `outputs/${dateDirectory(at)}/${clockPrefix(at)}-${jobId.slice(0, 8)}${extension}`;
}

/**
 * A filename safe to write, derived from what the browser sent.
 *
 * The uploaded name is never used as a path: only its last segment survives, and
 * everything outside a small character class becomes a hyphen.
 */
export function sanitiseUploadName(original: string): { name: string; kind: MediaKind } | null {
  const last = original.split(/[\\/]/).pop() ?? '';
  const kind = mediaKind(last);
  if (kind === null) return null;

  const ext = extensionOf(last);
  const stem = last
    .slice(0, last.length - ext.length)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  const safe = stem === '' || WINDOWS_DEVICE.test(stem) ? `upload-${stem}`.replace(/-$/, '') : stem;
  return { name: `${safe}${ext}`, kind };
}

/** `outputs/a/b.mp4` -> `library/outputs/a/b.mp4.json`. */
export function recordId(id: string): string {
  return `${LIBRARY_DIR}/${id}.json`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The one line under a thumbnail. Dimensions first: it is what the eye checks. */
export function shortDescription(item: MediaItem): string {
  const parts: string[] = [];
  const output = item.meta?.output;

  if (output) {
    parts.push(`${output.width}×${output.height}`);
    if (item.kind === 'video' && output.seconds !== undefined && output.fps !== undefined) {
      parts.push(`${output.seconds.toFixed(1)}s`, `${Math.round(output.fps)} fps`);
    }
  }

  parts.push(formatBytes(item.bytes));
  if (item.meta?.armId) parts.push(item.meta.armId.replace(/^(video|image|text|audio)-/, ''));
  else if (!item.meta) parts.push('untracked');

  return parts.join(' · ');
}

/** Newest first, by the record's own timestamp where there is one. */
export function mediaTime(item: MediaItem): number {
  return Date.parse(item.meta?.createdAt ?? item.modifiedAt);
}

export interface MediaGroup {
  group: string;
  label: string;
  items: MediaItem[];
}

/** Folders, newest first, each holding its own items newest first. */
export function groupMedia(items: readonly MediaItem[]): MediaGroup[] {
  const byGroup = new Map<string, MediaItem[]>();
  for (const item of items) {
    const bucket = byGroup.get(item.group);
    if (bucket) bucket.push(item);
    else byGroup.set(item.group, [item]);
  }

  return [...byGroup.entries()]
    .map(([group, groupItems]) => ({
      group,
      label: groupLabel(group),
      items: [...groupItems].sort((a, b) => mediaTime(b) - mediaTime(a)),
    }))
    .sort((a, b) => mediaTime(b.items[0] as MediaItem) - mediaTime(a.items[0] as MediaItem));
}
