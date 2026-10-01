/**
 * What each kind of job asks for, declared once and read by both ends.
 *
 * Arms validate their own job bodies in Python and publish no schema for them,
 * so there is nothing to generate this from. Writing it down here is what keeps
 * the form the console renders and the payload the worker forwards from drifting
 * apart: the field names below *are* the arm's field names.
 */

export type JobFieldKind = 'textarea' | 'text' | 'number' | 'toggle' | 'select';

interface FieldCommon {
  /** The key in the arm's job body. Not a display concern. */
  name: string;
  label: string;
  help?: string;
  group?: 'prompt' | 'frame' | 'sampling';
  /**
   * Computed from the frame and duration controls rather than typed.
   *
   * Still declared, because it is a real field of the arm's job body and the
   * same clamping applies to it; the form just does not render a box for it.
   */
  derived?: boolean;
}

export interface TextJobField extends FieldCommon {
  kind: 'text' | 'textarea';
  default: string;
  maxLength?: number;
  required?: boolean;
}

export interface NumberJobField extends FieldCommon {
  kind: 'number';
  default: number;
  min: number;
  max: number;
  /** Values the arm refuses unless they land on this grid. */
  multipleOf?: number;
}

export interface ToggleJobField extends FieldCommon {
  kind: 'toggle';
  default: boolean;
}

export interface SelectJobField extends FieldCommon {
  kind: 'select';
  default: string;
  options: { value: string; label: string }[];
}

export type JobField = TextJobField | NumberJobField | ToggleJobField | SelectJobField;

export interface JobReferenceSpec {
  /** The arm's own spelling: a single path, or a positional list. */
  field: 'image' | 'refImages';
  shape: 'single' | 'list';
  max: number;
  label: string;
  help?: string;
}

export interface JobTypeSpec {
  id: string;
  label: string;
  armId: string;
  modality: 'video' | 'image';
  /** Required suffix of `outPath`; the arm refuses anything else. */
  outputExtension: 'mp4' | 'png';
  /**
   * Where finished files appear in the arm's report. A batch-capable arm lists
   * them; the diffusers arm returns the one path at the top level.
   */
  results: { listKey: 'videos' | 'images' | null };
  references: JobReferenceSpec | null;
  /**
   * How `width` and `height` are arrived at.
   *
   * Asking for a shape and a pixel budget rather than two numbers: the rounding
   * to the model's grid has to happen somewhere, and a user who types 1000
   * should get a frame rather than a rejection.
   */
  frame: FrameSpec;
  /** How `numFrames` is arrived at. Null for a still. */
  duration: DurationSpec | null;
  fields: JobField[];
}

export interface FrameSpec {
  /** The grid the arm rounds to: 32 for the video models, 16 for Qwen-Image. */
  multiple: number;
  defaultAspect: string;
  /**
   * H3 has one canvas it was trained at, offered as a button rather than
   * enforced; the budget below still applies if it is not taken.
   */
  native: 'h3' | null;
  defaultMegapixels: number;
  minMegapixels: number;
  maxMegapixels: number;
}

export interface DurationSpec {
  /** Which temporal grid: H3's `17k+5` at a fixed rate, or LTX's `8n+1`. */
  grid: 'h3' | 'ltx';
  defaultSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  /** Fixed by the model, or null when the job may choose. */
  fps: number | null;
}

const PROMPT_FIELDS: JobField[] = [
  {
    name: 'prompt',
    label: 'Prompt',
    kind: 'textarea',
    default: '',
    required: true,
    maxLength: 8000,
    group: 'prompt',
  },
  {
    name: 'negativePrompt',
    label: 'Negative prompt',
    kind: 'text',
    default: '',
    maxLength: 8000,
    group: 'prompt',
  },
];

const SEED_FIELD: NumberJobField = {
  name: 'seed',
  label: 'Seed',
  kind: 'number',
  default: -1,
  min: -1,
  max: 2147483647,
  help: '-1 là ngẫu nhiên',
  group: 'sampling',
};

