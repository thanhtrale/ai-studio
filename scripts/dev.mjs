import { spawn } from 'node:child_process';
import process from 'node:process';

const RESET = '\u001b[0m';

const targets = [
  { label: 'supervisor', colour: '\u001b[36m', workspace: '@ai-studio/supervisor' },
  { label: 'web', colour: '\u001b[35m', workspace: '@ai-studio/web' },
];

const width = Math.max(...targets.map((target) => target.label.length));

// Node refuses to spawn a .cmd shim without a shell. npm_execpath points at
// whatever launched us -- npm's own cli.js under `npm run dev` -- so it is run
// with this same node binary. Run directly as `node scripts/dev.mjs` there is
// no such variable, and `npm` from PATH is the fallback.
const execPath = process.env['npm_execpath'];

const isScript = execPath !== undefined && /\.[cm]?js$/.test(execPath);
const command = isScript ? process.execPath : (execPath ?? 'npm');
const baseArgs = isScript ? [execPath] : [];

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

function prefix(target) {
  return `${target.colour}${target.label.padEnd(width)}${RESET} | `;
}

function pipe(stream, target) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`${prefix(target)}${line}\n`);
  });
}

for (const target of targets) {
  // --silent drops npm's own banner per child; the package's own output is
  // untouched and still arrives prefixed with the label below.
  const child = spawn(command, [...baseArgs, 'run', '--silent', 'dev', '--workspace', target.workspace], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });

  pipe(child.stdout, target);
  pipe(child.stderr, target);
  children.push(child);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix(target)}exited with code ${code}\n`);
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Set it here too: an unref'd timer would let the process exit 0 on its own.
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
