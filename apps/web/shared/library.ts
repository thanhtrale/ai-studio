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

export type MediaKind = 'image' | 'video' | 'model';

/** Roots that are scanned. `outputs` is what arms write; `inputs` is what they read. */
export const MEDIA_ROOTS = ['outputs', 'inputs'] as const;
export type MediaRoot = (typeof MEDIA_ROOTS)[number];

/** Where sidecar records go, mirroring the media path with a `.json` suffix. */
export const LIBRARY_DIR = 'library';

/** Uploads land in the arm input root, because that is the only place an arm may read. */
export const UPLOAD_ROOT: MediaRoot = 'inputs';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
export const VIDEO_EXTENSIONS = ['.mp4', '.webm'] as const;
/**
 * Binary glTF only. A `.gltf` names its buffers and textures as sibling files,
 * which would make one library entry several files on disk; a GLB is one file,
 * and it is what both the mesh arm writes and three.js loads fastest.
 */
export const MODEL_EXTENSIONS = ['.glb'] as const;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
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
  /**
   * The style half of the prompt, when the console's two boxes were used.
   *
   * Kept apart from `prompt` only so the form can be refilled the way it was
   * written. What reached the model is the two of them joined, which is
   * `promptUsed`.
   */
  stylePrompt?: string;
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
  /**
   * The sampling controls a distilled ComfyUI video arm exposes and a
   * fixed-schedule diffusers arm does not.
   *
   * Optional rather than a third settings shape: they are the same four
   * numbers the image console already writes, under the same names, and a
   * record from the arm that has no step count simply omits them.
   */
  steps?: number;
  scheduler?: string;
  /** The video stream's flow shift. The audio one is derived from it. */
  flowShift?: number;
  /** How many clips the one job asked for. */
  batch?: number;
  /** Which of them this file is, zero-based. */
  batchIndex?: number;
  /**
   * Which task the MiniMax-H3 arm ran: `fl2v` reads the references as a first
   * and a last frame, `ref2v` as `<Picture i>` stills the prompt cites. Absent
   * on records from before there was a choice, which were all `fl2v`.
   */
  mode?: VideoMode;
  /** How `ref2v` sized its references: the clip's own area, or a 2048 edge. */
  refImageSize?: 'match' | 'max';
}

export type VideoMode = 'fl2v' | 'ref2v';

/** Which model made a mesh. The two take different knobs. */
export type MeshEngine = 'hunyuan3d' | 'trellis2' | 'hunyuan3d-paint';

/**
 * A mesh made from one photograph.
 *
 * Not a `CommonSettings`: there is no frame. What a mesh has instead is how
 * finely the surface was extracted and how far it was decimated afterwards,
 * which together decide whether the file is fit for a web page.
 *
 * One shape for both engines, with each one's own knobs optional: they share
 * the seed, the guidance, the face budget and the cut-out, and a record from
 * before there was a second engine is a Hunyuan3D one.
 */