export const JOB_TYPES: JobTypeSpec[] = [
  {
    id: 'video-h3',
    label: 'Video — MiniMax H3 (ComfyUI)',
    armId: 'video-minimax-h3-comfy',
    modality: 'video',
    outputExtension: 'mp4',
    results: { listKey: 'videos' },
    references: {
      field: 'refImages',
      shape: 'list',
      max: 2,
      label: 'Keyframe',
      help: 'Theo thứ tự: khung đầu, rồi khung cuối. Muốn chỉ định khung cuối thì phải điền cả hai.',
    },
    frame: { multiple: 32, defaultAspect: '16:9', native: 'h3', defaultMegapixels: 0.5, minMegapixels: 0.05, maxMegapixels: 4 },
    duration: { grid: 'h3', defaultSeconds: 5, minSeconds: 5, maxSeconds: 15, fps: 24 },
    fields: [
      ...PROMPT_FIELDS,
      { name: 'width', label: 'Rộng', kind: 'number', default: 1344, min: 256, max: 2048, multipleOf: 32, group: 'frame', derived: true },
      { name: 'height', label: 'Cao', kind: 'number', default: 768, min: 256, max: 2048, multipleOf: 32, group: 'frame', derived: true },
      { name: 'numFrames', label: 'Số khung', kind: 'number', default: 124, min: 124, max: 362, group: 'frame', derived: true },
      { name: 'steps', label: 'Steps', kind: 'number', default: 6, min: 1, max: 32, group: 'sampling' },
      { name: 'batch', label: 'Số clip', kind: 'number', default: 1, min: 1, max: 4, help: 'Mỗi clip là vài phút GPU.', group: 'sampling' },
      {
        name: 'scheduler',
        label: 'Scheduler',
        kind: 'select',
        default: 'simple',
        options: [
          { value: 'simple', label: 'simple' },
          { value: 'normal', label: 'normal' },
          { value: 'karras', label: 'karras' },
          { value: 'beta', label: 'beta' },
          { value: 'sgm_uniform', label: 'sgm_uniform' },
        ],
        group: 'sampling',
      },
      SEED_FIELD,
    ],
  },
  {
    id: 'video-ltx',
    label: 'Video — LTX-2.5 (Diffusers)',
    armId: 'video-ltx25-diffusers',
    modality: 'video',
    outputExtension: 'mp4',
    results: { listKey: null },
    references: {
      field: 'image',
      shape: 'single',
      max: 1,
      label: 'Ảnh điều kiện',
      help: 'Khung đầu cho image-to-video.',
    },
    frame: { multiple: 32, defaultAspect: '16:9', native: null, defaultMegapixels: 0.5, minMegapixels: 0.05, maxMegapixels: 4 },
    duration: { grid: 'ltx', defaultSeconds: 5, minSeconds: 1, maxSeconds: 20, fps: null },
    fields: [
      ...PROMPT_FIELDS,
      { name: 'width', label: 'Rộng', kind: 'number', default: 1216, min: 256, max: 1920, multipleOf: 32, group: 'frame', derived: true },
      { name: 'height', label: 'Cao', kind: 'number', default: 704, min: 256, max: 1920, multipleOf: 32, group: 'frame', derived: true },
      { name: 'numFrames', label: 'Số khung', kind: 'number', default: 121, min: 9, max: 481, multipleOf: 8, group: 'frame', derived: true },
      { name: 'frameRate', label: 'FPS', kind: 'number', default: 24, min: 8, max: 60, group: 'frame', derived: true },
      { name: 'enhancePrompt', label: 'Enhance prompt', kind: 'toggle', default: false, help: 'Gemma viết lại prompt theo văn phong model được huấn luyện.', group: 'sampling' },
      { name: 'spatialUpsample', label: 'Upsample không gian', kind: 'toggle', default: true, group: 'sampling' },
      { name: 'temporalUpsample', label: 'Upsample thời gian', kind: 'toggle', default: true, group: 'sampling' },
      SEED_FIELD,
    ],
  },
  {
    id: 'image-qwen-edit',
    label: 'Ảnh — Qwen Image Edit (ComfyUI)',
    armId: 'image-qwen-edit-comfy',
    modality: 'image',
    outputExtension: 'png',
    results: { listKey: 'images' },
    references: {
      field: 'refImages',
      shape: 'list',
      max: 3,
      label: 'Ảnh tham chiếu',
      help: 'Tối đa 3, theo giới hạn của encoder.',
    },
    frame: { multiple: 16, defaultAspect: '1:1', native: null, defaultMegapixels: 0.5, minMegapixels: 0.05, maxMegapixels: 8 },
    duration: null,
    fields: [
      ...PROMPT_FIELDS,
      { name: 'width', label: 'Rộng', kind: 'number', default: 1024, min: 256, max: 4096, multipleOf: 16, group: 'frame', derived: true },
      { name: 'height', label: 'Cao', kind: 'number', default: 1024, min: 256, max: 4096, multipleOf: 16, group: 'frame', derived: true },
      { name: 'steps', label: 'Steps', kind: 'number', default: 20, min: 1, max: 100, group: 'sampling' },
      { name: 'cfgScale', label: 'CFG', kind: 'number', default: 2.5, min: 0, max: 30, group: 'sampling' },
      {
        name: 'sampler',
        label: 'Sampler',
        kind: 'select',
        default: 'dpmpp_2m_sde_gpu',
        options: [
          { value: 'dpmpp_2m_sde_gpu', label: 'dpmpp_2m_sde_gpu' },
          { value: 'dpmpp_2m', label: 'dpmpp_2m' },
          { value: 'euler', label: 'euler' },
          { value: 'euler_ancestral', label: 'euler_ancestral' },
          { value: 'ddim', label: 'ddim' },
        ],
        group: 'sampling',
      },
      {
        name: 'scheduler',
        label: 'Scheduler',
        kind: 'select',
        default: 'karras',
        options: [
          { value: 'karras', label: 'karras' },
          { value: 'simple', label: 'simple' },
          { value: 'normal', label: 'normal' },
          { value: 'beta', label: 'beta' },
        ],
        group: 'sampling',
      },
      { name: 'batch', label: 'Số ảnh', kind: 'number', default: 1, min: 1, max: 8, group: 'sampling' },
      SEED_FIELD,
    ],
  },
];

