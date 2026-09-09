import { describe, expect, it } from 'vitest';

import { launch } from './launcher.js';

const ECHO_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

/**
 * These run the real launcher. The point is to prove that nothing reaches a
 * command interpreter, so a hostile parameter value cannot become a command.
 * With `node -e`, argv[1] is the first argument after the inline script.
 */
describe('launch', () => {
  it('passes each argument through verbatim', async () => {
    const process_ = launch({
      command: process.execPath,
      args: ['-e', ECHO_ARGV, 'plain', 'with space'],
      cwd: process.cwd(),
    });

    let stdout = '';
    process_.child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    await process_.exited;

    expect(JSON.parse(stdout)).toEqual(['plain', 'with space']);
  });

  it('keeps shell metacharacters inert inside a single argument', async () => {
    const hostile = 'a && echo pwned | whoami > out.txt; rm -rf /';

    const process_ = launch({
      command: process.execPath,
      args: ['-e', ECHO_ARGV, hostile],
      cwd: process.cwd(),
    });

    let stdout = '';
    process_.child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    await process_.exited;

    const argv = JSON.parse(stdout) as string[];
    expect(argv).toHaveLength(1);
    expect(argv[0]).toBe(hostile);
  });

  it('captures output and reports the exit code', async () => {
    const process_ = launch({
      command: process.execPath,
      args: ['-e', 'console.log("hello from arm"); process.exit(3)'],
      cwd: process.cwd(),
    });

    const exit = await process_.exited;

    expect(exit.code).toBe(3);
    expect(process_.recentOutput()).toContain('hello from arm');
  });
});
