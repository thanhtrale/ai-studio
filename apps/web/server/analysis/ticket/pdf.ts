/**
 * Text out of a PDF, for the Print export path.
 *
 * This is the poorest of the import paths and the spec says so: a printed issue
 * has lost the structure that made the other paths worth having. A table is
 * positioned glyphs, a list is positioned glyphs, and nothing in the file says
 * which was which. So this recovers lines and paragraphs and stops there --
 * fields it cannot distinguish stay absent rather than being guessed, because a
 * wrong `status` is worse than no `status`.
 *
 * Use it when nothing better is available. Jira's XML export is right there in
 * the same menu and carries everything.
 */

/**
 * Vertical distance, in points, at which two runs are different lines.
 *
 * Glyphs on one line vary by a fraction of a point; a new line in body text is
 * ten or more. Two is well inside the gap and forgiving of a baseline shift
 * from a superscript or a changed font size mid-line.
 */
const LINE_EPSILON = 2;

/** Horizontal gap, in points, that reads as a deliberate space rather than kerning. */
const SPACE_EPSILON = 1.5;

interface Run {
  text: string;
  x: number;
  y: number;
  width: number;
}

/** Groups runs into lines by their baseline, then orders each line left to right. */
function linesOf(runs: Run[]): string[] {
  const rows: Run[][] = [];

  for (const run of [...runs].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const last = rows[rows.length - 1];
    const first = last?.[0];
    if (first && Math.abs(first.y - run.y) <= LINE_EPSILON) last.push(run);
    else rows.push([run]);
  }

  return rows.map((row) => {
    const ordered = [...row].sort((a, b) => a.x - b.x);
    let line = '';
    let cursor: number | undefined;

    for (const run of ordered) {
      // A PDF has no spaces, only positions. A gap wider than kerning is one.
      if (cursor !== undefined && run.x - cursor > SPACE_EPSILON && !line.endsWith(' ')) line += ' ';
      line += run.text;
      cursor = run.x + run.width;
    }

    return line.replace(/\s+/g, ' ').trim();
  });
}

/**
 * Extracts a PDF's text, page by page.
 *
 * pdfjs is loaded lazily: it is a large module and every other import path
 * reaches this file's module graph without needing it.
 */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  // The legacy build is the one that runs outside a browser.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // No worker, no fonts, no canvas: this process wants characters, and font
  // data would only ever be read in order to draw them.
  const loading = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, disableFontFace: true });
  const document = await loading.promise;

  try {
    const pages: string[] = [];

    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();

      const runs: Run[] = [];
      for (const item of content.items) {
        if (!('str' in item) || typeof item.str !== 'string' || !item.str.trim()) continue;
        const transform = item.transform as number[] | undefined;
        runs.push({
          text: item.str,
          x: transform?.[4] ?? 0,
          y: transform?.[5] ?? 0,
          width: typeof item.width === 'number' ? item.width : 0,
        });
      }

      pages.push(linesOf(runs).join('\n').trim());
      page.cleanup();
    }

    return pages
      .filter(Boolean)
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } finally {
    // The loading task owns the worker; destroying the document alone leaves it.
    await loading.destroy();
  }
}
