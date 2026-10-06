/**
 * What an enhance changed in a prompt, word by word.
 *
 * Words rather than characters: a rewrite moves whole phrases, and a
 * character diff of two paragraphs reads as confetti. Each word carries the
 * whitespace after it, so joining the parts back up gives the original text
 * exactly -- line breaks in a `Timeline:` block included.
 *
 * A plain longest-common-subsequence table. A prompt is a few hundred words,
 * so the table is a few hundred thousand cells; past `MAX_CELLS` the two texts
 * are shown as one removal and one addition instead of freezing the page.
 */

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

const MAX_CELLS = 4_000_000;

/** Words with their trailing whitespace; leading whitespace is its own token. */
export function tokenize(text: string): string[] {
  return text.match(/^\s+|\S+\s*/g) ?? [];
}

/** Two tokens are the same word when they differ only in the space after them. */
function key(token: string): string {
  return token.trim();
}

function push(parts: DiffPart[], kind: DiffKind, text: string): void {
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const parts: DiffPart[] = [];

  if (a.length * b.length > MAX_CELLS) {
    if (before) parts.push({ kind: 'removed', text: before });
    if (after) parts.push({ kind: 'added', text: after });
    return parts;
  }

  // lcs[i][j]: the longest common run of a[i..] and b[j..], flattened.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        key(a[i]!) === key(b[j]!)
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]!) === key(b[j]!)) {
      // The new text's spacing, because that is the text now in the box.
      push(parts, 'same', b[j]!);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      push(parts, 'removed', a[i]!);
      i++;
    } else {
      push(parts, 'added', b[j]!);
      j++;
    }
  }
  while (i < a.length) push(parts, 'removed', a[i++]!);
  while (j < b.length) push(parts, 'added', b[j++]!);

  return parts;
}

/** How many words each side of the diff holds, for a one-line summary. */
export function diffStats(parts: DiffPart[]): { added: number; removed: number } {
  const count = (kind: DiffKind) =>
    parts.filter((part) => part.kind === kind).reduce((sum, part) => sum + (part.text.match(/\S+/g)?.length ?? 0), 0);
  return { added: count('added'), removed: count('removed') };
}