export function jobTypeById(id: string): JobTypeSpec | undefined {
  return JOB_TYPES.find((spec) => spec.id === id);
}

export function defaultJobValues(spec: JobTypeSpec): Record<string, unknown> {
  return Object.fromEntries(spec.fields.map((field) => [field.name, field.default]));
}

function coerceNumber(field: NumberJobField, raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : field.default;
  const clamped = Math.min(field.max, Math.max(field.min, value));
  if (!field.multipleOf) return clamped;

  // The arm refuses an off-grid value outright, so snap rather than forward it.
  const snapped = Math.round(clamped / field.multipleOf) * field.multipleOf;
  return Math.min(field.max, Math.max(field.min, snapped));
}

/**
 * Brings submitted values back inside what the arm accepts.
 *
 * Run on both ends: the console so the user sees what will be sent, the worker
 * because a document can be written by anything holding a session.
 */
export function coerceJobValues(spec: JobTypeSpec, values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of spec.fields) {
    const raw = values[field.name];
    if (field.kind === 'number') {
      result[field.name] = coerceNumber(field, typeof raw === 'string' ? Number(raw) : raw);
    } else if (field.kind === 'toggle') {
      result[field.name] = typeof raw === 'boolean' ? raw : field.default;
    } else if (field.kind === 'select') {
      const candidate = typeof raw === 'string' ? raw : field.default;
      result[field.name] = field.options.some((option) => option.value === candidate)
        ? candidate
        : field.default;
    } else {
      const text = typeof raw === 'string' ? raw.trim() : field.default;
      result[field.name] = field.maxLength ? text.slice(0, field.maxLength) : text;
    }
  }

  return result;
}