export interface ModelJobSettings {
  kind: 'model';
  /** Absent on records from before TRELLIS.2, which were all Hunyuan3D. */
  engine?: MeshEngine;
  /** Every sampler step the job ran; for TRELLIS.2 the sum of its four passes. */
  steps: number;
  cfgScale: number;
  /** Hunyuan3D only: TRELLIS.2's passes each have the template's own. */
  sampler?: string;
  scheduler?: string;
  /** Hunyuan3D: marching resolution of the decoded field, 256 is the blueprint's. */
  octreeResolution?: number;
  /** Hunyuan3D: tokens in the shape latent, 4096 is the blueprint's. */
  latentTokens?: number;
  /** TRELLIS.2: the four sampling passes, structure to texture. */
  structureSteps?: number;
  shapeSteps?: number;
  refineSteps?: number;
  textureSteps?: number;
  /** TRELLIS.2: the voxel resolution the shape is refined at, 1024 or 1536. */
  shapeResolution?: number;
  /** TRELLIS.2: edge of the baked texture maps, in pixels. */
  textureSize?: number;
  bakeNormals?: boolean;
  bakeOcclusion?: boolean;
  /** TRELLIS.2: whether the baked maps were re-encoded as WebP. */
  compressTextures?: boolean;
  /** TRELLIS.2 and Hunyuan3D Paint: the WebP quality, 1-100; 100 is lossless. */
  textureQuality?: number;
  /** Hunyuan3D Paint: whether the paint stage ran at all. */
  texture?: boolean;
  /** Hunyuan3D Paint: views drawn by the multiview model, 6 to 9. */
  paintViews?: number;
  /** Hunyuan3D Paint: edge of each drawn view, 512 or 768. */
  paintResolution?: number;
  paintSteps?: number;
  paintGuidance?: number;
  /** Hunyuan3D Paint: Real-ESRGAN x4 on each view before baking. */
  upscale?: boolean;
  /** Faces to decimate to; 0 kept the raw surface (Hunyuan3D only). */
  targetFaces: number;
  /** Whether BiRefNet cut the object out of its photograph first. */
  removeBackground: boolean;
  seed: number;
  batch: number;
  batchIndex: number;
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

export type JobSettings = VideoJobSettings | ImageJobSettings | ModelJobSettings;

export function isImageSettings(settings: JobSettings | undefined): settings is ImageJobSettings {
  return settings?.kind === 'image';
}

export function isVideoSettings(settings: JobSettings | undefined): settings is VideoJobSettings {
  return settings !== undefined && settings.kind !== 'image' && settings.kind !== 'model';
}

export function isModelSettings(settings: JobSettings | undefined): settings is ModelJobSettings {
  return settings?.kind === 'model';
}

/** What came out, after the upsamplers or the batch changed it. */
export interface OutputInfo {
  /** Absent for a mesh, which has no frame. */
  width?: number;
  height?: number;
  /** Video only. An image has one frame and saying so adds nothing. */
  numFrames?: number;
  fps?: number;
  seconds?: number;
  /** Images only: how many files the job produced. */
  count?: number;
  /** Meshes only, read back from the GLB the arm wrote. */
  vertices?: number;
  faces?: number;
  /** Meshes only: whether the GLB carries texture images. */
  textured?: boolean;
}

export interface ReportSummary {
  secondsTotal: number;
  steps: number;
  peakVramGib: number;
  /**
   * What `peakVramGib` measured: this arm's own share, or the whole card.
   *
   * Absent on records from an arm that only reports its own share, which is
   * the assumption a reader should make when it is missing.
   */
  peakVramScope?: 'process' | 'card' | 'unavailable';
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
  if ((MODEL_EXTENSIONS as readonly string[]).includes(ext)) return 'model';
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
 *
 * A named `collection` stands in for the date when a run is one batch of work
 * that wants to be looked at together, which a date folder cannot express once
 * the same day holds two of them.
 */
export function generatedMediaId(
  jobId: string,
  at: Date,
  extension = '.mp4',
  collection?: string,
): string {
  const folder = collection ?? dateDirectory(at);
  return `outputs/${folder}/${clockPrefix(at)}-${jobId.slice(0, 8)}${extension}`;
}

/**
 * A collection name safe to make a directory of, or `null`.
 *
 * One segment, never a path: this is request input that becomes a folder, so
 * separators and dots are folded away rather than rejected, and the result is
 * held to the same character class `isMediaId` will later accept.
 */
export function sanitiseCollection(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64)
    .replace(/[-._]+$/, '');

