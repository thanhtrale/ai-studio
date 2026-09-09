import { spawn } from 'node:child_process';
import process from 'node:process';

const RESET = '\u001b[0m';

const targets = [
  { label: 'supervisor', colour: '\u001b[36m', filter: '@ai-studio/supervisor' },
  { label: 'web', colour: '\u001b[35m', filter: '@ai-studio/web' },
];

const width = Math.max(...targets.map((target) => target.label.length));

// Node refuses to spawn a .cmd shim without a shell. npm_execpath points at
// whatever launched us: a JS entry point (run it with node) or a real binary
// (spawn it directly). Both avoid going through a shell.
const execPath = process.env['npm_execpath'];

if (execPath !== undefined && !/pnpm/i.test(execPath)) {
  process.stderr.write(
    'This is a pnpm workspace: the dev script shells out to `--filter`, and internal\n' +
      'packages use the `workspace:` protocol. Run `pnpm dev` instead.\n',
  );
  process.exit(1);
}

const isScript = execPath !== undefined && /\.[cm]?js$/.test(execPath);
const command = isScript ? process.execPath : (execPath ?? 'pnpm');
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
  const child = spawn(command, [...baseArgs, '--filter', target.filter, 'dev'], {
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
