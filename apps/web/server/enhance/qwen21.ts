/**
 * What the Qwen3-VL arm is told when it rewrites a prompt for Qwen-Image 2.1.
 *
 * The instructions are Viggle's, the ones its ComfyUI workflows hand the text
 * encoder: `t2i.md` for text-to-image and `edit.md` when there are references.
 * They are read from the image arm's own `rewrite/` folder rather than copied
 * here, so the in-job enhancer the arm still has and this one cannot drift
 * apart. Both ask for one JSON object whose `rewritten_prompt` is the prompt.
 *
 * What this module adds is the H3 enhancer's shape: a draft and a note rather
 * than a single brief, and an answer that goes into the prompt box to be read
 * before anything is sampled, instead of straight to the sampler.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Qwen21RewriteInput {
  /** The prompt as it stands. May be empty: the note and the images can be enough. */
  prompt: string;
  /** What the user wants changed or added. May be empty: then the rewrite only expands. */
  comment: string;
  /** How many reference images are attached; any at all makes this an edit. */
  references: number;
  width: number;
  height: number;
}

export interface Qwen21RewriteRequest {
  system: string;
  prompt: string;
}

/** Where the instructions live, relative to the arms directory. */
const PROMPTS = path.join('image-qwen21-turbo-comfy', 'src', 'arm_qwen21', 'rewrite');

/** Viggle's system prompt for this request: the edit one when there are references. */
export async function qwen21SystemPrompt(armsDir: string, references: number): Promise<string> {
  return readFile(path.join(armsDir, PROMPTS, references > 0 ? 'edit.md' : 't2i.md'), 'utf8');
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** `1344x768` -> `7:4`: the ratio the t2i rewriter is expected to echo back. */
export function aspectRatioText(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/**
 * The user turn, in the shape the arm's own enhancer sends it -- the brief,
 * then the frame for t2i or the language for an edit -- with the note folded
 * into the brief as a change to make.
 */
export function qwen21RewritePrompt(input: Qwen21RewriteInput): string {
  const draft = input.prompt.trim();
  const note = input.comment.trim();

  const brief = draft && note
    ? `${draft}\n\nChange this prompt as follows, and keep everything else in it: ${note}`
    : draft || note;

  if (input.references > 0) {
    const images = input.references === 1
      ? 'One input image is attached.'
      : `${input.references} input images are attached, in order: ${Array.from({ length: input.references }, (_, index) => `<image${index + 1}>`).join(', ')}.`;
    return `${images}\n${brief || 'Make the most of the input image.'}\n(Write the description in English.)`;
  }
  return `${brief}\nAspect ratio: ${aspectRatioText(input.width, input.height)}`;
}

/** The system prompt and the user turn for one rewrite. */
export async function qwen21RewriteRequest(armsDir: string, input: Qwen21RewriteInput): Promise<Qwen21RewriteRequest> {
  return {
    system: await qwen21SystemPrompt(armsDir, input.references),
    prompt: qwen21RewritePrompt(input),
  };
}

/**
 * The rewritten prompt out of the rewriter's JSON, or null.
 *
 * The same reading as the arm's `parse_rewrite`: JSON, sometimes fenced, and
 * anything that is not JSON is taken as the prompt itself. A single paragraph
 * is what both instructions ask for, so stray line breaks are folded.
 */
export function parseQwen21Rewrite(answer: string): string | null {
  let text = answer.trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();

  let value: string;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rewritten = (parsed as { rewritten_prompt?: unknown }).rewritten_prompt;
    if (typeof rewritten !== 'string') return null;
    value = rewritten;
  } catch {
    // A JSON object cut short or wrapped in prose still carries the prompt.
    const field = /"rewritten_prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (field?.[1] !== undefined) {
      try {
        value = JSON.parse(`"${field[1]}"`) as string;
      } catch {
        value = field[1];
      }
    } else if (text.startsWith('{')) {
      return null;
    } else {
      value = text;
    }
  }

  const folded = value.replace(/\s*\n+\s*/g, ' ').trim();
  return folded.length > 0 ? folded : null;
}