  if (name === '' || isDeviceName(name)) return null;
  return name;
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

/** `1.2M`, `48K`, `950`: a face count at a glance. */
export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return `${count}`;
}

/** The modality prefix every arm id starts with, which a chip has no room for. */
const ARM_PREFIX = /^(video|image|text|audio|mesh)-/;

/**
 * The one line under a thumbnail. Dimensions first: it is what the eye checks.
 *
 * `arm` is off where chips already name it, because the arm id is the longest
 * token here and repeating it only truncates the size out of view.
 */
export function shortDescription(item: MediaItem, { arm = true } = {}): string {
  const parts: string[] = [];
  const output = item.meta?.output;

  if (output?.faces !== undefined) {
    parts.push(`${formatCount(output.faces)} faces`);
  } else if (output?.width !== undefined && output.height !== undefined) {
    parts.push(`${output.width}×${output.height}`);
    if (item.kind === 'video' && output.seconds !== undefined && output.fps !== undefined) {
      parts.push(`${output.seconds.toFixed(1)}s`, `${Math.round(output.fps)} fps`);
    }
  }

  parts.push(formatBytes(item.bytes));
  if (arm && item.meta?.armId) parts.push(item.meta.armId.replace(ARM_PREFIX, ''));
  else if (!item.meta) parts.push('untracked');

  return parts.join(' · ');
}

/**
 * What to call each arm in one or two words, for a chip rather than a sentence.
 *
 * An arm id names a directory and reads like one. Comparing two runs at a
 * glance needs the backend and the model as separate words, which the id runs
 * together and abbreviates differently each time.
 */
const ARM_TAGS: Record<string, readonly string[]> = {
  'image-qwen-edit-comfy': ['comfy', 'qwen2511'],
  'image-qwen21-turbo-comfy': ['comfy', 'qwen2.1', 'turbo'],
  'video-ltx25-diffusers': ['diffusers', 'ltx2.5'],
  'mesh-hunyuan3d-comfy': ['comfy', 'hunyuan3d2.1'],
  'mesh-trellis2-comfy': ['comfy', 'trellis2'],
  'mesh-hunyuan3d-paint': ['hunyuan3d2.1', 'paint'],
};

/**
 * The chips under a thumbnail: how a file was made, in comparable words.
 *
 * Derived from the record rather than stored in it, so the vocabulary can be
 * changed without rewriting every sidecar -- and so a file made before these
 * existed gets them anyway.
 */
export function mediaTags(item: MediaItem): string[] {
  const meta = item.meta;
  if (!meta || meta.source !== 'generated') return [];

  const armId = meta.armId;
  const arm = armId
    ? (ARM_TAGS[armId] ?? [armId.replace(ARM_PREFIX, '')])
    : [];

  const feature = featureOf(item);
  if (feature === null) return [...arm];

  const modality = feature === 'image.generate' ? 'i' : feature === 'mesh.generate' ? '3d' : 'v';
  const conditioned = (meta.referenceIds?.length ?? 0) > 0 || meta.referenceId !== undefined;
  return [...arm, `${conditioned ? 'i' : 't'}2${modality}`];
}

/**
 * How long this file took to make, or `null` where nothing timed it.
 *
 * A batch is one job with one report, so the per-image figure is an average.
 * That is the number worth comparing anyway: the alternative is a total that
 * says a batch of a hundred is slower than a batch of one.
 */
export function mediaSeconds(item: MediaItem): number | null {
  const report = item.meta?.report;
  if (!report || !Number.isFinite(report.secondsTotal) || report.secondsTotal <= 0) return null;

  const settings = item.meta?.settings;
  const count = item.meta?.output?.count ?? settings?.batch ?? 1;
  return report.secondsTotal / Math.max(count, 1);
}

/** Short enough for a chip: seconds under a minute, minutes and seconds above it. */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** Newest first, by the record's own timestamp where there is one. */
export function mediaTime(item: MediaItem): number {
  return Date.parse(item.meta?.createdAt ?? item.modifiedAt);
}

/**
 * What produced a file, in the studio's own terms.
 *
 * Not the same as `kind`: an uploaded photograph is an image but no arm made
 * it, and saying "image" about both would make the filter that uses this
 * answer a question nobody asked. `null` means nothing generated this file.
 */
export function featureOf(item: MediaItem): ArmFeature | null {
  const meta = item.meta;
  if (!meta || meta.source !== 'generated') return null;
  if (isModelSettings(meta.settings)) return 'mesh.generate';
  if (meta.settings) return isImageSettings(meta.settings) ? 'image.generate' : 'video.generate';
  // Generated before settings were recorded, or by a script: the file itself is
  // the only evidence left of which console would have made it.
  if (item.kind === 'model') return 'mesh.generate';
  return item.kind === 'image' ? 'image.generate' : 'video.generate';
}

/** The capabilities an arm manifest can declare, as the library sees them. */
export type ArmFeature = 'image.generate' | 'video.generate' | 'mesh.generate';

export const FEATURE_LABELS: Record<ArmFeature, string> = {
  'image.generate': 'Image generation',
  'video.generate': 'Video generation',
  'mesh.generate': '3D model generation',
};

/**
 * Who a file is attributed to: an arm id, or one of two states that are not
 * arms at all. Both of those are worth filtering by, which is why they sit in
 * the same list rather than being a second control.
 */
export function sourceOf(item: MediaItem): string {
  if (item.meta?.armId) return item.meta.armId;
  return item.meta ? 'uploaded' : 'untracked';
}

export function sourceLabel(source: string): string {
  if (source === 'uploaded') return 'Uploaded';
  if (source === 'untracked') return 'Untracked';
  return source;
}

export interface MediaFacet {
  value: string;
  label: string;
  count: number;
}

/** The values actually present, so a filter never offers an empty result. */
export function facetsOf(
  items: readonly MediaItem[],
  of: (item: MediaItem) => string | null,
  label: (value: string) => string,
): MediaFacet[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = of(item);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: label(value), count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface MediaFilter {
  /** An `ArmFeature`, or anything else to mean "no filter". */
  feature?: string | null;
  /** An arm id, `uploaded`, `untracked`, or anything else to mean "no filter". */
  source?: string | null;
}

export function filterMedia(items: readonly MediaItem[], filter: MediaFilter): MediaItem[] {
  const feature = filter.feature;
  const source = filter.source;

  return items.filter((item) => {
    if (feature === 'image.generate' || feature === 'video.generate' || feature === 'mesh.generate') {
      if (featureOf(item) !== feature) return false;
    }
    if (source !== undefined && source !== null && source !== 'all') {
      if (sourceOf(item) !== source) return false;
    }
    return true;
  });
}

/**
 * The key that ties one image of a batch to its siblings.
 *
 * A batch is one job that wrote several files, so the job id is what they
 * share. Only asked of images that say they were part of one: a job of one is
 * a file, and calling it a batch of one would put a folder around a single
 * picture.
 */
export function batchKeyOf(item: MediaItem): string | null {
  const settings = item.meta?.settings;
  if ((settings?.batch ?? 1) <= 1) return null;
  const jobId = item.meta?.jobId;
  return jobId ? `${item.group}/${jobId}` : null;
}

/** One card in the library: a file, or the batch a job wrote in one go. */
export type MediaEntry =
  | { kind: 'item'; key: string; item: MediaItem }
  | { kind: 'stack'; key: string; items: MediaItem[]; cover: MediaItem };

/**
 * Collapses each batch into a single card, in place.
 *
 * The stack takes the position of its newest member, so a batch does not jump
 * to the top of a folder for having several files in it. Members keep the order
 * the job made them in -- that is what `batchIndex` is for, and it is the order
 * the seeds were used. A batch that has lost all but one file is shown as that
 * file: there is no folder left to open.
 */
export function stackMedia(items: readonly MediaItem[]): MediaEntry[] {
  const stacks = new Map<string, MediaItem[]>();
  for (const item of items) {
    const key = batchKeyOf(item);
    if (key === null) continue;
    const bucket = stacks.get(key);
    if (bucket) bucket.push(item);
    else stacks.set(key, [item]);
  }

  const emitted = new Set<string>();
  const entries: MediaEntry[] = [];

  for (const item of items) {
    const key = batchKeyOf(item);
    const members = key === null ? undefined : stacks.get(key);

    if (key === null || members === undefined || members.length < 2) {
      entries.push({ kind: 'item', key: item.id, item });
      continue;
    }

    if (emitted.has(key)) continue;
    emitted.add(key);

    const ordered = [...members].sort((a, b) => batchIndexOf(a) - batchIndexOf(b));
    entries.push({ kind: 'stack', key, items: ordered, cover: ordered[0] as MediaItem });
  }

  return entries;
}

function batchIndexOf(item: MediaItem): number {
  return item.meta?.settings?.batchIndex ?? 0;
}

/** Every file behind a list of cards, stacks flattened back out. */
export function entryItems(entries: readonly MediaEntry[]): MediaItem[] {
  return entries.flatMap((entry) => (entry.kind === 'stack' ? entry.items : [entry.item]));
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
