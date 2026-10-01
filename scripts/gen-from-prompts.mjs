// Runs a list of prompts through one image arm, one job per prompt.
//
// The arm's own batch repeats a single prompt with different seeds, which is
// not what a list of 233 different prompts needs -- so this submits them one
// at a time and lets the arm stay warm between them.
//
//   node scripts/gen-from-prompts.mjs --file <prompts.json> [--limit 10]
//
// The file is a JSON array of { id, prompt, width, height, character? }.
// `--collection` files the whole run in one folder under outputs/ instead of
// today's date, which is the only way a run of this length stays readable next
// to whatever else was made the same day. Everything else -- what is recorded
// against an image -- is the studio's own business, and happens because this
// calls the same route the console does.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    arm: { type: 'string', default: 'image-qwen21-turbo-comfy' },
    base: { type: 'string', default: 'http://127.0.0.1:3000' },
    limit: { type: 'string' },
    every: { type: 'string' },
    steps: { type: 'string', default: '6' },
    seed: { type: 'string', default: '0' },
    prefix: { type: 'string', default: 'refcrawl' },
    collection: { type: 'string' },
  },
});

if (!values.file) {
  console.error('--file is required');
  process.exit(1);
}

const steps = Number(values.steps);
const baseSeed = Number(values.seed);
const entries = JSON.parse(await readFile(values.file, 'utf8'));
if (!Array.isArray(entries)) throw new Error('the prompt file must be a JSON array');

// `--every N` takes one in N, spread across the list, so a sample covers the
// whole of it rather than the first few of whatever happens to sort first.
const sampled = values.every
  ? entries.filter((_, index) => index % Number(values.every) === 0)
  : entries;
const chosen = values.limit ? sampled.slice(0, Number(values.limit)) : sampled;

console.log(`${chosen.length} of ${entries.length} prompts → ${values.arm}`);
if (values.collection) console.log(`filing into outputs/${values.collection}`);

const started = Date.now();
let done = 0;
const failures = [];

for (const [index, entry] of chosen.entries()) {
  const width = Number(entry.width) || 1024;
  const height = Number(entry.height) || 1024;
  // Job ids are plain identifiers and the library takes the first eight of
  // them for a filename, so the position in the list is what goes in.
  const jobId = `${values.prefix}-${String(index + 1).padStart(4, '0')}`;
  const seed = baseSeed > 0 ? baseSeed + index : -1;

  const body = {
    jobId,
    prompt: entry.prompt,
    settings: {
      kind: 'image',
      aspect: `${width}:${height}`,
      width,
      height,
      steps,
      cfgScale: 1,
      sampler: 'euler',
      scheduler: 'simple',
      flowShift: 3,
      seed,
      batch: 1,
      batchIndex: 0,
    },
    output: { width, height, count: 1 },
    ...(values.collection ? { collection: values.collection } : {}),
  };

  const at = Date.now();
  try {
    const response = await fetch(`${values.base}/api/arms/${values.arm}/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer?.data?.message ?? answer?.message ?? response.statusText);

    done += 1;
    const seconds = ((Date.now() - at) / 1000).toFixed(1);
    const label = entry.character ?? entry.id ?? '';
    console.log(
      `[${index + 1}/${chosen.length}] ${seconds}s  ${answer.media[0].id}  ${width}×${height}  ${label}`,
    );
  } catch (error) {
    failures.push({ jobId, id: entry.id, message: error.message });
    console.log(`[${index + 1}/${chosen.length}] FAILED  ${entry.id ?? jobId}  ${error.message}`);
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${done}/${chosen.length} in ${total}s (${(total / Math.max(done, 1)).toFixed(1)}s each)`);
for (const failure of failures) console.log(`  failed: ${failure.id} — ${failure.message}`);
